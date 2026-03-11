# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Repository Purpose

This is the **Cognizone branded document conversion** package (`@cognizone/brand-docs`). It converts Markdown files to branded output formats (PDF, Word) using Cognizone brand styles — colors, fonts, and layout.

Published to GitHub Packages as an internal npm package. CLI command: `cognizone-convert`.

## Repo Structure

```
bin/
  cognizone-convert.js    # CLI entry point — parses args, calls convert.js
  convert.js              # Full conversion pipeline (cross-platform, pure Node.js)
templates/
  styles.css              # Cognizone brand CSS for PDF output
  pdf-print.js            # Puppeteer script — renders HTML to PDF with headers/footers
  logo.png                # Cognizone logo (used in PDF header)
  fonts/                  # Roboto + Roboto Mono variable fonts (TTF)
package.json              # npm package config
.npmrc                    # Points @cognizone scope to GitHub Packages
```

## PDF Pipeline

`bin/convert.js` orchestrates the full conversion (pure Node.js, no bash or pandoc):

1. **Parse frontmatter** — `gray-matter` extracts `title`, `id`, `type`, `status`, `date`
2. **Strip H1** — body starts from the first H2
3. **Render body HTML + section numbers** — `marked` with a custom renderer; H2 = "1", H3 = "1.1", etc.
4. **Generate TOC** — collected during rendering via `walkTokens`, built as `<nav id="TOC">`
5. **Assemble HTML** — cover page + TOC page + document body
6. **Render PDF** — `node templates/pdf-print.js` via Puppeteer

`templates/pdf-print.js`:

- Base64-encodes logo and Roboto font (external URLs/`@import` crash Puppeteer PDF printing)
- Injects branded `headerTemplate` and `footerTemplate` (rendered in page margins on every page)
- Uses `page.evaluate()` to calculate and inject page numbers into TOC before printing
- `page.pdf()` with `margin: { top: 25mm, bottom: 20mm, left: 20mm, right: 20mm }`

## marked v13 renderer note

`marked.use()` renderer overrides are **post-processors**: the function receives the already-rendered inner HTML string from the default renderer (not the token). To correlate with token data, use `walkTokens` to collect heading metadata in order, then match by index in the renderer override.

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

## Adding Word Support

Word export is planned as the second output format. Key notes:

- Word cannot render HTML — needs a different approach than the PDF pipeline
- The output should match Cognizone brand styles (same colors, fonts, layout)
- Likely approach: a template `.docx` with pre-configured styles, populated via a library
  (e.g. `docxtemplater`, `officegen`, or `mammoth`)
- CLI will extend `cognizone-convert` with a `--format` / `-f` flag, defaulting to `pdf`:
  ```bash
  cognizone-convert document.md                # PDF (default)
  cognizone-convert document.md --format pdf   # explicit PDF
  cognizone-convert document.md --format docx  # Word
  cognizone-convert document.md -f docx        # short form
  ```

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

