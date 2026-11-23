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
When a folder is given, all .md/.markdown files are merged into a single PDF or
HTML file. Without [output], a file is written next to the input
(document.md → document.pdf); a folder gives <folder>.pdf in the
current folder.

Options:
  -f, --format <pdf|docx|html>  Output format (default: pdf, or the output
                                file's extension when one is given).
                                Folder input supports pdf and html.
      --no-external-links       Render links to other files or sites (raw HTML
                                <a href> too) as plain text; in-document
                                #heading links still work.
      --relative-links          Point relative links to other .md files at their
                                converted file (a.md#x → a.docx), assuming the
                                delivery keeps the repo's folder layout. The
                                #section is dropped. Single files, docx/html.
      --link-base <url>         Like --relative-links, but links become absolute:
                                <url> is the http(s) address (e.g. a SharePoint
                                folder) of the folder you run the command from.
                                Needed for Word for the web, which can't follow
                                relative links.
  -v, --version                 Print version and exit
  -h, --help                    Show this help message

Examples:
  cognizone-convert document.md
  cognizone-convert document.md --format docx
  cognizone-convert document.md --format html
  cognizone-convert document.md output.pdf
  cognizone-convert document.md -f docx
  cognizone-convert document.md -f docx --no-external-links
  cognizone-convert document.md -f docx --no-external-links --relative-links
  cognizone-convert specs/a.md -f docx --link-base "https://x.sharepoint.com/sites/s/Shared Documents/"
  cognizone-convert docs/                      # merge folder → PDF
  cognizone-convert docs/ -f html              # merge folder → HTML
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
