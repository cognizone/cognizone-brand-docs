#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: cognizone-convert <input.md> [output] [options]

Converts a Markdown file to a branded Cognizone document.

Options:
  -f, --format <pdf|docx>  Output format (default: pdf)
  -h, --help               Show this help message

Examples:
  cognizone-convert document.md
  cognizone-convert document.md --format docx
  cognizone-convert document.md output.pdf
  cognizone-convert document.md -f docx
`);
  process.exit(0);
}

const script = path.join(__dirname, 'convert.js');

try {
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
