'use strict';
// PDF renderer: takes parsed markdown data, produces a branded PDF via Puppeteer.

const { marked } = require('marked');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { parseMermaidOpts } = require('./mermaid-opts');

function mermaidWrapHtml(text, info) {
  const opts = parseMermaidOpts(info || '');
  const marginCss =
    opts.align === 'left'  ? '0 auto 0 0' :
    opts.align === 'right' ? '0 0 0 auto' :
                             '0 auto';
  return `<div class="mermaid-wrap" style="max-width:${opts.maxWidth}px;margin:${marginCss};"><pre class="mermaid">${text}</pre></div>\n`;
}

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
        if (parseMermaidOpts(lang || '').isMermaid) {
          return mermaidWrapHtml(text, lang);
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

function buildCoverHtml(doc) {
  const { title, id, type, status, date, author, client, project } = doc;
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

  return `<div class="cover-page">
    <div class="cover-contact">
      <a href="mailto:info@cogni.zone">info@cogni.zone</a>
      <a href="https://cogni.zone">cogni.zone</a>
    </div>
    ${id ? `<p class="cover-id">${id}</p>` : ''}
    <h1 class="cover-title">${title}</h1>
    <table class="cover-meta-table">
      ${metaRows}
    </table>
  </div>`;
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
      number: `${i + 1}`,
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

  let headingRenderIdx = 0;

  marked.use({
    renderer: {
      heading(innerHtml) {
        const entry = allPrefixedEntries[headingRenderIdx++];
        if (!entry) return `<h2>${innerHtml}</h2>\n`;
        return `<h${entry.level} id="${entry.id}"><span class="header-section-number">${entry.number}</span> ${innerHtml}</h${entry.level}>\n`;
      },
      code(text, lang) {
        if (parseMermaidOpts(lang || '').isMermaid) {
          return mermaidWrapHtml(text, lang);
        }
        const langClass = lang ? ` class="language-${lang}"` : '';
        return `<pre><code${langClass}>${text}</code></pre>\n`;
      },
    },
  });

  const docSections = parsedDocs.map((doc, i) => {
    const bodyHtml = resolveImagePaths(marked(doc.mdNoH1), doc.inputDir);
    const cover = buildCoverHtml(doc);
    return `
  <div class="page-break"></div>
  <div id="doc-${i}">
    ${cover}
  </div>
  <div class="page-break"></div>
  <div class="document-body">
    ${bodyHtml}
  </div>`;
  }).join('\n');

  // ── Master cover page ────────────────────────────────────────────────────
  const docListRows = parsedDocs.map((doc, i) => {
    const num = i + 1;
    return `<tr><td class="meta-label">${num}</td><td>${doc.id ? `${doc.id} — ` : ''}${doc.title}</td></tr>`;
  }).join('\n      ');

  const masterCover = `<div class="cover-page">
    <div class="cover-contact">
      <a href="mailto:info@cogni.zone">info@cogni.zone</a>
      <a href="https://cogni.zone">cogni.zone</a>
    </div>
    <h1 class="cover-title">${folderName}</h1>
    <table class="cover-meta-table">
      ${docListRows}
    </table>
  </div>`;

  // ── Assemble full HTML ───────────────────────────────────────────────────
  const cssUrl = pathToFileURL(CSS_PATH).href;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="${cssUrl}">
</head>
<body>

  ${masterCover}

  <div class="page-break"></div>

  <div class="document-body toc-page">
    <h2 class="toc-heading">Contents</h2>
    ${buildToc(masterTocEntries)}
  </div>

  ${docSections}

</body>
</html>`;

  // ── Render PDF ─────────────────────────────────────────────────────────────
  const tmpHtml = path.join(os.tmpdir(), `cognizone-merged-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const mermaidJsPath = require.resolve('mermaid/dist/mermaid.min.js');

  const headerTitle = folderName;
  const footerTitle = '';

  try {
    execFileSync('node', [
      path.join(SCRIPT_DIR, 'templates', 'pdf-print.js'),
      tmpHtml, outputFile, headerTitle, '', LOGO_PATH, footerTitle, mermaidJsPath,
    ], { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
  }
}

module.exports = { renderPdf, renderMergedPdf };
