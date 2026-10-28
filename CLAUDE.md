# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Repository Purpose

This is the **Cognizone branded document conversion** package (`@cognizone/brand-docs`). It converts Markdown files to branded output formats (PDF, Word, HTML) using Cognizone brand styles — colors, fonts, and layout. The **2026 brand** is the default; the old `classic` brand stays available with `-b classic` until it is deleted.

Published to GitHub Packages. Installed via Git URL: `npm install -g cognizone/cognizone-brand-docs`. CLI command: `cognizone-convert`.

Supports single-file conversion (PDF, DOCX, or HTML) and folder merge (all `.md` files → single PDF or HTML).

## Repo Structure

```
bin/
  cognizone-convert.js    # CLI entry point — help/version, downloads Chrome on first use, calls convert.js
  convert.js              # Thin orchestrator — parse + route to renderer
  parse.js                # Shared parsing: frontmatter, lexing, section numbers, TOC
  render-pdf.js           # PDF renderer (HTML assembly + Puppeteer)
  render-docx.js          # DOCX renderer (token tree → docx Document)
  render-html.js          # HTML renderer (self-contained single file, no Puppeteer)
  render-*-2026.js        # 2026 brand (default) copies of the three renderers (see "Brands")
  mermaid-opts.js         # Parses mermaid fence options (maxWidth, align)
templates/
  styles.css              # Cognizone brand CSS for PDF output
  pdf-print.js            # Puppeteer script — renders HTML to PDF with headers/footers
  logo.png                # Cognizone logo (used in headers)
  2026/                   # 2026 brand: styles.css, pdf-print.js, icon.png
  fonts/                  # Roboto + Roboto Mono variable fonts, Calistoga (2026 titles), TTF
reference/                # 2026 style spec + content-free reference .docx (private/ is git-ignored)
assets/brand-2026/        # 2026 logo pack as delivered (not in the npm package)
test/
  run.js                  # Test runner (`npm test`) — converts fixture.md in every format/brand and asserts on the output
  fixture.md              # Test document exercising every element
  output/                 # brand-2026.{pdf,docx}: README samples; fixture.{pdf,docx}: classic samples (tracked)
package.json              # npm package config
```

## Testing

`npm test` runs `test/run.js` (no framework). It regenerates the tracked samples in `test/output/` as a side effect — only commit those when the sample outputs should change (the README screenshots in `docs/screenshots/` are cropped from `test/output/brand-2026.pdf` with `pdftoppm -r 150`). Classic-brand tests pass `--brand classic` explicitly. Add a regression test there for every rendering bug fixed. The tests shell out to `unzip` and write to `/dev/null`, so they run on macOS/Linux (or WSL), not plain Windows.

## Cross-platform

The tool itself must work on macOS, Windows and Linux: no shell scripts, spawn Node with `process.execPath` (not `'node'`), build paths with `path`, and keep install steps to plain `npm`. Recent npm versions skip install scripts by default, so puppeteer's postinstall may never fetch Chrome; `ensureChrome()` in `bin/cognizone-convert.js` runs puppeteer's own `install.mjs` on first use instead (skipped for HTML output).

## Conversion Pipeline

`bin/convert.js` orchestrates the conversion (pure Node.js, no bash or pandoc):

1. **Parse** (`parse.js`) — `gray-matter` extracts frontmatter; `marked.lexer()` produces token tree; walks tokens to compute section numbers + TOC entries
2. **Route** — based on `--format` flag, delegates to `render-pdf.js`, `render-docx.js`, or `render-html.js` (or their `-2026` copies when the brand is `2026`: `--brand` flag first, then frontmatter `brand`, default `2026`)

The path sections below name the classic files; the `-2026` copies follow the same structure, with the differences listed under "Brands".

### Folder merge path (PDF and HTML)

When the input is a directory, `convert.js` recursively finds all `.md` files (sorted alphabetically), parses each one, and calls `renderMergedPdf()` in `render-pdf.js` (or `renderMergedHtml()` in `render-html.js` when `--format html`). This produces a single file:

1. **Master cover page** — folder name as title, table listing all documents (number, ID, title)
2. **Master TOC** — single table of contents; each document is a top-level entry with its headings nested below
3. **Per-document sections** — each document gets its own cover page (from its frontmatter) followed by its body content

Key details:

- Section numbering resets per document
- Heading IDs are prefixed with `doc-{index}-` to avoid collisions across documents
- Relative image paths are resolved per document — PDF uses absolute `file://` URLs (no `<base href>`); HTML embeds them as data URIs
- Header shows the folder name; footer is empty (Puppeteer only supports one static header/footer template)
- DOCX merge is not supported — folder input errors if `--format docx` is requested

### PDF path (`render-pdf.js`)

1. Configure `marked.use()` heading + code renderer with pre-computed section numbers
2. `marked.parser(tokens)` → body HTML (mermaid blocks emit `<pre class="mermaid">` instead of `<pre><code>`)
3. Assemble full HTML (cover + TOC + body)
4. Render via Puppeteer (`templates/pdf-print.js`) — mermaid.js is injected and runs before TOC page calculation

### DOCX path (`render-docx.js`)

1. Pre-render mermaid blocks to PNG via Puppeteer (single browser session, one page per diagram)
2. Walk token tree directly to build `docx` library objects (no HTML intermediate); mermaid blocks become `ImageRun` elements
3. Three sections: cover page (no header/footer) → TOC (native Word TOC field) → body
4. Headers/footers with logo image + title / footer text + page numbers
5. `Packer.toBuffer()` → write `.docx` file

Note: Word references fonts by name (can't embed TTFs). Roboto/Roboto Mono must be installed on the machine opening the file, or Word falls back to defaults.

### HTML path (`render-html.js`)

1. Same marked renderer approach as PDF (section-numbered headings, mermaid `<pre class="mermaid">` blocks)
2. Assemble a single self-contained `.html` file — no Puppeteer, no external requests:
   - Roboto/Roboto Mono fonts and logo embedded as base64 data URIs
   - Images (both `![alt](path)` and raw `<img>` tags) embedded as data URIs, resolved relative to the source file
   - Mermaid UMD bundle inlined into a `<script>` (only when the document has mermaid blocks) so diagrams render offline
3. Web-style layout instead of paged: sticky branded header, anchor-link TOC (no page numbers), footer at document end, `@media print` rules for browser printing

HTML brand CSS lives in `render-html.js` (`STYLES` constant), mirroring `templates/styles.css` values.

`templates/pdf-print.js`:

- Base64-encodes logo and Roboto font (external URLs/`@import` crash Puppeteer PDF printing)
- Injects branded `headerTemplate` and `footerTemplate` (rendered in page margins on every page)
- Forces `prefers-color-scheme: light` to prevent dark mode from affecting rendering
- Injects mermaid.js and runs `mermaid.run()` to render diagrams as SVGs before layout
- Uses `page.evaluate()` to calculate and inject page numbers into TOC before printing
- `page.pdf()` with `margin: { top: 25mm, bottom: 20mm, left: 20mm, right: 20mm }`

## marked v13 renderer note

`marked.use()` renderer overrides vary by element type:

- **`heading(innerHtml)`** — receives already-rendered inner HTML (post-processor). To correlate with token data, use `walkTokens` to collect heading metadata in order, then match by index in the renderer override.
- **`code(text, lang, escaped)`** — receives raw code text, language string, and escaped flag as separate arguments. Return HTML string directly.

## Brands: 2026 (default) and classic (frozen)

The 2026 brand is the default and lives in full copies of the renderers: `bin/render-pdf-2026.js`, `bin/render-docx-2026.js`, `bin/render-html-2026.js`, `templates/2026/` (styles.css, pdf-print.js, icon.png). `--brand classic` (or frontmatter `brand: classic`) routes to the original renderers instead. Routing lives in `bin/convert.js` (`renderer()`).

- The classic brand is **frozen** and will be deleted in late 2026 / early 2027: fix bugs in the 2026 files only. Removal = delete the classic renderers/templates, rename the `-2026` files, drop the `--brand` switch and its tests.
- Styling source of truth: `reference/brand-2026-spec.md` (measured from `reference/brand-2026-reference.docx`, a content-free copy of a real 2026 document). `reference/private/` is git-ignored and holds the confidential original — never commit or quote it.
- Logo pack as delivered: `assets/brand-2026/` (not shipped in the npm package; the renderers use `templates/2026/icon.png`).
- PDF header/footer are drawn with CSS `@page` margin boxes (not Puppeteer templates) so the cover can have none; needs Chrome ≥ 131 (bundled with puppeteer 24).
- H2 headings carry a `CHAPTER 01` label above the title (`displayNumber()` in the PDF/HTML renderers, a separate label paragraph in DOCX); merged master-TOC entries show `DOCUMENT 01`.
- DOCX contents page is **static**, not a native TOC field (Word's TOC copies the heading's direct run formatting into the entries). Each entry is built from `parsed.tocEntries`; page numbers are `PAGEREF` fields to `_toc_n` bookmarks on the headings, filled in when Word updates fields on open (`updateFields: true` — the user must click Yes on Word's prompt).
- DOCX blockquotes are a single-cell table (pink left border, sand fill), so the whole quote is one box whatever it contains.
- Word paragraph-border quirks to keep in mind: space-after is drawn *inside* the border box (put gaps in space-before instead), and adjacent paragraphs with identical borders and indents are merged into one box (alternate the indent by 1 twip to keep them apart).

## Document Frontmatter

Input Markdown files should have YAML frontmatter:

```yaml
---
title: "Document Title"
id: ADR-001
type: adr            # adr | spec | report | ...
status: draft
version: "1.0"
date: 2025-01-01
author: Cognizone
client: "ERA — European Union Agency for Railways"
project: REG+
---
```

All fields are optional, plus `subtitle`, `summary`, `classification` (ignored by classic) and `brand` (`2026` or `classic`). How each field is used in the 2026 brand (full spec: `reference/brand-2026-spec.md`):

| Field | Cover | Header | Footer |
|---|---|---|---|
| `title` | Title (Calistoga 32pt plum) | `{id} - {title}` | — |
| `subtitle` | Second title line (pink) | — | — |
| `summary` | Paragraph under the title | — | — |
| `type` | Eyebrow `COGNIZONE / {type}` + table row | — | — |
| `id` | Eyebrow when there is no type + table row | `{id} - {title}` | — |
| `status`, `version`, `author` | Table row | — | — |
| `date` | Table row + bottom line `{date} · {classification}` | — | — |
| `classification` | Bottom line | — | `{classification} · {client} · {project}` |
| `client`, `project` | Table row | — | `{classification} · {client} · {project}` |

## Classic brand rendering rules (frozen)

The 2026 brand's rules are in `reference/brand-2026-spec.md`. The rules below describe the **classic** brand (`-b classic`), kept until it is deleted; its frontmatter use is the same as the 2026 table above except: green `id` eyebrow, 22pt bold title, and footer `{client} · {project}`. All formats apply the same brand rules. Defined in `templates/styles.css` (PDF), `bin/render-docx.js` (DOCX), and `bin/render-html.js` (HTML).

### Brand colors

| Name | Hex | Usage |
|---|---|---|
| Green | `#058775` | Primary accent — H3 headings, links, borders, table headers, cover ID |
| Dark | `#353744` | Primary text — body, H2/H4 headings |
| Dark2 | `#272727` | H4 heading text |
| Gray | `#666666` | Secondary text — PDF header/footer |
| Mono Green | `#188038` | Code text (inline + blocks) |
| Light Green | `#E8F5F3` | Alternating table row background |
| Border | `#BFBFBF` | Table borders, horizontal rules |
| Meta Label BG | `#EAF0F8` | Cover metadata table label column |
| Link Blue | `#0563C1` | Cover page contact links |

### Page layout

A4 (210×297mm), margins: top 25mm, bottom 20mm, left/right 20mm.

### Typography

- Body: Roboto 10pt, line-height 1.5, color `#353744`
- Code: Roboto Mono

### Headings

H1 is stripped from body (used on cover page only). Body headings get section numbers.

| Level | Size | Color | Extra |
|---|---|---|---|
| H2 | 13pt bold | `#353744` (dark) | Bottom border, section number "1" |
| H3 | 12pt bold | `#058775` (green) | Section number "1.1" |
| H4 | 11pt bold | `#272727` (dark2) | Section number "1.1.1" |

### Elements

- **Mermaid diagrams**: `` ```mermaid `` code blocks render as visual diagrams. PDF: client-side SVG via mermaid.js in Puppeteer. DOCX: pre-rendered to PNG via headless browser, embedded as images. HTML: mermaid bundle inlined, renders in the browser on open. Uses `theme: 'neutral'`. Per-diagram sizing via fence options: `` ```mermaid maxWidth=300 align=left `` — keys `maxWidth` (pixels, default 500) and `align` (`left`/`center`/`right`, default `center`). Parsed by `bin/mermaid-opts.js`; invalid values warn to stderr and fall back to defaults
- **Code blocks**: Roboto Mono 8.5pt, `#188038` on `#f5f5f5`, green left border
- **Inline code**: Roboto Mono 9pt, `#188038` on `#f5f5f5`
- **Tables**: Green header row (white bold text, 9.5pt), alternating `#E8F5F3`/white body rows, `#BFBFBF` borders
- **Blockquotes**: Italic, green left border
- **Links**: `#058775` (green), no underline
- **Horizontal rules**: 1px `#BFBFBF`
- **Lists**: Bullet (•/◦/–) and ordered (1./a./i.) with nested indentation
- **Images**: `![alt](path)` and `<img>` tags supported; PDF and HTML constrain via `max-width: 100%`; DOCX scales to max 500px wide preserving aspect ratio. Paths resolve relative to the input markdown file; HTML embeds them as base64 data URIs

### Document structure

1. **Cover page** — contact links → ID eyebrow (green, letter-spaced) → title (22pt bold) → metadata table
2. **Table of Contents** — "Contents" heading + TOC with section numbers and page references
3. **Body** — section-numbered content with all block/inline elements

### Header / Footer

- **Header**: Logo (left) + `{id} - {title}` (right), green bottom border
- **Footer**: `{client} · {project}` (left) + page number (right), green top border

### PDF vs DOCX differences

Some intentional styling differences between formats:

| Element | PDF | DOCX | Reason |
|---|---|---|---|
| Blockquote text | `#444444` | `#666666` | Word renders lighter; GRAY ensures readability |
| Blockquote background | none | `#F9F9F9` | Word lacks CSS cascade; light bg distinguishes from body |
| Header/footer text | `#666666` (gray) | `#000000` (black) | Word renders 8pt differently; black ensures legibility, green border provides accent |
| Cover page logo | No | Yes | DOCX cover is richer since it can't rely on CSS layout |
| TOC | HTML with dot leaders + calculated page numbers | Native Word TOC field (updates on open) | Different capabilities per format |
| Mermaid diagrams | Client-side SVG (mermaid.js in Puppeteer page) | Pre-rendered PNG screenshots embedded as images | DOCX can't run JS; PNG via headless browser |

## Markdown Authoring Rule

**Always put a blank line between a label/paragraph and the list that follows it.**

```markdown
<!-- WRONG -->
Key forces:
- Item one

<!-- CORRECT -->
Key forces:

- Item one
```

This applies to any label ending in `:` followed by a list.

## Installation

Install via Git URL (no npm registry config needed):

```bash
npm install -g cognizone/cognizone-brand-docs
```

To update, run the same command again.

### Usage

```bash
# Single file
cognizone-convert document.md                    # → document.pdf
cognizone-convert document.md --format docx      # → document.docx
cognizone-convert document.md output.pdf         # custom output path
cognizone-convert document.md -b classic         # old brand

# Folder merge (PDF or HTML)
cognizone-convert docs/                          # → docs.pdf in CWD
cognizone-convert docs/ -f html                  # → docs.html in CWD
cognizone-convert docs/ merged-output.pdf        # custom output path
```

## Publishing

Package is published to GitHub Packages under the `@cognizone` scope. Users install via Git URL (not the registry) to avoid scope conflicts with `@cognizone` OSS packages on npmjs.com.

Publishing is automated via GitHub Actions — triggered by pushing a version tag:

```bash
# 1. Bump version in package.json
# 2. Commit and tag
git add package.json && git commit -m "chore: bump version to x.y.z"
git tag vx.y.z
git push origin main --tags
```

The workflow (`.github/workflows/publish.yml`) runs automatically on any `v*` tag. It publishes to GitHub Packages and creates a **draft** GitHub Release. After the workflow completes, edit the draft on the Releases page with hand-written notes (sections, descriptions) and publish it.

`gh release edit vx.y.z --notes-file notes.md --draft=false` does the last step from the CLI once `gh run watch` shows the workflow passed. Run `npm test` before tagging.
