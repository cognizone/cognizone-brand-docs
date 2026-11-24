'use strict';
// PDF renderer: takes parsed markdown data, produces a branded PDF via Puppeteer.
// See reference/brand-2026-spec.md for the styling rules.

const { marked } = require('marked');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { parseMermaidOpts } = require('./mermaid-opts');
const { tagRe, replaceAttr } = require('./parse');

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
  return `<div class="mermaid-wrap" style="max-width:${opts.maxWidth}px;margin:${marginCss};"><pre class="mermaid">${escapeHtml(text)}</pre></div>\n`;
}

// Markdown may carry raw HTML. The page Chrome prints from therefore runs no
// script (no element carries the nonce: pdf-print.js evaluates mermaid through
// DevTools, which CSP does not govern) and loads no frames or plugins.
function cspMeta() {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'; object-src 'none'; frame-src 'none'">`;
}

// A well-formed nested list whatever the heading levels: a skipped level
// (H2 → H4) or a deep start (H3 before any H2) opens a list for it instead of
// emitting a stray </li>.
function nestedList(entries, itemHtml) {
  const lines = [];
  const stack = [];   // levels of the open <ul>s; each holds one open <li>
  for (const e of entries) {
    while (stack.length && stack[stack.length - 1] > e.level) {
      lines.push('</li></ul>');
      stack.pop();
    }
    if (stack.length && stack[stack.length - 1] === e.level) {
      lines.push('</li>');
    } else {
      lines.push('<ul>');
      stack.push(e.level);
    }
    lines.push(itemHtml(e));
  }
  while (stack.length) { lines.push('</li></ul>'); stack.pop(); }
  return lines;
}

const SCRIPT_DIR    = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(SCRIPT_DIR, 'templates');
const CSS_PATH      = path.join(TEMPLATES_DIR, 'styles.css');
const ICON_PATH     = path.join(TEMPLATES_DIR, 'icon.png');

const ADDRESS = 'Cognizone BV · Avenue Arnaud Fraiteur 15-23, 1050 Ixelles, Belgium · BE 0634.615.174';

// H2-level section numbers are a chapter label ("CHAPTER 01", like the reference's
// "ITEM 01"); deeper ones stay "1.1". Merged master-TOC document entries pass a
// ready-made "DOCUMENT 01" label through unchanged.
// Section numbers are digits and dots only, so the markup is safe. Roboto Mono gives
// the dot a full digit-wide cell; .num-dot pulls it in so `1.1` does not read as `1 . 1`
function displayNumber(number, level) {
  if (level === 2 && /^\d+$/.test(number)) return `CHAPTER ${number.padStart(2, '0')}`;
  return number.replace(/\./g, '<span class="num-dot">.</span>');
}

// ── TOC HTML ──────────────────────────────────────────────────────────────────
function buildToc(entries) {
  if (!entries.length) return '<nav id="TOC"></nav>';

  return ['<nav id="TOC">',
    ...nestedList(entries, h => `<li><a href="#${h.id}"><span class="toc-section-number">${displayNumber(h.number, h.level)}</span><span class="toc-title">${escapeText(h.text)}</span><span class="toc-page"></span></a>`),
    '</nav>'].join('\n');
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
        // Default code block rendering: the class takes the info string's first word only
        const word = (lang || '').match(/^\S*/)[0];
        const langClass = word ? ` class="language-${escapeText(word)}"` : '';
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

// The page goes in a fresh private folder (unpredictable name, no collision between two
// runs); nothing depends on where it is: links, images and CSS are absolute or <base href>
function printPdf(html, outputFile, headerTitle, footer, tmpName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cognizone-'));
  const tmpHtml = path.join(tmpDir, `${tmpName}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  // Resolve mermaid browser bundle path for Puppeteer injection
  const mermaidJsPath = require.resolve('mermaid/dist/mermaid.min.js');

  try {
    execFileSync(process.execPath, [
      path.join(TEMPLATES_DIR, 'pdf-print.js'),
      tmpHtml, outputFile, headerTitle, footer, ICON_PATH, mermaidJsPath,
    ], { stdio: 'inherit' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function renderPdf(parsed, outputFile) {
  const { title, headerTitle, inputDir, tocEntries, tokens } = parsed;

  // ── Render body HTML with section numbers ──────────────────────────────────
  useRenderer(tocEntries);
  // render parse.js's tokens, not the raw Markdown: link rewriting happens there
  const bodyHtml = marked.parser(tokens);

  // ── Assemble HTML ──────────────────────────────────────────────────────────
  const cssUrl = pathToFileURL(CSS_PATH).href;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  ${cspMeta()}
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

// The src is URL-encoded (marked turns `<pic one.png>` into pic%20one.png) and
// may be entity-escaped: decode both, so pathToFileURL encodes exactly once. The src may
// be double-quoted, single-quoted or unquoted, with spaces around "="; "data-src" is not it.
function resolveImagePaths(html, inputDir) {
  return html.replace(tagRe('img'), tag => replaceAttr(tag, 'src', src => {
    if (!src || /^(data:|https?:|file:)/i.test(src)) return undefined;
    let file = src.replace(/&amp;/g, '&');
    try { file = decodeURIComponent(file); } catch { /* not URL-encoded */ }
    return pathToFileURL(path.resolve(inputDir, file)).href.replace(/&/g, '&amp;');
  }));
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
    const bodyHtml = resolveImagePaths(marked.parser(doc.tokens), doc.inputDir);
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
  ${cspMeta()}
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
  // so the footer carries no per-document text.
  printPdf(html, outputFile, folderName, '', 'cognizone-merged');
}

module.exports = { renderPdf, renderMergedPdf, escapeHtml };
