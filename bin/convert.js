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
  console.error('Usage: convert.js <input.md|folder> [output] [--format pdf|docx|html]');
  process.exit(1);
}

if (!['pdf', 'docx', 'html'].includes(format)) {
  console.error(`Unknown format: ${format}. Supported: pdf, docx, html`);
  process.exit(1);
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

    const mdFiles = findMarkdownFiles(inputPath);
    if (!mdFiles.length) {
      console.error(`No .md files found in ${inputPath}`);
      process.exit(1);
    }

    console.log(`Found ${mdFiles.length} markdown file(s) in ${path.basename(inputPath)}/`);
    const parsedDocs = mdFiles.map(f => parseMarkdown(f));

    const folderName = path.basename(inputPath);
    const ext = format === 'html' ? '.html' : '.pdf';
    const outputFile = path.resolve(outputArg || `${folderName}${ext}`);

    if (format === 'html') {
      const { renderMergedHtml } = require('./render-html');
      renderMergedHtml(parsedDocs, inputPath, outputFile);
    } else {
      const { renderMergedPdf } = require('./render-pdf');
      renderMergedPdf(parsedDocs, inputPath, outputFile);
    }
    console.log(`Written: ${outputFile}`);
  } else {
    const ext = format === 'docx' ? '.docx' : format === 'html' ? '.html' : '.pdf';
    const outputFile = path.resolve(outputArg || inputPath.replace(/\.md$/, ext));
    const parsed = parseMarkdown(inputPath);

    if (format === 'docx') {
      const { renderDocx } = require('./render-docx');
      await renderDocx(parsed, outputFile);
    } else if (format === 'html') {
      const { renderHtml } = require('./render-html');
      renderHtml(parsed, outputFile);
    } else {
      const { renderPdf } = require('./render-pdf');
      renderPdf(parsed, outputFile);
    }

    console.log(`Written: ${outputFile}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
