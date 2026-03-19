'use strict';
// PDF renderer: takes parsed markdown data, produces a branded PDF via Puppeteer.

const { marked } = require('marked');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = path.join(__dirname, '..');
const CSS_PATH   = path.join(SCRIPT_DIR, 'templates', 'styles.css');
const LOGO_PATH  = path.join(SCRIPT_DIR, 'templates', 'logo.png');

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

function renderPdf(parsed, outputFile) {
  const { title, id, type, status, date, author, client, project, headerTitle, footerTitle, inputDir, tocEntries, mdNoH1 } = parsed;

  // ── Render body HTML with section numbers ──────────────────────────────────
  // In marked v13, renderer overrides are post-processors: the function
  // receives already-rendered inner HTML. walkTokens runs in the same order
  // as rendering, so we correlate by index.
  let headingRenderIdx = 0;

  marked.use({
    renderer: {
      heading(innerHtml) {
        const entry = tocEntries[headingRenderIdx++];
        if (!entry) return `<h2>${innerHtml}</h2>\n`;
        return `<h${entry.level} id="${entry.id}"><span class="header-section-number">${entry.number}</span> ${innerHtml}</h${entry.level}>\n`;
      },
      code(text, lang) {
        if (lang === 'mermaid') {
          return `<pre class="mermaid">${text}</pre>\n`;
        }
        // Default code block rendering
        const langClass = lang ? ` class="language-${lang}"` : '';
        return `<pre><code${langClass}>${text}</code></pre>\n`;
      },
    },
  });

  const bodyHtml = marked(mdNoH1);

  // ── Metadata rows ──────────────────────────────────────────────────────────
  const metaRows = [
    ['ID',             id],
    ['Document title', title],
    ['Type',           type],
    ['Date',           date],
    ['Status',         status],
    ['Author',         author],
    ['Client',         client],
    ['Project',        project],
  ].filter(([, v]) => v)
   .map(([l, v]) => `<tr><td class="meta-label">${l}</td><td>${v}</td></tr>`)
   .join('\n      ');

  // ── Assemble HTML ──────────────────────────────────────────────────────────
  const cssUrl = pathToFileURL(CSS_PATH).href;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <base href="${pathToFileURL(inputDir + '/').href}">
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

  // ── Render PDF ─────────────────────────────────────────────────────────────
  const tmpHtml = path.join(os.tmpdir(), `cognizone-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  // Resolve mermaid browser bundle path for Puppeteer injection
  const mermaidJsPath = require.resolve('mermaid/dist/mermaid.min.js');

  try {
    execFileSync('node', [
      path.join(SCRIPT_DIR, 'templates', 'pdf-print.js'),
      tmpHtml, outputFile, headerTitle, date, LOGO_PATH, footerTitle, mermaidJsPath,
    ], { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
  }
}

module.exports = { renderPdf };
