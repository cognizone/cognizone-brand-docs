'use strict';
// PDF renderer, 2026 brand: takes parsed markdown data, produces a branded PDF via Puppeteer.
// Deliberately a full copy of render-pdf.js (the classic brand is frozen and
// will be removed) — see reference/brand-2026-spec.md for the styling rules.

const { marked } = require('marked');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { parseMermaidOpts } = require('./mermaid-opts');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Frontmatter values also land in attribute-free text, but escape quotes too
// so a value can never break out of an attribute.
function escapeText(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function mermaidWrapHtml(text, info) {
  const opts = parseMermaidOpts(info || '');
  const marginCss =
    opts.align === 'left'  ? '0 auto 0 0' :
    opts.align === 'right' ? '0 0 0 auto' :
                             '0 auto';
  return `<div class="mermaid-wrap" style="max-width:${opts.maxWidth}px;margin:${marginCss};"><pre class="mermaid">${text}</pre></div>\n`;
}

const SCRIPT_DIR    = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(SCRIPT_DIR, 'templates', '2026');
const CSS_PATH      = path.join(TEMPLATES_DIR, 'styles.css');
const ICON_PATH     = path.join(TEMPLATES_DIR, 'icon.png');

const ADDRESS = 'Cognizone BV · Avenue Arnaud Fraiteur 15-23, 1050 Ixelles, Belgium · BE 0634.615.174';

// H2-level section numbers are a chapter label ("CHAPTER 01", like the reference's
// "ITEM 01"); deeper ones stay "1.1". Merged master-TOC document entries pass a
// ready-made "DOCUMENT 01" label through unchanged.
function displayNumber(number, level) {
  return level === 2 && /^\d+$/.test(number) ? `CHAPTER ${number.padStart(2, '0')}` : number;
}

// ── TOC HTML ──────────────────────────────────────────────────────────────────
function buildToc(entries) {
  if (!entries.length) return '<nav id="TOC"></nav>';

  const lines = ['<nav id="TOC">'];
  const stack = [];
  let prev = 0;

  for (const h of entries) {
    if (prev === 0) {
      lines.push('<ul>');
      stack.push(h.level);
    } else if (h.level > prev) {
      lines.push('<ul>');
      stack.push(h.level);
    } else if (h.level === prev) {
      lines.push('</li>');
    } else {
      while (stack.length && stack[stack.length - 1] > h.level) {
        lines.push('</li></ul>');
        stack.pop();
      }
      lines.push('</li>');
    }
    lines.push(`<li><a href="#${h.id}"><span class="toc-section-number">${displayNumber(h.number, h.level)}</span><span class="toc-title">${escapeText(h.text)}</span><span class="toc-page"></span></a>`);
    prev = h.level;
  }

  while (stack.length) { lines.push('</li></ul>'); stack.pop(); }
  lines.push('</nav>');
  return lines.join('\n');
}

// ── Body renderer (section-numbered headings, mermaid, escaped code) ─────────
function useRenderer(entries) {
  let headingRenderIdx = 0;

  // In marked v13, renderer overrides are post-processors: the function
  // receives already-rendered inner HTML. walkTokens runs in the same order
  // as rendering, so we correlate by index.
  marked.use({
    renderer: {
      heading(innerHtml) {
        const entry = entries[headingRenderIdx++];
        if (!entry) return `<h2>${innerHtml}</h2>\n`;
        const num = displayNumber(entry.number, entry.level);
        return `<h${entry.level} id="${entry.id}"><span class="header-section-number">${num}</span> ${innerHtml}</h${entry.level}>\n`;
      },
      code(text, lang) {
        if (parseMermaidOpts(lang || '').isMermaid) {
          return mermaidWrapHtml(text, lang);
        }
        // Default code block rendering
        const langClass = lang ? ` class="language-${lang}"` : '';
        return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>\n`;
      },
    },
  });
}

// ── Cover page ───────────────────────────────────────────────────────────────
function lockupHtml() {
  const iconUrl = pathToFileURL(ICON_PATH).href;
  return `<div class="cover-lockup"><img src="${iconUrl}" alt=""><span>Cognizone</span></div>`;
}

function coverBottomHtml(date, classification) {
  const dateLine = [date, classification].filter(Boolean).map(escapeText).join(' · ');
  return `<div class="cover-bottom">
      <p class="cover-address">${escapeText(ADDRESS)}</p>
      ${dateLine ? `<p class="cover-dateline">${dateLine}</p>` : ''}
    </div>`;
}

// `attrs` lets the merged renderer turn a cover into a page-break anchor.
function buildCoverHtml(doc, attrs = '') {
  const { title, subtitle, summary, id, type, status, version, date, author, client, project, classification } = doc;
  const eyebrow = ['Cognizone', type || id].filter(Boolean).join(' / ');
  const metaRows = [
    ['ID',      id],
    ['Type',    type],
    ['Status',  status],
    ['Version', version],
    ['Date',    date],
    ['Author',  author],
    ['Client',  client],
    ['Project', project],
  ].filter(([, v]) => v)
   .map(([l, v]) => `<tr><td class="meta-label">${l}</td><td>${escapeText(v)}</td></tr>`)
   .join('\n      ');

  return `<div class="cover-page${attrs ? ' page-break' : ''}"${attrs}>
    ${lockupHtml()}
    <p class="cover-eyebrow">${escapeText(eyebrow)}</p>
    <div class="cover-title-block">
      <h1 class="cover-title">${escapeText(title)}</h1>
      ${subtitle ? `<p class="cover-subtitle">${escapeText(subtitle)}</p>` : ''}
    </div>
    ${summary ? `<p class="cover-summary">${escapeText(summary)}</p>` : ''}
    ${metaRows ? `<table class="cover-meta-table">
      ${metaRows}
    </table>` : ''}
    ${coverBottomHtml(date, classification)}
  </div>`;
}

function tocPageHtml(entries) {
  return `<div class="document-body toc-page">
    <p class="toc-label">CONTENTS</p>
    ${buildToc(entries)}
  </div>`;
}

function footerText(doc) {
  return [doc.classification, doc.client, doc.project].filter(Boolean).join(' · ');
}

function printPdf(html, outputFile, headerTitle, footer, tmpName) {
  const tmpHtml = path.join(os.tmpdir(), `${tmpName}-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  // Resolve mermaid browser bundle path for Puppeteer injection
  const mermaidJsPath = require.resolve('mermaid/dist/mermaid.min.js');

  try {
    execFileSync('node', [
      path.join(TEMPLATES_DIR, 'pdf-print.js'),
      tmpHtml, outputFile, headerTitle, footer, ICON_PATH, mermaidJsPath,
    ], { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
  }
}

function renderPdf(parsed, outputFile) {
  const { title, headerTitle, inputDir, tocEntries, mdNoH1 } = parsed;

  // ── Render body HTML with section numbers ──────────────────────────────────
  useRenderer(tocEntries);
  const bodyHtml = marked(mdNoH1);

  // ── Assemble HTML ──────────────────────────────────────────────────────────
  const cssUrl = pathToFileURL(CSS_PATH).href;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeText(title)}</title>
  <base href="${pathToFileURL(inputDir + '/').href}">
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body>

  ${buildCoverHtml(parsed)}

  <div class="page-break"></div>

  ${tocPageHtml(tocEntries)}

  <div class="page-break"></div>

  <div class="document-body">
    ${bodyHtml}
  </div>

</body>
</html>`;

  // ── Render PDF ─────────────────────────────────────────────────────────────
  printPdf(html, outputFile, headerTitle, footerText(parsed), 'cognizone');
}

// ── Merged PDF (folder input) ────────────────────────────────────────────────

function resolveImagePaths(html, inputDir) {
  return html.replace(
    /(<img\s[^>]*src=")(?!data:|https?:|file:)([^"]+)(")/gi,
    (_m, pre, src, post) => {
      const abs = pathToFileURL(path.resolve(inputDir, src)).href;
      return pre + abs + post;
    },
  );
}

function renderMergedPdf(parsedDocs, folderPath, outputFile) {
  const folderName = path.basename(folderPath);

  // ── Build master TOC entries ───────────────────────────────────────────────
  const masterTocEntries = [];
  parsedDocs.forEach((doc, i) => {
    masterTocEntries.push({
      level: 2,
      text: doc.title,
      id: `doc-${i}`,
      number: `DOCUMENT ${String(i + 1).padStart(2, '0')}`,
    });
    for (const e of doc.tocEntries) {
      masterTocEntries.push({
        level: e.level + 1,   // nest under the document title entry
        text: e.text,
        id: `doc-${i}-${e.id}`,
        number: `${i + 1}.${e.number}`,
      });
    }
  });

  // ── Render each document's body HTML ───────────────────────────────────────
  // We need one flat tocEntries array to correlate with the heading renderer.
  // The heading renderer uses a global index, so we render documents in order.
  const allPrefixedEntries = [];
  parsedDocs.forEach((doc, i) => {
    for (const e of doc.tocEntries) {
      allPrefixedEntries.push({
        level: e.level,
        text: e.text,
        id: `doc-${i}-${e.id}`,
        number: e.number,
      });
    }
  });

  useRenderer(allPrefixedEntries);

  // Each document cover carries the page break itself (and the TOC anchor):
  // a separate break marker before a cover on its own named page would leave
  // a blank page behind.
  const docSections = parsedDocs.map((doc, i) => {
    const bodyHtml = resolveImagePaths(marked(doc.mdNoH1), doc.inputDir);
    const cover = resolveImagePaths(buildCoverHtml(doc, ` id="doc-${i}"`), doc.inputDir);
    return `
  ${cover}
  <div class="page-break"></div>
  <div class="document-body">
    ${bodyHtml}
  </div>`;
  }).join('\n');

  // ── Master cover page ────────────────────────────────────────────────────
  const docListRows = parsedDocs.map((doc, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `<tr><td class="meta-label">${num}</td><td>${doc.id ? `${escapeText(doc.id)} — ` : ''}${escapeText(doc.title)}</td></tr>`;
  }).join('\n      ');

  const masterCover = `<div class="cover-page">
    ${lockupHtml()}
    <p class="cover-eyebrow">COGNIZONE</p>
    <div class="cover-title-block">
      <h1 class="cover-title">${escapeText(folderName)}</h1>
    </div>
    <table class="cover-meta-table cover-doc-list">
      ${docListRows}
    </table>
    ${coverBottomHtml('', '')}
  </div>`;

  // ── Assemble full HTML ───────────────────────────────────────────────────
  const cssUrl = pathToFileURL(CSS_PATH).href;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeText(folderName)}</title>
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body>

  ${masterCover}

  <div class="page-break"></div>

  ${tocPageHtml(masterTocEntries)}

  ${docSections}

</body>
</html>`;

  // ── Render PDF ─────────────────────────────────────────────────────────────
  // Merged output spans documents that may belong to different clients/projects,
  // so the footer carries no per-document text (as classic).
  printPdf(html, outputFile, folderName, '', 'cognizone-merged');
}

module.exports = { renderPdf, renderMergedPdf, escapeHtml };
