#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: cognizone-convert <input.md|folder> [output] [options]

Converts a Markdown file (or folder of files) to a branded Cognizone document.
When a folder is given, all .md files are merged into a single PDF or HTML file.

Options:
  -f, --format <pdf|docx|html>  Output format (default: pdf)
                                Folder input supports pdf and html.
  -b, --brand <2026|classic>    Brand (default: 2026, or the document's
                                \`brand:\` frontmatter field). classic is the
                                old brand, kept for a short transition.
  -v, --version                 Print version and exit
  -h, --help                    Show this help message

Examples:
  cognizone-convert document.md
  cognizone-convert document.md --format docx
  cognizone-convert document.md --format html
  cognizone-convert document.md output.pdf
  cognizone-convert document.md -f docx
  cognizone-convert document.md -b classic     # old brand
  cognizone-convert docs/                      # merge folder → PDF
  cognizone-convert docs/ -f html              # merge folder → HTML
  cognizone-convert docs/ merged-output.pdf
`);
  process.exit(0);
}

// Recent npm versions skip install scripts by default, so puppeteer's postinstall may
// never have downloaded Chrome. Fetch it on first use instead (HTML needs no browser).
function ensureChrome() {
  const fi = args.findIndex(a => a === '-f' || a === '--format');
  if (fi !== -1 && (args[fi + 1] || '').toLowerCase() === 'html') return;
  const exe = require('puppeteer').executablePath();
  if (require('fs').existsSync(exe)) return;
  console.error('Chrome for rendering is not installed yet; downloading it once (npm skipped puppeteer\'s install script)...');
  execFileSync(process.execPath, [require.resolve('puppeteer/install.mjs')], { stdio: 'inherit' });
}

const script = path.join(__dirname, 'convert.js');

try {
  ensureChrome();
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
