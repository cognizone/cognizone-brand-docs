# @cognizone/brand-docs

Cognizone branded document conversion. Converts Markdown files to PDF or Word (.docx) using Cognizone brand styles (colors, fonts, layout).

Works on macOS, Linux, and Windows — no bash or pandoc required.

## Features

- **PDF and Word output** from a single Markdown source
- **Branded cover page** with document ID, title, and metadata table
- **Auto-generated table of contents** with section numbers and page references
- **Branded headers and footers** with logo, document title, client/project info, and page numbers
- **Full Markdown support** — headings, tables, lists (nested/mixed), code blocks, blockquotes, images, links, inline formatting
- **HTML `<img>` tags** with width/height for precise image sizing
- **YAML frontmatter** for document metadata (title, id, type, status, date, author, client, project)
- **Cognizone brand styles** — colors, Roboto/Roboto Mono fonts, A4 layout
- **Cross-platform** — pure Node.js, no bash or pandoc dependency

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18

## Installation

```bash
npm install -g @cognizone/brand-docs
```

> **Requires GitHub Packages authentication.**
>
> 1. Go to https://github.com/settings/tokens → click **Generate new token** → select **Generate new token (classic)**
>    - Note: `cognizone-packages-read` (or similar)
>    - Expiration: 1 year (or lower if preferred)
>    - Scope: check `read:packages`
>    - Click **Generate token** and copy the token
>
> 2. Add to your user-level `.npmrc` (a hidden file in your home folder):
>    - macOS/Linux: `~/.npmrc`
>    - Windows: `%USERPROFILE%\.npmrc` (e.g. `C:\Users\YourName\.npmrc`)
>
>
>    To show hidden files:
>    - macOS (Finder): **Cmd + Shift + .** (dot)
>    - Windows (File Explorer): **View → Show → Hidden items**
>    - Linux (file manager): **Ctrl + H**
>
>    Create or edit the file and add these two lines (replace `YOUR_GITHUB_TOKEN` with the token you copied):
>    ```
>    @cognizone:registry=https://npm.pkg.github.com
>    //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
>    ```

## Usage

```bash
cognizone-convert document.md                        # converts to PDF (default)
cognizone-convert document.md --format docx          # converts to Word
cognizone-convert document.md -f docx                # short form
cognizone-convert document.md output/custom-name.pdf # custom output path
```

> **Note (Word output):** Word documents reference fonts by name. For correct rendering, install [Roboto](https://fonts.google.com/specimen/Roboto) and [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono) on the machine opening the `.docx` file.

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

All fields are optional. Supported frontmatter fields: `title`, `id`, `type`, `status`, `date`, `author`, `client`, `project`.

## Output preview

Sample outputs generated from the [test fixture](test/fixture.md): [PDF](test/output/fixture.pdf) | [Word](test/output/fixture.docx)

PDF output with Cognizone brand styling:

### Cover page with header

![Cover page](docs/screenshots/cover-page.png)

### Footer

![Footer](docs/screenshots/footer.png)

### Table of contents

![Table of contents](docs/screenshots/table-of-contents.png)

### Body content

![Body content](docs/screenshots/body-content.png)
