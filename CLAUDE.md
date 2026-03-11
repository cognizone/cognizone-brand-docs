# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Repository Purpose

This is the **Cognizone branded document conversion** package (`@cognizone/brand-docs`). It converts Markdown files to branded output formats (PDF, Word) using Cognizone brand styles — colors, fonts, and layout.

Published to GitHub Packages as an internal npm package. CLI command: `cognizone-convert`.

## Repo Structure

```
bin/
  cognizone-convert.js    # CLI entry point — thin wrapper that calls export-to-pdf.sh
templates/
  styles.css              # Cognizone brand CSS for PDF output
  pdf-print.js            # Puppeteer script — renders HTML to PDF with headers/footers
  logo.png                # Cognizone logo (used in PDF header)
  fonts/                  # Roboto + Roboto Mono variable fonts (TTF)
export-to-pdf.sh          # Main PDF conversion script (bash + pandoc + puppeteer)
package.json              # npm package config
.npmrc                    # Points @cognizone scope to GitHub Packages
```

## PDF Pipeline

`export-to-pdf.sh` orchestrates the full conversion:

1. **Parse frontmatter** — extracts `title`, `id`, `type`, `status`, `date` from YAML frontmatter
2. **Strip frontmatter + H1** — body starts from the first H2
3. **Generate TOC** — `pandoc --toc --number-sections --standalone | awk '/<nav /,/<\/nav>/'`
4. **Convert body** — `pandoc --number-sections` (section numbers match TOC)
5. **Assemble HTML** — cover page + TOC page + document body
6. **Render PDF** — `node templates/pdf-print.js` via Puppeteer

`templates/pdf-print.js`:

- Base64-encodes logo and Roboto font (external URLs/`@import` crash Puppeteer PDF printing)
- Injects branded `headerTemplate` and `footerTemplate` (rendered in page margins on every page)
- Uses `page.evaluate()` to calculate and inject page numbers into TOC before printing
- `page.pdf()` with `margin: { top: 25mm, bottom: 20mm, left: 20mm, right: 20mm }`

## Brand Styles

Defined in `templates/styles.css`:

| Token | Value |
|---|---|
| `--green` | `#058775` |
| `--dark` | `#353744` |
| `--gray` | `#666666` |
| `--light-green-bg` | `#E8F5F3` |

- H1: 14pt bold dark (cover page only — stripped from body)
- H2: 13pt bold dark, thin bottom border
- H3: 12pt bold green
- Code: Roboto Mono, green on light gray background
- Tables: green header row, alternating light-green/white rows

## Document Frontmatter

Input Markdown files should have YAML frontmatter:

```yaml
---
title: "Document Title"
id: ADR-001          # shown as green eyebrow above title on cover page
type: adr            # adr | spec | report | ...
status: draft
date: 2025-01-01
---
```

Cover page: ID (green, above title) → title (large, dark) → metadata table.
Running header: `{ID} - {title}` (e.g. `ADR-001 - Architecture Pattern: ...`).

## Markdown Authoring Rule

**Always put a blank line between a label/paragraph and the list that follows it.** Pandoc requires this — without it, list items render as paragraph text in PDF output.

```markdown
<!-- WRONG -->
Key forces:
- Item one

<!-- CORRECT -->
Key forces:

- Item one
```

This applies to any label ending in `:` followed by a list.

## Adding Word Support

Word export is planned as the second output format. Key notes:

- Word cannot render HTML — needs a different approach than the PDF pipeline
- The output should match Cognizone brand styles (same colors, fonts, layout)
- Likely approach: a template `.docx` with pre-configured styles, populated via a library
  (e.g. `docxtemplater`, `officegen`, or `mammoth`)
- CLI will extend `cognizone-convert` with a `--format` flag or a separate subcommand

## Publishing

Package is published to GitHub Packages under the `@cognizone` scope.

To publish:

```bash
npm publish
```

To install in another project:

```bash
# ~/.npmrc must contain:
# @cognizone:registry=https://npm.pkg.github.com
# //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN

npm install @cognizone/brand-docs
```
