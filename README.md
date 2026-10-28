# @cognizone/brand-docs

Cognizone branded document conversion. Converts Markdown files to PDF, Word (.docx), or HTML using Cognizone brand styles (colors, fonts, layout).

Works on macOS, Linux, and Windows — no bash or pandoc required.

## Features

- **PDF, Word, and HTML output** from a single Markdown source
- **Self-contained HTML** — a single `.html` file with fonts, images, logo, and mermaid embedded; opens offline in any browser
- **Folder merge** — pass a folder to combine all Markdown files into a single PDF or HTML file with a master cover page and TOC
- **Branded cover page** with document ID, title, and metadata table
- **Auto-generated table of contents** with section numbers and page references
- **Branded headers and footers** with logo, document title, client/project info, and page numbers
- **Mermaid diagrams** — `\`\`\`mermaid` code blocks render as visual diagrams (flowcharts, sequence diagrams, etc.)
- **Full Markdown support** — headings, tables, lists (nested/mixed), code blocks, blockquotes, images, links, inline formatting
- **HTML `<img>` tags** with width/height for precise image sizing
- **YAML frontmatter** for document metadata (title, subtitle, summary, id, type, status, version, date, author, client, project, classification)
- **Cognizone 2026 brand** — plum / cream colours, Calistoga titles, Roboto / Roboto Mono text, A4 layout (the old brand is still available with `-b classic` for a short transition)
- **Cross-platform** — pure Node.js, no bash or pandoc dependency

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18 with npm (check with `node -v` and `npm -v`)
- Access to the `cognizone/cognizone-brand-docs` GitHub repository (the package installs from it)

Works the same on macOS, Windows and Linux.

## Installation

```bash
npm install -g cognizone/cognizone-brand-docs
cognizone-convert --version
```

To update to the latest version, run the same install command again.

PDF and Word output render through a headless Chrome. Recent npm versions skip install scripts by default (you may see `npm warn install-scripts ... puppeteer`), so Chrome is downloaded automatically the first time you convert a document (about 150 MB, once, into `~/.cache/puppeteer`; on Windows `%USERPROFILE%\.cache\puppeteer`). HTML output needs no browser.

### Fonts for Word output

Word documents reference fonts by name, so install [Calistoga](https://fonts.google.com/specimen/Calistoga), [Roboto](https://fonts.google.com/specimen/Roboto) and [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono) on the machine that opens the `.docx` (PDF and HTML embed their fonts):

- **macOS** — double-click each `.ttf` and click *Install* (Font Book)
- **Windows** — right-click each `.ttf` → *Install for all users*
- **Linux** — copy the `.ttf` files to `~/.local/share/fonts/` and run `fc-cache -f`

### Troubleshooting

| Problem | Fix |
|---|---|
| `command not found: cognizone-convert` | npm's global bin folder is not on your `PATH`. It is `$(npm prefix -g)/bin` on macOS/Linux and the `npm prefix -g` folder itself on Windows. Open a new terminal after changing `PATH`. |
| `EACCES` / permission error on install (macOS/Linux) | Don't use `sudo`; install Node with a version manager ([Volta](https://volta.sh), [nvm](https://github.com/nvm-sh/nvm)) so global installs go to your home folder. |
| 404 or authentication error on install | Check that your GitHub account has access to the Cognizone organisation. |
| `Could not find Chrome` | Run `npx puppeteer browsers install chrome`. On a minimal Linux install Chrome may also need system libraries; see the [Puppeteer troubleshooting guide](https://pptr.dev/troubleshooting). |
| Word contents page shows `–` or wrong page numbers | Choose **References → Update Table → Update page numbers only**. "Update entire table" replaces the 2026 styling with Word's default look. |

## Usage

```bash
cognizone-convert document.md                        # converts to PDF (default)
cognizone-convert document.md --format docx          # converts to Word
cognizone-convert document.md --format html          # converts to self-contained HTML
cognizone-convert document.md -f docx                # short form
cognizone-convert document.md output/custom-name.pdf # custom output path

# Folder merge (PDF or HTML)
cognizone-convert docs/                              # merges all .md files → docs.pdf
cognizone-convert docs/ -f html                      # merges all .md files → docs.html
cognizone-convert docs/ merged-output.pdf            # custom output path
```

All output uses the 2026 Cognizone brand; no flag is needed.

### Using it from Claude Code

Claude Code picks the tool up from the shell like any other command. To make it the default for client-facing documents, add a short section to your `~/.claude/CLAUDE.md`:

```markdown
## Cognizone branded documents
Render client-facing Markdown deliverables with `cognizone-convert` (`-f pdf|docx|html`),
never with plain pandoc. It uses the 2026 Cognizone brand by default.
```

## Document format

Input files should be Markdown with YAML frontmatter:

```yaml
---
title: "My Document Title"
id: ADR-001
type: adr
status: draft
date: 2025-01-01
author: Cognizone
client: "ERA — European Union Agency for Railways"
project: REG+
---
```

All fields are optional. Supported frontmatter fields: `title`, `id`, `type`, `status`, `version`, `date`, `author`, `client`, `project`, plus `subtitle`, `summary`, `classification` and `brand` (see [Brands](#brands)).

## Brands

The 2026 Cognizone brand (plum / cream, Calistoga titles) is the default. The old brand is kept for a short transition and will be removed:

```bash
cognizone-convert document.md -b classic             # old brand, any format
```

Or set `brand: classic` in a document's frontmatter (the `-b` / `--brand` flag wins over it). For a folder merge without `--brand`, the first document's `brand:` decides for the whole folder.

Extra optional frontmatter fields used by the 2026 cover and footer:

| Field | Use |
|---|---|
| `subtitle` | Second title line, in pink |
| `summary` | Paragraph under the title |
| `classification` | e.g. `Confidential`, shown on the cover and in the footer |

The style spec is [`reference/brand-2026-spec.md`](reference/brand-2026-spec.md); the logo pack is in [`assets/brand-2026/`](assets/brand-2026/).

## Sizing mermaid diagrams

Add options to the fence line to control per-diagram width and alignment. Applies to PDF, DOCX, and HTML output.

````markdown
```mermaid maxWidth=300 align=left
flowchart LR
  A --> B
```
````

| Option | Values | Default | Effect |
|---|---|---|---|
| `maxWidth` | integer pixels | `500` | Upper bound on rendered width; height scales proportionally |
| `align` | `left`, `center`, `right` | `center` | Paragraph alignment of the diagram |

Unknown or invalid values are ignored with a warning on stderr; the diagram still renders with defaults.

## Output preview

Sample outputs generated from the [test fixture](test/fixture.md): [PDF](test/output/brand-2026.pdf) | [Word](test/output/brand-2026.docx)

PDF output in the 2026 Cognizone brand:

### Cover page

![Cover page](docs/screenshots/cover-page.png)

### Footer

![Footer](docs/screenshots/footer.png)

### Table of contents

![Table of contents](docs/screenshots/table-of-contents.png)

### Mermaid diagrams

![Mermaid diagram](docs/screenshots/mermaid-diagram.png)

### Body content

![Body content](docs/screenshots/body-content.png)
