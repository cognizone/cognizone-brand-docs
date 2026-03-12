#!/usr/bin/env node
'use strict';
// Cross-platform Markdown → PDF/DOCX pipeline.
// Pure Node.js — no bash, pandoc, or Unix tools required.

const path = require('path');
const { parseMarkdown } = require('./parse');

// ── Parse arguments ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let format = 'pdf';
let inputArg, outputArg;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--format' || args[i] === '-f') && args[i + 1]) {
    format = args[++i].toLowerCase();
  } else if (!inputArg) {
    inputArg = args[i];
  } else if (!outputArg) {
    outputArg = args[i];
  }
}

if (!inputArg) {
  console.error('Usage: convert.js <input.md> [output] [--format pdf|docx]');
  process.exit(1);
}

if (!['pdf', 'docx'].includes(format)) {
  console.error(`Unknown format: ${format}. Supported: pdf, docx`);
  process.exit(1);
}

const inputFile  = path.resolve(inputArg);
const ext = format === 'docx' ? '.docx' : '.pdf';
const outputFile = path.resolve(outputArg || inputFile.replace(/\.md$/, ext));

// ── Parse + render ───────────────────────────────────────────────────────────
const parsed = parseMarkdown(inputFile);

async function main() {
  if (format === 'docx') {
    const { renderDocx } = require('./render-docx');
    await renderDocx(parsed, outputFile);
  } else {
    const { renderPdf } = require('./render-pdf');
    renderPdf(parsed, outputFile);
  }

  console.log(`Written: ${outputFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
