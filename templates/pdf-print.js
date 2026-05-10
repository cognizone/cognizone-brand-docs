#!/usr/bin/env node
// Usage: node pdf-print.js <input.html> <output.pdf> <title> <date> <logo.png>

const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const [,, htmlFile, outputPdf, title, date, logoPath, footerTitle, mermaidJsPath] = process.argv;

const GREEN = '#058775';
const GRAY  = '#666666';

const logoBase64 = logoPath && fs.existsSync(logoPath)
  ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
  : '';

const fontPath = path.join(__dirname, 'fonts', 'Roboto[wdth,wght].ttf');
const fontBase64 = fs.existsSync(fontPath)
  ? fs.readFileSync(fontPath).toString('base64')
  : null;

const FONT = fontBase64
  ? `<style>@font-face { font-family: 'Roboto'; src: url('data:font/ttf;base64,${fontBase64}') format('truetype'); font-weight: 100 900; }</style>`
  : '';

const headerTemplate = `
  ${FONT}
  <div style="width:100%; box-sizing:border-box; padding:0 20mm;">
    <div style="
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 4pt;
      border-bottom: 0.5px solid ${GREEN};
      font-size: 8pt; font-family: 'Roboto', sans-serif; color: ${GRAY};
    ">
      ${logoBase64 ? `<img src="${logoBase64}" style="height:18px; width:auto; max-width:110px;">` : '<span></span>'}
      <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:70%; text-align:right;">
        ${title || ''}
      </span>
    </div>
  </div>`;

const footerTemplate = `
  ${FONT}
  <div style="width:100%; box-sizing:border-box; padding:0 20mm;">
    <div style="
      display: flex; align-items: center; justify-content: space-between;
      padding-top: 4pt;
      border-top: 0.5px solid ${GREEN};
      font-size: 8pt; font-family: 'Roboto', sans-serif; color: ${GRAY};
    ">
      <span>${footerTitle || ''}</span>
      <span class="pageNumber"></span>
    </div>
  </div>`;

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
  await page.evaluate(() => document.fonts && document.fonts.ready);

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

    document.querySelectorAll('h2, h3, h4').forEach(el => {
      const next = el.nextElementSibling;
      const keep = el.offsetHeight + (next ? Math.min(next.offsetHeight, 80) : 0);
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
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    margin: { top: '25mm', bottom: '20mm', left: '20mm', right: '20mm' },
  });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
