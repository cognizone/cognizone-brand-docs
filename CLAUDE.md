# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Repository Purpose

This is the **Cognizone branded document conversion** package (`@cognizone/brand-docs`). It converts Markdown files to branded output formats (PDF, Word, HTML) using the Cognizone 2026 brand — colors, fonts, and layout. It has one brand; the old `classic` brand was removed in 2.0.0.

Published to GitHub Packages. Installed via Git URL: `npm install -g cognizone/cognizone-brand-docs`. CLI command: `cognizone-convert`.

Supports single-file conversion (PDF, DOCX, or HTML) and folder merge (all `.md` / `.markdown` files → single PDF or HTML).

## Repo Structure

```
bin/
  cognizone-convert.js    # CLI entry point — help/version, calls convert.js
  convert.js              # Thin orchestrator — args/format, downloads Chrome on first use, parse + route to renderer
  parse.js                # Shared parsing: frontmatter, lexing, section numbers, TOC
  render-pdf.js           # PDF renderer (HTML assembly + Puppeteer)
  render-docx.js          # DOCX renderer (token tree → docx Document)
  render-html.js          # HTML renderer (self-contained single file, no Puppeteer)
  mermaid-opts.js         # Parses mermaid fence options (maxWidth, align)
templates/
  styles.css              # Cognizone brand CSS for PDF output
  pdf-print.js            # Puppeteer script — renders HTML to PDF with headers/footers
  icon.png                # Cognizone icon (cover, headers)
  fonts/                  # Roboto + Roboto Mono variable fonts (HTML), Calistoga (titles), TTF
    static/               # Static Roboto/Roboto Mono instances for the PDF (variable fonts embed as Type 3)
reference/                # Brand style spec + content-free reference .docx (private/ is git-ignored)
assets/brand-2026/        # Logo pack as delivered (not in the npm package)
test/
  run.js                  # Test runner (`npm test`) — converts fixture.md in every format and asserts on the output
  fixture.md              # Test document exercising every element
  output/                 # brand-2026.{pdf,docx}: README samples (tracked)
package.json              # npm package config
```

## Testing

`npm test` runs `test/run.js` (no framework). It regenerates the tracked samples in `test/output/` as a side effect — only commit those when the sample outputs should change (the README screenshots in `docs/screenshots/` are cropped from `test/output/brand-2026.pdf` with `pdftoppm -r 150`). Add a regression test there for every rendering bug fixed. The tests shell out to `unzip` and write to `/dev/null`, so they run on macOS/Linux (or WSL), not plain Windows. The PDF text and TOC page-number checks use `pdftotext` (poppler) when it is installed and are skipped without it. Besides the fixture, the tests cover the CLI wrapper (`bin/cognizone-convert.js --help` / `--version`), a PDF folder merge and the removed `--brand` option's compatibility shim.

## Cross-platform

The tool itself must work on macOS, Windows and Linux: no shell scripts, spawn Node with `process.execPath` (not `'node'`), build paths with `path`, and keep install steps to plain `npm`. Recent npm versions skip install scripts by default, so puppeteer's postinstall may never fetch Chrome; `ensureChrome()` in `bin/convert.js` runs puppeteer's own `install.mjs` on first use instead (skipped for HTML output).

## Conversion Pipeline

`bin/convert.js` orchestrates the conversion (pure Node.js, no bash or pandoc):

1. **Parse** (`parse.js`) — `gray-matter` extracts frontmatter (YAML only: `---js` / `---javascript` throw); `marked.lexer()` produces token tree; the title H1 is spliced out of the tokens only when it is the first block (leading blank lines and raw HTML blocks such as a comment are skipped), so a later H1 and `#` lines in code fences stay; `rewriteLinks()` runs; walks tokens to compute section numbers + TOC entries. Heading ids are unique against every id issued (suffix bumped until free, `section` when the heading has no usable characters); TOC text comes from the heading's inline tokens (link text without the URL, entities decoded by `decodeEntities()`, which `render-docx.js` imports too)
2. **Route** — based on `--format` flag, delegates to `render-pdf.js`, `render-docx.js`, or `render-html.js`

The removed `--brand` option is still parsed so old scripts keep working, and is deliberately left out of `--help`: `-b 2026` is ignored, any other value exits 1 with the removal message. A document with frontmatter `brand: classic` gets a one-line warning on stderr and is rendered in the 2026 brand.

### Link options (`rewriteLinks()` in `parse.js`)

`rewriteLinks()` always runs and rewrites link tokens in place after lexing, so every renderer gets the result; renderers must render `parsed.tokens`, never re-lex the Markdown source (that misses the rewrite). `javascript:`, `vbscript:` and `data:` links always become their text. In folder merges `anchorPrefix` turns `#x` into `#doc-{i}-x`. `--no-external-links` turns other non-`#` links into their text and also drops raw HTML `<a href>` tags, keeping their text and `#anchor` ones (`stripRawLinks()`). Relative `.md` links become the converted sibling (`#section` dropped); with `--link-base` they become `<url>` + their path from the cwd, plus `?web=1` on `*.sharepoint.com` (SharePoint downloads a bare file URL). `convert.js` `folderUrl()` requires an http(s) URL and turns a SharePoint `AllItems.aspx?id=` address into the folder URL; the `id` must be a `/`-rooted folder path on the same site. Out-of-cwd links: plain text with `--no-external-links`, else left relative. User docs: README "Links in delivered documents".

### Folder merge path (PDF and HTML)

When the input is a directory, `convert.js` recursively finds all `.md` / `.markdown` files, any case (sorted alphabetically), parses each one, and calls `renderMergedPdf()` in `render-pdf.js` (or `renderMergedHtml()` in `render-html.js` when `--format html`). This produces a single file:

1. **Master cover page** — folder name as title, table listing all documents (number, ID, title)
2. **Master TOC** — single table of contents; each document is a top-level entry with its headings nested below
3. **Per-document sections** — each document gets its own cover page (from its frontmatter) followed by its body content

Key details:

- Section numbering resets per document
- Heading IDs are prefixed with `doc-{index}-` to avoid collisions across documents; `#heading` links get the same prefix (`anchorPrefix` in `parse.js`), so they keep working
- Relative image paths are resolved per document — PDF uses absolute `file://` URLs (no `<base href>`); HTML embeds them as data URIs
- Header shows the folder name; footer is empty (the documents may belong to different clients/projects)
- DOCX merge is not supported — folder input errors if `--format docx` is requested

### PDF path (`render-pdf.js`)

1. Configure `marked.use()` heading + code renderer with pre-computed section numbers
2. `marked.parser(tokens)` → body HTML (mermaid blocks emit `<pre class="mermaid">` instead of `<pre><code>`)
3. Assemble full HTML (cover + TOC + body)
4. Render via Puppeteer (`templates/pdf-print.js`) — mermaid.js runs in the page before TOC page calculation

### DOCX path (`render-docx.js`)

1. Pre-render mermaid blocks to PNG via Puppeteer (single browser session, one page per diagram); SVG images are rasterized to PNG in the same session
2. Walk token tree directly to build `docx` library objects (no HTML intermediate); mermaid blocks become `ImageRun` elements
3. Three sections: cover page (no header/footer) → contents page (static entries in a TOC field, see below) → body
4. Headers/footers with icon + title / footer text + page numbers
5. `Packer.toBuffer()` → write `.docx` file

Note: Word references fonts by name (can't embed TTFs). Calistoga/Roboto/Roboto Mono must be installed on the machine opening the file, or Word falls back to defaults.

### HTML path (`render-html.js`)

1. Same marked renderer approach as PDF (section-numbered headings, mermaid `<pre class="mermaid">` blocks)
2. Assemble a single self-contained `.html` file — no Puppeteer, no external requests:
   - Calistoga/Roboto/Roboto Mono fonts and icon embedded as base64 data URIs
   - Images (both `![alt](path)` and raw `<img>` tags) embedded as data URIs, resolved relative to the source file (%-encoded paths such as `pic%20one.png` and single-quoted `src` work too)
   - Mermaid UMD bundle inlined into a `<script>` (only when the document has mermaid blocks, also ones nested in blockquotes and list items) so diagrams render offline; the `<script>` tags carry the CSP nonce
3. Web-style layout instead of paged: sticky branded header, anchor-link TOC (no page numbers), footer at document end, `@media print` rules for browser printing

HTML brand CSS lives in `render-html.js` (`STYLES` constant), mirroring `templates/styles.css` values.

`templates/pdf-print.js`:

- Inlines the icon as a data URI (external URLs/`@import` crash Puppeteer PDF printing)
- Draws the branded header and footer as CSS `@page` margin boxes, not Puppeteer's `headerTemplate`/`footerTemplate` (those are painted on every page; the cover has none); needs Chrome ≥ 131 (bundled with puppeteer 24)
- Forces `prefers-color-scheme: light` to prevent dark mode from affecting rendering
- Evaluates mermaid.js through `page.evaluate` and runs `mermaid.run()` to render diagrams as SVGs before layout
- Uses `page.evaluate()` to calculate and inject page numbers into TOC before printing
- `page.pdf()` with `margin: { top: 25mm, bottom: 20mm, left: 20mm, right: 20mm }`

## marked v13 renderer note

`marked.use()` renderer overrides vary by element type:

- **`heading(innerHtml)`** — receives already-rendered inner HTML (post-processor). To correlate with token data, use `walkTokens` to collect heading metadata in order, then match by index in the renderer override.
- **`code(text, lang, escaped)`** — receives raw code text, language string, and escaped flag as separate arguments. Return HTML string directly.

## Brand implementation notes

- Styling source of truth: `reference/brand-2026-spec.md` (measured from `reference/brand-2026-reference.docx`, a content-free copy of a real 2026 document). `reference/private/` is git-ignored and holds the confidential original — never commit or quote it.
- Logo pack as delivered: `assets/brand-2026/` (not shipped in the npm package; the renderers use `templates/icon.png`).
- H2 headings carry a `CHAPTER 01` label above the title (`displayNumber()` in the PDF/HTML renderers, a separate label paragraph in DOCX); merged master-TOC entries show `DOCUMENT 01`.
- DOCX contents page entries are **static**, not generated by Word (a Word-built TOC copies the heading's direct run formatting into the entries). Each entry is built from `parsed.tocEntries`; page numbers are `PAGEREF` fields to `_toc_n` bookmarks on the headings, wrapped in one `TOC \o "2-4"` field whose cached result is the styled entries. The numbers come from References → Update Table → "Update page numbers only", which repaginates first. Never update fields on open (`updateFields` / `w:dirty`): Word then rebuilds the TOC field in its default TOC styles, like "Update entire table", and fills bare PAGEREFs with 1.
- DOCX blockquotes are a single-cell table (pink left border, sand fill), so the whole quote is one box whatever it contains.
- DOCX images take their type and size from the file's bytes (`imageInfo()`: PNG, JPEG, GIF, BMP), not the extension; SVG is rasterized to PNG (DOCX path step 1); any other file is left out with a warning and shows `[alt]`. Images are at most 500px wide with their aspect ratio kept, and a raw `<img>` with only `width` or only `height` gets the other proportionally. %-encoded paths are decoded, and every `<img>` in a raw HTML block renders, inline `<img>` too.
- DOCX ordered lists keep their start number (`3.` resumes at 3). Each gets its own numbering definition, allocated as it renders (`listRef()`), so lists inside quotes get one too; `buildNumberingConfig()` runs after the body.
- A DOCX list item that starts with a block (heading, code fence, quote) shows its marker on its own line, with the block below it. Code blocks, quotes, tables and images inside a list item start at the item's text indent and end at the right margin (`box` in `tokensToElements()`); a heading keeps its own position.
- DOCX entities: fenced code is verbatim; inline code and prose are decoded once (`decodeEntities()` from `parse.js`).
- The HTML output and the page the PDF is printed from carry a Content-Security-Policy meta: scripts run only with a per-run nonce, no objects or frames. Raw `<script>`, `on*=` handlers and `javascript:` URLs in the Markdown are inert, and `<iframe>` / `<object>` load nothing. Only the HTML's mermaid `<script>` tags carry the nonce; `templates/pdf-print.js` evaluates the mermaid bundle through `page.evaluate` (an injected script tag would be blocked), and stops with an error if the document navigates to another page (e.g. `<meta http-equiv="refresh">`).
- Fence info strings: only the first word becomes the `language-…` class, escaped. The PDF escapes mermaid source.
- A PDF cover is exactly one page and content that does not fit is cut off; `pdf-print.js` warns on stderr when that happens (shorten `summary`). TOC page numbers count each cover as one page. TOC nesting stays well-formed when heading levels are skipped or a document starts below H2.
- Mermaid diagrams: `` ```mermaid `` blocks use `theme: 'neutral'`; per-diagram sizing via fence options `` ```mermaid maxWidth=300 align=left `` — keys `maxWidth` (pixels, default 500) and `align` (`left`/`center`/`right`, default `center`), parsed by `bin/mermaid-opts.js`; invalid values warn to stderr and fall back to defaults. PDF and HTML render SVG in the browser; DOCX embeds pre-rendered PNGs.
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

All fields are optional, plus `subtitle`, `summary` and `classification`. How each field is used (full spec: `reference/brand-2026-spec.md`):

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
cognizone-convert document.md out.docx           # format from the output extension (when no -f)
cognizone-convert document.md --no-external-links  # non-#anchor links (raw <a href> too) → plain text (stripped in parse.js; all formats)
cognizone-convert document.md --relative-links     # relative .md links → converted sibling (.docx/.html; PDF gets absolute file://)
cognizone-convert specs/a.md --link-base <url>      # same, absolute: <url> is the web address of the cwd (SharePoint AllItems.aspx?id= accepted)

# Folder merge (PDF or HTML)
cognizone-convert docs/                          # → docs.pdf in CWD
cognizone-convert docs/ -f html                  # → docs.html in CWD
cognizone-convert docs/ merged-output.pdf        # custom output path
```

The default single-file output sits next to the input with the extension replaced whatever its case (`X.MD` → `X.pdf`); the tool refuses to write over its input. Unknown options, an option missing its value and a third positional argument are errors. Folder merges take `.md` and `.markdown` files in any case.

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
