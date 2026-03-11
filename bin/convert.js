#!/usr/bin/env node
'use strict';
// Cross-platform Markdown → PDF pipeline.
// Replaces export-to-pdf.sh — no bash, pandoc, or Unix tools required.

const { marked } = require('marked');
const matter = require('gray-matter');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const [,, inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error('Usage: convert.js <input.md> [output.pdf]');
  process.exit(1);
}

const inputFile  = path.resolve(inputArg);
const outputFile = path.resolve(outputArg || inputFile.replace(/\.md$/, '.pdf'));
const SCRIPT_DIR = path.join(__dirname, '..');
const CSS_PATH   = path.join(SCRIPT_DIR, 'templates', 'styles.css');
const LOGO_PATH  = path.join(SCRIPT_DIR, 'templates', 'logo.png');

// ── Frontmatter ───────────────────────────────────────────────────────────────
const { data: fm, content: mdBody } = matter(fs.readFileSync(inputFile, 'utf8'));

const title       = String(fm.title  || path.basename(inputFile, '.md'));
const id          = String(fm.id     || '');
const type        = String(fm.type   || '');
const status      = String(fm.status || '');
const date        = fm.date ? String(fm.date) : '';
const headerTitle = id ? `${id} - ${title}` : title;

// ── Strip H1 ──────────────────────────────────────────────────────────────────
const mdNoH1 = mdBody.replace(/^#\s[^\n]*\n?/m, '');

// ── Slugify ───────────────────────────────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

// ── Render body + collect TOC entries ────────────────────────────────────────
// In marked v13, marked.use() renderer overrides are post-processors: the
// function receives the already-rendered inner HTML string from the default
// renderer (not the token). walkTokens runs during lexing (same order as
// rendering), so we correlate by index.
const sectionCounters = [0, 0, 0, 0, 0, 0]; // index = depth - 1
const tocEntries = [];
let headingRenderIdx = 0;

marked.use({
  walkTokens(token) {
    if (token.type !== 'heading') return;

    const idx = token.depth - 1;
    sectionCounters[idx]++;
    for (let i = idx + 1; i < sectionCounters.length; i++) sectionCounters[i] = 0;

    const number = sectionCounters.slice(1, idx + 1).join('.');
    // token.text is the raw inline markdown (e.g. "My **Bold** Section")
    const plain = token.text.replace(/[*_`[\]()]/g, '').trim();
    const hId   = slugify(plain);
    tocEntries.push({ level: token.depth, text: plain, id: hId, number });
  },
  renderer: {
    // innerHtml is the rendered heading content (e.g. "My <strong>Bold</strong> Section")
    heading(innerHtml) {
      const entry = tocEntries[headingRenderIdx++];
      if (!entry) return `<h2>${innerHtml}</h2>\n`;
      return `<h${entry.level} id="${entry.id}"><span class="header-section-number">${entry.number}</span> ${innerHtml}</h${entry.level}>\n`;
    },
  },
});

const bodyHtml = marked(mdNoH1);

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
    lines.push(`<li><a href="#${h.id}"><span class="toc-section-number">${h.number}</span> ${h.text}</a>`);
    prev = h.level;
  }

  while (stack.length) { lines.push('</li></ul>'); stack.pop(); }
  lines.push('</nav>');
  return lines.join('\n');
}

// ── Metadata rows ─────────────────────────────────────────────────────────────
const metaRows = [
  ['ID',             id],
  ['Document title', title],
  ['Type',           type],
  ['Date',           date],
  ['Status',         status],
  ['Author',         'Cognizone'],
  ['Client',         'ERA — European Union Agency for Railways'],
  ['Project',        'REG+'],
].filter(([, v]) => v)
 .map(([l, v]) => `<tr><td class="meta-label">${l}</td><td>${v}</td></tr>`)
 .join('\n      ');

// ── Assemble HTML ─────────────────────────────────────────────────────────────
// Use file:// URLs so Puppeteer can load local CSS/assets on all platforms.
const cssUrl = pathToFileURL(CSS_PATH).href;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body>

  <div class="cover-page">
    <div class="cover-contact">
      <a href="mailto:info@cogni.zone">info@cogni.zone</a>
      <a href="https://cogni.zone">cogni.zone</a>
    </div>
    ${id ? `<p class="cover-id">${id}</p>` : ''}
    <h1 class="cover-title">${title}</h1>
    <table class="cover-meta-table">
      ${metaRows}
    </table>
  </div>

  <div class="page-break"></div>

  <div class="document-body toc-page">
    <h2 class="toc-heading">Contents</h2>
    ${buildToc(tocEntries)}
  </div>

  <div class="page-break"></div>

  <div class="document-body">
    ${bodyHtml}
  </div>

</body>
</html>`;

// ── Render PDF ────────────────────────────────────────────────────────────────
const tmpHtml = path.join(os.tmpdir(), `cognizone-${Date.now()}.html`);
fs.writeFileSync(tmpHtml, html, 'utf8');

try {
  execFileSync('node', [
    path.join(SCRIPT_DIR, 'templates', 'pdf-print.js'),
    tmpHtml, outputFile, headerTitle, date, LOGO_PATH,
  ], { stdio: 'inherit' });
  console.log(`Written: ${outputFile}`);
} finally {
  try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
}
