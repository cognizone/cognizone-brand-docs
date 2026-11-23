#!/usr/bin/env node
'use strict';
// Cross-platform Markdown → PDF/DOCX/HTML pipeline.
// Pure Node.js — no bash, pandoc, or Unix tools required.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseMarkdown } = require('./parse');

// ── Parse arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let format;
let stripExternalLinks = false;
let relativeLinks = false;
let linkBase;
let inputArg, outputArg;

const CLASSIC_REMOVED = 'The classic brand was removed in version 2.0.0; cognizone-convert 1.8.0 is the last version with it.';

function usageError(msg) {
  console.error(`${msg} See cognizone-convert --help.`);
  process.exit(1);
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (['--format', '-f', '--brand', '-b', '--link-base'].includes(a)) {
    const value = args[++i];
    if (value === undefined || value.startsWith('-')) usageError(`Missing value for ${a}.`);
    if (a === '--format' || a === '-f') format = value.toLowerCase();
    else if (a === '--brand' || a === '-b') {
      // Undocumented: old scripts may still pass the brand; 2026 is the only one left
      if (value !== '2026') {
        console.error(CLASSIC_REMOVED);
        process.exit(1);
      }
    }
    else { linkBase = value; relativeLinks = true; }
  } else if (a === '--no-external-links') {
    stripExternalLinks = true;
  } else if (a === '--relative-links') {
    relativeLinks = true;
  } else if (a.startsWith('-')) {
    usageError(`Unknown option: ${a}.`);
  } else if (!inputArg) {
    inputArg = a;
  } else if (!outputArg) {
    outputArg = a;
  } else {
    usageError(`Unexpected argument: ${a} (input ${inputArg} and output ${outputArg} are already given).`);
  }
}

if (!inputArg) {
  console.error('Usage: convert.js <input.md|folder> [output] [--format pdf|docx|html] [--no-external-links] [--relative-links] [--link-base <url>]');
  process.exit(1);
}

const FORMATS = ['pdf', 'docx', 'html'];
if (format && !FORMATS.includes(format)) {
  console.error(`Unknown format: ${format}. Supported: pdf, docx, html`);
  process.exit(1);
}

// The output file's extension picks the format when -f is absent, and must agree with it when given
const outExt = outputArg && path.extname(outputArg).slice(1).toLowerCase();
if (FORMATS.includes(outExt)) {
  if (format && format !== outExt) {
    console.error(`Output file ${outputArg} does not match --format ${format}.`);
    process.exit(1);
  }
  format = outExt;
}
format = format || 'pdf';

// --link-base takes the folder's web address. A SharePoint address bar shows the library
// view (".../Forms/AllItems.aspx?id=/sites/x/Shared Documents/specs&viewid=..."): the
// folder path is in its id parameter.
function folderUrl(input) {
  const fail = msg => { console.error(`--link-base: ${msg}`); process.exit(1); };
  let u;
  try { u = new URL(input); } catch {
    fail(`not a URL: ${input}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(`must be an http(s) URL: ${input}`);
  const id = u.searchParams.get('id');
  if (id !== null) {
    // only a folder path on the same site ("/sites/x/Shared Documents/specs")
    const folder = /^\/(?![/\\])/.test(id) && new URL(id.replace(/\/?$/, '/'), u.origin);
    if (!folder || folder.origin !== u.origin) fail(`the id parameter is not a folder path starting with "/": ${id}`);
    return folder.href;
  }
  u.search = ''; u.hash = '';
  u.pathname = u.pathname.replace(/\/Forms\/[^/]+\.aspx$/i, '').replace(/\/?$/, '/');
  return u.href;
}
if (linkBase) linkBase = folderUrl(linkBase);

// A document still asking for the removed classic brand is rendered in the 2026 brand
function warnClassic(parsed, file) {
  if (String(parsed.brand).toLowerCase() === 'classic') {
    console.warn(`${path.basename(file)}: the classic brand was removed; rendering in the 2026 brand.`);
  }
}

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
    else if (/\.(md|markdown)$/i.test(entry.name)) results.push(full);
  }
  return results.sort();
}

// The output would overwrite a source file: same path, or the same file through a
// symlink, hard link or case-insensitive name
function sameFile(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true });
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;  // the output does not exist yet
  }
}
function refuseOverwrite(source, outputFile) {
  if (!sameFile(source, outputFile)) return;
  console.error(`Output ${outputFile} would overwrite the input ${source}; give another output file.`);
  process.exit(1);
}

// Recent npm versions skip install scripts by default, so puppeteer's postinstall may
// never have downloaded Chrome. Fetch it on first use instead (HTML needs no browser).
function ensureChrome() {
  const exe = require('puppeteer').executablePath();
  if (fs.existsSync(exe)) return;
  console.error('Chrome for rendering is not installed yet; downloading it once (npm skipped puppeteer\'s install script)...');
  execFileSync(process.execPath, [require.resolve('puppeteer/install.mjs')], { stdio: 'inherit' });
}

// ── Parse + render ───────────────────────────────────────────────────────────
async function main() {
  if (isDirectory && format === 'docx') {
    console.error('Folder input only supports pdf and html output.');
    process.exit(1);
  }
  if (format !== 'html') ensureChrome();
  if (isDirectory) {
    if (relativeLinks) console.warn('--relative-links / --link-base are ignored for folder merges (one output file).');
    const mdFiles = findMarkdownFiles(inputPath);
    if (!mdFiles.length) {
      console.error(`No .md files found in ${inputPath}`);
      process.exit(1);
    }

    const folderName = path.basename(inputPath);
    const ext = format === 'html' ? '.html' : '.pdf';
    const outputFile = path.resolve(outputArg || `${folderName}${ext}`);
    for (const f of mdFiles) refuseOverwrite(f, outputFile);

    console.log(`Found ${mdFiles.length} markdown file(s) in ${path.basename(inputPath)}/`);
    // "#anchor" links get the doc-{i}- prefix the merged renderers give heading ids
    const parsedDocs = mdFiles.map((f, i) => parseMarkdown(f, { stripExternal: stripExternalLinks, anchorPrefix: `doc-${i}-` }));

    parsedDocs.forEach((p, i) => warnClassic(p, mdFiles[i]));
    // renderers load on use: HTML output needs neither puppeteer nor docx
    if (format === 'html') require('./render-html').renderMergedHtml(parsedDocs, inputPath, outputFile);
    else require('./render-pdf').renderMergedPdf(parsedDocs, inputPath, outputFile);
    console.log(`Written: ${outputFile}`);
  } else {
    const ext = format === 'docx' ? '.docx' : format === 'html' ? '.html' : '.pdf';
    const { dir, name } = path.parse(inputPath);
    const outputFile = path.resolve(outputArg || path.join(dir, name + ext));
    refuseOverwrite(inputPath, outputFile);
    // ponytail: Chrome resolves relative hrefs against the page base when printing, so a PDF
    // gets absolute file:// links; post-process the PDF annotations if PDF ever needs this
    if (relativeLinks && !linkBase && format === 'pdf') console.warn('--relative-links: PDF links become absolute file paths on this machine; use docx or html for a delivery.');
    const parsed = parseMarkdown(inputPath, { stripExternal: stripExternalLinks, docExt: relativeLinks ? ext : '', linkBase, linkRoot: process.cwd() });
    warnClassic(parsed, inputPath);

    if (format === 'docx') await require('./render-docx').renderDocx(parsed, outputFile);
    else if (format === 'html') require('./render-html').renderHtml(parsed, outputFile);
    else require('./render-pdf').renderPdf(parsed, outputFile);

    console.log(`Written: ${outputFile}`);
  }
}

main().catch(err => {
  console.error(err.userError ? err.message : err);
  process.exit(1);
});
