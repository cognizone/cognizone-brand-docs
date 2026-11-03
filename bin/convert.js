#!/usr/bin/env node
'use strict';
// Cross-platform Markdown → PDF/DOCX/HTML pipeline.
// Pure Node.js — no bash, pandoc, or Unix tools required.

const fs = require('fs');
const path = require('path');
const { parseMarkdown } = require('./parse');

// ── Parse arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let format = 'pdf';
let brandArg;
let stripExternalLinks = false;
let relativeLinks = false;
let linkBase;
let inputArg, outputArg;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--format' || args[i] === '-f') && args[i + 1]) {
    format = args[++i].toLowerCase();
  } else if ((args[i] === '--brand' || args[i] === '-b') && args[i + 1]) {
    brandArg = args[++i].toLowerCase();
  } else if (args[i] === '--no-external-links') {
    stripExternalLinks = true;
  } else if (args[i] === '--relative-links') {
    relativeLinks = true;
  } else if (args[i] === '--link-base' && args[i + 1]) {
    linkBase = args[++i];
    relativeLinks = true;
  } else if (!inputArg) {
    inputArg = args[i];
  } else if (!outputArg) {
    outputArg = args[i];
  }
}

if (!inputArg) {
  console.error('Usage: convert.js <input.md|folder> [output] [--format pdf|docx|html] [--brand 2026|classic] [--no-external-links] [--relative-links] [--link-base <url>]');
  process.exit(1);
}

if (!['pdf', 'docx', 'html'].includes(format)) {
  console.error(`Unknown format: ${format}. Supported: pdf, docx, html`);
  process.exit(1);
}

// --link-base takes the folder's web address. A SharePoint address bar shows the library
// view (".../Forms/AllItems.aspx?id=/sites/x/Shared Documents/specs&viewid=..."): the
// folder path is in its id parameter.
function folderUrl(input) {
  let u;
  try { u = new URL(input); } catch {
    console.error(`--link-base: not a URL: ${input}`);
    process.exit(1);
  }
  const id = u.searchParams.get('id');
  if (id) return new URL(id.replace(/\/?$/, '/'), u.origin).href;
  u.search = ''; u.hash = '';
  u.pathname = u.pathname.replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/?$/, '/');
  return u.href;
}
if (linkBase) linkBase = folderUrl(linkBase);

// ponytail: two brands only while the classic one is phased out — delete the
// classic renderers and this switch when it goes
const BRANDS = ['classic', '2026'];
if (brandArg && !BRANDS.includes(brandArg)) {
  console.error(`Unknown brand: ${brandArg}. Supported: ${BRANDS.join(', ')}`);
  process.exit(1);
}

// --brand wins; otherwise the (first) document's `brand:` frontmatter; default 2026
function pickBrand(parsed) {
  const brand = brandArg || String(parsed.brand || '2026').toLowerCase();
  if (!BRANDS.includes(brand)) {
    console.error(`Unknown brand in frontmatter: ${brand}. Supported: ${BRANDS.join(', ')}`);
    process.exit(1);
  }
  return brand;
}

const renderer = (name, brand) => require(brand === '2026' ? `./${name}-2026` : `./${name}`);

const inputPath = path.resolve(inputArg);

if (!fs.existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

const isDirectory = fs.statSync(inputPath).isDirectory();

// ── Helpers ──────────────────────────────────────────────────────────────────
function findMarkdownFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results.sort();
}

// ── Parse + render ───────────────────────────────────────────────────────────
async function main() {
  if (isDirectory) {
    if (format === 'docx') {
      console.error('Folder input only supports pdf and html output.');
      process.exit(1);
    }

    if (relativeLinks) console.warn('--relative-links / --link-base are ignored for folder merges (one output file).');
    const mdFiles = findMarkdownFiles(inputPath);
    if (!mdFiles.length) {
      console.error(`No .md files found in ${inputPath}`);
      process.exit(1);
    }

    console.log(`Found ${mdFiles.length} markdown file(s) in ${path.basename(inputPath)}/`);
    const parsedDocs = mdFiles.map(f => parseMarkdown(f, { stripExternal: stripExternalLinks }));

    const folderName = path.basename(inputPath);
    const ext = format === 'html' ? '.html' : '.pdf';
    const outputFile = path.resolve(outputArg || `${folderName}${ext}`);

    const brand = pickBrand(parsedDocs[0]);
    if (format === 'html') {
      const { renderMergedHtml } = renderer('render-html', brand);
      renderMergedHtml(parsedDocs, inputPath, outputFile);
    } else {
      const { renderMergedPdf } = renderer('render-pdf', brand);
      renderMergedPdf(parsedDocs, inputPath, outputFile);
    }
    console.log(`Written: ${outputFile}`);
  } else {
    const ext = format === 'docx' ? '.docx' : format === 'html' ? '.html' : '.pdf';
    const outputFile = path.resolve(outputArg || inputPath.replace(/\.md$/, ext));
    // ponytail: Chrome resolves relative hrefs against the page base when printing, so a PDF
    // gets absolute file:// links; post-process the PDF annotations if PDF ever needs this
    if (relativeLinks && !linkBase && format === 'pdf') console.warn('--relative-links: PDF links become absolute file paths on this machine; use docx or html for a delivery.');
    const parsed = parseMarkdown(inputPath, { stripExternal: stripExternalLinks, docExt: relativeLinks ? ext : '', linkBase, linkRoot: process.cwd() });
    const brand = pickBrand(parsed);

    if (format === 'docx') {
      const { renderDocx } = renderer('render-docx', brand);
      await renderDocx(parsed, outputFile);
    } else if (format === 'html') {
      const { renderHtml } = renderer('render-html', brand);
      renderHtml(parsed, outputFile);
    } else {
      const { renderPdf } = renderer('render-pdf', brand);
      renderPdf(parsed, outputFile);
    }

    console.log(`Written: ${outputFile}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
