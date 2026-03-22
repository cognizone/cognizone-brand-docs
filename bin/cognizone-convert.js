#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: cognizone-convert <input.md|folder> [output] [options]

Converts a Markdown file (or folder of files) to a branded Cognizone document.
When a folder is given, all .md files are merged into a single PDF.

Options:
  -f, --format <pdf|docx>  Output format (default: pdf)
                           Folder input only supports pdf.
  -h, --help               Show this help message

Examples:
  cognizone-convert document.md
  cognizone-convert document.md --format docx
  cognizone-convert document.md output.pdf
  cognizone-convert document.md -f docx
  cognizone-convert docs/                      # merge folder → PDF
  cognizone-convert docs/ merged-output.pdf
`);
  process.exit(0);
}

const script = path.join(__dirname, 'convert.js');

try {
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
