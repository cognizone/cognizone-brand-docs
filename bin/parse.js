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

// Rewrite links in place. opts.docExt (e.g. ".docx"): a relative link to a
// .md file points at the converted sibling instead ("../a/b.md#x" -> "../a/b.docx"),
// assuming the delivery keeps the repo's folder layout.
// ponytail: the #section is dropped (other docs' bookmarks are numbered, not slugs),
// so the link opens the other document at its start; slug bookmarks if that matters.
// opts.stripExternal: every other link that is not an in-document "#anchor" is
// replaced by its child tokens, so the text (and its formatting) stays.
// opts.linkBase: web address of opts.linkRoot (the folder the command runs from).
// The target's path from linkRoot is appended, so the link is absolute: Word for
// the web turns a relative "../a.docx" into "https://../a.docx".
function absoluteLink(href, opts) {
  let p = href;
  try { p = decodeURI(href); } catch { /* keep as written */ }
  const rel = path.relative(opts.linkRoot, path.resolve(opts.inputDir, p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // a relative link can't work on SharePoint: plain text when dead links are stripped
    console.warn(`--link-base: ${href} is outside ${opts.linkRoot}; ${opts.stripExternal ? 'plain text' : 'left relative'}.`);
    return opts.stripExternal ? null : href;
  }
  const url = new URL(rel.split(path.sep).map(encodeURIComponent).join('/'), opts.linkBase);
  // SharePoint downloads a plain file URL; ?web=1 opens it in Word (or the viewer) in the browser
  if (/\.sharepoint\.com$/i.test(url.hostname)) url.searchParams.set('web', '1');
  return url.href;
}

function rewriteLinks(tokens, opts) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'link') {
      const m = opts.docExt && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(t.href) && t.href.match(/^([^#?]*)\.md(?:[?#].*)?$/i);
      const href = m && (opts.linkBase ? absoluteLink(m[1] + opts.docExt, opts) : m[1] + opts.docExt);
      if (href) {
        t.href = href;
        continue;
      }
      if (opts.stripExternal && !t.href.startsWith('#')) {
        tokens.splice(i, 1, ...(t.tokens || []));
        continue;
      }
    }
    if (t.tokens) rewriteLinks(t.tokens, opts);
    for (const item of t.items || []) if (item.tokens) rewriteLinks(item.tokens, opts);
    for (const cell of t.header || []) if (cell.tokens) rewriteLinks(cell.tokens, opts);
    for (const row of t.rows || []) for (const cell of row) if (cell.tokens) rewriteLinks(cell.tokens, opts);
  }
}

function parseMarkdown(inputFile, opts = {}) {
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
  // 2026 brand cover/footer fields (ignored by the classic brand)
  const subtitle       = String(fm.subtitle       || '');
  const summary        = String(fm.summary        || '');
  const classification = String(fm.classification || '');
  const brand          = String(fm.brand          || '');
  const headerTitle = id ? `${id} - ${title}` : title;
  const footerTitle = [client, project].filter(Boolean).join(' \u00B7 ');

  // Strip H1
  const mdNoH1 = mdBody.replace(/^#\s[^\n]*\n?/m, '');

  // Lex into token tree
  const tokens = marked.lexer(mdNoH1);
  if (opts.stripExternal || opts.docExt) rewriteLinks(tokens, { ...opts, inputDir: path.dirname(path.resolve(inputFile)) });

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
    subtitle, summary, classification, brand,
    inputDir: path.dirname(inputFile), tokens, tocEntries, mdNoH1,
  };
}

module.exports = { parseMarkdown, slugify };
