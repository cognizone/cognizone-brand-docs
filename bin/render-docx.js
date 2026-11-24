'use strict';
// DOCX renderer: takes parsed markdown data, produces a branded Word document.
// Styling follows reference/brand-2026-spec.md.

const docx = require('docx');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { parseMermaidOpts } = require('./mermaid-opts');
const { decodeEntities, imageInfo, isSvg } = require('./parse');

const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, InternalHyperlink, ImageRun,
  Table, TableRow, TableCell, BookmarkStart, BookmarkEnd, BuilderElement,
  Header, Footer, PageNumber,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, TableLayoutType,
  SectionType, TabStopType, ShadingType, LevelFormat, VerticalAlignTable,
  FrameAnchorType, HorizontalPositionAlign, VerticalPositionAlign, HeightRule,
  convertMillimetersToTwip, LineRuleType,
} = docx;

// ── Brand constants (reference/brand-2026-spec.md) ───────────────────────────
const PLUM      = '2F2450'; // headings, titles, table header fill, wordmark, page number
const INK       = '2B2340'; // body text
const PLUM_SOFT = '4A3A78'; // cover summary, blockquote text, H4
const PINK_DEEP = 'C85A8A'; // eyebrows, section numbers, bullets, subtitle, quote bar, inline code
const PINK      = 'E17B9E'; // H3 bottom rule
const MUTED     = '6B6185'; // header/footer text, cover address, TOC page numbers
const BLUE      = '3D6BB8'; // links
const SAND      = 'F3EBDE'; // blockquote fill, inline-code fill, cover metadata labels
const CREAM     = 'FBF6F1'; // zebra table rows, code block fill
const RULE      = 'E2D8CB'; // table/TOC/header rules, horizontal rules, code border
const WHITE     = 'FFFFFF';

const FONT_TITLE = 'Calistoga';
const FONT_BODY  = 'Roboto';
const FONT_MONO  = 'Roboto Mono';

// Sizes in half-points (Word), spacing in twips (pt × 20), borders in eighths of a pt
const BODY_SIZE = 19;   // 9.5pt
const BODY_LINE = 288;  // line height 1.2 (240 = single)
const BODY_AFTER = 120; // 6pt

const COVER_ADDRESS = 'Cognizone BV · Avenue Arnaud Fraiteur 15-23, 1050 Ixelles, Belgium · BE 0634.615.174';

// decodeEntities (parse.js) is used on prose text (the Markdown source, where "&amp;" shows
// "&" in HTML) and on inline code / escapes (which marked escapes once). Fenced code text
// is verbatim and must not be decoded.

const SCRIPT_DIR = path.join(__dirname, '..');
const ICON_PATH  = path.join(SCRIPT_DIR, 'templates', 'icon.png');

// A4, 20mm margins on all sides, header/footer 12.5mm from the edge
const MARGIN          = convertMillimetersToTwip(20);
const HEADER_DISTANCE = convertMillimetersToTwip(12.5);
// Usable width in twips (A4 = 210mm, minus 20mm each side = 170mm)
const CONTENT_WIDTH_TWIP = convertMillimetersToTwip(170);
// TOC text column (H2 number → text tab stop, H3 indent)
const TOC_TEXT_COL = convertMillimetersToTwip(26);
// List indent per level 6.35mm, bullet hanging 4.2mm (exact reference values). Numbered
// lists hang the full 6.35mm: a number wider than the hanging indent ("10.", "viii.")
// pushes the tab on to Word's next default tab stop, 12.7mm out
const LIST_INDENT  = 360;
const LIST_HANGING = 240;

// ── Mermaid rendering ────────────────────────────────────────────────────────
const MERMAID_JS_PATH = require.resolve('mermaid/dist/mermaid.min.js');

const DOCX_ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

async function renderMermaidToPng(browser, code) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setContent('<html><body style="background:#fff"><pre class="mermaid"></pre></body></html>');
  await page.addScriptTag({ path: MERMAID_JS_PATH });
  await page.evaluate(async (src) => {
    document.querySelector('.mermaid').textContent = src;
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    await mermaid.run();
  }, code);
  const svgEl = await page.$('.mermaid svg');
  const box = await svgEl.boundingBox();
  const pngBuffer = await svgEl.screenshot({ type: 'png' });
  await page.close();
  return { buffer: pngBuffer, width: Math.round(box.width), height: Math.round(box.height) };
}

// SVG image → transparent PNG at twice its size (longest side at most 1000px), for Word
// viewers without SVG support. Loaded as an <img> data URI, so the SVG can neither run
// scripts nor fetch files. Returns null when the browser cannot decode it.
async function renderSvgToPng(browser, svg) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<html><body style="margin:0"><img src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`);
    const size = await page.$eval('img', img => img.decode().then(() => [img.naturalWidth, img.naturalHeight], () => null));
    if (!size || !size[0] || !size[1]) return null;
    const [width, height] = size;
    const scale = Math.min(1, 1000 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    await page.$eval('img', (img, w, h) => { img.style.width = `${w}px`; img.style.height = `${h}px`; }, w, h);
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    const data = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    return { type: 'png', data, width, height };
  } finally {
    await page.close();
  }
}

function collectMermaidBlocks(tokens) {
  const blocks = [];
  for (const t of tokens) {
    if (t.type === 'code' && parseMermaidOpts(t.lang || '').isMermaid) blocks.push(t.text);
    if (t.tokens) blocks.push(...collectMermaidBlocks(t.tokens));
    if (t.items) {
      for (const item of t.items) {
        if (item.tokens) blocks.push(...collectMermaidBlocks(item.tokens));
      }
    }
  }
  return blocks;
}

// ── Numbering definitions (bullets + ordered) ────────────────────────────────
// Bullets and numbers are pink deep; the item text keeps the paragraph colour
function listLevelStyle(level, bullet = false) {
  return {
    paragraph: { indent: { left: LIST_INDENT * (level + 1), hanging: bullet ? LIST_HANGING : LIST_INDENT } },
    // Roboto's • is 0.21 em across, barely bigger than a full stop: 15pt (1.6× body), lowered
    // 3pt so its centre (0.37 em up) sits on the text's x-height middle. ◦ and – stay
    run: bullet && level % 3 === 0 ? { color: PINK_DEEP, size: 30, position: -6 } : { color: PINK_DEEP },
  };
}

// `start`: the list's first number (`3.` resumes at 3); docx also writes it as the
// instance's startOverride of each level. Every level gets it: each ordered list has its
// own definition and uses only the level of its depth (a nested list uses level 1, ...)
function orderedListLevels(start = 1) {
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return LEVELS.map(level => ({
    level,
    format: level % 3 === 0 ? LevelFormat.DECIMAL : level % 3 === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.LOWER_ROMAN,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    start,
    style: listLevelStyle(level),
  }));
}

// orderedListStarts: the start number of each ordered list, in the order rendered
function buildNumberingConfig(orderedListStarts) {
  // OOXML requires exactly 9 levels (0-8) per numbering definition
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const bulletChars = ['•', '◦', '–']; // •, ◦, –
  const config = [
    {
      reference: 'bullet-list',
      levels: LEVELS.map(level => ({
        level,
        format: LevelFormat.BULLET,
        text: bulletChars[level % 3],
        alignment: AlignmentType.LEFT,
        style: listLevelStyle(level, true),
      })),
    },
  ];
  // Each ordered list gets its own abstract numbering definition so Word restarts from 1
  const starts = orderedListStarts.length ? orderedListStarts : [1];
  starts.forEach((start, i) => {
    config.push({ reference: `ordered-list-${i}`, levels: orderedListLevels(start) });
  });
  return { config };
}

// ── Inline token → TextRun conversion ────────────────────────────────────────
let _inputDir = process.cwd();

// ── Images ───────────────────────────────────────────────────────────────────
// The type comes from the file's bytes: imageInfo() / isSvg() in parse.js
// src (as written, maybe %-encoded) → image file path, or null for a URL or missing file
function resolveImageSrc(src) {
  if (!src || src.startsWith('http')) return null;
  let decoded = src;
  try { decoded = decodeURIComponent(src); } catch { /* malformed %-escape: use as written */ }
  return [decoded, src].map(s => path.resolve(_inputDir, s)).find(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}

// src → { type, data, width, height } for an ImageRun, or null (shown as "[alt]").
// Only real image bytes are embedded: a path to any other file must not pull it into
// the document. SVG is kept as { svg } until prepareSvgImages rasterizes it.
let _images = new Map();
function loadImage(src) {
  if (!_images.has(src)) {
    const file = resolveImageSrc(src);
    let img = null;
    if (file) {
      const data = fs.readFileSync(file);
      const info = imageInfo(data);
      if (info && info.width > 0 && info.height > 0) img = { ...info, data };
      else if (isSvg(file, data)) img = { svg: data };
      else console.warn(`Warning: ${src} is not a PNG, JPEG, GIF, BMP or SVG image; left out of the Word document`);
    }
    _images.set(src, img);
  }
  return _images.get(src);
}

// Every image source in the document: Markdown images and each <img> in raw HTML
function collectImageSrcs(tokens, out = []) {
  for (const t of tokens || []) {
    if (t.type === 'image') out.push(t.href);
    if (t.type === 'html') out.push(...imgTags(t.raw).map(img => img.src));
    collectImageSrcs(t.tokens, out);
    for (const item of t.items || []) collectImageSrcs(item.tokens, out);
    for (const cell of [...(t.header || []), ...(t.rows || []).flat()]) collectImageSrcs(cell.tokens, out);
  }
  return out;
}

async function prepareSvgImages(browser, srcs) {
  for (const src of srcs) {
    const img = _images.get(src);
    if (!img || !img.svg) continue;
    const png = await renderSvgToPng(browser, img.svg);
    if (!png) console.warn(`Warning: ${src} could not be rendered as an SVG image; left out of the Word document`);
    _images.set(src, png);
  }
}

// Each <img> tag in raw HTML: src, alt and any pixel width/height attributes
function imgTags(html) {
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : undefined;
  };
  // only a positive size counts; zero, negative or no number is "not given"
  const px = value => { const n = parseInt(value, 10); return n > 0 ? n : undefined; };
  return (html.match(/<img\b[^>]*>/gi) || []).map(tag => ({
    src: attr(tag, 'src'),
    alt: attr(tag, 'alt'),
    width: px(attr(tag, 'width')),
    height: px(attr(tag, 'height')),
  })).filter(img => img.src);
}

// Image run scaled to at most 500px wide; a raw <img> with only width or only height
// gets the other from the image's aspect ratio. Placeholder "[alt]" when not embeddable.
function imageRun(src, alt, size = {}) {
  const img = loadImage(src);
  if (!img || !img.data) return new TextRun({ text: `[${alt || src}]`, color: MUTED });
  const w = size.width || (size.height ? size.height * img.width / img.height : img.width);
  const h = size.height || (size.width ? size.width * img.height / img.width : img.height);
  const scale = Math.min(1, 500 / w);
  return new ImageRun({
    type: img.type,
    data: img.data,
    transformation: { width: Math.round(w * scale), height: Math.round(h * scale) },
  });
}

// The images of a raw HTML fragment side by side, as a browser lays them out
const htmlImageRuns = imgs => imgs.flatMap((img, i) => [
  ...(i ? [new TextRun({ text: ' ' })] : []),
  imageRun(img.src, img.alt, img),
]);

// Run properties for a text run. With ctx.inherit (headings) font/size/colour are
// left to the paragraph style.
function runProps(ctx) {
  const props = {
    bold: ctx.bold || undefined,
    italics: ctx.italics || undefined,
    strike: ctx.strike || undefined,
  };
  if (!ctx.inherit) {
    props.font = ctx.font || FONT_BODY;
    props.size = ctx.size || BODY_SIZE;
    props.color = ctx.color || INK;
  } else if (ctx.color) {
    props.color = ctx.color;
  }
  return props;
}

function inlineToRuns(tokens, ctx = {}) {
  if (!tokens || !tokens.length) return [];
  const runs = [];

  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        // Text may contain nested tokens (e.g. from marked's inline lexer)
        if (t.tokens) {
          runs.push(...inlineToRuns(t.tokens, ctx));
        } else {
          // The Markdown source: decode entities ("&amp;" → "&") as HTML shows them
          runs.push(new TextRun({ text: decodeEntities(t.raw || t.text), ...runProps(ctx) }));
        }
        break;
      }
      // Backslash escape (`\~`, `\*`, ...): emit the escaped character, not the raw pair
      // (marked escapes it: `\&` arrives as "&amp;")
      case 'escape':
        runs.push(new TextRun({ text: decodeEntities(t.text), ...runProps(ctx) }));
        break;
      case 'strong':
        runs.push(...inlineToRuns(t.tokens, { ...ctx, bold: true }));
        break;
      case 'em':
        runs.push(...inlineToRuns(t.tokens, { ...ctx, italics: true }));
        break;
      case 'del':
        runs.push(...inlineToRuns(t.tokens, { ...ctx, strike: true }));
        break;
      case 'codespan':
        // Inline code: Roboto Mono 8.5pt pink deep on sand
        // marked escapes inline code once: decode exactly once
        runs.push(new TextRun({
          text: decodeEntities(t.text),
          font: FONT_MONO,
          size: 17,
          color: PINK_DEEP,
          bold: ctx.bold || undefined,
          italics: ctx.italics || undefined,
          strike: ctx.strike || undefined,
          shading: { type: ShadingType.CLEAR, fill: SAND },
        }));
        break;
      case 'link': {
        // Links: blue, no underline
        const children = t.tokens
          ? inlineToRuns(t.tokens, { ...ctx, color: BLUE })
          : [new TextRun({ text: decodeEntities(t.text), ...runProps({ ...ctx, color: BLUE }) })];
        // "#heading-id" jumps to that heading's bookmark: as an external link Word
        // opens the bare "#id" and lands at the top of the document
        const n = t.href.startsWith('#') && _tocBookmarks.get(t.href.slice(1));
        runs.push(n
          ? new InternalHyperlink({ anchor: tocBookmarkName(n), children })
          : new ExternalHyperlink({ link: t.href, children }));
        break;
      }
      case 'image':
        runs.push(imageRun(t.href, decodeEntities(t.text || '')));
        break;
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
      // Inline raw HTML: <img> tags become images; other tags print as written (below)
      case 'html': {
        const imgs = imgTags(t.raw);
        if (imgs.length) {
          runs.push(...htmlImageRuns(imgs));
          break;
        }
      }
      // falls through
      default:
        // Fallback: raw text
        if (t.raw) {
          runs.push(new TextRun({ text: t.raw, ...runProps({ ...ctx, strike: false }) }));
        }
    }
  }
  return runs;
}

// ── Block token → Paragraph/Table conversion ─────────────────────────────────
let _orderedListIndex = 0;
let _orderedListStarts = [];

// Numbering reference for a list. Each ordered list gets its own abstract numbering
// definition (unique reference), so Word restarts numbering for each separate list, at
// its own start number. Allocated as lists render, so every rendered list (in quotes,
// list items, ...) has a definition: buildNumberingConfig runs after the body.
function listRef(token) {
  if (!token.ordered) return 'bullet-list';
  _orderedListStarts.push(Number.isInteger(token.start) ? token.start : 1);
  return `ordered-list-${_orderedListIndex++}`;
}

// Set while rendering a blockquote's children so every run inside it (including
// list items) gets the quote text style; the bar and fill come from the quote's table
let _inQuote = false;
const QUOTE_RUN = { italics: true, color: PLUM_SOFT };
const quoteRun = () => (_inQuote ? QUOTE_RUN : {});

// Heading level used in the document: H1 (after the stripped title) → 2, H5/H6 → 4
const headingLevelOf = depth => (depth <= 2 ? 2 : depth === 3 ? 3 : 4);
const chapterLabel = number => `CHAPTER ${number.padStart(2, '0')}`;

// Heading id → contents entry number n (bookmark `_toc_{n}`, w:id n), set per render.
// Word bookmark names start with a letter or underscore ("_" = hidden), max 40 chars.
let _tocBookmarks = new Map();
const tocBookmarkName = n => `_toc_${n}`;

// Heading look per level. Font/size/colour live in the Heading2-4 paragraph styles
// (see buildStyles); only the section number carries direct formatting.
// Returns the heading paragraph, preceded by the CHAPTER label paragraph for H2.
function headingParagraphs(token) {
  const level = headingLevelOf(token.depth);
  const headingLevel = level === 2 ? HeadingLevel.HEADING_2
    : level === 3 ? HeadingLevel.HEADING_3
    : HeadingLevel.HEADING_4;
  const contentRuns = inlineToRuns(token.tokens, { inherit: true });
  const paragraphs = [];
  const children = [];

  if (token._number) {
    if (level === 2) {
      // H2 eyebrow: "CHAPTER 01" in its own plain paragraph (not a heading, so it stays
      // out of the outline); it carries the space before (the Heading 2 style has none)
      paragraphs.push(new Paragraph({
        children: [new TextRun({
          text: chapterLabel(token._number),
          font: FONT_MONO, size: 17, bold: true, color: PINK_DEEP, characterSpacing: 20,
        })],
        spacing: { before: 480, after: 40, line: 240 },
        keepNext: true,
        keepLines: true,
      }));
    } else {
      const num = { font: FONT_MONO, size: level === 3 ? 20 : 18, bold: true, color: PINK_DEEP };
      // A 9pt gap to the title: the mono space (0.6 em) widened by character spacing
      children.push(...numberRuns(token._number, num),
        new TextRun({ text: ' ', ...num, characterSpacing: Math.round((9 - 0.6 * num.size / 2) * 20) }));
    }
  }
  children.push(...contentRuns);

  // Bookmark the heading for its contents page PAGEREF. Start/end are built directly:
  // docx's Bookmark gives every bookmark the same w:id
  const n = _tocBookmarks.get(token._id);
  paragraphs.push(new Paragraph({
    heading: headingLevel,
    children: n ? [new BookmarkStart(tocBookmarkName(n), n), ...children, new BookmarkEnd(n)] : children,
    // Unnumbered H2 (a later H1) has no label paragraph to carry the space before
    spacing: level === 2 && !token._number ? { before: 480 } : undefined,
    keepNext: true,
    keepLines: true,
  }));
  // H3 gap below its rule. Word draws space-after inside the border box (above the rule),
  // so the H3 has none and this empty exact-height paragraph holds the 12pt instead
  if (level === 3) {
    paragraphs.push(new Paragraph({
      spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.EXACT },
      keepNext: true,
    }));
  }
  return paragraphs;
}

// box: where block-level boxes (code, quote, table, image) go. Inside a list item they
// start at the item's text indent, so they read as part of the item; width is the room
// between the margins (or inside a quote cell).
function tokensToElements(tokens, listDepth = 0, mermaidImages = new Map(), box = { indent: 0, width: CONTENT_WIDTH_TWIP }) {
  const elements = [];
  const boxIndent = box.indent ? { left: box.indent } : undefined;
  // Full width at the margin (as before); an indented table needs an explicit width,
  // or it sticks out on the right by its indent
  const boxWidth = box.width - box.indent;
  const boxed = box.indent
    ? { width: { size: boxWidth, type: WidthType.DXA }, indent: { size: box.indent, type: WidthType.DXA } }
    : { width: { size: 100, type: WidthType.PERCENTAGE } };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        elements.push(...headingParagraphs(token));
        break;

      case 'paragraph':
      // List-item continuation paragraphs arrive as block 'text' tokens with inline children
      case 'text':
        elements.push(new Paragraph({
          children: inlineToRuns(token.tokens, quoteRun()),
          spacing: { after: BODY_AFTER, line: BODY_LINE },
        }));
        break;

      case 'code': {
        // Mermaid diagrams → render as image
        const mermaidOpts = parseMermaidOpts(token.lang || '');
        if (mermaidOpts.isMermaid && mermaidImages.has(token.text)) {
          const { buffer, width, height } = mermaidImages.get(token.text);
          const scale = Math.min(1, mermaidOpts.maxWidth / width);
          elements.push(new Paragraph({
            children: [new ImageRun({
              type: 'png',
              data: buffer,
              transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
            })],
            alignment: DOCX_ALIGN[mermaidOpts.align],
            indent: boxIndent,
            spacing: { before: 120, after: 120 },
          }));
          break;
        }
        // Code block as single-cell table: cream fill, 0.5pt rule border, 3pt plum
        // left border, 6pt padding. The text is verbatim (marked does not escape fenced code)
        const codeLines = token.text.split('\n');
        const codeBorder = { style: BorderStyle.SINGLE, size: 4, color: RULE };
        elements.push(new Table({
          ...boxed,
          // one column of the full width: without it some viewers collapse the cell
          columnWidths: box.indent ? [boxWidth] : undefined,
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  width: box.indent ? { size: boxWidth, type: WidthType.DXA } : undefined,
                  shading: { fill: CREAM, type: ShadingType.CLEAR },
                  margins: { top: 120, bottom: 120, left: 120, right: 120, marginUnitType: WidthType.DXA },
                  borders: {
                    top: codeBorder,
                    bottom: codeBorder,
                    right: codeBorder,
                    left: { style: BorderStyle.SINGLE, size: 24, color: PLUM },
                  },
                  children: codeLines.map(line =>
                    new Paragraph({
                      children: [new TextRun({
                        text: line || ' ',
                        font: FONT_MONO,
                        size: 16,
                        color: PLUM,
                      })],
                      spacing: { before: 0, after: 0, line: 264 },
                    })
                  ),
                }),
              ],
            }),
          ],
        }));
        // Spacing after code block
        elements.push(new Paragraph({ spacing: { after: 120 } }));
        break;
      }

      case 'blockquote': {
        // Single-cell table, like code blocks: one continuous 3pt pink-deep bar and
        // sand fill behind all children (paragraphs, lists, ...). Per-paragraph
        // borders broke up in Word: list items draw the bar at their hanging indent.
        const wasInQuote = _inQuote;
        _inQuote = true;
        // 320 = the cell's left + right padding
        const quoteChildren = tokensToElements(token.tokens || [], listDepth, mermaidImages, { indent: 0, width: boxWidth - 320 });
        _inQuote = wasInQuote;
        const quoteBar = { style: BorderStyle.SINGLE, size: 24, color: PINK_DEEP };
        elements.push(new Table({
          // Explicit DXA widths: viewers that ignore percentage widths collapse the cell
          width: { size: boxWidth, type: WidthType.DXA },
          columnWidths: [boxWidth],
          indent: box.indent ? { size: box.indent, type: WidthType.DXA } : undefined,
          layout: TableLayoutType.FIXED,
          borders: { top: NO_BORDER, bottom: NO_BORDER, left: quoteBar, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  width: { size: boxWidth, type: WidthType.DXA },
                  shading: { fill: SAND, type: ShadingType.CLEAR },
                  // text 8pt from the bar; the last paragraph's space-after is the bottom padding
                  margins: { top: 100, bottom: 0, left: 160, right: 160, marginUnitType: WidthType.DXA },
                  borders: { top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER, left: quoteBar },
                  children: quoteChildren.length ? quoteChildren : [new Paragraph({})],
                }),
              ],
            }),
          ],
        }));
        // Spacing after the quote (as after code blocks)
        elements.push(new Paragraph({ spacing: { after: 120 } }));
        break;
      }

      case 'list': {
        const ref = listRef(token);
        for (const item of token.items) {
          elements.push(...listItemToElements(item, ref, listDepth, mermaidImages, box.width));
        }
        break;
      }

      case 'table': {
        // Full width, plum header row (repeats per page), zebra white/cream body,
        // horizontal 0.5pt rules only. Column alignment from the delimiter row
        // (:---:, ---:); null = left
        const cellMargins = { top: 60, bottom: 60, left: 90, right: 90, marginUnitType: WidthType.DXA };
        const cellPara = (runs, colIdx) => new Paragraph({
          children: runs,
          alignment: DOCX_ALIGN[token.align[colIdx]],
          spacing: { before: 0, after: 0, line: 252 },
        });

        const headerCells = token.header.map((cell, colIdx) =>
          new TableCell({
            shading: { fill: PLUM, type: ShadingType.CLEAR },
            borders: cellBorders(),
            margins: cellMargins,
            children: [cellPara(inlineToRuns(cell.tokens, { bold: true, color: WHITE, size: 17 }), colIdx)],
          })
        );

        const bodyRows = token.rows.map((row, rowIdx) =>
          new TableRow({
            children: row.map((cell, colIdx) =>
              new TableCell({
                shading: { fill: rowIdx % 2 === 0 ? WHITE : CREAM, type: ShadingType.CLEAR },
                borders: cellBorders(),
                margins: cellMargins,
                children: [cellPara(inlineToRuns(cell.tokens, { size: 17 }), colIdx)],
              })
            ),
          })
        );

        elements.push(new Table({
          ...boxed,
          borders: tableBorders(),
          rows: [
            new TableRow({ tableHeader: true, children: headerCells }),
            ...bodyRows,
          ],
        }));
        elements.push(new Paragraph({ spacing: { after: 120 } }));
        break;
      }

      case 'hr':
        elements.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
          spacing: { before: 200, after: 200 },
        }));
        break;

      case 'space':
        // Skip whitespace tokens
        break;

      case 'html': {
        // Every <img> tag, side by side in one paragraph; other HTML is skipped
        const imgs = imgTags(token.raw);
        if (imgs.length) {
          elements.push(new Paragraph({ children: htmlImageRuns(imgs), indent: boxIndent, spacing: { after: 120 } }));
        }
        break;
      }

      default:
        // Unknown token — render as plain text if possible
        if (token.raw) {
          elements.push(new Paragraph({
            children: [new TextRun({ text: token.raw, font: FONT_BODY, size: BODY_SIZE, color: INK })],
            spacing: { after: BODY_AFTER },
          }));
        }
    }
  }

  return elements;
}

function listItemToElements(item, ref, depth, mermaidImages = new Map(), width = CONTENT_WIDTH_TWIP) {
  const elements = [];

  // First paragraph in the list item gets the numbering. When the item starts with
  // another block (heading, code, quote, ...), the marker stands on its own line and
  // that block renders below it at the item's text indent (a heading keeps its
  // contents-page bookmark and its own position)
  const first = item.tokens && item.tokens[0];
  const inlineFirst = !first || first.type === 'text' || first.type === 'paragraph';
  const firstParaTokens = inlineFirst && first && first.tokens
    ? first.tokens
    : [{ type: 'text', raw: item.text || '' }];

  const firstRuns = inlineFirst ? inlineToRuns(firstParaTokens, quoteRun()) : [];
  // Task list item ("- [x] Done"): marked drops the "[x] " from the text and sets
  // item.task / item.checked; the state shows as ☑ / ☐ after the bullet or number
  if (item.task) firstRuns.unshift(new TextRun({ text: item.checked ? '☑ ' : '☐ ', ...runProps(quoteRun()) }));
  elements.push(new Paragraph({
    children: firstRuns,
    numbering: { reference: ref, level: depth },
    spacing: { after: 80, line: BODY_LINE },
  }));

  // Handle remaining tokens (nested lists, extra paragraphs, other blocks)
  if (item.tokens) {
    for (let i = inlineFirst ? 1 : 0; i < item.tokens.length; i++) {
      const sub = item.tokens[i];
      if (sub.type === 'list') {
        const subRef = listRef(sub);
        for (const subItem of sub.items) {
          elements.push(...listItemToElements(subItem, subRef, depth + 1, mermaidImages, width));
        }
      } else if (sub.type === 'text' || sub.type === 'paragraph') {
        // Continuation paragraph: align with the item text (matches the numbering level indent)
        elements.push(new Paragraph({
          children: inlineToRuns(sub.tokens || [{ type: 'text', raw: sub.raw || '' }], quoteRun()),
          indent: { left: LIST_INDENT * (depth + 1) },
          spacing: { after: 80, line: BODY_LINE },
        }));
      } else {
        elements.push(...tokensToElements([sub], depth, mermaidImages, { indent: LIST_INDENT * (depth + 1), width }));
      }
    }
  }

  return elements;
}

// Horizontal 0.5pt rules only — no vertical borders
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' };
function cellBorders() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: RULE };
  return { top: b, bottom: b, left: NO_BORDER, right: NO_BORDER };
}
function tableBorders() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: RULE };
  return { top: b, bottom: b, insideHorizontal: b, left: NO_BORDER, right: NO_BORDER, insideVertical: NO_BORDER };
}

// Icon + "Cognizone" wordmark, as the brand's horizontal lockup: the icon is cropped to
// its nodes (so it starts on the margin), the gap is half the icon height, and the
// wordmark is raised so its capitals centre on the icon (Word sits an inline picture on
// the text baseline). Sizes in pt (position is in half-points); Roboto's space is
// 0.248 em, its cap height 0.711 em.
function lockupRuns(iconPt, fontPt) {
  const runs = [];
  if (fs.existsSync(ICON_PATH)) {
    const png = fs.readFileSync(ICON_PATH);
    const px = iconPt * 96 / 72;
    runs.push(new ImageRun({
      data: png,
      transformation: { width: px * png.readUInt32BE(16) / png.readUInt32BE(20), height: px },
      type: 'png',
    }));
    runs.push(new TextRun({ text: ' ', font: FONT_BODY, size: fontPt * 2,
      characterSpacing: Math.round((iconPt / 2 - 0.248 * fontPt) * 20) }));
  }
  runs.push(new TextRun({ text: 'Cognizone', bold: true, font: FONT_BODY, size: fontPt * 2, color: PLUM,
    ...(runs.length ? { position: Math.round(iconPt - 0.711 * fontPt) } : {}) }));
  return runs;
}

// Roboto Mono gives the dot a full digit-wide cell, so `1.1` reads as `1 . 1`. Character
// spacing is added after a character: tighten the digit before each dot and the dot itself
function numberRuns(text, props) {
  const tight = Math.round(-0.15 * props.size / 2 * 20);
  return text.split(/(\d\.)/).filter(Boolean).map(part => new TextRun({
    text: part, ...props, ...(part.endsWith('.') ? { characterSpacing: tight } : {}),
  }));
}

// ── Build header/footer ──────────────────────────────────────────────────────
function buildHeader(headerTitle) {
  const children = [];

  // Icon (3.4mm, the nodes of the old 4.2mm square) + "Cognizone" wordmark on the left
  children.push(...lockupRuns(9.6, 8.5));

  // Tab + `{id} - {title}` on the right
  children.push(new TextRun({ text: '\t', font: FONT_MONO, size: 14 }));
  children.push(new TextRun({ text: headerTitle, font: FONT_MONO, size: 14, color: MUTED }));

  return new Header({
    children: [new Paragraph({
      children,
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
      spacing: { before: 0, after: 0, line: 240 },
    })],
  });
}

function buildFooter(footerText) {
  const mono = { font: FONT_MONO, size: 14 };
  return new Footer({
    children: [new Paragraph({
      children: [
        new TextRun({ text: footerText, ...mono, color: MUTED }),
        new TextRun({ text: '\t', ...mono }),
        new TextRun({ children: [PageNumber.CURRENT], ...mono, color: PLUM }),
      ],
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
      spacing: { before: 0, after: 0, line: 240 },
    })],
  });
}

// ── Cover page ───────────────────────────────────────────────────────────────
function buildCoverPage(parsed) {
  const { title, subtitle, summary, id, type, status, version, date, author, client, project, classification } = parsed;
  const children = [];

  // 1. Logo lockup: icon (13.6mm, the nodes of the old 17mm square) + "Cognizone" wordmark (live text)
  children.push(new Paragraph({
    children: lockupRuns(38.5, 20),
    spacing: { before: 400, after: 1600, line: 240 },
  }));

  // 2. Eyebrow: COGNIZONE / {type|id}
  const eyebrow = ['Cognizone', type || id].filter(Boolean).join(' / ').toUpperCase();
  children.push(new Paragraph({
    children: [new TextRun({ text: eyebrow, font: FONT_MONO, size: 18, color: PINK_DEEP, characterSpacing: 60 })],
    spacing: { after: 240, line: 240 },
  }));

  // 3–4. Title (plum) + optional subtitle (pink deep), Calistoga 32pt, line height 1.1
  children.push(new Paragraph({
    children: [new TextRun({ text: title, font: FONT_TITLE, size: 64, color: PLUM })],
    spacing: { after: subtitle ? 0 : 400, line: 264 },
  }));
  if (subtitle) {
    children.push(new Paragraph({
      children: [new TextRun({ text: subtitle, font: FONT_TITLE, size: 64, color: PINK_DEEP })],
      spacing: { after: 400, line: 264 },
    }));
  }

  // 5. Summary
  if (summary) {
    children.push(new Paragraph({
      children: [new TextRun({ text: summary, font: FONT_BODY, size: 24, color: PLUM_SOFT })],
      spacing: { after: 600, line: 320 },
    }));
  }

  // 6. Metadata table: 60% of the text block, sand label column, horizontal rules only
  const metaData = [
    ['ID',      id],
    ['Type',    type],
    ['Status',  status],
    ['Version', version],
    ['Date',    date],
    ['Author',  author],
    ['Client',  client],
    ['Project', project],
  ].filter(([, v]) => v);

  if (metaData.length) {
    const tableWidth = Math.round(CONTENT_WIDTH_TWIP * 0.6);
    const labelWidth = Math.round(tableWidth / 3);
    const valueWidth = tableWidth - labelWidth;
    const margins = { top: 60, bottom: 60, left: 90, right: 90, marginUnitType: WidthType.DXA };
    children.push(new Table({
      width: { size: tableWidth, type: WidthType.DXA },
      columnWidths: [labelWidth, valueWidth],
      layout: TableLayoutType.FIXED,
      borders: tableBorders(),
      rows: metaData.map(([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: labelWidth, type: WidthType.DXA },
              shading: { fill: SAND, type: ShadingType.CLEAR },
              verticalAlign: VerticalAlignTable.CENTER,
              margins,
              borders: cellBorders(),
              children: [new Paragraph({
                children: [new TextRun({
                  text: label.toUpperCase(), font: FONT_MONO, size: 15, color: MUTED, characterSpacing: 20,
                })],
                spacing: { before: 0, after: 0, line: 240 },
              })],
            }),
            new TableCell({
              width: { size: valueWidth, type: WidthType.DXA },
              verticalAlign: VerticalAlignTable.CENTER,
              margins,
              borders: cellBorders(),
              children: [new Paragraph({
                children: [new TextRun({ text: value, font: FONT_BODY, size: BODY_SIZE, color: INK })],
                spacing: { before: 0, after: 0, line: 240 },
              })],
            }),
          ],
        })
      ),
    }));
  }

  // 7. Bottom of the page: address + date line, anchored to the bottom margin with a
  // frame. Consecutive paragraphs with identical frame properties share one frame.
  const bottomFrame = {
    type: 'alignment',
    width: CONTENT_WIDTH_TWIP,
    height: 0,
    rule: HeightRule.AUTO,
    anchor: { horizontal: FrameAnchorType.MARGIN, vertical: FrameAnchorType.MARGIN },
    alignment: { x: HorizontalPositionAlign.LEFT, y: VerticalPositionAlign.BOTTOM },
  };
  const dateLine = [date, classification].filter(Boolean).join(' · ');
  children.push(new Paragraph({
    frame: bottomFrame,
    children: [new TextRun({ text: COVER_ADDRESS, font: FONT_BODY, size: 17, color: MUTED })],
    spacing: { before: 0, after: dateLine ? 60 : 0, line: 240 },
  }));
  if (dateLine) {
    children.push(new Paragraph({
      frame: bottomFrame,
      children: [new TextRun({ text: dateLine, font: FONT_MONO, size: 16, color: MUTED })],
      spacing: { before: 0, after: 0, line: 240 },
    }));
  }

  return children;
}

// ── Contents page ────────────────────────────────────────────────────────────
// Static entries built from parsed.tocEntries instead of a native TOC field (which
// copies the heading's direct run formatting, e.g. the CHAPTER label, into entries).
// Page numbers are PAGEREF fields to the heading bookmarks. The entries are the cached
// result of a TOC field, so Word's "Update Table" finds them: "Update page numbers
// only" repaginates and refreshes every PAGEREF at once, keeping this styling.
// Nothing updates on open: Word's open-time update rebuilds the TOC field in its own
// TOC styles (as does "Update entire table"), and fills bare PAGEREFs with 1.

// Raw field parts: docx's own field classes can carry neither run formatting nor a
// cached result, so the field runs are built here.
const fldChar = type => new BuilderElement({
  name: 'w:fldChar',
  attributes: { type: { key: 'w:fldCharType', value: type } },
});
const instrText = code => new BuilderElement({
  name: 'w:instrText',
  attributes: { space: { key: 'xml:space', value: 'preserve' } },
  children: [` ${code} `],
});

// Styled PAGEREF field with a cached placeholder
function pageRefRuns(bookmark, style) {
  return [
    new TextRun({ ...style, children: [fldChar('begin')] }),
    new TextRun({ ...style, children: [instrText(`PAGEREF ${bookmark} \\h`)] }),
    new TextRun({ ...style, children: [fldChar('separate')] }),
    new TextRun({ ...style, text: '\u2013' }), // shown until Word updates the field
    new TextRun({ ...style, children: [fldChar('end')] }),
  ];
}

const TOC_RULE = { style: BorderStyle.SINGLE, size: 2, color: RULE, space: 3 };
const TOC_PAGE = { font: FONT_MONO, size: 16, color: MUTED };

function buildTocEntries(tocEntries) {
  return tocEntries.map((entry, i) => {
    const level = headingLevelOf(entry.level);
    const bookmark = tocBookmarkName(_tocBookmarks.get(entry.id));
    let runs;
    let props;

    if (level === 2) {
      // "CHAPTER 01" in the 26mm number column, title plum, rule 3pt below.
      // Word merges the borders of adjacent paragraphs with identical borders and
      // indents (only the last keeps its bottom rule), so a 1-twip indent alternation
      // keeps each H2 entry separate; the matching between border is the fallback.
      const odd = i % 2;
      runs = [
        ...(entry.number ? [new TextRun({ text: chapterLabel(entry.number), font: FONT_MONO, size: 16, bold: true, color: PINK_DEEP })] : []),
        new TextRun({ text: '\t' }),
        new TextRun({ text: entry.text, font: FONT_BODY, size: 21, color: PLUM }),
      ];
      props = {
        // Hanging indent: wrapped title lines continue in the text column
        indent: { left: TOC_TEXT_COL + odd, hanging: TOC_TEXT_COL + odd },
        tabStops: [
          { type: TabStopType.LEFT, position: TOC_TEXT_COL },
          { type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP },
        ],
        border: { bottom: TOC_RULE, between: TOC_RULE },
        // Gap goes before, never after: Word draws space-after inside the border box,
        // which would push the rule away from the text and onto the next entry
        spacing: { before: 200, after: 0, line: 240 },
      };
    } else {
      // H3 at the text column, H4 one list indent further: number muted, text ink
      runs = [
        ...numberRuns(entry.number + ' ', { font: FONT_MONO, size: 15, color: MUTED }),
        new TextRun({ text: entry.text, font: FONT_BODY, size: 19, color: INK }),
      ];
      props = {
        indent: { left: TOC_TEXT_COL + (level === 4 ? LIST_INDENT : 0) },
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
        spacing: { before: 60, after: 0, line: 240 },
      };
    }
    runs.push(new TextRun({ text: '\t' }), ...pageRefRuns(bookmark, TOC_PAGE));

    // Whole entry clickable, like Word's own TOC. The TOC field opens before the
    // first entry and closes after the last, as in a TOC Word inserts itself.
    const children = [new InternalHyperlink({ anchor: bookmark, children: runs })];
    if (i === 0) {
      children.unshift(
        new TextRun({ children: [fldChar('begin')] }),
        new TextRun({ children: [instrText('TOC \\o "2-4" \\h \\z')] }),
        new TextRun({ children: [fldChar('separate')] }),
      );
    }
    if (i === tocEntries.length - 1) children.push(new TextRun({ children: [fldChar('end')] }));
    return new Paragraph({ ...props, children });
  });
}

// ── Styles ───────────────────────────────────────────────────────────────────
function buildStyles() {
  return {
    default: {
      document: {
        run: { font: FONT_BODY, size: BODY_SIZE, color: INK },
        paragraph: { spacing: { line: BODY_LINE } },
      },
      // Heading styles replace docx's built-in Heading 2-4 definitions (same style IDs).
      // H2: Calistoga 20pt plum; the CHAPTER label paragraph above it carries the space before
      heading2: {
        run: { font: FONT_TITLE, size: 40, color: PLUM, bold: false, italics: false },
        paragraph: {
          outlineLevel: 1,
          spacing: { before: 0, after: 240, line: 264 },
          keepNext: true,
        },
      },
      // H3: Roboto bold 12pt plum, 0.75pt pink rule 3pt below
      heading3: {
        run: { font: FONT_BODY, size: 24, color: PLUM, bold: true, italics: false },
        paragraph: {
          outlineLevel: 2,
          // after: 0, the gap below the rule is a spacer paragraph (see headingParagraphs)
          spacing: { before: 280, after: 0, line: 264 },
          keepNext: true,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: PINK, space: 3 } },
        },
      },
      // H4: Roboto bold 10.5pt plum soft
      heading4: {
        run: { font: FONT_BODY, size: 21, color: PLUM_SOFT, bold: true, italics: false },
        paragraph: {
          outlineLevel: 3,
          spacing: { before: 200, after: 80, line: 264 },
          keepNext: true,
        },
      },
    },
    paragraphStyles: [
      {
        id: 'Normal',
        name: 'Normal',
        run: { font: FONT_BODY, size: BODY_SIZE, color: INK },
        paragraph: { spacing: { line: BODY_LINE, after: BODY_AFTER } },
      },
    ],
  };
}

// ── Section properties ───────────────────────────────────────────────────────
const sectionProps = {
  page: {
    size: { width: 11906, height: 16838 }, // A4 in twips
    margin: {
      top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN,
      header: HEADER_DISTANCE, footer: HEADER_DISTANCE,
    },
  },
};

// ── Main render function ─────────────────────────────────────────────────────
async function renderDocx(parsed, outputFile) {
  const { headerTitle, inputDir, tokens, tocEntries, classification, client, project } = parsed;
  _inputDir = inputDir || process.cwd();
  _orderedListIndex = 0;
  _orderedListStarts = [];
  _images = new Map();
  _tocBookmarks = new Map(tocEntries.map((e, i) => [e.id, i + 1]));

  // Footer: {classification} · {client} · {project}, only the parts present
  const footerText = [classification, client, project].filter(Boolean).join(' · ');

  // Cover page section (no header/footer — omit headers/footers entirely;
  // setting empty Header({children:[]}) poisons subsequent sections)
  const coverSection = {
    properties: {
      ...sectionProps,
      type: SectionType.NEXT_PAGE,
    },
    children: buildCoverPage(parsed),
  };

  // TOC section
  const tocSection = {
    properties: {
      ...sectionProps,
      type: SectionType.NEXT_PAGE,
    },
    headers: { default: buildHeader(headerTitle) },
    footers: { default: buildFooter(footerText) },
    children: [
      // Plain paragraph (not a heading) so it stays out of the outline
      new Paragraph({
        children: [new TextRun({
          text: 'CONTENTS',
          bold: true,
          font: FONT_MONO,
          size: 17,
          color: PINK_DEEP,
          characterSpacing: 60,
        })],
        spacing: { after: 200, line: 240 },
      }),
      ...buildTocEntries(tocEntries),
    ],
  };

  // Pre-render mermaid diagrams and SVG images to PNG, in one browser session (none
  // is launched when the document has neither)
  const mermaidImages = new Map();
  const mermaidCodes = collectMermaidBlocks(tokens);
  const svgSrcs = collectImageSrcs(tokens).filter(src => loadImage(src)?.svg);
  if (mermaidCodes.length > 0 || svgSrcs.length > 0) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      for (const code of mermaidCodes) {
        if (!mermaidImages.has(code)) {
          mermaidImages.set(code, await renderMermaidToPng(browser, code));
        }
      }
      await prepareSvgImages(browser, svgSrcs);
    } finally {
      await browser.close();
    }
  }

  // Body section
  const bodyElements = tokensToElements(tokens, 0, mermaidImages);
  const bodySection = {
    properties: {
      ...sectionProps,
      type: SectionType.NEXT_PAGE,
    },
    headers: { default: buildHeader(headerTitle) },
    footers: { default: buildFooter(footerText) },
    children: bodyElements,
  };

  const doc = new Document({
    styles: buildStyles(),
    // After the body: the ordered lists were numbered as they rendered
    numbering: buildNumberingConfig(_orderedListStarts),
    sections: [coverSection, tocSection, bodySection],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputFile, buffer);
}

module.exports = { renderDocx };
