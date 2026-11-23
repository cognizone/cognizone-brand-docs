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

// ── Test code-block HTML escaping (angle brackets survive in PDF) ────────────
// Regression: `<...>` in a code block was parsed as HTML and dropped by Puppeteer.
const { escapeHtml } = require('../bin/render-pdf');
assert('escapeHtml: angle brackets escaped',
  escapeHtml('PREFIX eurio: <http://data.europa.eu/s66#>') ===
  'PREFIX eurio: &lt;http://data.europa.eu/s66#&gt;');
assert('escapeHtml: ampersand escaped first',
  escapeHtml('a & <b>') === 'a &amp; &lt;b&gt;');

// ── Test parse.js ────────────────────────────────────────────────────────────
const { parseMarkdown } = require('../bin/parse');
const parsed = parseMarkdown(FIXTURE);

assert('parse: title extracted', parsed.title === 'Test Document: All Formatting Features');
assert('parse: id extracted', parsed.id === 'TEST-001');
assert('parse: date formatted as YYYY-MM-DD', parsed.date === '2026-03-12');
assert('parse: version extracted', parsed.version === '1.2');

// ── Test: YAML-numeric version preserves formatting (1.0 does not become 1) ──
{
  const versionNumericMd = path.join(OUT_DIR, 'version-numeric.md');
  fs.writeFileSync(versionNumericMd, '---\ntitle: V\nversion: 1.0\n---\n\n## X\n');
  const v = parseMarkdown(versionNumericMd);
  assert('parse: unquoted version 1.0 preserves trailing zero', v.version === '1.0',
    `got "${v.version}"`);
}
{
  const versionQuotedMd = path.join(OUT_DIR, 'version-quoted.md');
  fs.writeFileSync(versionQuotedMd, '---\ntitle: V\nversion: "2.0"\n---\n\n## X\n');
  const v = parseMarkdown(versionQuotedMd);
  assert('parse: quoted version strips quotes', v.version === '2.0',
    `got "${v.version}"`);
}
{
  const versionMissingMd = path.join(OUT_DIR, 'version-missing.md');
  fs.writeFileSync(versionMissingMd, '---\ntitle: V\n---\n\n## X\n');
  const v = parseMarkdown(versionMissingMd);
  assert('parse: missing version yields empty string', v.version === '');
}
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
  execFileSync(process.execPath, [CONVERT, FIXTURE, docxOut, '--format', 'docx', '--brand', 'classic'], { stdio: 'pipe' });
  assert('docx: file created', fs.existsSync(docxOut));
  const docxSize = fs.statSync(docxOut).size;
  assert('docx: file is non-trivial (>10KB)', docxSize > 10000, `size: ${docxSize}`);
  // Regression: angle brackets in code blocks must survive (XML-escaped in docx)
  const docXml = execFileSync('unzip', ['-p', docxOut, 'word/document.xml']).toString();
  assert('docx: code-block angle brackets preserved',
    docXml.includes('&lt;http://data.europa.eu/s66#&gt;'),
    'IRI in code block was dropped or unescaped');
  // Regression: :---: column alignment reaches the cell paragraphs
  const pendingPara = docXml.split('</w:p>').find(p => p.includes('>pending<')) || '';
  assert('docx: centred table column is centred',
    pendingPara.includes('<w:jc w:val="center"/>'), 'cell paragraph has no center justification');
  // Regression: blockquote content after the first paragraph (e.g. a list) is not dropped
  const quotedItem = docXml.split('</w:p>').find(p => p.includes('>Quoted list item two<')) || '';
  assert('docx: blockquote list rendered with quote styling',
    quotedItem.includes('F9F9F9') && quotedItem.includes('<w:i/>'), 'quoted list item missing or unstyled');
} catch (e) {
  assert('docx: generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test DOCX mermaid sizing + alignment ─────────────────────────────────────
// fixture.md has two default-sized mermaid blocks (500px cap, centered) and
// one sized block: ```mermaid maxWidth=200 align=left```.

// Body drawings of a .docx: the paragraph each sits in, its extent (EMU, 1 px = 9525),
// its media path and the picture's bytes
function docxDrawings(file) {
  const read = p => execFileSync('unzip', ['-p', file, p]);
  const xml = read('word/document.xml').toString();
  const rels = read('word/_rels/document.xml.rels').toString();
  const out = [];
  for (const chunk of xml.split('</w:p>')) {
    const para = chunk.slice(Math.max(chunk.lastIndexOf('<w:p>'), chunk.lastIndexOf('<w:p ')));
    for (const d of para.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) || []) {
      const [, cx, cy] = d.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
      const rId = d.match(/r:embed="([^"]+)"/)[1];
      const target = rels.match(new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`))[1];
      out.push({ para, cx: +cx, cy: +cy, target, media: read(`word/${target}`) });
    }
  }
  return out;
}
// The drawings that show a mermaid diagram: every picture except the static images
// (sample image, logos), which would otherwise satisfy extent checks on their own
const STATIC_IMAGES = ['sample-image.png', '../templates/logo.png', '../templates/2026/icon.png']
  .map(f => fs.readFileSync(path.join(__dirname, f)));
const mermaidDrawings = file => docxDrawings(file).filter(d => !STATIC_IMAGES.some(s => s.equals(d.media)));
const FIXTURE_MERMAIDS = (fs.readFileSync(FIXTURE, 'utf8').match(/^```mermaid/gm) || []).length;

try {
  const mermaid = mermaidDrawings(docxOut);
  assert('docx mermaid: one drawing per mermaid diagram',
    FIXTURE_MERMAIDS === 3 && mermaid.length === FIXTURE_MERMAIDS,
    `found ${mermaid.length} mermaid drawings for ${FIXTURE_MERMAIDS} diagrams`);
  // The maxWidth=200 align=left diagram: the only mermaid drawing in a left-justified paragraph
  const left = mermaid.filter(d => d.para.includes('<w:jc w:val="left"/>'));
  assert('docx mermaid: sized diagram respects maxWidth=200',
    left.length === 1 && left[0].cx <= 200 * 9525,
    `left-aligned mermaid extents (EMU): [${left.map(d => d.cx).join(', ')}]`);
  assert('docx mermaid: align=left produces left-justified paragraph',
    left.length === 1 && mermaid.filter(d => d.para.includes('<w:jc w:val="center"/>')).length === FIXTURE_MERMAIDS - 1,
    `${left.length} left-aligned mermaid drawings`);
} catch (e) {
  assert('docx mermaid: extent/alignment checks', false, e.stderr?.toString() || e.message);
}

// ── Test PDF generation ──────────────────────────────────────────────────────
const pdfOut = path.join(OUT_DIR, 'fixture.pdf');
try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, pdfOut, '--format', 'pdf', '--brand', 'classic'], { stdio: 'pipe' });
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

// The numbering of the list item paragraph containing `text`: its numId, that
// instance's abstractNumId, and the level-0 start number (abstract start, instance override)
function listNumbering(docXml, numXml, text) {
  const para = docXml.split('</w:p>').find(p => p.includes(`>${text}<`)) || '';
  const numId = (para.match(/<w:numId w:val="([^"]+)"\/>/) || [])[1];
  const num = (numXml.match(new RegExp(`<w:num w:numId="${numId}">[\\s\\S]*?</w:num>`)) || [''])[0];
  const abstractNumId = (num.match(/<w:abstractNumId w:val="(\d+)"\/>/) || [])[1];
  const abs = (numXml.match(new RegExp(`<w:abstractNum [^>]*w:abstractNumId="${abstractNumId}"[\\s\\S]*?</w:abstractNum>`)) || [''])[0];
  return {
    numId, abstractNumId,
    start: (abs.match(/<w:start w:val="(\d+)"\/>/) || [])[1],
    startOverride: (num.match(/<w:lvlOverride w:ilvl="0"><w:startOverride w:val="(\d+)"\/>/) || [])[1],
  };
}

const multiListOut = path.join(OUT_DIR, 'multi-list.docx');
try {
  execFileSync(process.execPath, [CONVERT, multiListMd, multiListOut, '--format', 'docx', '--brand', 'classic'], { stdio: 'pipe' });
  // DOCX is a ZIP — the two lists' paragraphs must use different numIds, each on its
  // own abstractNumId (Word ignores startOverride when multiple w:num share the same
  // abstractNumId)
  const docXml = execFileSync('unzip', ['-p', multiListOut, 'word/document.xml']).toString();
  const numXml = execFileSync('unzip', ['-p', multiListOut, 'word/numbering.xml']).toString();
  const a = listNumbering(docXml, numXml, 'Alpha');
  const b = listNumbering(docXml, numXml, 'One');
  assert('docx: separate ordered lists get different abstractNumId',
    a.numId && b.numId && a.numId !== b.numId
    && a.abstractNumId && b.abstractNumId && a.abstractNumId !== b.abstractNumId,
    `Alpha: ${JSON.stringify(a)}, One: ${JSON.stringify(b)}`);
} catch (e) {
  assert('docx: separate ordered lists get different numId instances', false,
    e.stderr?.toString() || e.message);
}

// ── Test missing frontmatter ─────────────────────────────────────────────────
const minimalMd = path.join(OUT_DIR, 'minimal.md');
fs.writeFileSync(minimalMd, '## Just a heading\n\nSome text.\n');
const minimalOut = path.join(OUT_DIR, 'minimal.docx');
try {
  execFileSync(process.execPath, [CONVERT, minimalMd, minimalOut, '--format', 'docx', '--brand', 'classic'], { stdio: 'pipe' });
  assert('edge: no frontmatter produces valid docx', fs.existsSync(minimalOut));
} catch (e) {
  assert('edge: no frontmatter produces valid docx', false, e.stderr?.toString() || e.message);
}

// ── Test HTML generation ─────────────────────────────────────────────────────
const htmlOut = path.join(OUT_DIR, 'fixture.html');
try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, htmlOut, '--format', 'html', '--brand', 'classic'], { stdio: 'pipe' });
  assert('html: file created', fs.existsSync(htmlOut));
  const html = fs.readFileSync(htmlOut, 'utf8');
  assert('html: file is non-trivial (>10KB)', html.length > 10000, `size: ${html.length}`);
  assert('html: title present', html.includes('<title>Test Document: All Formatting Features</title>'));
  assert('html: cover id present', html.includes('TEST-001'));
  assert('html: TOC nav with anchor links', /<nav id="TOC">[\s\S]*?<a href="#/.test(html));
  assert('html: section-numbered headings', html.includes('class="section-num"'));
  assert('html: fonts embedded as data URIs', html.includes('data:font/ttf;base64,'));
  assert('html: images embedded as data URIs', html.includes('data:image/png;base64,'));
  // Sticky header offset so TOC anchor jumps aren't hidden behind the header
  assert('html: CSS has scroll-padding-top for sticky-header anchor offset',
    html.includes('scroll-padding-top'));
  // Default mermaid sizing is always emitted (fixture has bare ```mermaid blocks)
  assert('html: bare mermaid block emits default max-width:500px',
    html.includes('max-width:500px'),
    'no default 500px cap on a bare mermaid block');
  // Cover metadata table now surfaces ID and the document title as rows
  assert('html: cover meta table has ID row',
    /class="meta-label">ID</.test(html),
    'no meta-label cell containing "ID"');
  assert('html: cover meta table has Document title row',
    /class="meta-label">Document title</.test(html),
    'no meta-label cell containing "Document title"');
  const htmlNoScripts = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  assert('html: raw <img> tags embedded too',
    !/<img\s[^>]*src="(?!data:)/.test(htmlNoScripts),
    'found an <img> with a non-data src');
  assert('html: mermaid inlined for offline use', html.includes('mermaid.initialize'));
  assert('html: no external resource loads',
    !/(?:src|href)="https?:\/\/(?!cogni\.zone)/.test(html.replace(/<script>[\s\S]*?<\/script>/g, '')),
    'found external src/href outside cogni.zone links');
} catch (e) {
  assert('html: generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test HTML folder merge ───────────────────────────────────────────────────
const mergeDir = path.join(OUT_DIR, 'merge-src');
fs.mkdirSync(mergeDir);
// Two H2s and a skipped level (H2 → H4) per document
fs.writeFileSync(path.join(mergeDir, 'a-first.md'),
  '---\ntitle: First Doc\nid: DOC-A\nclient: TestClient\nproject: TestProject\n---\n\n# First Doc\n\n## Intro\n\nAlpha.\n\n#### Intro detail\n\nMore.\n\n## Later\n\nGamma.\n');
fs.writeFileSync(path.join(mergeDir, 'b-second.md'),
  '---\ntitle: Second Doc\nid: DOC-B\n---\n\n# Second Doc\n\n## Overview\n\nBeta.\n\n#### Overview detail\n\nMore.\n\n## Closing\n\nDelta.\n');

// Walks a TOC's <ul>/<li> tags: `error` names the first stray, misplaced or
// unclosed tag; `depth` maps each entry's href to its list depth.
function tocStructure(nav) {
  const stack = [];
  const depth = {};
  for (const [, close, tag, href] of nav.matchAll(/<(\/?)(ul|li)\b[^>]*>(?:<a href="#([^"]*)")?/g)) {
    if (close) {
      if (stack.pop() !== tag) return { error: `stray </${tag}>` };
      continue;
    }
    if (tag === 'li' && stack.at(-1) !== 'ul') return { error: '<li> outside a list' };
    if (tag === 'ul' && stack.length && stack.at(-1) !== 'li') return { error: '<ul> directly inside <ul>' };
    stack.push(tag);
    if (href) depth[href] = stack.filter(t => t === 'ul').length;
  }
  return stack.length ? { error: `unclosed ${stack.join(' ')}` } : { depth };
}

const mergedHtmlOut = path.join(OUT_DIR, 'merged.html');
try {
  execFileSync(process.execPath, [CONVERT, mergeDir, mergedHtmlOut, '--format', 'html', '--brand', 'classic'], { stdio: 'pipe' });
  assert('html merge: file created', fs.existsSync(mergedHtmlOut));
  const html = fs.readFileSync(mergedHtmlOut, 'utf8');
  assert('html merge: master cover table lists docs',
    html.includes('master-cover-table') && html.includes('DOC-A') && html.includes('DOC-B'));
  assert('html merge: doc-prefixed anchors present',
    html.includes('id="doc-0-cover"') && html.includes('id="doc-1-cover"'));
  assert('html merge: per-doc heading anchors prefixed',
    html.includes('id="doc-0-intro"') && html.includes('id="doc-1-overview"'));

  // Master TOC nav is the first TOC block; nested headings are numbered with
  // their document's prefix → doc 1's "## Intro" is 1.1, doc 2's "## Overview" is 2.1
  const masterNav = (html.match(/<nav id="TOC">[\s\S]*?<\/nav>/) || [''])[0];
  assert('html merge: master TOC prefixes nested numbers per document',
    masterNav.includes('>1.1') && masterNav.includes('>2.1'),
    `master TOC toc-num spans missing 1.1/2.1: ${masterNav.slice(0, 400)}`);

  // TOC nested-list markup must be a well-formed tree (equal <li>/</li> counts
  // also accept a stray </li> with the next item outside its list)
  const { error, depth = {} } = tocStructure(masterNav);
  assert('html merge: TOC is a well-formed nested list',
    !error && depth['doc-0-intro'] > depth['doc-0-cover'] && depth['doc-0-later'] === depth['doc-0-intro'],
    error || JSON.stringify(depth));

  // Merged footer is empty (Puppeteer parity: single static footer, no client/project)
  const footer = (html.match(/<footer class="doc-footer">[\s\S]*?<\/footer>/) || [''])[0];
  assert('html merge: footer omits client/project text',
    !footer.includes('TestClient · TestProject') && !footer.includes('TestClient'),
    `footer still carries client/project: ${footer}`);
} catch (e) {
  assert('html merge: generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test HTML mermaid bundle inclusion (only when actually used) ─────────────
// A document with no mermaid diagrams must NOT inline the (large) mermaid bundle.
const noMermaidMd = path.join(OUT_DIR, 'no-mermaid.md');
fs.writeFileSync(noMermaidMd, [
  '---',
  'title: No Mermaid Here',
  '---',
  '',
  '## Plain',
  '',
  'Just prose, a list, and some `inline code`.',
  '',
  '- one',
  '- two',
  '',
].join('\n'));
const noMermaidOut = path.join(OUT_DIR, 'no-mermaid.html');
try {
  execFileSync(process.execPath, [CONVERT, noMermaidMd, noMermaidOut, '--format', 'html', '--brand', 'classic'], { stdio: 'pipe' });
  const html = fs.readFileSync(noMermaidOut, 'utf8');
  assert('html: no-mermaid doc omits the mermaid bundle',
    !html.includes('mermaid.initialize'),
    'mermaid bundle was inlined into a doc with no diagrams');
  // Sanity: without the ~MB bundle this output is much smaller than a mermaid doc
  const withMermaid = fs.readFileSync(htmlOut, 'utf8');
  assert('html: no-mermaid output is much smaller than a mermaid doc',
    html.length < withMermaid.length,
    `no-mermaid=${html.length}, fixture=${withMermaid.length}`);
} catch (e) {
  assert('html: no-mermaid generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test HTML mermaid false-positive (mermaid only inside a code example) ────
// A ```mermaid fence shown *inside* a fenced code block is documentation, not a
// diagram — a naive substring match on the source would wrongly inline the bundle.
const mermaidExampleMd = path.join(OUT_DIR, 'mermaid-example.md');
fs.writeFileSync(mermaidExampleMd, [
  '---',
  'title: Mermaid Docs Example',
  '---',
  '',
  '## How to write a diagram',
  '',
  'Wrap your diagram in a fenced block like this:',
  '',
  '````markdown',
  '```mermaid',
  'flowchart TD',
  '  A --> B',
  '```',
  '````',
  '',
  'That is all.',
  '',
].join('\n'));
const mermaidExampleOut = path.join(OUT_DIR, 'mermaid-example.html');
try {
  execFileSync(process.execPath, [CONVERT, mermaidExampleMd, mermaidExampleOut, '--format', 'html', '--brand', 'classic'], { stdio: 'pipe' });
  const html = fs.readFileSync(mermaidExampleOut, 'utf8');
  assert('html: mermaid inside a code example does not inline the bundle',
    !html.includes('mermaid.initialize'),
    'a documented ```mermaid example triggered a false-positive bundle inline');
} catch (e) {
  assert('html: mermaid-example generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test HTML does not embed non-image referenced files (info leak guard) ────
// `![x](secret.txt)` must not slurp arbitrary local files into the output.
const secretMarker = 'SUPERSECRETMARKER_DO_NOT_LEAK_31337';
const leakDir = path.join(OUT_DIR, 'leak-src');
fs.mkdirSync(leakDir);
const secretTxt = path.join(leakDir, 'secret.txt');
fs.writeFileSync(secretTxt, `top ${secretMarker} secret\n`);
const leakMd = path.join(leakDir, 'leak.md');
fs.writeFileSync(leakMd, [
  '---',
  'title: Leak Test',
  '---',
  '',
  '## Body',
  '',
  '![x](secret.txt)',
  '',
].join('\n'));
const leakOut = path.join(OUT_DIR, 'leak.html');
try {
  execFileSync(process.execPath, [CONVERT, leakMd, leakOut, '--format', 'html', '--brand', 'classic'], { stdio: 'pipe' });
  const html = fs.readFileSync(leakOut, 'utf8');
  const b64Secret = fs.readFileSync(secretTxt).toString('base64');
  assert('html: non-image file content not embedded raw', !html.includes(secretMarker));
  assert('html: non-image file content not embedded as base64', !html.includes(b64Secret),
    'secret.txt was base64-embedded as a data URI');
} catch (e) {
  assert('html: non-image reference conversion succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test default folder output naming (html) ─────────────────────────────────
// Folder input with no explicit output → <folder-basename>.html in the CWD.
try {
  execFileSync(process.execPath, [CONVERT, mergeDir, '--format', 'html', '--brand', 'classic'], { cwd: OUT_DIR, stdio: 'pipe' });
  const expected = path.join(OUT_DIR, `${path.basename(mergeDir)}.html`);
  assert('html merge: default output is <folder>.html in CWD',
    fs.existsSync(expected),
    `expected ${expected}`);
} catch (e) {
  assert('html merge: default output naming succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test HTML escaping of hostile input ──────────────────────────────────────
const hostileMd = path.join(OUT_DIR, 'hostile.md');
fs.writeFileSync(hostileMd, [
  '---',
  'title: Hostile <img src=x onerror=alert(1)> "Doc"',
  '---',
  '',
  '# Hostile',
  '',
  '## Body',
  '',
  '![evil](x.png"onerror=alert(1))',
  '',
  '![He said "hi"](missing.png "a "quoted" title")',
  '',
].join('\n'));

const hostileOut = path.join(OUT_DIR, 'hostile.html');
try {
  execFileSync(process.execPath, [CONVERT, hostileMd, hostileOut, '--format', 'html', '--brand', 'classic'], { stdio: 'pipe' });
  const html = fs.readFileSync(hostileOut, 'utf8');
  assert('html escaping: image href cannot break out of src attribute',
    !/<img[^>]*src="[^"]*"onerror/.test(html) && !html.includes('src="x.png"onerror'));
  assert('html escaping: quote in image href is entity-encoded',
    html.includes('src="x.png&quot;onerror=alert(1)"'));
  assert('html escaping: hostile frontmatter title neutralized',
    !html.includes('<img src=x onerror'));
  assert('html escaping: quotes in alt/title stay inside the attribute',
    !/alt="[^"]*"hi"/.test(html) && !/title="[^"]*"quoted"/.test(html));
} catch (e) {
  assert('html escaping: generation succeeds', false, e.stderr?.toString() || e.message);
}

// ── Test folder + docx still rejected ────────────────────────────────────────
try {
  execFileSync(process.execPath, [CONVERT, mergeDir, path.join(OUT_DIR, 'merged.docx'), '--format', 'docx'], { stdio: 'pipe' });
  assert('edge: folder input rejects docx', false, 'should have thrown');
} catch {
  assert('edge: folder input rejects docx', true);
}

// ── Test format flag validation ──────────────────────────────────────────────
try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, '/dev/null', '--format', 'rtf'], { stdio: 'pipe' });
  assert('edge: unknown format rejected', false, 'should have thrown');
} catch {
  assert('edge: unknown format rejected', true);
}

// ── 2026 brand (--brand 2026) ────────────────────────────────────────────────
// ponytail: delete the classic-vs-2026 split here when the classic brand goes
const brand2026Md = path.join(OUT_DIR, 'brand-2026.md');
// Also the README sample outputs (test/output/brand-2026.{pdf,docx}); image paths
// are rewritten because the copy lives one folder below the fixture
fs.writeFileSync(brand2026Md, fs.readFileSync(FIXTURE, 'utf8')
  .replace(/^---\n/, '---\nsubtitle: "Second title line"\nsummary: "Cover summary paragraph."\nclassification: Confidential\n')
  .replace(/sample-image\.png/g, '../sample-image.png'));

for (const format of ['pdf', 'docx', 'html']) {
  const out = path.join(OUT_DIR, `brand-2026.${format}`);
  try {
    execFileSync(process.execPath, [CONVERT, brand2026Md, out, '--format', format, '--brand', '2026'], { stdio: 'pipe' });
    assert(`2026 ${format}: file created`, fs.existsSync(out) && fs.statSync(out).size > 10000);
  } catch (e) {
    assert(`2026 ${format}: generation succeeds`, false, e.stderr?.toString() || e.message);
  }
}

try {
  const docXml = execFileSync('unzip', ['-p', path.join(OUT_DIR, 'brand-2026.docx'), 'word/document.xml']).toString();
  const ftrXml = execFileSync('unzip', ['-p', path.join(OUT_DIR, 'brand-2026.docx'), 'word/footer*.xml']).toString();
  assert('2026 docx: Calistoga title in plum', docXml.includes('Calistoga') && docXml.includes('2F2450'));
  assert('2026 docx: subtitle and summary on cover',
    docXml.includes('>Second title line<') && docXml.includes('>Cover summary paragraph.<'));
  assert('2026 docx: classification in footer', ftrXml.includes('Confidential'));
  assert('2026 docx: classic green not used', !docXml.includes('058775'));
  const centred = docXml.split('</w:p>').find(p => p.includes('>pending<')) || '';
  assert('2026 docx: centred table column is centred', centred.includes('<w:jc w:val="center"/>'));
  const quoted = docXml.split('</w:p>').find(p => p.includes('>Quoted list item two<')) || '';
  assert('2026 docx: blockquote list rendered', quoted.includes('<w:i/>'));
  // Contents entries sit inside one TOC field so Word's "Update Table" refreshes all
  // their PAGEREFs at once (a bare PAGEREF updated on open reads 1 on every entry)
  const tocParas = docXml.split('</w:p>').filter(p => p.includes('PAGEREF _toc_'));
  const ends = p => (p.match(/fldCharType="end"/g) || []).length;
  assert('2026 docx: contents entries wrapped in one TOC field',
    (docXml.match(/TOC \\o &quot;2-4&quot; \\h/g) || []).length === 1
    && tocParas[0].includes('TOC \\o') && ends(tocParas.at(-1)) === 2);
  // No update on open: Word would rebuild the TOC field in its default TOC styles
  const settingsXml = execFileSync('unzip', ['-p', path.join(OUT_DIR, 'brand-2026.docx'), 'word/settings.xml']).toString();
  assert('2026 docx: no field update on open', !settingsXml.includes('updateFields') && !docXml.includes('w:dirty'));
  // Cover lockup: Word sits the icon on the baseline, so the wordmark is raised to centre on it
  assert('2026 docx: cover wordmark raised onto the icon', /<w:position w:val="\d+"\/>[\s\S]*?<w:t[^>]*>Cognizone<\/w:t>/.test(docXml));
  // Section numbers: the digit-wide mono dot is pulled in, so `1.1` does not read as `1 . 1`
  // H3: 9pt gap after the number; the gap below the rule is an exact-height spacer, because
  // Word draws space-after inside the border box
  assert('2026 docx: H3 number gap widened', /<w:spacing w:val="60"\/>[^<]*(<[^>]*>[^<]*){0,6}<w:t xml:space="preserve"> <\/w:t>/.test(docXml));
  assert('2026 docx: H3 spacer paragraph after each H3',
    (docXml.match(/w:lineRule="exact"/g) || []).length === (docXml.match(/w:val="Heading3"/g) || []).length);
  const numXml = execFileSync('unzip', ['-p', path.join(OUT_DIR, 'brand-2026.docx'), 'word/numbering.xml']).toString();
  assert('2026 docx: numbered lists hang 6.35mm so "10." keeps its tab, bullets 4.2mm',
    /<w:numFmt w:val="decimal"\/>[\s\S]*?<w:ind w:left="360" w:hanging="360"\/>/.test(numXml) &&
    /<w:lvlText w:val="•"\/>[\s\S]*?<w:ind w:left="360" w:hanging="240"\/>/.test(numXml));
  assert('2026 docx: level-1 bullet enlarged', /<w:lvlText w:val="•"\/>[\s\S]*?<w:sz w:val="30"\/>/.test(numXml));
  assert('2026 docx: section-number dots tightened', /<w:spacing w:val="-30"\/>[\s\S]*?<w:t[^>]*>\d\.<\/w:t>/.test(docXml));
} catch (e) {
  assert('2026 docx: content checks', false, e.message);
}

try {
  const html = fs.readFileSync(path.join(OUT_DIR, 'brand-2026.html'), 'utf8');
  assert('2026 html: Calistoga embedded', /@font-face\s*{[^}]*Calistoga/.test(html));
  assert('2026 html: plum brand colour', /#2F2450/i.test(html));
  assert('2026 html: bullet enlarged and H3 gaps widened',
    /ul > li::before \{[^}]*font-size: 1\.6em/.test(html) && /h3 \.section-num \{[^}]*margin-right: 6pt/.test(html));
  assert('2026 html: section-number dots tightened', /\d<span class="num-dot">\.<\/span>\d/.test(html) && html.includes('.num-dot {'));
  assert('2026 html: subtitle and summary on cover',
    html.includes('Second title line') && html.includes('Cover summary paragraph.'));
  assert('2026 html: no external requests', !/(src|href)=["']https?:\/\/(?!cogni\.zone)/.test(html.replace(/<a [^>]*>/g, '')));
} catch (e) {
  assert('2026 html: content checks', false, e.message);
}

// ── 2026 Word renderer: mermaid, lists, entities, images ─────────────────────
// Mermaid checks on the 2026 fixture output above, as for classic
try {
  const mermaid = mermaidDrawings(path.join(OUT_DIR, 'brand-2026.docx'));
  const left = mermaid.filter(d => d.para.includes('<w:jc w:val="left"/>'));
  assert('2026 docx mermaid: one drawing per diagram; the maxWidth=200 align=left one is left and ≤ 200px',
    mermaid.length === FIXTURE_MERMAIDS && left.length === 1 && left[0].cx <= 200 * 9525,
    `${mermaid.length} mermaid drawings, left extents: [${left.map(d => d.cx).join(', ')}]`);
} catch (e) {
  assert('2026 docx mermaid: extent/alignment checks', false, e.stderr?.toString() || e.message);
}

// One document for the Word renderer fixes. Images are built here, no image tools needed:
// a 1200×240 grey baseline JPEG (one 1-bit Huffman code each for "DC 0" and "end of
// block", so every 8×8 block is two zero bits) and a GIF with a 40×120 logical screen
try {
  const dir = path.join(OUT_DIR, 'word-fixes');
  fs.mkdirSync(dir);
  const seg = (marker, body) => Buffer.from([0xFF, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
  const huffman = tableClass => [tableClass, 1, ...Array(15).fill(0), 0];
  fs.writeFileSync(path.join(dir, 'wide.jpg'), Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    seg(0xDB, [0, ...Array(64).fill(1)]),
    seg(0xC0, [8, 0, 240, 1200 >> 8, 1200 & 255, 1, 1, 0x11, 0]),
    seg(0xC4, [...huffman(0x00), ...huffman(0x10)]),
    seg(0xDA, [1, 1, 0x00, 0, 63, 0]),
    Buffer.alloc(150 * 30 * 2 / 8),
    Buffer.from([0xFF, 0xD9]),
  ]));
  fs.writeFileSync(path.join(dir, 'tall.gif'),
    Buffer.from('474946383961280078008000' + '00ffffff000000' + '2c00000000010001000002024401003b', 'hex'));
  fs.copyFileSync(path.join(__dirname, 'sample-image.png'), path.join(dir, 'pic one.png'));
  const marker = 'NOT_AN_IMAGE_MARKER_4711';
  fs.writeFileSync(path.join(dir, 'notes.png'), `plain text ${marker}\n`);
  fs.writeFileSync(path.join(dir, 'drawing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#c85a8a"/></svg>');
  const md = path.join(dir, 'word-fixes.md');
  fs.writeFileSync(md, [
    '---', 'title: Word fixes', '---', '',
    '## Lists', '',
    '> 1. Quoted', '',
    '1. Alpha', '2. Beta', '',
    'Interrupting paragraph.', '',
    '3. Gamma', '4. Delta', '',
    '- ### Listed heading', '',
    '- ```js', '  const fenced = 1;', '  ```', '',
    '## Text', '',
    'Tom &amp; Jerry &copy; and `&lt;b&gt;` stays.', '',
    '```', 'code &lt;i&gt; stays', '```', '',
    '## Images', '',
    '![wide](wide.jpg)', '',
    '<img src="tall.gif" width="20">', '',
    '![spaced](pic%20one.png)', '',
    '<p><img src="pic one.png"> <img src="wide.jpg" height="40"></p>', '',
    'Inline <img src="tall.gif" height="30"> image.', '',
    '![text](notes.png)', '',
    '![vector](drawing.svg)', '',
  ].join('\n'));
  const out = path.join(dir, 'word-fixes.docx');
  execFileSync(process.execPath, [CONVERT, md, out, '--format', 'docx'], { stdio: 'pipe' });
  const xml = execFileSync('unzip', ['-p', out, 'word/document.xml']).toString();
  const numXml = execFileSync('unzip', ['-p', out, 'word/numbering.xml']).toString();
  const paraWith = text => xml.split('</w:p>').find(p => p.includes(text)) || '';

  // #9: a numbered list inside a quote is counted, so later lists get a real numId
  const numIds = [...xml.matchAll(/<w:numId w:val="([^"]+)"\/>/g)].map(m => m[1]);
  const defined = new Set([...numXml.matchAll(/<w:num w:numId="(\d+)"/g)].map(m => m[1]));
  assert('2026 docx: every list numId is defined, also after a numbered list in a quote',
    numIds.length > 0 && !xml.includes('{ordered-list') && numIds.every(id => /^\d+$/.test(id) && defined.has(id)),
    `numIds: ${numIds.join(', ')}`);
  // #20 + restarts: separate lists use separate definitions; "3." resumes at 3
  const [quoted, alpha, gamma] = ['Quoted', 'Alpha', 'Gamma'].map(t => listNumbering(xml, numXml, t));
  assert('2026 docx: separate ordered lists use different numIds and abstractNumIds, starting at 1',
    new Set([quoted.numId, alpha.numId, gamma.numId]).size === 3
    && new Set([quoted.abstractNumId, alpha.abstractNumId, gamma.abstractNumId]).size === 3
    && quoted.start === '1' && alpha.start === '1' && alpha.startOverride === '1',
    JSON.stringify({ quoted, alpha }));
  assert('2026 docx: ordered list keeps its start number (3. resumes at 3)',
    gamma.start === '3' && gamma.startOverride === '3', JSON.stringify(gamma));
  // #18: a heading or code fence first in a list item renders as that block
  const heading = xml.split('</w:p>').find(p => p.includes('>Listed heading<') && !p.includes('PAGEREF')) || '';
  const bookmark = (heading.match(/<w:bookmarkStart w:name="(_toc_\d+)"/) || [])[1];
  assert('2026 docx: heading first in a list item keeps the bookmark its contents PAGEREF points to',
    bookmark && xml.includes(`PAGEREF ${bookmark} \\h`), bookmark);
  assert('2026 docx: code fence first in a list item renders as a code block',
    paraWith('>const fenced = 1;<').includes('Roboto Mono') && !xml.includes('```'));
  // a block inside a list item starts at the item's text indent and ends at the right margin
  const tableWith = text => (xml.split('</w:tbl>').find(t => t.includes(text)) || '').split('<w:tbl>').pop();
  const listed = tableWith('>const fenced = 1;<'), plain = tableWith('>code &amp;lt;i&amp;gt; stays<');
  assert('2026 docx: code block in a list item is indented to the item text; a top-level one is not',
    listed.includes('<w:tblInd w:type="dxa" w:w="360"/>') && listed.includes('<w:tblW w:type="dxa" w:w="9277"/>')
    && plain.includes('<w:tblW') && !plain.includes('<w:tblInd'),
    (listed.match(/<w:tblW[^>]*>|<w:tblInd[^>]*>/g) || []).join(' '));
  // #19: fenced code verbatim, inline code decoded once, prose entities decoded
  assert('2026 docx: entities: fenced &lt; stays literal, inline code decoded once, prose &amp; shows &',
    xml.includes('>code &amp;lt;i&amp;gt; stays<') && xml.includes('>&amp;lt;b&amp;gt;<')
    && xml.includes('>Tom &amp; Jerry © and <'));

  const drawings = docxDrawings(out);
  const px = d => [d.cx / 9525, d.cy / 9525].join('x');
  const jpgs = drawings.filter(d => d.target.endsWith('.jpg'));
  const gifs = drawings.filter(d => d.target.endsWith('.gif'));
  // #21: real JPEG/GIF dimensions; a width- or height-only <img> keeps the aspect ratio
  assert('2026 docx: wide JPEG keeps its aspect ratio (1200×240 → 500×100)',
    jpgs.length === 2 && px(jpgs[0]) === '500x100', jpgs.map(px).join(', '));
  assert('2026 docx: <img> with only width or only height gets the other proportionally',
    gifs.length === 2 && jpgs.length === 2 && px(gifs[0]) === '20x60' && px(gifs[1]) === '10x30' && px(jpgs[1]) === '200x40',
    [...gifs, ...jpgs].map(px).join(', '));
  // #16: %20 in an image path is decoded (pic%20one.png and <img src="pic one.png">)
  assert('2026 docx: %-encoded image path found',
    !xml.includes('[spaced]') && drawings.filter(d => STATIC_IMAGES[0].equals(d.media)).length === 2);
  // #17: every <img> of an HTML block, and an inline <img>, become pictures
  assert('2026 docx: two <img> in one HTML block give two pictures',
    (jpgs[1]?.para.match(/<w:drawing>/g) || []).length === 2);
  assert('2026 docx: inline <img> becomes a picture, not tag text',
    (paraWith('>Inline <').match(/<w:drawing>/g) || []).length === 1 && !xml.includes('&lt;img'));
  // #5: a non-image file referenced as an image is not embedded; SVG embeds as a real PNG
  const media = execFileSync('unzip', ['-p', out, 'word/media/*']);
  assert('2026 docx: text file referenced as an image is not embedded',
    !media.includes(marker) && xml.includes('>[text]<'));
  assert('2026 docx: SVG is rasterized to PNG, not embedded as SVG bytes',
    !media.includes('<svg') && drawings.some(d => px(d) === '200x100' && d.media.readUInt32BE(0) === 0x89504E47));
} catch (e) {
  assert('2026 docx: Word renderer fixes', false, e.stderr?.toString() || e.message);
}

// Word: a link to "#heading-id" jumps to that heading, not to an external "#id"
try {
  const linkMd = path.join(OUT_DIR, 'anchor-link.md');
  fs.writeFileSync(linkMd, '---\ntitle: Anchor link\n---\n\n## One\n\nSee [Two](#two).\n\n## Two\n\nText.\n');
  const out = path.join(OUT_DIR, 'anchor-link.docx');
  execFileSync(process.execPath, [CONVERT, linkMd, out, '--format', 'docx'], { stdio: 'pipe' });
  const xml = execFileSync('unzip', ['-p', out, 'word/document.xml']).toString();
  const rels = execFileSync('unzip', ['-p', out, 'word/_rels/document.xml.rels']).toString();
  const target = (xml.match(/<w:bookmarkStart w:name="(_toc_\d+)"[^>]*\/>(?:(?!<\/w:p>).)*>Two</) || [])[1];
  assert('2026 docx: in-document link jumps to its heading bookmark',
    target && (xml.split('</w:p>').find(p => p.includes('>See <')) || '').includes(`w:anchor="${target}"`)
    && !rels.includes('Target="#two"'), target);
} catch (e) {
  assert('2026 docx: in-document link jumps to its heading bookmark', false, e.stderr?.toString() || e.message);
}

// --no-external-links: external and relative links become plain text, "#anchor" links stay
try {
  const md = path.join(OUT_DIR, 'no-ext-links.md');
  fs.writeFileSync(md, '---\ntitle: No external links\n---\n\n## One\n\n'
    + 'Para [**site**](https://example.com/a) and [spec](other-spec.md#x) and [Two](#two).\n\n'
    + '- item [gh](https://github.com/x/y)\n\n| A |\n|---|\n| [cell](https://example.com/c) |\n\n## Two\n\nText.\n');
  const htmlOut = path.join(OUT_DIR, 'no-ext-links.html');
  execFileSync(process.execPath, [CONVERT, md, htmlOut, '--format', 'html', '--no-external-links'], { stdio: 'pipe' });
  const html = fs.readFileSync(htmlOut, 'utf8');
  assert('no-external-links html: external/relative links gone, text kept, #anchor kept',
    !/href="(https:\/\/(example|github)\.com|other-spec\.md)/.test(html)
    && html.includes('<p>Para <strong>site</strong> and spec and <a href="#two">Two</a>.</p>')
    && html.includes('item gh') && html.includes('<td>cell</td>'));
  const docxOut = path.join(OUT_DIR, 'no-ext-links.docx');
  execFileSync(process.execPath, [CONVERT, md, docxOut, '--format', 'docx', '--no-external-links'], { stdio: 'pipe' });
  const xml = execFileSync('unzip', ['-p', docxOut, 'word/document.xml']).toString();
  const rels = execFileSync('unzip', ['-p', docxOut, 'word/_rels/document.xml.rels']).toString();
  assert('no-external-links docx: no hyperlink rels, #anchor still an internal link',
    !rels.includes('TargetMode="External"') && xml.includes('>cell<')
    && /w:anchor="_toc_\d+"/.test(xml.split('</w:p>').find(p => p.includes('>Para <')) || ''));
  const pdfOut = path.join(OUT_DIR, 'no-ext-links.pdf');
  execFileSync(process.execPath, [CONVERT, md, pdfOut, '--format', 'pdf', '--no-external-links'], { stdio: 'pipe' });
  const pdf = fs.readFileSync(pdfOut).toString('latin1');
  assert('no-external-links pdf: no external URIs', !/\/URI\s*\((https|file)/.test(pdf));
} catch (e) {
  assert('no-external-links: plain text links', false, e.stderr?.toString() || e.message);
}

// --relative-links: a relative link to another .md points at that doc's converted file
try {
  const md = path.join(OUT_DIR, 'rel-links.md');
  fs.writeFileSync(md, '---\ntitle: Relative links\n---\n\n## One\n\n'
    + 'See [case model](../EVR-10/case-model.md#states), [here](#one), [site](https://example.com) and [data](model.ttl).\n');
  const docxOut = path.join(OUT_DIR, 'rel-links.docx');
  execFileSync(process.execPath, [CONVERT, md, docxOut, '--format', 'docx', '--relative-links', '--no-external-links'], { stdio: 'pipe' });
  const rels = execFileSync('unzip', ['-p', docxOut, 'word/_rels/document.xml.rels']).toString();
  const ext = rels.match(/Target="[^"]*" TargetMode="External"/g) || [];
  assert('relative-links docx: .md link → sibling .docx, others plain text',
    ext.length === 1 && ext[0].startsWith('Target="../EVR-10/case-model.docx"'), ext.join(' '));
  const htmlOut = path.join(OUT_DIR, 'rel-links.html');
  execFileSync(process.execPath, [CONVERT, md, htmlOut, '--format', 'html', '--relative-links'], { stdio: 'pipe' });
  const html = fs.readFileSync(htmlOut, 'utf8');
  assert('relative-links html: .md link → .html, other links untouched without --no-external-links',
    html.includes('href="../EVR-10/case-model.html"') && html.includes('href="https://example.com"')
    && html.includes('href="model.ttl"') && html.includes('href="#one"'));
} catch (e) {
  assert('relative-links: rewrite to converted files', false, e.stderr?.toString() || e.message);
}

// --link-base: links become absolute, rooted at the cwd; a SharePoint library-view
// address ("AllItems.aspx?id=<folder path>") resolves to the folder itself
try {
  const dir = path.join(OUT_DIR, 'link-base', 'specs', 'EVR-13');
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'search.md');
  fs.writeFileSync(md, '---\ntitle: Link base\n---\n\n## One\n\nSee [case model](../EVR-10/case%20model.md#states) and [outside](../../../outside.md).\n');
  const out = path.join(dir, 'search.docx');
  execFileSync(process.execPath, [CONVERT, md, out, '--format', 'docx', '--no-external-links', '--link-base',
    'https://x.sharepoint.com/sites/REG/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FREG%2FShared%20Documents%2Fdelivery&viewid=1'],
    { cwd: path.join(OUT_DIR, 'link-base'), stdio: 'pipe' });
  const rels = execFileSync('unzip', ['-p', out, 'word/_rels/document.xml.rels']).toString();
  const xml = execFileSync('unzip', ['-p', out, 'word/document.xml']).toString();
  assert('link-base docx: link outside the cwd is plain text with --no-external-links',
    (rels.match(/TargetMode="External"/g) || []).length === 1 && xml.includes('outside'));
  assert('link-base docx: absolute SharePoint link (?web=1) from library-view URL',
    rels.includes('Target="https://x.sharepoint.com/sites/REG/Shared%20Documents/delivery/specs/EVR-10/case%20model.docx?web=1"'));
} catch (e) {
  assert('link-base docx: absolute SharePoint link (?web=1) from library-view URL', false, e.stderr?.toString() || e.message);
}

// ── 2026 HTML/PDF: active content, fence escaping, nested mermaid, image paths, TOC, cover ──
// Raw HTML in someone else's Markdown must not run (CSP), fence info strings and
// mermaid source must not break out of their markup. Every hostile payload
// appends to document.title, which Chrome writes into the PDF Info dictionary
// in plain text, so script execution shows in the PDF bytes without a PDF tool.
// pdftotext (poppler), when installed, also checks text and page numbers.
{
  const { spawnSync } = require('child_process');
  const hasPdftotext = !spawnSync('pdftotext', ['-v']).error;
  const pdfPages = f => execFileSync('pdftotext', ['-layout', f, '-']).toString().split('\f');
  const skip = hasPdftotext ? '' : ' (skipped: pdftotext not installed)';
  const dir = path.join(OUT_DIR, 'review-src');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'LEAKED_LOCAL_FILE\n');
  fs.copyFileSync(path.join(__dirname, 'sample-image.png'), path.join(dir, 'pic one.png'));
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  // (the page-number estimate is exact for this layout; some headings that land
  // near a page bottom are still off by one, cover or not)
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(6);
  const sections = names.map((n, i) => `## Part ${n}\n\n${Array(3 + 2 * i).fill(para).join('\n\n')}\n\n### Sub ${n}\n\n${para}\n`);
  const hostile = [
    '<script>document.title += " PWNED_SCRIPT"</script>',
    '<img src="missing.png" onerror="document.title += \' PWNED_ONERROR\'">',
    '<style>@keyframes k { from { opacity: 0.9 } to { opacity: 1 } }</style>',
    '<div style="animation: k 0.01s" onanimationend="document.title += \' PWNED_ANIM\'">box</div>',
    '~~~x"><img src=x onerror="document.title += \' PWNED_FENCE\'">\ncode\n~~~',
    '```mermaid\ngraph TD\nNodeAlpha-->NodeBeta\n%% </pre><script>document.title += " PWNED_MERMAID"</script><pre>\n```',
    '<iframe src="secret.txt"></iframe>',
    '<object data="secret.txt"></object>',
    '[js link](javascript:void(0))',
  ].join('\n\n');
  // 60-sentence summary: the cover overflows its page
  const summary = Array(60).fill('This summary sentence is long enough to fill the cover.').join(' ');
  const md = path.join(dir, 'hostile.md');
  fs.writeFileSync(md, `---\ntitle: Review hostile\nsummary: "${summary}"\n---\n\n${sections.join('\n')}\n## Part Hostile\n\n${hostile}\n`);

  // HTML: CSP first in <head>, only the tool's scripts carry the nonce
  try {
    const out = path.join(OUT_DIR, 'review-hostile.html');
    execFileSync(process.execPath, [CONVERT, md, out], { stdio: 'pipe' });
    const html = fs.readFileSync(out, 'utf8');
    const nonce = (html.match(/^<!DOCTYPE html>\s*<html[^>]*>\s*<head>\s*<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-([A-Za-z0-9+/=]{16,})'; object-src 'none'; frame-src 'none'">/) || [])[1];
    assert('2026 html: Content-Security-Policy is the first thing in <head>', nonce, html.slice(0, 300));
    const nonced = html.split(`<script nonce="${nonce}">`).length - 1;
    assert('2026 html: the mermaid bundle and init carry the CSP nonce',
      nonce && nonced === 2 && html.includes(`<script nonce="${nonce}">\n  mermaid.initialize`), `${nonced} nonce scripts`);
    assert('2026 html: fence info string escaped, first word only',
      html.includes('<code class="language-x&quot;&gt;&lt;img">') && !html.includes('PWNED_FENCE\'">'));
    assert('2026 html: mermaid source escaped', html.includes('%% &lt;/pre&gt;&lt;script&gt;'));
  } catch (e) {
    assert('2026 html: hostile document converts', false, e.stderr?.toString() || e.message);
  }

  // PDF: nothing runs or loads, mermaid still renders, the long cover warns and
  // counts as one page for the TOC numbers
  try {
    const out = path.join(OUT_DIR, 'review-hostile.pdf');
    const r = spawnSync(process.execPath, [CONVERT, md, out], { encoding: 'utf8' });
    assert('2026 pdf: hostile document converts', r.status === 0, r.stderr);
    const bytes = fs.readFileSync(out).toString('latin1');
    assert('2026 pdf: no script, handler or mermaid breakout ran', bytes.includes('/Title (Review hostile)') && !bytes.includes('PWNED'),
      (bytes.match(/\/Title \([^)]*\)/) || [])[0]);
    assert('2026 pdf: overflowing cover warns on stderr', r.stderr.includes('cover content does not fit on one page'), r.stderr);
    const pages = hasPdftotext ? pdfPages(out) : [];
    const text = pages.join('\f');
    assert(`2026 pdf: iframe/object load no local file; mermaid renders${skip}`,
      !hasPdftotext || (!text.includes('LEAKED_LOCAL_FILE') && !text.includes('PWNED') && text.includes('NodeAlpha')));
    const wrong = !hasPdftotext ? [] : names.map(n => {
      const toc = +((pages[1].match(new RegExp(`Part ${n}\\s+(\\d+)`)) || [])[1]);
      const real = pages.findIndex((p, i) => i > 1 && new RegExp(`^\\s*(CHAPTER \\d+\\s*)?Part ${n}\\s*$`, 'm').test(p)) + 1;
      return toc === real ? '' : `${n}: toc ${toc}, real ${real}`;
    }).filter(Boolean);
    assert(`2026 pdf: TOC page numbers right after an overflowing cover${skip}`, !wrong.length, wrong.join('; '));
  } catch (e) {
    assert('2026 pdf: hostile document converts', false, e.stderr?.toString() || e.message);
  }

  // HTML: a mermaid fence only inside a blockquote / list item still inlines the bundle
  try {
    const nested = path.join(dir, 'nested-mermaid.md');
    fs.writeFileSync(nested, '---\ntitle: Nested\n---\n\n## S\n\n> ```mermaid\n> graph TD\n> A-->B\n> ```\n\n- item\n\n  ```mermaid\n  graph TD\n  C-->D\n  ```\n');
    const out = path.join(OUT_DIR, 'review-nested-mermaid.html');
    execFileSync(process.execPath, [CONVERT, nested, out], { stdio: 'pipe' });
    assert('2026 html: nested mermaid fence inlines the bundle', fs.readFileSync(out, 'utf8').includes('mermaid.initialize'));
  } catch (e) {
    assert('2026 html: nested mermaid fence inlines the bundle', false, e.stderr?.toString() || e.message);
  }

  // HTML: %20-encoded, <angle-bracket> and single-quoted raw image paths all embed
  try {
    const imgMd = path.join(dir, 'images.md');
    fs.writeFileSync(imgMd, "---\ntitle: Images\n---\n\n## S\n\n![a](pic%20one.png)\n\n![b](<pic one.png>)\n\n<img src='pic one.png' alt='c'>\n");
    const out = path.join(OUT_DIR, 'review-images.html');
    execFileSync(process.execPath, [CONVERT, imgMd, out], { stdio: 'pipe' });
    const html = fs.readFileSync(out, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    const srcs = [...html.matchAll(/<img\s[^>]*src=(["'])(.*?)\1/g)].map(m => m[2].slice(0, 22));
    assert('2026 html: %20 and single-quoted image paths embedded',
      srcs.length === 5 && srcs.every(s => s.startsWith('data:image/png')), srcs.join(' '));
  } catch (e) {
    assert('2026 html: %20 and single-quoted image paths embedded', false, e.stderr?.toString() || e.message);
  }

  // TOC: a deep start (H3 before any H2) and a skipped level (H2 → H4 → H3) stay well-formed
  const tocDir = path.join(dir, 'toc');
  fs.mkdirSync(tocDir);
  fs.writeFileSync(path.join(tocDir, 'a.md'), '---\ntitle: Toc A\n---\n\n### First\n\nx\n\n## Next\n\n#### Deep\n\n### Mid\n\n## Last\n\n![a](../pic%20one.png)\n');
  fs.writeFileSync(path.join(tocDir, 'b.md'), '---\ntitle: Toc B\n---\n\n## One\n\n#### Skipped\n\n## Two\n');
  try {
    const out = path.join(OUT_DIR, 'review-toc.html');
    execFileSync(process.execPath, [CONVERT, path.join(tocDir, 'a.md'), out], { stdio: 'pipe' });
    const nav = (fs.readFileSync(out, 'utf8').match(/<nav id="TOC">[\s\S]*?<\/nav>/) || [''])[0];
    const { error, depth = {} } = tocStructure(nav);
    assert('2026 html: TOC with skipped levels is a well-formed nested list',
      !error && depth.mid > depth.next && depth.deep > depth.next && depth.last === depth.next, error || JSON.stringify(depth));
    const merged = path.join(OUT_DIR, 'review-toc-merged.html');
    execFileSync(process.execPath, [CONVERT, tocDir, merged], { stdio: 'pipe' });
    const navs = fs.readFileSync(merged, 'utf8').match(/<nav id="TOC">[\s\S]*?<\/nav>/g) || [];
    const errors = navs.map(n => tocStructure(n).error).filter(Boolean);
    assert('2026 html merge: every TOC is a well-formed nested list', navs.length === 3 && !errors.length, errors.join('; '));
  } catch (e) {
    assert('2026 html: TOC with skipped levels', false, e.stderr?.toString() || e.message);
  }

  // PDF folder merge (2026): both documents, and the %20 image resolved once (not %2520)
  try {
    const out = path.join(OUT_DIR, 'review-merged.pdf');
    execFileSync(process.execPath, [CONVERT, tocDir, out], { stdio: 'pipe' });
    const bytes = fs.readFileSync(out).toString('latin1');
    assert('2026 pdf merge: PDF with the %20-encoded image embedded',
      bytes.startsWith('%PDF-') && /\/Width 232\b/.test(bytes));   // sample-image.png is 232 × 48
    const text = hasPdftotext ? pdfPages(out).join('\f') : '';
    assert(`2026 pdf merge: both documents' titles present${skip}`, !hasPdftotext || (text.includes('Toc A') && text.includes('Toc B')));
  } catch (e) {
    assert('2026 pdf merge: generation succeeds', false, e.stderr?.toString() || e.message);
  }
}

// Chrome embeds a variable font as Type 3 outlines (no BaseFont), which viewers draw thin;
// the 2026 PDF uses static instances, which embed as named TrueType fonts
{
  const pdf = fs.readFileSync(path.join(OUT_DIR, 'brand-2026.pdf')).toString('latin1');
  assert('2026 pdf: Roboto and Roboto Mono embed as TrueType, not Type 3',
    /\/BaseFont \/[A-Z]{6}\+Roboto-Regular/.test(pdf) && /\/BaseFont \/[A-Z]{6}\+RobotoMono-Bold/.test(pdf));
}

// No flag and no frontmatter → 2026 (the default); `brand: classic` in frontmatter opts out
for (const [label, fm, want2026] of [['default is 2026', '', true], ['frontmatter brand selects classic', 'brand: classic\n', false]]) {
  try {
    const fmMd = path.join(OUT_DIR, 'brand-fm.md');
    fs.writeFileSync(fmMd, `---\ntitle: FM brand\n${fm}---\n\n## One\n\nText.\n`);
    const out = path.join(OUT_DIR, 'brand-fm.docx');
    execFileSync(process.execPath, [CONVERT, fmMd, out, '--format', 'docx'], { stdio: 'pipe' });
    const xml = execFileSync('unzip', ['-p', out, 'word/document.xml']).toString();
    assert(`brand: ${label}`, xml.includes('Calistoga') === want2026);
  } catch (e) {
    assert(`brand: ${label}`, false, e.stderr?.toString() || e.message);
  }
}

// The output extension picks the format when --format is absent; a mismatch with --format is an error
{
  const md = path.join(OUT_DIR, 'ext-format.md');
  fs.writeFileSync(md, '---\ntitle: Ext format\n---\n\n## One\n\nText.\n');
  for (const [ext, magic] of [['docx', 'PK'], ['html', '<!DOCTYPE html>']]) {
    const out = path.join(OUT_DIR, `ext-format.${ext}`);
    try {
      execFileSync(process.execPath, [CONVERT, md, out], { stdio: 'pipe' });
      assert(`cli: output .${ext} without --format writes ${ext}`, fs.readFileSync(out, 'latin1').startsWith(magic));
    } catch (e) {
      assert(`cli: output .${ext} without --format writes ${ext}`, false, e.stderr?.toString() || e.message);
    }
  }
  const out = path.join(OUT_DIR, 'ext-mismatch.docx');
  fs.rmSync(out, { force: true });
  try {
    execFileSync(process.execPath, [CONVERT, md, out, '--format', 'pdf'], { stdio: 'pipe' });
    assert('cli: output .docx with --format pdf rejected', false, 'should have thrown');
  } catch (e) {
    assert('cli: output .docx with --format pdf rejected', e.status !== 0 && !fs.existsSync(out), e.stderr?.toString());
  }
  try {
    const upper = path.join(OUT_DIR, 'ext-format-upper.HTML');
    execFileSync(process.execPath, [CONVERT, md, upper], { stdio: 'pipe' });
    assert('cli: uppercase .HTML output writes html', fs.readFileSync(upper, 'utf8').startsWith('<!DOCTYPE html>'));
  } catch (e) {
    assert('cli: uppercase .HTML output writes html', false, e.stderr?.toString() || e.message);
  }
  for (const [label, extra, want] of [
    ['folder input with .docx output and no --format rejected', [mergeDir, path.join(OUT_DIR, 'merged-noflag.docx')], 'Folder input only supports pdf and html'],
    ['--format nope rejected as unknown format', [md, path.join(OUT_DIR, 'x.docx'), '--format', 'nope'], 'Unknown format'],
  ]) {
    try {
      execFileSync(process.execPath, [CONVERT, ...extra], { stdio: 'pipe' });
      assert(`cli: ${label}`, false, 'should have thrown');
    } catch (e) {
      assert(`cli: ${label}`, e.status !== 0 && (e.stderr?.toString() || '').includes(want), e.stderr?.toString());
    }
  }
}

try {
  execFileSync(process.execPath, [CONVERT, FIXTURE, '/dev/null', '--brand', 'nope'], { stdio: 'pipe' });
  assert('edge: unknown brand rejected', false, 'should have thrown');
} catch {
  assert('edge: unknown brand rejected', true);
}

// ── Parse and CLI review findings ────────────────────────────────────────────
{
  const dir = path.join(OUT_DIR, 'review-a');
  fs.mkdirSync(dir);
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const run = (argv, opts = {}) => {
    try {
      const stdout = execFileSync(process.execPath, [CONVERT, ...argv], { stdio: 'pipe', ...opts }).toString();
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
    }
  };
  const noStack = s => !/\n\s+at /.test(s);

  // H1 stripping works on tokens: only a leading H1 goes, code and later H1s stay
  {
    const p = parseMarkdown(write('no-h1.md', '---\ntitle: T\n---\n\n## Setup\n\n```bash\n# keep me\n```\n'));
    assert('review: "# line" in a code fence survives without a leading H1',
      p.mdNoH1.includes('# keep me') && p.tokens.some(t => t.type === 'code' && t.text.includes('# keep me')));
    const q = parseMarkdown(write('two-h1.md', '# Title\n\n## A\n\n# Part Two\n\n## B\n'));
    assert('review: leading H1 stripped, later H1 kept',
      !q.mdNoH1.includes('# Title') && q.mdNoH1.includes('# Part Two') && q.tocEntries.map(e => e.text).join('|') === 'A|Part Two|B');
  }

  // JavaScript frontmatter is refused, not evaluated
  {
    const md = write('js-fm.md', '---javascript\n({title: "EVALUATED" + 1})\n---\n\n## A\n');
    const r = run([md, path.join(dir, 'js-fm.html')]);
    assert('review: ---javascript frontmatter refused with a one-line error',
      r.status === 1 && r.stderr.includes('only YAML frontmatter is supported') && noStack(r.stderr)
      && !fs.existsSync(path.join(dir, 'js-fm.html')), r.stderr);
  }

  // The default output name never equals the input; an explicit same-file output is refused
  {
    const src = '---\ntitle: Up\n---\n\n## A\n\nText.\n';
    const upper = write('UPPER.MD', src);
    const r = run([upper, '-f', 'html']);
    assert('review: INPUT.MD -f html writes INPUT.html, input untouched',
      r.status === 0 && fs.readFileSync(upper, 'utf8') === src && fs.existsSync(path.join(dir, 'UPPER.html')), r.stderr);
    const same = write('same.md', src);
    const s = run([same, same]);
    assert('review: output equal to the input is refused',
      s.status === 1 && s.stderr.includes('would overwrite the input') && fs.readFileSync(same, 'utf8') === src, s.stderr);
  }

  // Unknown options, missing values and extra positionals are errors
  {
    const md = write('args.md', '---\ntitle: Args\n---\n\n## A\n');
    for (const [label, argv, want] of [
      ['misspelt option', [md, '-f', 'html', '--no-external-link'], 'Unknown option: --no-external-link'],
      ['option without its value', [md, '-f', 'html', '-b'], 'Missing value for -b'],
      ['third positional argument', [md, path.join(dir, 'a1.html'), path.join(dir, 'a2.html')], 'Unexpected argument'],
    ]) {
      const r = run(argv, { cwd: dir });
      assert(`review: cli rejects ${label}`,
        r.status === 1 && r.stderr.includes(want) && r.stderr.includes('--help')
        && !fs.existsSync(path.join(dir, '--no-external-link')) && !fs.existsSync(path.join(dir, '-b')), r.stderr);
    }
  }

  // Folder merge: .MD / .markdown files are included; "#anchor" links get the doc prefix
  {
    const merge = path.join(dir, 'merge');
    fs.mkdirSync(merge);
    fs.writeFileSync(path.join(merge, 'a.md'), '---\ntitle: Doc A\n---\n\n## One\n\n[Go A](#one)\n');
    fs.writeFileSync(path.join(merge, 'b.MD'), '---\ntitle: Doc B\n---\n\n## One\n\n[Go B](#one)\n');
    fs.writeFileSync(path.join(merge, 'c.markdown'), '---\ntitle: Doc C\n---\n\n## Three\n');
    const out = path.join(dir, 'merge.html');
    const r = run([merge, out]);
    const html = r.status === 0 ? fs.readFileSync(out, 'utf8') : '';
    assert('review: folder merge includes .MD and .markdown files',
      html.includes('Doc B') && html.includes('Doc C'), r.stderr);
    assert('review: merged "#anchor" link reaches its own document\'s heading',
      html.includes('<a href="#doc-1-one">Go B</a>') && html.includes('id="doc-1-one"')
      && html.includes('<a href="#doc-0-one">Go A</a>'), (html.match(/<a href="#doc-\d-one">[^<]*/g) || []).join(' '));
  }

  // javascript:/vbscript:/data: links become plain text; raw <a href> obeys --no-external-links
  {
    const md = write('unsafe.md', '---\ntitle: Unsafe\n---\n\n## One\n\n'
      + '[js](javascript:alert(1)) [js2](JaVaScRiPt&#58;alert(2)) [vb](vbscript:x) [dat](data:text/html,x) [ok](#one)\n\n'
      + 'Inline <a href="https://example.com/raw">raw</a> and <a href="#one">here</a>.\n\n'
      + '<div><a href=\'https://example.com/block\'>blk</a></div>\n');
    const out = path.join(dir, 'unsafe.html');
    let r = run([md, out]);
    let html = r.status === 0 ? fs.readFileSync(out, 'utf8') : '';
    assert('review: javascript:/vbscript:/data: links become plain text',
      r.status === 0 && !/href="\s*(javascript|vbscript|data)/i.test(html) && !html.includes('&#58;alert')
      && /js js2 vb dat <a href="#one">ok<\/a>/.test(html), r.stderr);
    r = run([md, out, '--no-external-links']);
    html = r.status === 0 ? fs.readFileSync(out, 'utf8') : '';
    assert('review: --no-external-links strips raw HTML <a href> too, keeps its text and #anchors',
      r.status === 0 && !html.includes('example.com/') && html.includes('Inline raw and <a href="#one">here</a>.')
      && html.includes('<div>blk</div>'), r.stderr);
  }

  // Heading ids: unique against every issued id, non-empty; plain text from inline tokens
  {
    const p = parseMarkdown(write('ids.md', '## Foo\n\n## Foo\n\n## Foo-2\n\n## 日本語\n\n'
      + '## See [API](https://example.com) &amp; _details_\n\n## snake_case name\n'));
    assert('review: heading ids unique and never empty',
      p.tocEntries.map(e => e.id).join(' ') === 'foo foo-2 foo-2-2 section see-api-details snakecase-name',
      p.tocEntries.map(e => e.id).join(' '));
    assert('review: formatted heading TOC text has no URL or entity',
      p.tocEntries[4].text === 'See API & details', p.tocEntries[4].text);
    const fixtureIds = parseMarkdown(FIXTURE).tocEntries.map(e => e.id);
    assert('review: fixture heading ids unchanged',
      fixtureIds.includes('third-level-heading-h3') && fixtureIds.includes('fourth-level-heading-h4') && fixtureIds.includes('special-characters'));
  }

  // version: only a plain one-line scalar is read raw
  {
    const v = fm => parseMarkdown(write('v.md', `---\n${fm}---\n\n## H\n`)).version;
    assert('review: empty version does not swallow the next line', v('version:\nstatus: draft\n') === '');
    assert('review: version comment ignored', v('version: 1.0 # current\n') === '1.0');
  }

  // --link-base: per-segment decoding, "..name" inside the root, http(s) only, same-origin id
  {
    const md = write('lb.md', '---\ntitle: LB\n---\n\n## One\n\n[hash](a%23b.md) [dots](..draft.md)\n');
    const out = path.join(dir, 'lb.html');
    const r = run([md, out, '--link-base', 'https://example.com/base/'], { cwd: dir });
    const html = r.status === 0 ? fs.readFileSync(out, 'utf8') : '';
    assert('review: --link-base keeps "%23" single-encoded and "..draft.md" inside the root',
      html.includes('href="https://example.com/base/a%23b.html"') && html.includes('href="https://example.com/base/..draft.html"'), r.stderr);
    for (const [label, base, want] of [
      ['non-http scheme', 'javascript:alert(1)', 'must be an http(s) URL'],
      ['SharePoint id pointing to another site', 'https://good.example/Forms/AllItems.aspx?id=https%3A%2F%2Fevil.example%2F', 'id parameter'],
    ]) {
      const e = run([md, out, '--link-base', base], { cwd: dir });
      assert(`review: --link-base rejects ${label}`, e.status === 1 && e.stderr.includes(want) && noStack(e.stderr), e.stderr);
    }
  }

  // The wrapper answers --help and --version itself
  try {
    const wrapper = path.join(__dirname, '..', 'bin', 'cognizone-convert.js');
    const help = execFileSync(process.execPath, [wrapper, '--help'], { stdio: 'pipe' }).toString();
    assert('review: wrapper --help prints usage', help.includes('Usage'));
    const version = execFileSync(process.execPath, [wrapper, '--version'], { stdio: 'pipe' }).toString().trim();
    assert('review: wrapper --version prints the package version', version === require('../package.json').version, version);
  } catch (e) {
    assert('review: wrapper --help / --version exit 0', false, e.stderr?.toString() || e.message);
  }
}

// A title H1 after a leading HTML comment is still the title; entity decoding never throws
// and never resolves names through Object.prototype; a <meta refresh> must not get another
// (local) file printed as the PDF
{
  const dir = path.join(OUT_DIR, 'review-misc');
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'doc.md');
  fs.writeFileSync(md, '---\ntitle: Misc\n---\n\n<!-- lint-disable -->\n\n# Misc title\n\n## One &#99999999; &constructor; &#xD800;\n\n[x](http://a/?q=&#99999999;)\n\n```sh\n# keep this comment\n```\n');
  try {
    const parsed = parseMarkdown(md);
    assert('review: title H1 after a leading HTML comment is stripped, "# comment" in code kept',
      !parsed.tokens.some(t => t.type === 'heading' && t.depth === 1) && parsed.tokens.some(t => t.type === 'code' && t.text.includes('# keep this comment')));
    assert('review: invalid or unknown entities stay as written', parsed.tocEntries[0].text === 'One &#99999999; &constructor; &#xD800;', parsed.tocEntries[0].text);
  } catch (e) {
    assert('review: title after HTML comment / entity decoding', false, e.message);
  }
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'LOCAL_SECRET_MARKER\n');
  const refresh = path.join(dir, 'refresh.md');
  const out = path.join(dir, 'refresh.pdf');
  fs.writeFileSync(refresh, '---\ntitle: Refresh\n---\n\n## One\n\n<meta http-equiv="refresh" content="0;url=secret.txt">\n');
  try {
    execFileSync(process.execPath, [CONVERT, refresh, out], { stdio: 'pipe' });
    assert('review: 2026 pdf refuses a document that navigates away (meta refresh)', false, 'should have thrown');
  } catch (e) {
    assert('review: 2026 pdf refuses a document that navigates away (meta refresh)',
      !fs.existsSync(out) && (e.stderr?.toString() || '').includes('tries to load another page'), e.stderr?.toString().slice(0, 200));
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('');
for (const t of tests) {
  const icon = t.ok ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
  console.log(`  ${icon} ${t.name}${t.detail ? ` (${t.detail})` : ''}`);
}
console.log(`\n  ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
