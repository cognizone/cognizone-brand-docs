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
// Names: the HTML 4 set (generated from Python's html.entities; lang/rang take the HTML5
// values a browser shows), as "name:hex code point", plus apos, colon, tab and newline.
const ENTITIES = Object.fromEntries(`
  AElig:c6 Aacute:c1 Acirc:c2 Agrave:c0 Alpha:391 Aring:c5 Atilde:c3 Auml:c4 Beta:392 Ccedil:c7
  Chi:3a7 Dagger:2021 Delta:394 ETH:d0 Eacute:c9 Ecirc:ca Egrave:c8 Epsilon:395 Eta:397 Euml:cb
  Gamma:393 Iacute:cd Icirc:ce Igrave:cc Iota:399 Iuml:cf Kappa:39a Lambda:39b Mu:39c Ntilde:d1 Nu:39d
  OElig:152 Oacute:d3 Ocirc:d4 Ograve:d2 Omega:3a9 Omicron:39f Oslash:d8 Otilde:d5 Ouml:d6 Phi:3a6
  Pi:3a0 Prime:2033 Psi:3a8 Rho:3a1 Scaron:160 Sigma:3a3 THORN:de Tau:3a4 Theta:398 Uacute:da Ucirc:db
  Ugrave:d9 Upsilon:3a5 Uuml:dc Xi:39e Yacute:dd Yuml:178 Zeta:396 aacute:e1 acirc:e2 acute:b4
  aelig:e6 agrave:e0 alefsym:2135 alpha:3b1 amp:26 and:2227 ang:2220 aring:e5 asymp:2248 atilde:e3
  auml:e4 bdquo:201e beta:3b2 brvbar:a6 bull:2022 cap:2229 ccedil:e7 cedil:b8 cent:a2 chi:3c7 circ:2c6
  clubs:2663 cong:2245 copy:a9 crarr:21b5 cup:222a curren:a4 dArr:21d3 dagger:2020 darr:2193 deg:b0
  delta:3b4 diams:2666 divide:f7 eacute:e9 ecirc:ea egrave:e8 empty:2205 emsp:2003 ensp:2002
  epsilon:3b5 equiv:2261 eta:3b7 eth:f0 euml:eb euro:20ac exist:2203 fnof:192 forall:2200 frac12:bd
  frac14:bc frac34:be frasl:2044 gamma:3b3 ge:2265 gt:3e hArr:21d4 harr:2194 hearts:2665 hellip:2026
  iacute:ed icirc:ee iexcl:a1 igrave:ec image:2111 infin:221e int:222b iota:3b9 iquest:bf isin:2208
  iuml:ef kappa:3ba lArr:21d0 lambda:3bb lang:27e8 laquo:ab larr:2190 lceil:2308 ldquo:201c le:2264
  lfloor:230a lowast:2217 loz:25ca lrm:200e lsaquo:2039 lsquo:2018 lt:3c macr:af mdash:2014 micro:b5
  middot:b7 minus:2212 mu:3bc nabla:2207 nbsp:a0 ndash:2013 ne:2260 ni:220b not:ac notin:2209
  nsub:2284 ntilde:f1 nu:3bd oacute:f3 ocirc:f4 oelig:153 ograve:f2 oline:203e omega:3c9 omicron:3bf
  oplus:2295 or:2228 ordf:aa ordm:ba oslash:f8 otilde:f5 otimes:2297 ouml:f6 para:b6 part:2202
  permil:2030 perp:22a5 phi:3c6 pi:3c0 piv:3d6 plusmn:b1 pound:a3 prime:2032 prod:220f prop:221d
  psi:3c8 quot:22 rArr:21d2 radic:221a rang:27e9 raquo:bb rarr:2192 rceil:2309 rdquo:201d real:211c
  reg:ae rfloor:230b rho:3c1 rlm:200f rsaquo:203a rsquo:2019 sbquo:201a scaron:161 sdot:22c5 sect:a7
  shy:ad sigma:3c3 sigmaf:3c2 sim:223c spades:2660 sub:2282 sube:2286 sum:2211 sup:2283 sup1:b9
  sup2:b2 sup3:b3 supe:2287 szlig:df tau:3c4 there4:2234 theta:3b8 thetasym:3d1 thinsp:2009 thorn:fe
  tilde:2dc times:d7 trade:2122 uArr:21d1 uacute:fa uarr:2191 ucirc:fb ugrave:f9 uml:a8 upsih:3d2
  upsilon:3c5 uuml:fc weierp:2118 xi:3be yacute:fd yen:a5 yuml:ff zeta:3b6 zwj:200d zwnj:200c
  apos:27 colon:3a tab:9 newline:a`.trim().split(/\s+/).map(e => {
  const [name, hex] = e.split(':');
  return [name, String.fromCodePoint(parseInt(hex, 16))];
}));
// Exact name first (Eacute and eacute differ), then lower case as before (&AMP;, &Nbsp;)
const entity = name => Object.hasOwn(ENTITIES, name) ? ENTITIES[name]
  : Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : undefined;
function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (m, dec, hex, name) => {
    if (name) return entity(name) ?? m;
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
    t.text = t.raw = t.text.replace(new RegExp(`${tagRe('a').source}|<\\/a\\s*>`, 'gi'), tag => {
      if (tag[1] === '/') return dropped.pop() ? '' : tag;
      // a real href attribute, not "data-href" or "href=" inside another attribute's value
      const href = attrValue(tag, 'href');
      const drop = href !== undefined && !href.startsWith('#');
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
// opts.anchorPrefix (folder merges): "#x" becomes "#{prefix}x" (raw <a href="#x"> too),
// matching the renderers' prefixed heading ids. javascript:/vbscript:/data: links always become text.
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

// Folder merges: a raw <a href="#x"> (quoted or not) gets the prefix too; a bare "#" stays
const prefixRawAnchors = (html, prefix) => html.replace(tagRe('a'),
  tag => replaceAttr(tag, 'href', v => (/^#./.test(v) ? `#${prefix}${v.slice(1)}` : undefined)));

function rewriteLinks(tokens, opts) {
  if (opts.stripExternal) stripRawLinks(tokens);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'html' && opts.anchorPrefix) t.text = t.raw = prefixRawAnchors(t.text, opts.anchorPrefix);
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

// ── Image bytes (shared by the DOCX and HTML renderers) ──────────────────────
// Type and pixel size from the file's own bytes (never its extension), or null when it
// is not a PNG, JPEG, GIF or BMP
function imageInfo(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504E47 && buf.readUInt32BE(4) === 0x0D0A1A0A) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 2) === 'BM'
      && [40, 52, 56, 108, 124].includes(buf.readUInt32LE(14)) && buf.readUInt16LE(26) === 1) {
    return { type: 'bmp', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    // Walk the marker segments to the start-of-frame (C0-CF, except DHT C4, JPG C8, DAC CC)
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xFF) return null;
      const m = buf[i + 1];
      if (m === 0xFF) { i++; continue; } // fill byte
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { type: 'jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += m === 0x01 || (m >= 0xD0 && m <= 0xD8) ? 2 : 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// An SVG document: <svg> is the root element, after only an XML declaration, comments,
// a doctype and whitespace (a text file that merely contains "<svg" somewhere is not one)
const isSvg = buf => /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[^\]]*\])?[^>]*>)*<svg[\s>]/i
  .test(buf.toString('utf8').replace(/^﻿/, ''));

// Raw HTML tags and their attributes. A quoted value is taken whole, so "src=" or ">"
// inside another attribute's value (alt="a src=b") is never mistaken for markup.
const tagRe = name => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
const ATTR = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
// Value of attribute `name` ('' when it has none), or undefined when the tag lacks it
function attrValue(tag, name) {
  for (const m of tag.matchAll(ATTR)) if (m[2].toLowerCase() === name) return m[4] ?? m[5] ?? m[6] ?? '';
}
// Replace the value of attribute `name` with fn(value), double-quoted; fn returning
// undefined leaves the attribute as written
const replaceAttr = (tag, name, fn) => tag.replace(ATTR, (m, sp, n, eq, dq, sq, bare) => {
  const v = n.toLowerCase() === name ? dq ?? sq ?? bare : undefined;
  const nv = v === undefined ? undefined : fn(v);
  return nv === undefined ? m : `${sp}${n}="${nv.replace(/"/g, '&quot;')}"`;
});

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
  // cover/footer fields; `brand` only to warn about the removed classic brand
  const subtitle       = String(fm.subtitle       || '');
  const summary        = String(fm.summary        || '');
  const classification = String(fm.classification || '');
  const brand          = String(fm.brand          || '');
  const headerTitle = id ? `${id} - ${title}` : title;

  // Lex into token tree; strip the title H1 (cover page only), but only when it is
  // the first block (after any raw HTML): a "# comment" in a code fence or a later H1 stays.
  const tokens = marked.lexer(mdBody);
  const first = tokens.findIndex(t => t.type !== 'space' && t.type !== 'html');  // a leading comment or logo block may precede the title
  if (first !== -1 && tokens[first].type === 'heading' && tokens[first].depth === 1) {
    tokens.splice(first, 1);
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
    fm, title, id, type, status, version, date, author, client, project, headerTitle,
    subtitle, summary, classification, brand,
    inputDir: path.dirname(inputFile), tokens, tocEntries,
  };
}

module.exports = { parseMarkdown, slugify, decodeEntities, imageInfo, isSvg, tagRe, attrValue, replaceAttr };
