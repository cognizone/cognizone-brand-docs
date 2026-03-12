# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Repository Purpose

This is the **Cognizone branded document conversion** package (`@cognizone/brand-docs`). It converts Markdown files to branded output formats (PDF, Word) using Cognizone brand styles — colors, fonts, and layout.

Published to GitHub Packages as an internal npm package. CLI command: `cognizone-convert`.

## Repo Structure

```
bin/
  cognizone-convert.js    # CLI entry point — parses args, calls convert.js
  convert.js              # Thin orchestrator — parse + route to renderer
  parse.js                # Shared parsing: frontmatter, lexing, section numbers, TOC
  render-pdf.js           # PDF renderer (HTML assembly + Puppeteer)
  render-docx.js          # DOCX renderer (token tree → docx Document)
templates/
  styles.css              # Cognizone brand CSS for PDF output
  pdf-print.js            # Puppeteer script — renders HTML to PDF with headers/footers
  logo.png                # Cognizone logo (used in headers)
  fonts/                  # Roboto + Roboto Mono variable fonts (TTF)
package.json              # npm package config
.npmrc                    # Points @cognizone scope to GitHub Packages
```

## Conversion Pipeline

`bin/convert.js` orchestrates the conversion (pure Node.js, no bash or pandoc):

1. **Parse** (`parse.js`) — `gray-matter` extracts frontmatter; `marked.lexer()` produces token tree; walks tokens to compute section numbers + TOC entries
2. **Route** — based on `--format` flag, delegates to `render-pdf.js` or `render-docx.js`

### PDF path (`render-pdf.js`)

1. Configure `marked.use()` heading renderer with pre-computed section numbers
2. `marked.parser(tokens)` → body HTML
3. Assemble full HTML (cover + TOC + body)
4. Render via Puppeteer (`templates/pdf-print.js`)

### DOCX path (`render-docx.js`)

1. Walk token tree directly to build `docx` library objects (no HTML intermediate)
2. Three sections: cover page (no header/footer) → TOC (native Word TOC field) → body
3. Headers/footers with logo image + title / footer text + page numbers
4. `Packer.toBuffer()` → write `.docx` file

Note: Word references fonts by name (can't embed TTFs). Roboto/Roboto Mono must be installed on the machine opening the file, or Word falls back to defaults.

`templates/pdf-print.js`:

- Base64-encodes logo and Roboto font (external URLs/`@import` crash Puppeteer PDF printing)
- Injects branded `headerTemplate` and `footerTemplate` (rendered in page margins on every page)
- Uses `page.evaluate()` to calculate and inject page numbers into TOC before printing
- `page.pdf()` with `margin: { top: 25mm, bottom: 20mm, left: 20mm, right: 20mm }`

## marked v13 renderer note

`marked.use()` renderer overrides are **post-processors**: the function receives the already-rendered inner HTML string from the default renderer (not the token). To correlate with token data, use `walkTokens` to collect heading metadata in order, then match by index in the renderer override.

## Document Frontmatter

Input Markdown files should have YAML frontmatter:

```yaml
---
title: "Document Title"
id: ADR-001
type: adr            # adr | spec | report | ...
status: draft
date: 2025-01-01
author: Cognizone
client: "ERA — European Union Agency for Railways"
project: REG+
---
```

All fields are optional. How each field is used:

| Field | Cover table | Header | Footer |
|---|---|---|---|
| `title` | Title (22pt bold) | `{id} - {title}` | — |
| `id` | Green eyebrow above title + table row | `{id} - {title}` | — |
| `type` | Table row | — | — |
| `status` | Table row | — | — |
| `date` | Table row | — | — |
| `author` | Table row | — | — |
| `client` | Table row | — | `{client} · {project}` |
| `project` | Table row | — | `{client} · {project}` |

## Rendering Rules

Both PDF and DOCX apply the same brand rules. Defined in `templates/styles.css` (PDF) and `bin/render-docx.js` (DOCX).

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

- **Code blocks**: Roboto Mono 8.5pt, `#188038` on `#f5f5f5`, green left border
- **Inline code**: Roboto Mono 9pt, `#188038` on `#f5f5f5`
- **Tables**: Green header row (white bold text, 9.5pt), alternating `#E8F5F3`/white body rows, `#BFBFBF` borders
- **Blockquotes**: Italic, green left border
- **Links**: `#058775` (green), no underline
- **Horizontal rules**: 1px `#BFBFBF`
- **Lists**: Bullet (•/◦/–) and ordered (1./a./i.) with nested indentation
- **Images**: `![alt](path)` and `<img>` tags supported; PDF constrains via `max-width: 100%`; DOCX scales to max 500px wide preserving aspect ratio. Paths resolve relative to the input markdown file

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

## Publishing

Package is published to GitHub Packages under the `@cognizone` scope.

Publishing is automated via GitHub Actions — triggered by pushing a version tag:

```bash
# 1. Bump version in package.json
# 2. Commit and tag
git add package.json && git commit -m "chore: bump version to x.y.z"
git tag vx.y.z
git push origin main --tags
```

The workflow (`.github/workflows/publish.yml`) runs automatically on any `v*` tag.

