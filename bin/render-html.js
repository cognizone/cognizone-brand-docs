'use strict';
// Markdown → self-contained branded HTML.
// No Puppeteer, no external binaries. Fonts and logo are embedded as base64.
// Mermaid diagrams render client-side in the browser.

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { parseMermaidOpts } = require('./mermaid-opts');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// ── Asset embedding ──────────────────────────────────────────────────────────

function b64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.ttf': 'font/truetype',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }[ext] || 'application/octet-stream';
}

function dataUri(filePath) {
  return `data:${mimeType(filePath)};base64,${b64(filePath)}`;
}

// Embed fonts as base64 @font-face declarations so the HTML is self-contained.
function buildFontsCss() {
  const fontsDir = path.join(TEMPLATES_DIR, 'fonts');
  const entries = [
    { file: 'Roboto[wdth,wght].ttf',        family: 'Roboto',      weight: '100 900', style: 'normal' },
    { file: 'Roboto-Italic[wdth,wght].ttf', family: 'Roboto',      weight: '100 900', style: 'italic' },
    { file: 'RobotoMono[wght].ttf',          family: 'Roboto Mono', weight: '100 900', style: 'normal' },
    { file: 'RobotoMono-Italic[wght].ttf',   family: 'Roboto Mono', weight: '100 900', style: 'italic' },
  ];
  return entries
    .filter(e => fs.existsSync(path.join(fontsDir, e.file)))
    .map(e => {
      const uri = dataUri(path.join(fontsDir, e.file));
      return `@font-face{font-family:'${e.family}';src:url('${uri}') format('truetype');font-weight:${e.weight};font-style:${e.style};}`;
    })
    .join('\n');
}

// Resolve an image path from the markdown source to an absolute file URI or
// embedded data URI. Relative paths are resolved against the document's dir.
function resolveImageSrc(src, inputDir) {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src;
  const absPath = path.resolve(inputDir, src);
  if (!fs.existsSync(absPath)) return src;
  return dataUri(absPath);
}

// Raw HTML <img> tags in the markdown pass through marked untouched — embed
// their relative src paths as data URIs too.
function embedRawImages(html, inputDir) {
  return html.replace(
    /(<img\s[^>]*src=")(?!data:|https?:|file:)([^"]+)(")/gi,
    (_m, pre, src, post) => pre + resolveImageSrc(src, inputDir) + post,
  );
}

// ── HTML assembly helpers ─────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function coverPageHtml(doc) {
  const { id, title, type, status, version, date, author, client, project } = doc;
  const logoUri = dataUri(path.join(TEMPLATES_DIR, 'logo.png'));

  const rows = [
    ['Type', type],
    ['Status', status],
    ['Version', version],
    ['Date', date],
    ['Author', author],
    ['Client', client],
    ['Project', project],
  ].filter(([, v]) => v);

  const metaTable = rows.length
    ? `<table class="cover-meta-table"><tbody>${rows.map(([k, v]) =>
        `<tr><td class="meta-label">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`
      ).join('')}</tbody></table>`
    : '';

  return `
<div class="cover-page">
  <div class="cover-logo-block">
    <img class="cover-logo" src="${logoUri}" alt="Cognizone">
  </div>
  <div class="cover-contact">
    <a href="mailto:info@cogni.zone">info@cogni.zone</a>
    <a href="https://cogni.zone">cogni.zone</a>
  </div>
  ${id ? `<div class="cover-id">${escapeHtml(id)}</div>` : ''}
  <div class="cover-title">${escapeHtml(title)}</div>
  ${metaTable}
</div>`;
}

function tocHtml(tocEntries, idPrefix = '') {
  if (!tocEntries.length) return '';

  // Build nested list from flat entries (H2 → H4)
  const lines = ['<nav id="TOC"><h2>Contents</h2><ul>'];
  let prevLevel = 2;

  for (const entry of tocEntries) {
    const level = Math.max(2, Math.min(entry.level, 4));
    if (level > prevLevel) {
      for (let i = prevLevel; i < level; i++) lines.push('<ul>');
    } else if (level < prevLevel) {
      for (let i = level; i < prevLevel; i++) lines.push('</ul></li>');
    } else if (prevLevel !== 2 || lines.length > 2) {
      lines.push('</li>');
    }
    const anchor = `${idPrefix}${entry.id}`;
    const prefix = entry.number ? `${entry.number} ` : '';
    lines.push(`<li><a href="#${anchor}"><span class="toc-num">${escapeHtml(prefix)}</span><span class="toc-title">${escapeHtml(entry.text)}</span></a>`);
    prevLevel = level;
  }

  // Close open tags
  for (let i = 2; i < prevLevel; i++) lines.push('</li></ul>');
  lines.push('</li></ul></nav>');
  return lines.join('\n');
}

function bodyHtml(parsed, idPrefix = '') {
  const { tokens, inputDir } = parsed;
  let headingIdx = 0;
  const headingMeta = [];
  function collectHeadings(list) {
    for (const t of list) {
      if (t.type === 'heading') headingMeta.push({ number: t._number, id: t._id });
      if (t.tokens) collectHeadings(t.tokens);
      if (t.items) t.items.forEach(i => i.tokens && collectHeadings(i.tokens));
    }
  }
  collectHeadings(tokens);

  const renderer = {
    heading(text, depth) {
      const meta = headingMeta[headingIdx++] || {};
      const { number, id } = meta;
      const prefix = number ? `<span class="section-num">${number}&nbsp;</span>` : '';
      const fullId = `${idPrefix}${id || ''}`;
      return `<h${depth} id="${fullId}">${prefix}${text}</h${depth}>\n`;
    },

    code(code, lang) {
      const opts = parseMermaidOpts(lang);
      if (opts.isMermaid) {
        const style = [
          opts.maxWidth !== 500 ? `max-width:${opts.maxWidth}px` : '',
          opts.align === 'left' ? 'margin-left:0;margin-right:auto' :
          opts.align === 'right' ? 'margin-left:auto;margin-right:0' : 'margin:0 auto',
        ].filter(Boolean).join(';');
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre class="mermaid" style="${style}">${escaped}</pre>\n`;
      }
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cls = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${cls}>${escaped}</code></pre>\n`;
    },

    image(href, title, text) {
      // marked v13 passes href raw — escape everything to keep a crafted
      // destination like x.png"onerror=... from breaking out of the attribute
      const src = escapeHtml(resolveImageSrc(href, inputDir));
      const alt = text ? ` alt="${escapeHtml(text)}"` : '';
      const ttl = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${src}"${alt}${ttl}>`;
    },
  };

  marked.use({ renderer });
  return embedRawImages(marked.parser(tokens), inputDir);
}

// ── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
:root {
  --green:          #058775;
  --dark:           #353744;
  --dark2:          #272727;
  --gray:           #666666;
  --light-green-bg: #E8F5F3;
  --mono-green:     #188038;
  --white:          #ffffff;
  --border:         #BFBFBF;
  --meta-label-bg:  #EAF0F8;
  --link-blue:      #0563C1;
}

*, *::before, *::after { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  font-family: 'Roboto', sans-serif;
  font-size: 10pt;
  color: var(--dark);
  line-height: 1.5;
  margin: 0;
  padding: 0;
  background: #f4f4f4;
}

/* ── Layout ─────────────────────────────────────────────────────────────────*/

.doc-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #fff;
  border-bottom: 2px solid var(--green);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 32px;
  gap: 16px;
}

.doc-header img {
  height: 28px;
  width: auto;
}

.doc-header .header-title {
  font-size: 9pt;
  color: var(--gray);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-footer {
  background: #fff;
  border-top: 2px solid var(--green);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 32px;
  font-size: 9pt;
  color: var(--gray);
  margin-top: 48px;
}

.page-content {
  max-width: 820px;
  margin: 0 auto;
  background: #fff;
  padding: 32px 48px 48px;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
  min-height: calc(100vh - 120px);
}

/* ── Cover page ─────────────────────────────────────────────────────────────*/

.cover-page {
  padding-top: 24px;
  margin-bottom: 48px;
}

.cover-logo-block {
  margin-bottom: 24px;
}

.cover-logo {
  height: 36px;
  width: auto;
  max-width: 220px;
}

.cover-contact {
  display: flex;
  flex-direction: column;
  gap: 2pt;
  margin-bottom: 32px;
  align-items: flex-end;
  text-align: right;
}

.cover-contact a {
  font-size: 9pt;
  color: var(--link-blue);
  text-decoration: none;
}

.cover-id {
  font-size: 13pt;
  font-weight: 700;
  color: var(--green);
  letter-spacing: 0.05em;
  margin: 0 0 8px 0;
}

.cover-title {
  font-size: 22pt;
  font-weight: 700;
  color: var(--dark);
  margin: 0 0 24px 0;
  line-height: 1.2;
}

.cover-meta-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10pt;
}

.cover-meta-table td {
  padding: 6pt 10pt;
  border: 1px solid var(--border);
  vertical-align: top;
}

.cover-meta-table .meta-label {
  font-weight: 700;
  background-color: var(--meta-label-bg);
  width: 30%;
}

/* ── TOC ────────────────────────────────────────────────────────────────────*/

#TOC {
  font-size: 10pt;
  margin-bottom: 48px;
  padding-top: 8px;
}

#TOC h2 {
  font-size: 13pt;
  font-weight: 700;
  color: var(--dark);
  margin-top: 0;
  padding-bottom: 3pt;
  border-bottom: 0.25px solid var(--dark);
}

#TOC ul {
  list-style: none;
  padding-left: 0;
  margin: 0;
}

#TOC > ul > li {
  margin-bottom: 6pt;
}

#TOC ul ul {
  padding-left: 16pt;
  margin-top: 2pt;
}

#TOC ul ul li {
  margin-bottom: 2pt;
}

#TOC a {
  display: flex;
  align-items: baseline;
  text-decoration: none;
  color: var(--dark);
  gap: 6px;
}

#TOC > ul > li > a {
  font-weight: 700;
}

#TOC ul ul a {
  font-weight: 400;
  color: var(--gray);
}

#TOC a:hover {
  color: var(--green);
}

.toc-num {
  flex-shrink: 0;
  color: var(--gray);
  font-size: 9pt;
}

.toc-title {
  flex: 1;
}

/* ── Headings ───────────────────────────────────────────────────────────────*/

h1, h2, h3, h4, h5, h6 {
  margin-top: 1.4em;
  margin-bottom: 0.4em;
}

h2 {
  font-size: 13pt;
  font-weight: 700;
  color: var(--dark);
  padding-bottom: 3pt;
  border-bottom: 0.25px solid var(--dark);
}

h3 {
  font-size: 12pt;
  font-weight: 700;
  color: var(--green);
}

h4 {
  font-size: 11pt;
  font-weight: 700;
  color: var(--dark2);
}

.section-num {
  color: var(--gray);
  font-weight: inherit;
}

/* ── Body text ──────────────────────────────────────────────────────────────*/

p { margin-top: 0; margin-bottom: 8pt; }

a { color: var(--green); text-decoration: none; }
a:hover { text-decoration: underline; }

hr { border: none; border-top: 1px solid var(--border); margin: 12pt 0; }

strong { font-weight: 700; }
em { font-style: italic; }

/* ── Code ───────────────────────────────────────────────────────────────────*/

code {
  font-family: 'Roboto Mono', monospace;
  font-size: 9pt;
  color: var(--mono-green);
  background-color: #f5f5f5;
  padding: 1px 4px;
  border-radius: 2px;
}

pre {
  background-color: #f5f5f5;
  border-left: 3px solid var(--green);
  padding: 10pt 12pt;
  margin: 8pt 0;
  overflow-x: auto;
}

pre code {
  font-family: 'Roboto Mono', monospace;
  font-size: 8.5pt;
  color: var(--mono-green);
  background: none;
  padding: 0;
  border-radius: 0;
}

pre.mermaid {
  background: none;
  border-left: none;
  padding: 16pt 0;
  text-align: center;
  display: flex;
  justify-content: center;
}

pre.mermaid svg {
  max-width: 100%;
  height: auto;
}

/* ── Blockquote ─────────────────────────────────────────────────────────────*/

blockquote {
  margin: 8pt 0;
  padding: 6pt 12pt;
  border-left: 4px solid var(--green);
  font-style: italic;
  color: #444;
  background: none;
}

blockquote p { margin-bottom: 0; }

/* ── Tables ─────────────────────────────────────────────────────────────────*/

table {
  width: 100%;
  border-collapse: collapse;
  margin: 10pt 0;
  font-size: 9.5pt;
}

thead tr { background-color: var(--green); color: var(--white); }

thead th {
  font-weight: 700;
  padding: 6pt 8pt;
  border: 1px solid var(--border);
  text-align: left;
}

tbody tr:nth-child(even) { background-color: var(--light-green-bg); }
tbody tr:nth-child(odd)  { background-color: var(--white); }

tbody td {
  padding: 5pt 8pt;
  border: 1px solid var(--border);
  vertical-align: top;
}

/* ── Lists ──────────────────────────────────────────────────────────────────*/

ul, ol { margin: 4pt 0 8pt 0; padding-left: 20pt; }
li { margin-bottom: 3pt; line-height: 1.5; }

/* ── Images ─────────────────────────────────────────────────────────────────*/

img { max-width: 100%; height: auto; }

/* ── Merged doc dividers ────────────────────────────────────────────────────*/

.doc-section { border-top: 3px solid var(--green); padding-top: 32px; margin-top: 48px; }
.doc-section:first-child { border-top: none; padding-top: 0; margin-top: 0; }

/* ── Merged cover table ─────────────────────────────────────────────────────*/

.master-cover-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 24px;
  font-size: 9.5pt;
}

.master-cover-table th {
  background: var(--green);
  color: #fff;
  font-weight: 700;
  padding: 6pt 8pt;
  border: 1px solid var(--border);
  text-align: left;
}

.master-cover-table td {
  padding: 5pt 8pt;
  border: 1px solid var(--border);
  vertical-align: top;
}

.master-cover-table tr:nth-child(even) td { background: var(--light-green-bg); }

@media (max-width: 860px) {
  .page-content { padding: 20px 16px 32px; }
  .doc-header   { padding: 6px 16px; }
  .doc-footer   { padding: 8px 16px; }
}

@media print {
  body { background: #fff; }
  .doc-header { position: static; }
  .page-content { box-shadow: none; padding: 0; max-width: none; }
}
`;

// ── Mermaid script ───────────────────────────────────────────────────────────

// Inline the mermaid UMD bundle so diagrams render offline — the HTML stays
// fully self-contained. Only included when the document has mermaid blocks.
function mermaidScript() {
  const bundle = fs.readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8');
  return `
<script>${bundle}</script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
  mermaid.run({ querySelector: '.mermaid' });
</script>`;
}

// ── Page template ────────────────────────────────────────────────────────────

function htmlPage({ title, headerTitle, footerTitle, fontsCss, bodyContent, hasMermaid }) {
  const logoUri = dataUri(path.join(TEMPLATES_DIR, 'logo.png'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${fontsCss}
${STYLES}
</style>
</head>
<body>
<header class="doc-header">
  <img src="${logoUri}" alt="Cognizone">
  <span class="header-title">${escapeHtml(headerTitle)}</span>
</header>
<div class="page-content">
${bodyContent}
</div>
<footer class="doc-footer">
  <span>${escapeHtml(footerTitle)}</span>
</footer>
${hasMermaid ? mermaidScript() : ''}
</body>
</html>`;
}

// ── Single-file render ────────────────────────────────────────────────────────

function renderHtml(parsed, outputFile) {
  const fontsCss = buildFontsCss();
  const hasMermaid = parsed.mdNoH1.includes('```mermaid');

  const cover = coverPageHtml(parsed);
  const toc = tocHtml(parsed.tocEntries);
  const body = bodyHtml(parsed);

  const bodyContent = [cover, toc, `<div class="body-content">${body}</div>`].join('\n');

  const html = htmlPage({
    title: parsed.title,
    headerTitle: parsed.headerTitle,
    footerTitle: parsed.footerTitle,
    fontsCss,
    bodyContent,
    hasMermaid,
  });

  fs.writeFileSync(outputFile, html, 'utf8');
}

// ── Folder-merge render ───────────────────────────────────────────────────────

function renderMergedHtml(parsedDocs, inputDir, outputFile) {
  const fontsCss = buildFontsCss();
  const folderName = path.basename(inputDir);
  const hasMermaid = parsedDocs.some(d => d.mdNoH1.includes('```mermaid'));
  const logoUri = dataUri(path.join(TEMPLATES_DIR, 'logo.png'));

  // Master cover
  const masterCoverRows = parsedDocs.map((d, i) =>
    `<tr><td>${i + 1}</td><td>${escapeHtml(d.id)}</td><td>${escapeHtml(d.title)}</td></tr>`
  ).join('');

  const masterCover = `
<div class="cover-page">
  <div class="cover-logo-block"><img class="cover-logo" src="${logoUri}" alt="Cognizone"></div>
  <div class="cover-contact">
    <a href="mailto:info@cogni.zone">info@cogni.zone</a>
    <a href="https://cogni.zone">cogni.zone</a>
  </div>
  <div class="cover-title">${escapeHtml(folderName)}</div>
  <table class="master-cover-table">
    <thead><tr><th>#</th><th>ID</th><th>Title</th></tr></thead>
    <tbody>${masterCoverRows}</tbody>
  </table>
</div>`;

  // Master TOC: each document is a top-level H2 entry; its headings are nested below
  const allTocEntries = [];
  parsedDocs.forEach((d, i) => {
    const docPrefix = `doc-${i}-`;
    allTocEntries.push({ level: 2, text: d.title, id: `${docPrefix}cover`, number: String(i + 1) });
    d.tocEntries.forEach(e => allTocEntries.push({ ...e, level: Math.min(e.level + 1, 4), id: `${docPrefix}${e.id}` }));
  });

  const masterToc = tocHtml(allTocEntries);

  // Per-document sections
  const docSections = parsedDocs.map((d, i) => {
    const docPrefix = `doc-${i}-`;
    const docCover = `
<div class="cover-page" id="${docPrefix}cover">
  ${d.id ? `<div class="cover-id">${escapeHtml(d.id)}</div>` : ''}
  <div class="cover-title">${escapeHtml(d.title)}</div>
</div>`;
    const docToc = tocHtml(d.tocEntries, docPrefix);
    const docBody = bodyHtml(d, docPrefix);
    return `<div class="doc-section">${docCover}${docToc}<div class="body-content">${docBody}</div></div>`;
  }).join('\n');

  const bodyContent = [masterCover, masterToc, docSections].join('\n');

  const firstDoc = parsedDocs[0] || {};
  const footerTitle = firstDoc.footerTitle || '';

  const html = htmlPage({
    title: folderName,
    headerTitle: folderName,
    footerTitle,
    fontsCss,
    bodyContent,
    hasMermaid,
  });

  fs.writeFileSync(outputFile, html, 'utf8');
}

module.exports = { renderHtml, renderMergedHtml };
