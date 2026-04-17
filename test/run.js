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

// ── Test mermaid-opts parser ─────────────────────────────────────────────────
const { parseMermaidOpts } = require('../bin/mermaid-opts');

// Silence expected warnings from invalid-option cases below
const _origWarn = console.warn;
console.warn = () => {};

{
  const r = parseMermaidOpts('mermaid');
  assert('mermaid-opts: bare mermaid is mermaid', r.isMermaid === true);
  assert('mermaid-opts: default maxWidth 500', r.maxWidth === 500);
  assert('mermaid-opts: default align center', r.align === 'center');
}
{
  const r = parseMermaidOpts('mermaid maxWidth=300');
  assert('mermaid-opts: maxWidth parsed', r.maxWidth === 300);
  assert('mermaid-opts: align stays default', r.align === 'center');
}
{
  const r = parseMermaidOpts('mermaid align=left');
  assert('mermaid-opts: align=left parsed', r.align === 'left');
}
{
  const r = parseMermaidOpts('mermaid maxWidth=250 align=right');
  assert('mermaid-opts: both opts parsed', r.maxWidth === 250 && r.align === 'right');
}
{
  const r = parseMermaidOpts('javascript');
  assert('mermaid-opts: non-mermaid lang rejected', r.isMermaid === false);
}
{
  const r = parseMermaidOpts('');
  assert('mermaid-opts: empty lang rejected', r.isMermaid === false);
}
{
  const r = parseMermaidOpts('mermaid maxWidth=abc');
  assert('mermaid-opts: invalid maxWidth falls back', r.isMermaid === true && r.maxWidth === 500);
}
{
  const r = parseMermaidOpts('mermaid align=middle');
  assert('mermaid-opts: invalid align falls back', r.align === 'center');
}
{
  const r = parseMermaidOpts('mermaid bogus=1');
  assert('mermaid-opts: unknown key ignored, still mermaid', r.isMermaid === true);
}

console.warn = _origWarn;

// ── Test parse.js ────────────────────────────────────────────────────────────
const { parseMarkdown } = require('../bin/parse');
const parsed = parseMarkdown(FIXTURE);

assert('parse: title extracted', parsed.title === 'Test Document: All Formatting Features');
assert('parse: id extracted', parsed.id === 'TEST-001');
assert('parse: date formatted as YYYY-MM-DD', parsed.date === '2026-03-12');
assert('parse: version extracted', parsed.version === '1.2');
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

// ── Test DOCX mermaid sizing + alignment ─────────────────────────────────────
// fixture.md has two default-sized mermaid blocks (500px cap, centered) and
// one sized block: ```mermaid maxWidth=200 align=left```.
try {
  const docXml = execFileSync('unzip', ['-p', docxOut, 'word/document.xml']).toString();
  // EMU: 1 px ≈ 9525; 200 px → 1905000 EMU. Sized diagram must have cx ≤ that.
  const extents = [...docXml.matchAll(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/g)]
    .map(m => parseInt(m[1], 10));
  assert('docx mermaid: >=3 extents found',
    extents.length >= 3,
    `found ${extents.length} extents`);
  const MAX_EMU_200 = 200 * 9525;
  const sizedExtents = extents.filter(cx => cx <= MAX_EMU_200);
  assert('docx mermaid: sized diagram respects maxWidth=200',
    sizedExtents.length >= 1,
    `extents (EMU): [${extents.join(', ')}] — none ≤ ${MAX_EMU_200}`);
  // Alignment: the left-aligned diagram produces a paragraph with w:jc w:val="left"
  // near the drawing. Crude-but-reliable check: does the doc contain both "w:val=\"left\""
  // and "w:drawing" AND does the left-jc appear before some drawing element?
  const leftJcBeforeDrawing = /<w:jc\s+w:val="left"\s*\/>[\s\S]*?<w:drawing>/.test(docXml);
  assert('docx mermaid: align=left produces left-justified paragraph',
    leftJcBeforeDrawing,
    'no "<w:jc w:val=\\"left\\"/>" found before a <w:drawing>');
} catch (e) {
  assert('docx mermaid: extent/alignment checks', false, e.stderr?.toString() || e.message);
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

// ── Test ordered list numbering restarts ──────────────────────────────────────
const multiListMd = path.join(OUT_DIR, 'multi-list.md');
fs.writeFileSync(multiListMd, [
  '---',
  'title: Multi List Test',
  '---',
  '',
  '## Section A',
  '',
  '1. Alpha',
  '2. Beta',
  '3. Gamma',
  '',
  '## Section B',
  '',
  '1. One',
  '2. Two',
  '3. Three',
  '',
].join('\n'));

const multiListOut = path.join(OUT_DIR, 'multi-list.docx');
try {
  execFileSync(process.execPath, [CONVERT, multiListMd, multiListOut, '--format', 'docx'], { stdio: 'pipe' });
  // DOCX is a ZIP — extract word/numbering.xml and verify each ordered list
  // gets its own abstractNumId (not just different numId — Word ignores
  // startOverride when multiple w:num share the same abstractNumId)
  const numXml = execFileSync('unzip', ['-p', multiListOut, 'word/numbering.xml']).toString();
  // Find all <w:num> entries and their abstractNumId references
  const numEntries = [...numXml.matchAll(/<w:num w:numId="(\d+)"[^>]*>.*?<w:abstractNumId w:val="(\d+)"\/>/gs)];
  // Filter to non-bullet entries (abstractNumId > 0 for ordered lists based on config order)
  const abstractIds = numEntries.map(m => parseInt(m[2], 10));
  // The two ordered lists should reference different abstract definitions
  const uniqueAbstractIds = [...new Set(abstractIds)];
  assert('docx: separate ordered lists get different abstractNumId',
    uniqueAbstractIds.length >= 2,
    `expected >=2 unique abstractNumIds, got ${uniqueAbstractIds.length}: [${uniqueAbstractIds.join(', ')}]`);
} catch (e) {
  assert('docx: separate ordered lists get different numId instances', false,
    e.stderr?.toString() || e.message);
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
