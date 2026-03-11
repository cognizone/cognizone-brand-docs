# @cognizone/brand-docs

Cognizone branded document conversion. Converts Markdown files to PDF using Cognizone brand styles (colors, fonts, layout).

Works on macOS, Linux, and Windows — no bash or pandoc required.

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18

## Installation

```bash
npm install -g @cognizone/brand-docs
```

> Requires GitHub Packages authentication. Add to your `~/.npmrc`:
> ```
> @cognizone:registry=https://npm.pkg.github.com
> //npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
> ```

## Usage

```bash
cognizone-convert path/to/document.md
cognizone-convert path/to/document.md output/custom-name.pdf
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
---
```

Supported frontmatter fields: `title`, `id`, `type`, `status`, `date`.
