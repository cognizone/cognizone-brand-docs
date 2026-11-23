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

// An error the CLI prints as one line (no stack trace)
const userError = msg => Object.assign(new Error(msg), { userError: true });

// gray-matter evaluates `---javascript` / `---js` frontmatter with eval: refuse it
const NO_JS = { parse() { throw userError('only YAML frontmatter is supported'); } };

// Decode the HTML entities a browser would show as characters, in one pass so
// "&amp;lt;" becomes "&lt;", not "<". Unknown names and code points that are not valid
// XML characters (controls, surrogates) are left as written.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', copy: '\u00A9', colon: ':', tab: '\t', newline: '\n' };
function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    if (name) return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : m;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    const ok = cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
    return ok ? String.fromCodePoint(cp) : m;
  });
}

// Plain text of a heading from its inline tokens: link text without the URL,
// code spans' text, raw inline HTML tags dropped. marked escapes `&<>"'` in text tokens.
function inlineText(tokens) {
  return tokens.map(t => t.tokens ? inlineText(t.tokens) : t.type === 'html' ? '' : decodeEntities(t.text || '')).join('');
}

// Read a top-level scalar from the raw YAML block, preserving exact formatting
// (YAML parses `1.0` as the number 1, losing the trailing zero — the raw text retains it).
// Only a plain one-line scalar (optionally followed by a comment) is trusted; anything
// else (quoted, block scalar, empty) is left to the YAML parser (null).
function rawFrontmatterValue(rawMatter, key) {
  const m = String(rawMatter || '').match(new RegExp(`^${key}:[ \\t]*([\\w.+-]+)(?:[ \\t]+#.*|[ \\t]*)$`, 'm'));
  return m ? m[1] : null;
}

// Hrefs a browser would run or load as content; checked after the entity decoding
// and whitespace/control-character removal a browser does
// (a numeric entity decodeEntities left alone is a control character to a browser: dropped too)
const isUnsafeHref = href => /^(javascript|vbscript|data):/i.test(decodeEntities(href).replace(/&#x?[0-9a-f]+;|[\u0000-\u0020]/gi, ''));

// --no-external-links for raw HTML: drop <a href> tags (keeping their content) unless the
// href is an "#anchor". Opening and closing tags can sit in separate sibling inline tokens.
function stripRawLinks(tokens) {
  const dropped = [];  // one entry per open <a>: true when its tags are removed
  for (const t of tokens) {
    if (t.type !== 'html') continue;
    t.text = t.raw = t.text.replace(/<a\b[^>]*>|<\/a\s*>/gi, tag => {
      if (tag[1] === '/') return dropped.pop() ? '' : tag;
      const href = tag.match(/\bhref\s*=\s*["']?([^"'\s>]*)/i);
      const drop = !!href && !href[1].startsWith('#');
      dropped.push(drop);
      return drop ? '' : tag;
    });
  }
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
// opts.anchorPrefix (folder merges): "#x" becomes "#{prefix}x", matching the
// renderers' prefixed heading ids. javascript:/vbscript:/data: links always become text.
function absoluteLink(href, opts) {
  // decode per segment, so "a%23b.md" is the file "a#b.md" (re-encoded once below)
  const p = href.split('/').map(s => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
  const rel = path.relative(opts.linkRoot, path.resolve(opts.inputDir, p));
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
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
  if (opts.stripExternal) stripRawLinks(tokens);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'link') {
      const m = opts.docExt && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(t.href) && t.href.match(/^([^#?]*)\.md(?:[?#].*)?$/i);
      const href = m && (opts.linkBase ? absoluteLink(m[1] + opts.docExt, opts) : m[1] + opts.docExt);
      if (href) {
        t.href = href;
        continue;
      }
      if (isUnsafeHref(t.href) || (opts.stripExternal && !t.href.startsWith('#'))) {
        tokens.splice(i, 1, ...(t.tokens || []));
        continue;
      }
      if (opts.anchorPrefix && t.href.length > 1 && t.href.startsWith('#')) t.href = `#${opts.anchorPrefix}${t.href.slice(1)}`;
    }
    if (t.tokens) rewriteLinks(t.tokens, opts);
    for (const item of t.items || []) if (item.tokens) rewriteLinks(item.tokens, opts);
    for (const cell of t.header || []) if (cell.tokens) rewriteLinks(cell.tokens, opts);
    for (const row of t.rows || []) for (const cell of row) if (cell.tokens) rewriteLinks(cell.tokens, opts);
  }
}

function parseMarkdown(inputFile, opts = {}) {
  let parsedMatter;
  try {
    parsedMatter = matter(fs.readFileSync(inputFile, 'utf8'), { engines: { javascript: NO_JS, js: NO_JS } });
  } catch (e) {
    throw userError(`Frontmatter of ${inputFile}: ${e.message}`);
  }
  const { data: fm, content: mdBody } = parsedMatter;
  const rawMatter = parsedMatter.matter;

  const title       = String(fm.title  || path.parse(inputFile).name);
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

  // Lex into token tree; strip the title H1 (cover page only), but only when it is
  // the first block (after any raw HTML): a "# comment" in a code fence or a later H1 stays.
  const tokens = marked.lexer(mdBody);
  let mdNoH1 = mdBody;  // body text without the title H1 (the classic PDF renderer re-lexes it)
  const first = tokens.findIndex(t => t.type !== 'space' && t.type !== 'html');  // a leading comment or logo block may precede the title
  if (first !== -1 && tokens[first].type === 'heading' && tokens[first].depth === 1) {
    mdNoH1 = mdBody.replace(tokens.splice(first, 1)[0].raw, () => '');
  }
  rewriteLinks(tokens, { ...opts, inputDir: path.dirname(path.resolve(inputFile)) });

  // Walk tokens to compute section numbers + TOC entries
  const sectionCounters = [0, 0, 0, 0, 0, 0];
  const tocEntries = [];
  // De-duplicate heading slugs across the document. Sibling sections often
  // share a heading like "Required fields"; without disambiguation every TOC
  // link to that text resolves to the first match (since both target IDs and
  // getElementById hit the first occurrence), and TOC page numbers for later
  // duplicates point to the first one's page. Suffixes are checked against every
  // id issued so far, so "Foo", "Foo", "Foo-2" give foo, foo-2, foo-2-2.
  const usedIds = new Set();

  function walkHeadings(tokenList) {
    for (const token of tokenList) {
      if (token.type === 'heading') {
        const idx = token.depth - 1;
        sectionCounters[idx]++;
        for (let i = idx + 1; i < sectionCounters.length; i++) sectionCounters[i] = 0;

        const number = sectionCounters.slice(1, idx + 1).join('.');
        const plain = inlineText(token.tokens || []).trim();
        // "_" is removed before slugifying, as the old punctuation-stripping did, so
        // existing anchors (e.g. "snake_case" → #snakecase) keep working
        const baseSlug = slugify(plain.replace(/_/g, '')) || 'section';
        let hId = baseSlug;
        for (let n = 2; usedIds.has(hId); n++) hId = `${baseSlug}-${n}`;
        usedIds.add(hId);

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

module.exports = { parseMarkdown, slugify, decodeEntities };
