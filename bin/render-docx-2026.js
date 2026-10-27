'use strict';
// DOCX renderer, 2026 brand: takes parsed markdown data, produces a branded Word document.
// Deliberately a full copy of render-docx.js (the classic brand is frozen and will be
// deleted); styling follows reference/brand-2026-spec.md.

const docx = require('docx');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { parseMermaidOpts } = require('./mermaid-opts');

const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, InternalHyperlink, ImageRun,
  Table, TableRow, TableCell, BookmarkStart, BookmarkEnd, BuilderElement,
  Header, Footer, PageNumber,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, TableLayoutType,
  SectionType, TabStopType, ShadingType, LevelFormat, VerticalAlignTable,
  FrameAnchorType, HorizontalPositionAlign, VerticalPositionAlign, HeightRule,
  convertMillimetersToTwip,
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

// marked.lexer() escapes HTML entities in code token text; unescape for DOCX output.
function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const SCRIPT_DIR = path.join(__dirname, '..');
const ICON_PATH  = path.join(SCRIPT_DIR, 'templates', '2026', 'icon.png');

// A4, 20mm margins on all sides, header/footer 12.5mm from the edge
const MARGIN          = convertMillimetersToTwip(20);
const HEADER_DISTANCE = convertMillimetersToTwip(12.5);
// Usable width in twips (A4 = 210mm, minus 20mm each side = 170mm)
const CONTENT_WIDTH_TWIP = convertMillimetersToTwip(170);
// TOC text column (H2 number → text tab stop, H3 indent)
const TOC_TEXT_COL = convertMillimetersToTwip(26);
// List indent per level 6.35mm, hanging 4.2mm (exact reference values)
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
function listLevelStyle(level) {
  return {
    paragraph: { indent: { left: LIST_INDENT * (level + 1), hanging: LIST_HANGING } },
    run: { color: PINK_DEEP },
  };
}

function orderedListLevels() {
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return LEVELS.map(level => ({
    level,
    format: level % 3 === 0 ? LevelFormat.DECIMAL : level % 3 === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.LOWER_ROMAN,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: listLevelStyle(level),
  }));
}

function buildNumberingConfig(orderedListCount) {
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
        style: listLevelStyle(level),
      })),
    },
  ];
  // Each ordered list gets its own abstract numbering definition so Word restarts from 1
  const count = Math.max(1, orderedListCount || 1);
  for (let i = 0; i < count; i++) {
    config.push({ reference: `ordered-list-${i}`, levels: orderedListLevels() });
  }
  return { config };
}

function countOrderedLists(tokens) {
  let count = 0;
  for (const t of tokens) {
    if (t.type === 'list' && t.ordered) count++;
    if (t.items) {
      for (const item of t.items) {
        if (item.tokens) count += countOrderedLists(item.tokens);
      }
    }
  }
  return count;
}

// ── Inline token → TextRun conversion ────────────────────────────────────────
let _inputDir = process.cwd();

function detectImageType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  return 'png';
}

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
          runs.push(new TextRun({ text: t.raw || t.text, ...runProps(ctx) }));
        }
        break;
      }
      // Backslash escape (`\~`, `\*`, ...): emit the escaped character, not the raw pair
      case 'escape':
        runs.push(new TextRun({ text: t.text, ...runProps(ctx) }));
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
        runs.push(new TextRun({
          text: unescapeHtml(t.text),
          font: FONT_MONO,
          size: 17,
          color: PINK_DEEP,
          bold: ctx.bold || undefined,
          italics: ctx.italics || undefined,
          strike: ctx.strike || undefined,
          shading: { type: ShadingType.CLEAR, fill: SAND },
        }));
        break;
      case 'link':
        // Links: blue, no underline
        runs.push(new ExternalHyperlink({
          link: t.href,
          children: t.tokens
            ? inlineToRuns(t.tokens, { ...ctx, color: BLUE })
            : [new TextRun({ text: t.text, ...runProps({ ...ctx, color: BLUE }) })],
        }));
        break;
      case 'image': {
        const imgPath = t.href.startsWith('http') ? null : path.resolve(_inputDir, t.href);
        if (imgPath && fs.existsSync(imgPath)) {
          const imgBuf = fs.readFileSync(imgPath);
          // Read PNG dimensions from header (offset 16=width, 20=height, 4 bytes BE)
          const isPng = imgBuf[0] === 137 && imgBuf[1] === 80;
          const imgW = isPng ? imgBuf.readUInt32BE(16) : 400;
          const imgH = isPng ? imgBuf.readUInt32BE(20) : 300;
          // Scale to max 500px wide, preserving aspect ratio
          const scale = Math.min(1, 500 / imgW);
          runs.push(new ImageRun({
            type: detectImageType(imgPath),
            data: imgBuf,
            transformation: { width: Math.round(imgW * scale), height: Math.round(imgH * scale) },
          }));
        } else {
          runs.push(new TextRun({ text: `[${t.text || t.href}]`, color: MUTED }));
        }
        break;
      }
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
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
      children.push(new TextRun({
        text: token._number + ' ',
        font: FONT_MONO,
        size: level === 3 ? 20 : 18,
        color: PINK_DEEP,
      }));
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
  return paragraphs;
}

function tokensToElements(tokens, listDepth = 0, mermaidImages = new Map()) {
  const elements = [];

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
            spacing: { before: 120, after: 120 },
          }));
          break;
        }
        // Code block as single-cell table: cream fill, 0.5pt rule border, 3pt plum
        // left border, 6pt padding
        const codeLines = unescapeHtml(token.text).split('\n');
        const codeBorder = { style: BorderStyle.SINGLE, size: 4, color: RULE };
        elements.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({
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
        const quoteChildren = tokensToElements(token.tokens || [], listDepth, mermaidImages);
        _inQuote = wasInQuote;
        const quoteBar = { style: BorderStyle.SINGLE, size: 24, color: PINK_DEEP };
        elements.push(new Table({
          // Explicit DXA widths: viewers that ignore percentage widths collapse the cell
          width: { size: CONTENT_WIDTH_TWIP, type: WidthType.DXA },
          columnWidths: [CONTENT_WIDTH_TWIP],
          layout: TableLayoutType.FIXED,
          borders: { top: NO_BORDER, bottom: NO_BORDER, left: quoteBar, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  width: { size: CONTENT_WIDTH_TWIP, type: WidthType.DXA },
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
        // Each ordered list gets its own abstract numbering definition (unique reference)
        // so Word restarts numbering from 1 for each separate list
        const ref = token.ordered ? `ordered-list-${_orderedListIndex++}` : 'bullet-list';
        for (const item of token.items) {
          elements.push(...listItemToElements(item, ref, listDepth, mermaidImages));
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
          width: { size: 100, type: WidthType.PERCENTAGE },
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
        // Handle <img> tags; skip other HTML
        const imgMatch = token.raw.match(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/i);
        if (imgMatch) {
          const src = imgMatch[1];
          const wMatch = token.raw.match(/width=["']?(\d+)["']?/i);
          const hMatch = token.raw.match(/height=["']?(\d+)["']?/i);
          const imgPath = src.startsWith('http') ? null : path.resolve(_inputDir, src);
          if (imgPath && fs.existsSync(imgPath)) {
            const imgBuf = fs.readFileSync(imgPath);
            const isPng = imgBuf[0] === 137 && imgBuf[1] === 80;
            let imgW = wMatch ? parseInt(wMatch[1], 10) : isPng ? imgBuf.readUInt32BE(16) : 400;
            let imgH = hMatch ? parseInt(hMatch[1], 10) : isPng ? imgBuf.readUInt32BE(20) : 300;
            const scale = Math.min(1, 500 / imgW);
            elements.push(new Paragraph({
              children: [new ImageRun({
                type: detectImageType(imgPath),
                data: imgBuf,
                transformation: { width: Math.round(imgW * scale), height: Math.round(imgH * scale) },
              })],
              spacing: { after: 120 },
            }));
          }
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

function listItemToElements(item, ref, depth, mermaidImages = new Map()) {
  const elements = [];

  // First paragraph in the list item gets the numbering
  const firstParaTokens = item.tokens && item.tokens[0] && item.tokens[0].tokens
    ? item.tokens[0].tokens
    : [{ type: 'text', raw: item.text || '' }];

  elements.push(new Paragraph({
    children: inlineToRuns(firstParaTokens, quoteRun()),
    numbering: { reference: ref, level: depth },
    spacing: { after: 80, line: BODY_LINE },
  }));

  // Handle remaining tokens (nested lists, extra paragraphs)
  if (item.tokens && item.tokens.length > 1) {
    for (let i = 1; i < item.tokens.length; i++) {
      const sub = item.tokens[i];
      if (sub.type === 'list') {
        const subRef = sub.ordered ? `ordered-list-${_orderedListIndex++}` : 'bullet-list';
        for (const subItem of sub.items) {
          elements.push(...listItemToElements(subItem, subRef, depth + 1, mermaidImages));
        }
      } else if (sub.type === 'text' || sub.type === 'paragraph') {
        // Continuation paragraph: align with the item text (matches the numbering level indent)
        elements.push(new Paragraph({
          children: inlineToRuns(sub.tokens || [{ type: 'text', raw: sub.raw || '' }], quoteRun()),
          indent: { left: LIST_INDENT * (depth + 1) },
          spacing: { after: 80, line: BODY_LINE },
        }));
      } else {
        elements.push(...tokensToElements([sub], depth, mermaidImages));
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

function iconRun(px) {
  return new ImageRun({
    data: fs.readFileSync(ICON_PATH),
    transformation: { width: px, height: px },
    type: 'png',
  });
}

// ── Build header/footer ──────────────────────────────────────────────────────
function buildHeader(headerTitle) {
  const children = [];

  // Icon (4.2mm) + "Cognizone" wordmark on the left
  if (fs.existsSync(ICON_PATH)) children.push(iconRun(16));
  children.push(new TextRun({ text: ' Cognizone', bold: true, font: FONT_BODY, size: 17, color: PLUM }));

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

  // 1. Logo lockup: icon (17mm) + two spaces + "Cognizone" wordmark (live text)
  children.push(new Paragraph({
    children: [
      ...(fs.existsSync(ICON_PATH) ? [iconRun(64)] : []),
      new TextRun({ text: '  Cognizone', bold: true, font: FONT_BODY, size: 40, color: PLUM }),
    ],
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
// Page numbers stay live: PAGEREF fields to the heading bookmarks, refreshed on open.

// Styled PAGEREF field with a cached placeholder. docx's PageReference can carry
// neither run formatting nor a cached result, so the field runs are built here.
function pageRefRuns(bookmark, style) {
  const fldChar = (type, dirty) => new BuilderElement({
    name: 'w:fldChar',
    attributes: { type: { key: 'w:fldCharType', value: type }, dirty: { key: 'w:dirty', value: dirty } },
  });
  const instr = new BuilderElement({
    name: 'w:instrText',
    attributes: { space: { key: 'xml:space', value: 'preserve' } },
    children: [` PAGEREF ${bookmark} \\h `],
  });
  return [
    new TextRun({ ...style, children: [fldChar('begin', true)] }),
    new TextRun({ ...style, children: [instr] }),
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
        spacing: { before: 0, after: 140, line: 240 },
      };
    } else {
      // H3 at the text column, H4 one list indent further: number muted, text ink
      runs = [
        new TextRun({ text: entry.number + ' ', font: FONT_MONO, size: 15, color: MUTED }),
        new TextRun({ text: entry.text, font: FONT_BODY, size: 19, color: INK }),
      ];
      props = {
        indent: { left: TOC_TEXT_COL + (level === 4 ? LIST_INDENT : 0) },
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
        spacing: { before: 0, after: 60, line: 240 },
      };
    }
    runs.push(new TextRun({ text: '\t' }), ...pageRefRuns(bookmark, TOC_PAGE));

    // Whole entry clickable, like Word's own TOC
    return new Paragraph({ ...props, children: [new InternalHyperlink({ anchor: bookmark, children: runs })] });
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
          spacing: { before: 280, after: 120, line: 264 },
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

  // Pre-render mermaid diagrams to PNG
  const mermaidImages = new Map();
  const mermaidCodes = collectMermaidBlocks(tokens);
  if (mermaidCodes.length > 0) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    for (const code of mermaidCodes) {
      if (!mermaidImages.has(code)) {
        mermaidImages.set(code, await renderMermaidToPng(browser, code));
      }
    }
    await browser.close();
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
    numbering: buildNumberingConfig(countOrderedLists(tokens)),
    // Word refreshes fields on open, filling in the contents page PAGEREFs
    features: { updateFields: true },
    sections: [coverSection, tocSection, bodySection],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputFile, buffer);
}

module.exports = { renderDocx };
