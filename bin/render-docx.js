'use strict';
// DOCX renderer: takes parsed markdown data, produces a branded Word document.

const docx = require('docx');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, ImageRun,
  Table, TableRow, TableCell, TableOfContents,
  Header, Footer, PageNumber, PageBreak,
  AlignmentType, HeadingLevel, WidthType, BorderStyle,
  SectionType, TabStopType, ShadingType, LevelFormat, VerticalAlignTable,
  convertMillimetersToTwip,
} = docx;

// ── Brand constants ──────────────────────────────────────────────────────────
const GREEN         = '058775';
const DARK          = '353744';
const DARK2         = '272727';
const GRAY          = '666666';
const LIGHT_GREEN   = 'E8F5F3';
const MONO_GREEN    = '188038';
const BORDER_COLOR  = 'BFBFBF';
const META_LABEL_BG = 'EAF0F8';
const LINK_BLUE     = '0563C1';
const WHITE         = 'FFFFFF';

const FONT_BODY = 'Roboto';
const FONT_MONO = 'Roboto Mono';

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
const LOGO_PATH  = path.join(SCRIPT_DIR, 'templates', 'logo.png');

// Twip conversions for A4 margins
const MARGIN_TOP    = convertMillimetersToTwip(25);
const MARGIN_BOTTOM = convertMillimetersToTwip(20);
const MARGIN_SIDE   = convertMillimetersToTwip(20);
// Usable width in twips (A4 = 210mm, minus 20mm each side = 170mm)
const CONTENT_WIDTH_TWIP = convertMillimetersToTwip(170);

// ── Mermaid rendering ────────────────────────────────────────────────────────
const MERMAID_JS_PATH = require.resolve('mermaid/dist/mermaid.min.js');

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
    if (t.type === 'code' && t.lang === 'mermaid') blocks.push(t.text);
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
function orderedListLevels() {
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return LEVELS.map(level => ({
    level,
    format: level % 3 === 0 ? LevelFormat.DECIMAL : level % 3 === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.LOWER_ROMAN,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: convertMillimetersToTwip(5 * (level + 1)), hanging: convertMillimetersToTwip(3) } } },
  }));
}

function buildNumberingConfig(orderedListCount) {
  // OOXML requires exactly 9 levels (0-8) per numbering definition
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const bulletChars = ['\u2022', '\u25E6', '\u2013']; // •, ◦, –
  const config = [
    {
      reference: 'bullet-list',
      levels: LEVELS.map(level => ({
        level,
        format: LevelFormat.BULLET,
        text: bulletChars[level % 3],
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: convertMillimetersToTwip(5 * (level + 1)), hanging: convertMillimetersToTwip(3) } } },
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
          runs.push(new TextRun({
            text: t.raw || t.text,
            bold: ctx.bold || false,
            italics: ctx.italics || false,
            font: ctx.font || FONT_BODY,
            size: ctx.size || 20,
            color: ctx.color || DARK,
          }));
        }
        break;
      }
      case 'strong':
        runs.push(...inlineToRuns(t.tokens, { ...ctx, bold: true }));
        break;
      case 'em':
        runs.push(...inlineToRuns(t.tokens, { ...ctx, italics: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({
          text: unescapeHtml(t.text),
          font: FONT_MONO,
          size: 18,
          color: MONO_GREEN,
          bold: ctx.bold || false,
          italics: ctx.italics || false,
          shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
        }));
        break;
      case 'link':
        runs.push(new ExternalHyperlink({
          link: t.href,
          children: t.tokens
            ? inlineToRuns(t.tokens, { ...ctx, color: GREEN })
            : [new TextRun({ text: t.text, color: GREEN, font: FONT_BODY, size: ctx.size || 20 })],
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
          runs.push(new TextRun({ text: `[${t.text || t.href}]`, color: GRAY }));
        }
        break;
      }
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
      default:
        // Fallback: raw text
        if (t.raw) {
          runs.push(new TextRun({
            text: t.raw,
            bold: ctx.bold || false,
            italics: ctx.italics || false,
            font: ctx.font || FONT_BODY,
            size: ctx.size || 20,
            color: ctx.color || DARK,
          }));
        }
    }
  }
  return runs;
}

// ── Block token → Paragraph/Table conversion ─────────────────────────────────
let _orderedListIndex = 0;

function tokensToElements(tokens, listDepth = 0, mermaidImages = new Map()) {
  const elements = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const level = token.depth;
        const headingLevel = level === 2 ? HeadingLevel.HEADING_2
          : level === 3 ? HeadingLevel.HEADING_3
          : level === 4 ? HeadingLevel.HEADING_4
          : HeadingLevel.HEADING_2;

        const numberRun = token._number ? new TextRun({
          text: token._number + ' ',
          bold: true,
          font: FONT_BODY,
          size: level === 2 ? 26 : level === 3 ? 24 : 22,
          color: level === 3 ? GREEN : level === 4 ? DARK2 : DARK,
        }) : null;

        const contentRuns = inlineToRuns(token.tokens, {
          bold: true,
          font: FONT_BODY,
          size: level === 2 ? 26 : level === 3 ? 24 : 22,
          color: level === 3 ? GREEN : level === 4 ? DARK2 : DARK,
        });

        const children = numberRun ? [numberRun, ...contentRuns] : contentRuns;

        elements.push(new Paragraph({
          heading: headingLevel,
          children,
          spacing: {
            before: level === 2 ? 320 : 200,
            after: 120,
          },
          border: level === 2 ? {
            bottom: { style: BorderStyle.SINGLE, size: 4, color: DARK },
          } : undefined,
        }));
        break;
      }

      case 'paragraph':
        elements.push(new Paragraph({
          children: inlineToRuns(token.tokens),
          spacing: { after: 120, line: 360 },
        }));
        break;

      case 'code': {
        // Mermaid diagrams → render as image
        if (token.lang === 'mermaid' && mermaidImages.has(token.text)) {
          const { buffer, width, height } = mermaidImages.get(token.text);
          const scale = Math.min(1, 500 / width);
          elements.push(new Paragraph({
            children: [new ImageRun({
              type: 'png',
              data: buffer,
              transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
            })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 120 },
          }));
          break;
        }
        // Code block as single-cell table with green left border + gray bg
        const codeLines = unescapeHtml(token.text).split('\n');
        elements.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  shading: { fill: 'F5F5F5', type: ShadingType.CLEAR },
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0' },
                    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0' },
                    right: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0' },
                    left: { style: BorderStyle.SINGLE, size: 6, color: GREEN },
                  },
                  children: codeLines.map(line =>
                    new Paragraph({
                      children: [new TextRun({
                        text: line || ' ',
                        font: FONT_MONO,
                        size: 17,
                        color: MONO_GREEN,
                      })],
                      spacing: { line: 276 },
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
        // Render blockquote children with italic style and green left border
        const bqChildren = token.tokens
          ? tokensToElements(token.tokens, 0, mermaidImages)
          : [new Paragraph({ children: [new TextRun({ text: token.raw || '' })] })];

        // Wrap each child paragraph with blockquote styling
        for (const child of bqChildren) {
          if (child instanceof Paragraph) {
            elements.push(new Paragraph({
              children: inlineToRuns(
                token.tokens && token.tokens[0] && token.tokens[0].tokens
                  ? token.tokens[0].tokens
                  : [{ type: 'text', raw: token.raw || '' }],
                { italics: true, color: GRAY }
              ),
              indent: { left: convertMillimetersToTwip(5) },
              border: {
                left: { style: BorderStyle.SINGLE, size: 8, color: GREEN },
              },
              shading: { type: ShadingType.CLEAR, fill: 'F9F9F9' },
              spacing: { after: 120, line: 360 },
            }));
            break; // Only first paragraph for simple blockquotes
          }
        }
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
        const headerCells = token.header.map(cell =>
          new TableCell({
            shading: { fill: GREEN, type: ShadingType.CLEAR },
            borders: cellBorders(),
            children: [new Paragraph({
              children: inlineToRuns(cell.tokens, { bold: true, color: WHITE, size: 19 }),
              spacing: { before: 40, after: 40 },
            })],
          })
        );

        const bodyRows = token.rows.map((row, rowIdx) =>
          new TableRow({
            children: row.map(cell =>
              new TableCell({
                shading: { fill: rowIdx % 2 === 0 ? WHITE : LIGHT_GREEN, type: ShadingType.CLEAR },
                borders: cellBorders(),
                children: [new Paragraph({
                  children: inlineToRuns(cell.tokens),
                  spacing: { before: 40, after: 40 },
                })],
              })
            ),
          })
        );

        elements.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
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
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR } },
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
            children: [new TextRun({ text: token.raw, font: FONT_BODY, size: 20, color: DARK })],
            spacing: { after: 120 },
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
    children: inlineToRuns(firstParaTokens),
    numbering: { reference: ref, level: depth },
    spacing: { after: 40, line: 360 },
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
      } else {
        elements.push(...tokensToElements([sub], depth, mermaidImages));
      }
    }
  }

  return elements;
}

function cellBorders() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR };
  return { top: b, bottom: b, left: b, right: b };
}

// ── Build header/footer ──────────────────────────────────────────────────────
function buildHeader(headerTitle) {
  const children = [];

  // Logo on left
  if (fs.existsSync(LOGO_PATH)) {
    children.push(new ImageRun({
      data: fs.readFileSync(LOGO_PATH),
      transformation: { width: 110, height: 23 },
      type: 'png',
    }));
  }

  // Tab + title on right
  children.push(new TextRun({ text: '\t', font: FONT_BODY, size: 16 }));
  children.push(new TextRun({ text: headerTitle, font: FONT_BODY, size: 16, color: '000000' }));

  return new Header({
    children: [new Paragraph({
      children,
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: GREEN, space: 4 } },
      spacing: { after: 80 },
    })],
  });
}

function buildFooter(footerTitle) {
  return new Footer({
    children: [new Paragraph({
      children: [
        new TextRun({ text: footerTitle, font: FONT_BODY, size: 16, color: '000000' }),
        new TextRun({ text: '\t', font: FONT_BODY, size: 16 }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT_BODY, size: 16, color: '000000' }),
      ],
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: GREEN, space: 4 } },
    })],
  });
}

// ── Cover page ───────────────────────────────────────────────────────────────
function buildCoverPage(parsed) {
  const { title, id, type, status, date, author, client, project } = parsed;
  const children = [];

  // Logo (left) + email (right)
  const logoRuns = [];
  if (fs.existsSync(LOGO_PATH)) {
    logoRuns.push(new ImageRun({
      data: fs.readFileSync(LOGO_PATH),
      transformation: { width: 130, height: 27 },
      type: 'png',
    }));
  }
  children.push(new Paragraph({
    children: [
      ...logoRuns,
      new TextRun({ text: '\t', font: FONT_BODY, size: 18 }),
      new ExternalHyperlink({
        link: 'mailto:info@cogni.zone',
        children: [new TextRun({ text: 'info@cogni.zone', color: LINK_BLUE, font: FONT_BODY, size: 18 })],
      }),
    ],
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIP }],
    spacing: { after: 0 },
  }));
  // cogni.zone link (right-aligned, below logo line)
  children.push(new Paragraph({
    alignment: AlignmentType.RIGHT,
    children: [new ExternalHyperlink({
      link: 'https://cogni.zone',
      children: [new TextRun({ text: 'cogni.zone', color: LINK_BLUE, font: FONT_BODY, size: 18 })],
    })],
    spacing: { after: 400 },
  }));

  // ID eyebrow
  if (id) {
    children.push(new Paragraph({
      children: [new TextRun({
        text: id,
        bold: true,
        font: FONT_BODY,
        size: 26,
        color: GREEN,
        characterSpacing: 50,
      })],
      spacing: { after: 80 },
    }));
  }

  // Title
  children.push(new Paragraph({
    children: [new TextRun({
      text: title,
      bold: true,
      font: FONT_BODY,
      size: 44,
      color: DARK,
    })],
    spacing: { after: 480 },
  }));

  // Metadata table
  const metaData = [
    ['ID',             id],
    ['Document title', title],
    ['Type',           type],
    ['Date',           date],
    ['Status',         status],
    ['Author',         author],
    ['Client',         client],
    ['Project',        project],
  ].filter(([, v]) => v);

  if (metaData.length) {
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: metaData.map(([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 30, type: WidthType.PERCENTAGE },
              shading: { fill: META_LABEL_BG, type: ShadingType.CLEAR },
              verticalAlign: VerticalAlignTable.CENTER,
              margins: { top: 80, bottom: 80, left: 120, right: 120, marginUnitType: WidthType.DXA },
              borders: cellBorders(),
              children: [new Paragraph({
                children: [new TextRun({ text: label, bold: true, font: FONT_BODY, size: 20, color: DARK })],
                spacing: { before: 0, after: 0, line: 240 },
              })],
            }),
            new TableCell({
              width: { size: 70, type: WidthType.PERCENTAGE },
              verticalAlign: VerticalAlignTable.CENTER,
              margins: { top: 80, bottom: 80, left: 120, right: 120, marginUnitType: WidthType.DXA },
              borders: cellBorders(),
              children: [new Paragraph({
                children: [new TextRun({ text: value, font: FONT_BODY, size: 20, color: DARK })],
                spacing: { before: 0, after: 0, line: 240 },
              })],
            }),
          ],
        })
      ),
    }));
  }

  return children;
}

// ── Styles ───────────────────────────────────────────────────────────────────
function buildStyles() {
  return {
    default: {
      document: {
        run: { font: FONT_BODY, size: 20, color: DARK },
        paragraph: { spacing: { line: 360 } },
      },
    },
    paragraphStyles: [
      {
        id: 'Normal',
        name: 'Normal',
        run: { font: FONT_BODY, size: 20, color: DARK },
        paragraph: { spacing: { line: 360, after: 120 } },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: FONT_BODY, size: 26, color: DARK, bold: true },
        paragraph: {
          spacing: { before: 320, after: 120 },
        },
      },
      {
        id: 'Heading3',
        name: 'Heading 3',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: FONT_BODY, size: 24, color: GREEN, bold: true },
        paragraph: {
          spacing: { before: 200, after: 120 },
        },
      },
      {
        id: 'Heading4',
        name: 'Heading 4',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: FONT_BODY, size: 22, color: DARK2, bold: true },
        paragraph: {
          spacing: { before: 200, after: 120 },
        },
      },
    ],
  };
}

// ── Section properties ───────────────────────────────────────────────────────
const sectionProps = {
  page: {
    size: { width: 11906, height: 16838 }, // A4 in twips
    margin: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_SIDE, right: MARGIN_SIDE },
  },
};

// ── Main render function ─────────────────────────────────────────────────────
async function renderDocx(parsed, outputFile) {
  const { headerTitle, footerTitle, inputDir, tokens, tocEntries } = parsed;
  _inputDir = inputDir || process.cwd();
  _orderedListIndex = 0;

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
    footers: { default: buildFooter(footerTitle) },
    children: [
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({
          text: 'Contents',
          bold: true,
          font: FONT_BODY,
          size: 26,
          color: DARK,
        })],
        spacing: { after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: DARK } },
      }),
      new TableOfContents('Table of Contents', {
        hyperlink: true,
        headingStyleRange: '2-4',
      }),
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
    footers: { default: buildFooter(footerTitle) },
    children: bodyElements,
  };

  const doc = new Document({
    styles: buildStyles(),
    numbering: buildNumberingConfig(countOrderedLists(tokens)),
    features: { updateFields: true },
    sections: [coverSection, tocSection, bodySection],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputFile, buffer);
}

module.exports = { renderDocx };
