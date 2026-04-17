'use strict';

const DEFAULT_MAX_WIDTH = 500;
const DEFAULT_ALIGN = 'center';
const VALID_ALIGN = new Set(['left', 'center', 'right']);
const KNOWN_KEYS = new Set(['maxWidth', 'align']);

function parseMermaidOpts(info) {
  const parts = String(info || '').trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== 'mermaid') {
    return { isMermaid: false, maxWidth: DEFAULT_MAX_WIDTH, align: DEFAULT_ALIGN };
  }

  let maxWidth = DEFAULT_MAX_WIDTH;
  let align = DEFAULT_ALIGN;

  for (const token of parts.slice(1)) {
    const eq = token.indexOf('=');
    if (eq < 0) {
      console.warn(`[mermaid] unknown option "${token}" — ignored`);
      continue;
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);

    if (!KNOWN_KEYS.has(key)) {
      console.warn(`[mermaid] unknown option "${key}" — ignored`);
      continue;
    }

    if (key === 'maxWidth') {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
        console.warn(`[mermaid] invalid maxWidth "${value}" — using default ${DEFAULT_MAX_WIDTH}`);
        continue;
      }
      maxWidth = n;
    } else if (key === 'align') {
      if (!VALID_ALIGN.has(value)) {
        console.warn(`[mermaid] invalid align "${value}" — using default ${DEFAULT_ALIGN}`);
        continue;
      }
      align = value;
    }
  }

  return { isMermaid: true, maxWidth, align };
}

module.exports = { parseMermaidOpts };
