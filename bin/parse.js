'use strict';
// Shared Markdown parsing: frontmatter, lexing, section numbering, TOC entries.
// Used by both PDF and DOCX renderers.

const { marked } = require('marked');
const matter = require('gray-matter');
const fs = require('fs');
const path = require('path');

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

// Read a top-level scalar from the raw YAML block, preserving exact formatting
// (YAML parses `1.0` as the number 1, losing the trailing zero — the raw text retains it).
function rawFrontmatterValue(rawMatter, key) {
  const re = new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm');
  const m = String(rawMatter || '').match(re);
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function parseMarkdown(inputFile) {
  const parsedMatter = matter(fs.readFileSync(inputFile, 'utf8'));
  const { data: fm, content: mdBody } = parsedMatter;
  const rawMatter = parsedMatter.matter;

  const title       = String(fm.title  || path.basename(inputFile, '.md'));
  const id          = String(fm.id     || '');
  const type        = String(fm.type   || '');
  const status      = String(fm.status || '');
  const version     = rawFrontmatterValue(rawMatter, 'version') ?? String(fm.version || '');
  const date        = fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : fm.date ? String(fm.date) : '';
  const author      = String(fm.author  || '');
  const client      = String(fm.client  || '');
  const project     = String(fm.project || '');
  const headerTitle = id ? `${id} - ${title}` : title;
  const footerTitle = [client, project].filter(Boolean).join(' \u00B7 ');

  // Strip H1
  const mdNoH1 = mdBody.replace(/^#\s[^\n]*\n?/m, '');

  // Lex into token tree
  const tokens = marked.lexer(mdNoH1);

  // Walk tokens to compute section numbers + TOC entries
  const sectionCounters = [0, 0, 0, 0, 0, 0];
  const tocEntries = [];
  // De-duplicate heading slugs across the document. Sibling sections often
  // share a heading like "Required fields"; without disambiguation every TOC
  // link to that text resolves to the first match (since both target IDs and
  // getElementById hit the first occurrence), and TOC page numbers for later
  // duplicates point to the first one's page.
  const slugCount = new Map();

  function walkHeadings(tokenList) {
    for (const token of tokenList) {
      if (token.type === 'heading') {
        const idx = token.depth - 1;
        sectionCounters[idx]++;
        for (let i = idx + 1; i < sectionCounters.length; i++) sectionCounters[i] = 0;

        const number = sectionCounters.slice(1, idx + 1).join('.');
        const plain = token.text.replace(/[*_`[\]()]/g, '').trim();
        const baseSlug = slugify(plain);
        const seen = slugCount.get(baseSlug) || 0;
        slugCount.set(baseSlug, seen + 1);
        const hId = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;

        // Attach to token for renderer use
        token._number = number;
        token._id = hId;

        tocEntries.push({ level: token.depth, text: plain, id: hId, number });
      }
      // Walk nested tokens (e.g. inside blockquotes)
      if (token.tokens) walkHeadings(token.tokens);
      if (token.items) {
        for (const item of token.items) {
          if (item.tokens) walkHeadings(item.tokens);
        }
      }
    }
  }

  walkHeadings(tokens);

  return {
    fm, title, id, type, status, version, date, author, client, project, headerTitle, footerTitle,
    inputDir: path.dirname(inputFile), tokens, tocEntries, mdNoH1,
  };
}

module.exports = { parseMarkdown, slugify };
