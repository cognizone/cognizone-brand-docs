'use strict';
// Markdown → self-contained branded HTML, 2026 brand.
// No Puppeteer, no external binaries. Fonts and logo are embedded as base64.
// Mermaid diagrams render client-side in the browser.
// Deliberately a full copy of render-html.js (the classic brand is frozen and
// will be removed) — see reference/brand-2026-spec.md for the styling rules.

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { parseMermaidOpts } = require('./mermaid-opts');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const ICON_PATH = path.join(TEMPLATES_DIR, '2026', 'icon.png');

const ADDRESS = 'Cognizone BV \u00B7 Avenue Arnaud Fraiteur 15-23, 1050 Ixelles, Belgium \u00B7 BE 0634.615.174';

// ── Asset embedding ──────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// Extensions we will base64-embed as images. Restricting to these prevents a
// crafted markdown reference like ![x](../../.ssh/id_rsa) from smuggling
// arbitrary file bytes into the shareable HTML.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext];
}

// Cache encoded data URIs by absolute path so a shared image (logo, or an image
// referenced across N merged documents) is read and base64-encoded only once.
const dataUriCache = new Map();

function dataUri(filePath) {
  const key = path.resolve(filePath);
  if (dataUriCache.has(key)) return dataUriCache.get(key);
  const uri = `data:${mimeType(filePath)};base64,${fs.readFileSync(filePath).toString('base64')}`;
  dataUriCache.set(key, uri);
  return uri;
}

// Embed fonts as base64 @font-face declarations so the HTML is self-contained.
function buildFontsCss() {
  const fontsDir = path.join(TEMPLATES_DIR, 'fonts');
  const entries = [
    { file: 'Calistoga-Regular.ttf',         family: 'Calistoga',   weight: '400',     style: 'normal' },
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
  if (/^(https?:|data:|file:)/i.test(src)) return src;
  const absPath = path.resolve(inputDir, src);
  if (!fs.existsSync(absPath)) return src;
  // Only embed recognised image types. Anything else (e.g. a .txt or a key
  // file) is left as-is so we never inline arbitrary file bytes.
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    console.warn(`[html] skipping non-image reference (not embedded): ${src}`);
    return src;
  }
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

// H2-level section numbers are a chapter label ("CHAPTER 01", like the reference's
// "ITEM 01"); deeper ones stay "1.1". Merged master-TOC document entries pass a
// ready-made "DOCUMENT 01" label through unchanged.
// Section numbers are digits and dots only, so the markup is safe. Roboto Mono gives
// the dot a full digit-wide cell; .num-dot pulls it in so `1.1` does not read as `1 . 1`
function displayNumber(number, level) {
  if (level === 2 && /^\d+$/.test(number)) return `CHAPTER ${number.padStart(2, '0')}`;
  return number.replace(/\./g, '<span class="num-dot">.</span>');
}

function lockupHtml() {
  return `<div class="cover-lockup"><img src="${dataUri(ICON_PATH)}" alt=""><span>Cognizone</span></div>`;
}

function coverBottomHtml(date, classification) {
  const dateLine = [date, classification].filter(Boolean).map(escapeHtml).join(' · ');
  return `<div class="cover-bottom">
    <p class="cover-address">${escapeHtml(ADDRESS)}</p>
    ${dateLine ? `<p class="cover-dateline">${dateLine}</p>` : ''}
  </div>`;
}

function coverPageHtml(doc, attrs = '') {
  const { id, title, subtitle, summary, type, status, version, date, author, client, project, classification } = doc;
  const eyebrow = ['Cognizone', type || id].filter(Boolean).join(' / ');

  const rows = [
    ['ID', id],
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
<div class="cover-page"${attrs}>
  ${lockupHtml()}
  <div class="cover-eyebrow">${escapeHtml(eyebrow)}</div>
  <div class="cover-title-block">
    <div class="cover-title">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="cover-subtitle">${escapeHtml(subtitle)}</div>` : ''}
  </div>
  ${summary ? `<p class="cover-summary">${escapeHtml(summary)}</p>` : ''}
  ${metaTable}
  ${coverBottomHtml(date, classification)}
</div>`;
}

function tocHtml(tocEntries, idPrefix = '') {
  if (!tocEntries.length) return '';

  // Build nested list from flat entries (H2 → H4). Mirrors buildToc in
  // render-pdf.js: a stack tracks open nesting levels so every <li> and <ul>
  // is closed exactly once.
  const lines = ['<nav id="TOC"><div class="toc-label">CONTENTS</div>'];
  const stack = [];
  let prev = 0;

  for (const entry of tocEntries) {
    const level = Math.max(2, Math.min(entry.level, 4));
    if (prev === 0) {
      lines.push('<ul>');
      stack.push(level);
    } else if (level > prev) {
      lines.push('<ul>');
      stack.push(level);
    } else if (level === prev) {
      lines.push('</li>');
    } else {
      while (stack.length && stack[stack.length - 1] > level) {
        lines.push('</li></ul>');
        stack.pop();
      }
      lines.push('</li>');
    }
    const anchor = `${idPrefix}${entry.id}`;
    const num = entry.number ? displayNumber(entry.number, level) : '';
    lines.push(`<li><a href="#${anchor}"><span class="toc-num">${num}</span><span class="toc-title">${escapeHtml(entry.text)}</span></a>`);
    prev = level;
  }

  while (stack.length) { lines.push('</li></ul>'); stack.pop(); }
  lines.push('</nav>');
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
      const prefix = number ? `<span class="section-num">${displayNumber(number, depth)}</span> ` : '';
      const fullId = `${idPrefix}${id || ''}`;
      return `<h${depth} id="${fullId}">${prefix}${text}</h${depth}>\n`;
    },

    code(code, lang) {
      const opts = parseMermaidOpts(lang);
      if (opts.isMermaid) {
        const style = [
          `max-width:${opts.maxWidth}px`,
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
  --plum:      #2F2450;
  --ink:       #2B2340;
  --plum-soft: #4A3A78;
  --pink-deep: #C85A8A;
  --pink:      #E17B9E;
  --muted:     #6B6185;
  --blue:      #3D6BB8;
  --sand:      #F3EBDE;
  --cream:     #FBF6F1;
  --rule:      #E2D8CB;
  --white:     #FFFFFF;
}

*, *::before, *::after { box-sizing: border-box; }

html { scroll-behavior: smooth; scroll-padding-top: 56px; }

body {
  font-family: 'Roboto', sans-serif;
  font-size: 9.5pt;
  color: var(--ink);
  line-height: 1.2;
  margin: 0;
  padding: 0;
  background: var(--cream);
}

/* ── Layout ─────────────────────────────────────────────────────────────────*/

.doc-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--white);
  border-bottom: 0.5pt solid var(--rule);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 32px;
  gap: 16px;
}

.doc-header .header-brand {
  display: flex;
  align-items: center;
  gap: 6.4px;                     /* half the icon height, as the brand lockup */
  flex-shrink: 0;
  font-size: 8.5pt;
  font-weight: 700;
  color: var(--plum);
}

.doc-header .header-brand img {
  width: auto;
  height: 12.8px;                 /* icon is cropped to its nodes: same size as the old 16px square */
}

.doc-header .header-title {
  font-family: 'Roboto Mono', monospace;
  font-size: 7pt;
  color: var(--muted);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 32px 24px;
  font-family: 'Roboto Mono', monospace;
  font-size: 7pt;
  color: var(--muted);
}

.doc-footer .footer-brand {
  color: var(--plum);
}

.page-content {
  max-width: 820px;
  margin: 32px auto 0;
  background: var(--white);
  padding: 40px 56px 56px;
  box-shadow: 0 1px 4px rgba(47, 36, 80, .08);
  min-height: calc(100vh - 120px);
}

/* ── Cover page ─────────────────────────────────────────────────────────────*/

.cover-page {
  padding-top: 20pt;
  margin-bottom: 56px;
  padding-bottom: 32px;
  border-bottom: 0.5pt solid var(--rule);
}

.cover-lockup {
  display: flex;
  align-items: center;
  margin: 0 0 56pt 0;
  font-size: 20pt;
  font-weight: 700;
  color: var(--plum);
  line-height: 1;
}

.cover-lockup img {
  width: auto;
  height: 51.25px;                /* icon is cropped to its nodes: same size as the old 64px square */
  margin-right: 25.6px;           /* half the icon height, as the brand lockup */
}

.num-dot {
  margin: 0 -0.15em;              /* Roboto Mono's dot cell is digit-wide: pull it in */
}

.cover-eyebrow {
  font-family: 'Roboto Mono', monospace;
  font-size: 9pt;
  letter-spacing: 3pt;
  text-transform: uppercase;
  color: var(--pink-deep);
  margin: 0 0 12pt 0;
}

.cover-title-block {
  margin: 0 0 20pt 0;
}

.cover-title,
.cover-subtitle {
  font-family: 'Calistoga', serif;
  font-size: 32pt;
  font-weight: 400;
  line-height: 1.1;
  color: var(--plum);
}

.cover-subtitle {
  color: var(--pink-deep);
}

.cover-summary {
  font-size: 12pt;
  line-height: 1.33;
  color: var(--plum-soft);
  margin: 0 0 30pt 0;
}

.cover-meta-table {
  width: 60%;
  border-collapse: collapse;
  margin: 0;
  line-height: 1.2;
}

.cover-meta-table tbody tr:nth-child(n) {
  background-color: transparent;  /* no zebra on the cover table */
}

.cover-meta-table td {
  padding: 3pt 6pt;
  border: none;
  border-top: 0.5pt solid var(--rule);
  border-bottom: 0.5pt solid var(--rule);
  vertical-align: top;
  font-size: 9.5pt;
  color: var(--ink);
}

.cover-meta-table .meta-label {
  width: 32%;
  background-color: var(--sand);
  font-family: 'Roboto Mono', monospace;
  font-size: 7.5pt;
  letter-spacing: 1pt;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
  vertical-align: middle;
}

.cover-bottom {
  margin-top: 48pt;
}

.cover-address {
  font-size: 8.5pt;
  color: var(--muted);
  margin: 0 0 3pt 0;
}

.cover-dateline {
  font-family: 'Roboto Mono', monospace;
  font-size: 8pt;
  color: var(--muted);
  margin: 0;
}

/* ── TOC ────────────────────────────────────────────────────────────────────*/

#TOC {
  margin-bottom: 48px;
  padding-top: 8px;
}

#TOC .toc-label {
  font-family: 'Roboto Mono', monospace;
  font-size: 8.5pt;
  font-weight: 700;
  letter-spacing: 3pt;
  color: var(--pink-deep);
  margin: 0 0 10pt 0;
}

#TOC ul {
  list-style: none;
  padding-left: 0;
  margin: 0;
}

#TOC li {
  margin: 0;
}

#TOC li::before {
  content: none;
}

#TOC a {
  display: flex;
  align-items: baseline;
  text-decoration: none;
}

#TOC a:hover .toc-title {
  color: var(--blue);
}

.toc-title {
  flex: 1;
  min-width: 0;
}

/* Top-level entries (H2): "CHAPTER 01" in a 26mm number column, ruled below */
#TOC > ul > li > a {
  padding-bottom: 3pt;
  border-bottom: 0.25pt solid var(--rule);
  margin-bottom: 7pt;
}

#TOC > ul > li > a .toc-num {
  flex: 0 0 26mm;
  font-family: 'Roboto Mono', monospace;
  font-size: 8pt;
  font-weight: 700;
  color: var(--pink-deep);
}

#TOC > ul > li > a .toc-title {
  font-size: 10.5pt;
  color: var(--plum);
}

/* Sub-entries (H3 and deeper): indented to the text column, no rule */
#TOC ul ul {
  padding-left: 26mm;
}

#TOC ul ul ul {
  padding-left: 9mm;
  margin-top: 3pt;
}

/* Same gap before the next chapter as after a chapter's rule */
#TOC > ul > li > ul {
  margin-bottom: 11pt;
}

#TOC ul ul li {
  margin-bottom: 3pt;
}

#TOC ul ul .toc-num {
  flex: 0 0 auto;
  min-width: 9mm;
  padding-right: 4pt;
  font-family: 'Roboto Mono', monospace;
  font-size: 7.5pt;
  color: var(--muted);
}

#TOC ul ul .toc-title {
  font-size: 9.5pt;
  color: var(--ink);
}

/* ── Headings ───────────────────────────────────────────────────────────────*/

h1, h2, h3, h4, h5, h6 {
  break-after: avoid;
  break-inside: avoid;
}

/* H2: mono eyebrow number ("01") above a Calistoga heading */
h2 {
  font-family: 'Calistoga', serif;
  font-size: 20pt;
  font-weight: 400;
  line-height: 1.15;
  color: var(--plum);
  margin: 24pt 0 12pt 0;
}

h2 .section-num {
  display: block;
  font-family: 'Roboto Mono', monospace;
  font-size: 8.5pt;
  font-weight: 700;
  letter-spacing: 1pt;
  line-height: 1.2;
  color: var(--pink-deep);
  margin-bottom: 2pt;
}

h3 {
  font-size: 12pt;
  font-weight: 700;
  color: var(--plum);
  margin: 14pt 0 12pt 0;
  padding-bottom: 3pt;
  border-bottom: 0.75pt solid var(--pink);
}

h3 .section-num {
  font-family: 'Roboto Mono', monospace;
  font-size: 10pt;
  font-weight: 400;
  color: var(--pink-deep);
  margin-right: 6pt;              /* + the title's space ≈ a 9pt gap */
}

h4, h5, h6 {
  font-size: 10.5pt;
  font-weight: 700;
  color: var(--plum-soft);
  margin: 10pt 0 4pt 0;
}

h4 .section-num,
h5 .section-num,
h6 .section-num {
  font-family: 'Roboto Mono', monospace;
  font-size: 9pt;
  font-weight: 400;
  color: var(--pink-deep);
  margin-right: 6pt;              /* + the title's space ≈ a 9pt gap */
}

/* ── Body text ──────────────────────────────────────────────────────────────*/

p { margin-top: 0; margin-bottom: 6pt; }

a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }

hr { border: none; border-top: 0.5pt solid var(--rule); margin: 10pt 0; }

strong { font-weight: 700; }
em { font-style: italic; }

/* ── Code ───────────────────────────────────────────────────────────────────*/

code {
  font-family: 'Roboto Mono', monospace;
  font-size: 8.5pt;
  color: var(--pink-deep);
  background-color: var(--sand);
  padding: 0.5pt 3pt;
  border-radius: 2px;
}

pre {
  background-color: var(--cream);
  border: 0.5pt solid var(--rule);
  border-left: 3pt solid var(--plum);
  padding: 6pt;
  margin: 6pt 0 8pt 0;
  overflow-x: auto;
}

pre code {
  font-family: 'Roboto Mono', monospace;
  font-size: 8pt;
  line-height: 1.35;
  color: var(--plum);
  background: none;
  padding: 0;
  border-radius: 0;
}

pre.mermaid {
  background: none;
  border: none;
  padding: 12pt 0;
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
  margin: 6pt 0 8pt 3mm;
  padding: 6pt 8pt;
  border-left: 3pt solid var(--pink-deep);
  background-color: var(--sand);
  font-style: italic;
  color: var(--plum-soft);
}

blockquote p,
blockquote li {
  color: var(--plum-soft);
  font-style: italic;
}

blockquote > :last-child { margin-bottom: 0; }

/* ── Tables ─────────────────────────────────────────────────────────────────*/

table {
  width: 100%;
  border-collapse: collapse;
  margin: 8pt 0 10pt 0;
  font-size: 8.5pt;
  line-height: 1.05;
}

thead tr { background-color: var(--plum); color: var(--white); }

thead th {
  font-weight: 700;
  padding: 3pt 4.5pt;
  border: none;
  border-bottom: 0.5pt solid var(--rule);
  text-align: left;
  vertical-align: bottom;
}

/* Honour column alignment from the markdown delimiter row (:---:, ---:) */
thead th[align="center"] { text-align: center; }
thead th[align="right"] { text-align: right; }

tbody tr:nth-child(odd)  { background-color: var(--white); }
tbody tr:nth-child(even) { background-color: var(--cream); }

tbody td {
  padding: 3pt 4.5pt;
  border: none;
  border-bottom: 0.5pt solid var(--rule);
  vertical-align: top;
}

/* ── Lists ──────────────────────────────────────────────────────────────────*/

/* 6.35mm indent per level, 4.2mm hanging; bullets/numbers in pink deep */
ul, ol { margin: 0 0 6pt 0; padding-left: 6.35mm; }
li { margin-bottom: 4pt; line-height: 1.2; }
li > ul, li > ol { margin-top: 4pt; margin-bottom: 0; }
li > p { margin-bottom: 4pt; }

ul { list-style: none; }
ul > li { position: relative; }
ul > li::before {
  content: '•';
  position: absolute;
  left: -4.2mm;
  color: var(--pink-deep);
  font-style: normal;
  /* Roboto's • is 0.21 em across, barely bigger than a full stop: 1.6×. The line height
     drops its centre (0.37 em up) onto the text's x-height middle (0.26 em up) */
  font-size: 1.6em;
  line-height: 0.9;
}
:is(ul, ol) ul > li::before { content: '◦'; font-size: 1em; line-height: 1.2; }
:is(ul, ol) :is(ul, ol) ul > li::before { content: '–'; font-size: 1em; line-height: 1.2; }

ol { list-style-type: decimal; }
:is(ul, ol) ol { list-style-type: lower-alpha; }
:is(ul, ol) :is(ul, ol) ol { list-style-type: lower-roman; }
ol > li { padding-left: 1mm; }
ol > li::marker { color: var(--pink-deep); font-style: normal; }

/* ── Images ─────────────────────────────────────────────────────────────────*/

img { max-width: 100%; height: auto; }

/* ── Merged doc dividers ────────────────────────────────────────────────────*/

.doc-section { border-top: 3pt solid var(--plum); padding-top: 32px; margin-top: 56px; }
/* The first document section is preceded by the master cover + TOC (not another
   .doc-section), so it should not carry the inter-document divider. Match the
   first section only — any section directly following another keeps the rule. */
.doc-section:not(.doc-section + .doc-section) { border-top: none; padding-top: 0; margin-top: 0; }

/* ── Merged cover table ─────────────────────────────────────────────────────*/

.master-cover-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0;
  font-size: 8.5pt;
}

.master-cover-table th {
  background: var(--plum);
  color: var(--white);
  font-weight: 700;
  padding: 3pt 4.5pt;
  border: none;
  text-align: left;
}

.master-cover-table td {
  padding: 3pt 4.5pt;
  border: none;
  border-bottom: 0.5pt solid var(--rule);
  vertical-align: top;
}

.master-cover-table td:first-child {
  width: 1%;
  font-family: 'Roboto Mono', monospace;
  color: var(--pink-deep);
  white-space: nowrap;
}

.master-cover-table tr:nth-child(even) td { background: var(--cream); }

@media (max-width: 860px) {
  .page-content { padding: 20px 16px 32px; margin-top: 0; }
  .doc-header   { padding: 8px 16px; }
  .doc-footer   { padding: 16px; }
  .cover-meta-table { width: 100%; }
}

@media print {
  body { background: var(--white); }
  .doc-header { position: static; }
  .page-content { box-shadow: none; padding: 0; max-width: none; margin: 0; }
  .cover-page { border-bottom: none; break-after: page; }
  #TOC { break-after: page; }
  table, pre, .mermaid { break-inside: avoid; }
  thead { display: table-header-group; }
}
`;

// Detect mermaid blocks from the parsed token tree rather than substring-matching
// the raw markdown: a 4-backtick fence showing a ```mermaid example is NOT a
// mermaid diagram, and ~~~mermaid fences must still count. We check the fenced
// code tokens' lang directly (parseMermaidOpts is avoided here so its stderr
// warnings on invalid opts don't fire during mere detection).
function docHasMermaid(parsed) {
  return (parsed.tokens || []).some(
    t => t.type === 'code' && /^mermaid\b/.test((t.lang || '').trim()),
  );
}

// ── Mermaid script ───────────────────────────────────────────────────────────

// Inline the mermaid UMD bundle so diagrams render offline — the HTML stays
// fully self-contained. Only included when the document has mermaid blocks.
function mermaidScript() {
  const bundle = fs.readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8')
    // A literal </script in the bundle would prematurely close our inline tag.
    .replace(/<\/script/gi, '<\\/script');
  return `
<script>${bundle}</script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
  mermaid.run({ querySelector: '.mermaid' });
</script>`;
}

// ── Page template ────────────────────────────────────────────────────────────

function htmlPage({ title, headerTitle, footerTitle, fontsCss, bodyContent, hasMermaid }) {
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
  <span class="header-brand"><img src="${dataUri(ICON_PATH)}" alt="">Cognizone</span>
  <span class="header-title">${escapeHtml(headerTitle)}</span>
</header>
<div class="page-content">
${bodyContent}
</div>
<footer class="doc-footer">
  <span>${escapeHtml(footerTitle)}</span>
  <span class="footer-brand">Cognizone</span>
</footer>
${hasMermaid ? mermaidScript() : ''}
</body>
</html>`;
}

// ── Single-file render ────────────────────────────────────────────────────────

function renderHtml(parsed, outputFile) {
  const fontsCss = buildFontsCss();
  const hasMermaid = docHasMermaid(parsed);

  const cover = coverPageHtml(parsed);
  const toc = tocHtml(parsed.tocEntries);
  const body = bodyHtml(parsed);

  const bodyContent = [cover, toc, `<div class="body-content">${body}</div>`].join('\n');

  const html = htmlPage({
    title: parsed.title,
    headerTitle: parsed.headerTitle,
    footerTitle: [parsed.classification, parsed.client, parsed.project].filter(Boolean).join(' \u00B7 '),
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
  const hasMermaid = parsedDocs.some(docHasMermaid);
  // Master cover
  const masterCoverRows = parsedDocs.map((d, i) =>
    `<tr><td>${String(i + 1).padStart(2, '0')}</td><td>${escapeHtml(d.id)}</td><td><a href="#doc-${i}-cover">${escapeHtml(d.title)}</a></td></tr>`
  ).join('');

  const masterCover = `
<div class="cover-page">
  ${lockupHtml()}
  <div class="cover-eyebrow">COGNIZONE</div>
  <div class="cover-title-block">
    <div class="cover-title">${escapeHtml(folderName)}</div>
  </div>
  <table class="master-cover-table">
    <thead><tr><th>#</th><th>ID</th><th>Title</th></tr></thead>
    <tbody>${masterCoverRows}</tbody>
  </table>
  ${coverBottomHtml('', '')}
</div>`;

  // Master TOC: each document is a top-level H2 entry; its headings are nested below
  const allTocEntries = [];
  parsedDocs.forEach((d, i) => {
    const docPrefix = `doc-${i}-`;
    allTocEntries.push({ level: 2, text: d.title, id: `${docPrefix}cover`, number: `DOCUMENT ${String(i + 1).padStart(2, '0')}` });
    d.tocEntries.forEach(e => allTocEntries.push({ ...e, level: Math.min(e.level + 1, 4), id: `${docPrefix}${e.id}`, number: `${i + 1}.${e.number}` }));
  });

  const masterToc = tocHtml(allTocEntries);

  // Per-document sections
  const docSections = parsedDocs.map((d, i) => {
    const docPrefix = `doc-${i}-`;
    const docCover = coverPageHtml(d, ` id="${docPrefix}cover"`);
    const docToc = tocHtml(d.tocEntries, docPrefix);
    const docBody = bodyHtml(d, docPrefix);
    return `<div class="doc-section">${docCover}${docToc}<div class="body-content">${docBody}</div></div>`;
  }).join('\n');

  const bodyContent = [masterCover, masterToc, docSections].join('\n');

  // Merged output spans documents that may belong to different clients/projects,
  // so a single per-document footer would be misleading — leave it empty
  // (matching renderMergedPdf).
  const footerTitle = '';

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
