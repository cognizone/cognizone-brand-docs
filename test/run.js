#!/usr/bin/env node
'use strict';
// Smoke test: generates PDF and DOCX from the test fixture and verifies basic expectations.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixture.md');
const CONVERT = path.join(__dirname, '..', 'bin', 'convert.js');
const OUT_DIR = path.join(__dirname, 'output');

// Clean / create output dir
if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR);

const tests = [];
let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    tests.push({ name, ok: true });
    passed++;
  } else {
    tests.push({ name, ok: false, detail });
    failed++;
  }
}

// ── Test parse.js ────────────────────────────────────────────────────────────
const { parseMarkdown } = require('../bin/parse');
const parsed = parseMarkdown(FIXTURE);

assert('parse: title extracted', parsed.title === 'Test Document: All Formatting Features');
assert('parse: id extracted', parsed.id === 'TEST-001');
assert('parse: date formatted as YYYY-MM-DD', parsed.date === '2026-03-12');
assert('parse: author extracted', parsed.author === 'Cognizone');
assert('parse: client extracted', parsed.client === 'ERA \u2014 European Union Agency for Railways');
assert('parse: project extracted', parsed.project === 'REG+');
assert('parse: headerTitle composed', parsed.headerTitle === 'TEST-001 - Test Document: All Formatting Features');
assert('parse: footerTitle composed', parsed.footerTitle === 'ERA \u2014 European Union Agency for Railways \u00B7 REG+');
assert('parse: tokens is array', Array.isArray(parsed.tokens) && parsed.tokens.length > 0);
assert('parse: tocEntries populated', parsed.tocEntries.length > 0);
assert('parse: H1 stripped from body', !parsed.mdNoH1.match(/^#\s/m));

// Check section numbering
const h2s = parsed.tocEntries.filter(e => e.level === 2);
assert('parse: H2 numbering starts at 1', h2s[0]?.number === '1');
assert('parse: H2 numbering increments', h2s[1]?.number === '2');

const h3s = parsed.tocEntries.filter(e => e.level === 3);
assert('parse: H3 numbering is nested', h3s[0]?.number.includes('.'));

// ── Test DOCX generation ─────────────────────────────────────────────────────
const docxOut = path.join(OUT_DIR, 'fixture.docx');
try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, docxOut, '--format', 'docx'], { stdio: 'pipe' });
  assert('docx: file created', fs.existsSync(docxOut));
  const docxSize = fs.statSync(docxOut).size;
  assert('docx: file is non-trivial (>10KB)', docxSize > 10000, `size: ${docxSize}`);
} catch (e) {
  assert('docx: generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test PDF generation ──────────────────────────────────────────────────────
const pdfOut = path.join(OUT_DIR, 'fixture.pdf');
try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, pdfOut, '--format', 'pdf'], { stdio: 'pipe' });
  assert('pdf: file created', fs.existsSync(pdfOut));
  const pdfSize = fs.statSync(pdfOut).size;
  assert('pdf: file is non-trivial (>10KB)', pdfSize > 10000, `size: ${pdfSize}`);
  // Check PDF magic bytes
  const header = fs.readFileSync(pdfOut).subarray(0, 5).toString();
  assert('pdf: valid PDF header', header === '%PDF-', `got: ${header}`);
} catch (e) {
  assert('pdf: generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test missing frontmatter ─────────────────────────────────────────────────
const minimalMd = path.join(OUT_DIR, 'minimal.md');
fs.writeFileSync(minimalMd, '## Just a heading\n\nSome text.\n');
const minimalOut = path.join(OUT_DIR, 'minimal.docx');
try {
  execFileSync(process.execPath, [CONVERT, minimalMd, minimalOut, '--format', 'docx'], { stdio: 'pipe' });
  assert('edge: no frontmatter produces valid docx', fs.existsSync(minimalOut));
} catch (e) {
  assert('edge: no frontmatter produces valid docx', false, e.stderr?.toString() || e.message);
}

// ── Test format flag validation ──────────────────────────────────────────────
try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, '/dev/null', '--format', 'html'], { stdio: 'pipe' });
  assert('edge: unknown format rejected', false, 'should have thrown');
} catch {
  assert('edge: unknown format rejected', true);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('');
for (const t of tests) {
  const icon = t.ok ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
  console.log(`  ${icon} ${t.name}${t.detail ? ` (${t.detail})` : ''}`);
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
