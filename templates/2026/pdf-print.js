#!/usr/bin/env node
// Usage: node pdf-print.js <input.html> <output.pdf> <headerTitle> <footerText> <icon.png> <mermaid.min.js>
//
// 2026 brand. Header and footer are CSS page-margin boxes (@top-left etc.),
// not Puppeteer's headerTemplate/footerTemplate: those are painted on every
// page, while the spec wants the cover without header or footer. Cover pages
// use the margin-less named page `cover` (styles.css), which leaves the margin
// boxes no room. Margin boxes use the document's own @font-face fonts; the
// icon is inlined as a data URI (external URLs crash Puppeteer PDF printing).

const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');
const fs = require('fs');

const [,, htmlFile, outputPdf, headerTitle, footerText, iconPath, mermaidJsPath] = process.argv;

const PLUM  = '#2F2450';
const MUTED = '#6B6185';
const RULE  = '#E2D8CB';

// Icon is 512×512; image-set's resolution scales it to 4.2mm (≈15.9 CSS px).
const ICON_RESOLUTION = (512 / (4.2 * 96 / 25.4)).toFixed(2);
const iconUri = iconPath && fs.existsSync(iconPath)
  ? `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`
  : '';

// Margin boxes cannot clip with an ellipsis — truncate long text up front.
// Roboto Mono 7pt is ~1.48mm per character.
function truncate(s, max) {
  s = String(s || '');
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function cssString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

const HEADER_BOX = `vertical-align: bottom; margin-top: 12.5mm; margin-bottom: 6mm;
    padding-bottom: 6pt; border-bottom: 0.5pt solid ${RULE};`;
const FOOTER_BOX = `vertical-align: bottom; margin-top: 0; margin-bottom: 12.5mm;
    font-family: 'Roboto Mono', monospace; font-size: 7pt;`;

const pageCss = `
@page {
  @top-left {
    content: ${iconUri ? `image-set(url("${iconUri}") ${ICON_RESOLUTION}x) ` : ''}" Cognizone";
    width: 30%; ${HEADER_BOX}
    font-family: 'Roboto', sans-serif; font-size: 8.5pt; font-weight: 700; color: ${PLUM};
  }
  @top-right {
    content: ${cssString(truncate(headerTitle, 78))};
    width: 70%; text-align: right; ${HEADER_BOX}
    font-family: 'Roboto Mono', monospace; font-size: 7pt; color: ${MUTED};
  }
  @bottom-left {
    content: ${cssString(truncate(footerText, 95))};
    width: 85%; ${FOOTER_BOX} color: ${MUTED};
  }
  @bottom-right {
    content: counter(page);
    width: 15%; text-align: right; ${FOOTER_BOX} color: ${PLUM};
  }
}
@page cover {
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}`;

// A4 at 96dpi: full = 794 x 1123 px; printable area after margins is what
// matters for both layout (via viewport) and TOC page-number computation.
// Margins: top 25mm, bottom 20mm, left/right 20mm.
const A4_WIDTH_PX           = 794;   // 210mm
const PRINT_CONTENT_WIDTH   = 643;   // 170mm (210 - 20 - 20)
const PRINT_CONTENT_HEIGHT  = 952;   // 252mm (297 - 25 - 20)

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Match the browser's layout width to the PDF's printable content width so
  // text wraps the same way it will in the printed PDF. Without this, content
  // measured in JS would be laid out at the default viewport width and the
  // page-number estimate drifts further as the document gets longer.
  await page.setViewport({ width: PRINT_CONTENT_WIDTH, height: PRINT_CONTENT_HEIGHT });

  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'networkidle0' });

  // Header/footer margin boxes (see top of file)
  await page.addStyleTag({ content: pageCss });

  // Force light color scheme so mermaid diagrams don't pick up dark mode
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // Render mermaid diagrams (if any) before TOC page-number calculation
  const hasMermaid = await page.evaluate(() => document.querySelectorAll('pre.mermaid').length > 0);
  if (hasMermaid && mermaidJsPath) {
    await page.addScriptTag({ path: mermaidJsPath });
    await page.evaluate(async () => {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
      await mermaid.run();
    });
  }

  // Wait for web fonts to load — measuring before fonts swap underestimates
  // line heights and pushes computed page numbers low.
  // Margin boxes are not part of the DOM, so fonts used only there (Roboto
  // Mono when the body has no code) would never be requested — load them.
  await page.evaluate(() => document.fonts && Promise.all([
    document.fonts.load('700 8.5pt "Roboto"'),
    document.fonts.load('7pt "Roboto Mono"'),
  ]).then(() => document.fonts.ready));

  // Inject page numbers into TOC entries.
  //
  // Strategy: simulate Chromium's print pagination in document order. Two
  // browser-vs-print mismatches inflate the JS estimate otherwise:
  //   1. Forced page breaks (.page-break) advance to a fresh page in print but
  //      add no whitespace in browser layout.
  //   2. break-inside: avoid (tables, code blocks, mermaid wrappers) and the
  //      heading "stay-with-next" rule (h2/h3/h4) push elements to the next
  //      page when they don't fit on the current one — also without browser-
  //      side whitespace. Without simulating these, every avoid-pushed table
  //      or stuck heading shifts every later anchor 1 page early.
  // We walk all relevant elements in document order, maintain a running
  // "virtual" Y that includes inserted page-bump whitespace, and read off
  // each anchor's resulting page from that Y.
  await page.evaluate((PAGE_HEIGHT) => {
    function absoluteTop(el) {
      let top = 0;
      while (el) { top += el.offsetTop; el = el.offsetParent; }
      return top;
    }

    // Collect events: forced breaks, avoid-blocks, headings, and TOC targets.
    // For each, record its layout-Y and (when relevant) height. Headings carry
    // a "keep-with-next" budget — if the heading and its first following block
    // don't both fit on the current page, both push to the next.
    const events = [];

    document.querySelectorAll('.page-break').forEach(el => {
      events.push({ kind: 'break', y: absoluteTop(el) });
    });

    document.querySelectorAll('table, pre, .mermaid-wrap').forEach(el => {
      events.push({ kind: 'avoid', y: absoluteTop(el), h: el.offsetHeight });
    });

    // Chromium keeps a heading with whatever follows it: a run of further
    // headings, then the whole of an unbreakable block (table, code,
    // diagram), or the first lines of a flowing one (orphans/widows = 2, so a
    // block of up to ~4 lines cannot split and moves whole).
    const FOUR_LINES = 64;
    const TWO_LINES = 40;
    document.querySelectorAll('h2, h3, h4').forEach(el => {
      let next = el.nextElementSibling;
      while (next && /^H[1-6]$/.test(next.tagName)) next = next.nextElementSibling;
      const nextKeep = !next ? 0
        : next.matches('table, pre, .mermaid-wrap') ? next.offsetHeight
        : next.offsetHeight <= FOUR_LINES ? next.offsetHeight
        : TWO_LINES;
      const keep = next
        ? absoluteTop(next) - absoluteTop(el) + nextKeep
        : el.offsetHeight;
      events.push({ kind: 'avoid', y: absoluteTop(el), h: keep });
    });

    // Targets: every TOC anchor's destination element.
    const tocLinks = Array.from(document.querySelectorAll('#TOC a[href^="#"]'));
    const targetForLink = new Map();
    for (const link of tocLinks) {
      const t = document.getElementById(link.getAttribute('href').slice(1));
      if (t) {
        targetForLink.set(link, t);
        events.push({ kind: 'target', y: absoluteTop(t), link });
      }
    }

    // Sort by Y; on ties, breaks first, then avoid, then targets.
    const order = { break: 0, avoid: 1, target: 2 };
    events.sort((a, b) => a.y - b.y || order[a.kind] - order[b.kind]);

    // Walk events maintaining: shift (whitespace inserted up to here),
    // pageStart (virtual Y at top of current page), page (current page index).
    let shift = 0;
    let pageStart = 0;
    let page = 1;

    function advancePastY(virtualY) {
      while (virtualY - pageStart >= PAGE_HEIGHT) {
        page++;
        pageStart += PAGE_HEIGHT;
      }
    }

    for (const e of events) {
      const vy = e.y + shift;

      if (e.kind === 'break') {
        // Force jump to next page. Pad current page with whitespace.
        advancePastY(vy);
        const slack = PAGE_HEIGHT - (vy - pageStart);
        if (slack > 0 && slack < PAGE_HEIGHT) {
          shift += slack;
          page++;
          pageStart += PAGE_HEIGHT;
        }
      } else if (e.kind === 'avoid') {
        advancePastY(vy);
        const remaining = pageStart + PAGE_HEIGHT - vy;
        // Only push if the block fits on a single page but not in remaining
        // space. Blocks taller than a page would split anyway; don't simulate
        // that — let natural advance handle it.
        if (e.h <= PAGE_HEIGHT && e.h > remaining) {
          shift += remaining;
          page++;
          pageStart += PAGE_HEIGHT;
        }
      } else if (e.kind === 'target') {
        advancePastY(vy);
        const pageEl = e.link.querySelector('.toc-page');
        if (pageEl) pageEl.textContent = String(page);
      }
    }
  }, PRINT_CONTENT_HEIGHT);

  await page.pdf({
    path: outputPdf,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: false,
    margin: { top: '25mm', bottom: '20mm', left: '20mm', right: '20mm' },
  });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
