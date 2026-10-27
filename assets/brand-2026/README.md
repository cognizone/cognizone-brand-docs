# Cognizone — Logo Export Pack

**Version 1.0 · April 2026**
Logo 02 · "C-shaped knowledge graph"

---

## What's inside

```
exports/
├── svg/                      ← vector masters (use these whenever possible)
│   ├── icon/                 ← graph-mark only (100×100 viewBox)
│   ├── horizontal/           ← graph-mark + "Cognizone" wordmark, side by side
│   ├── stacked/              ← graph-mark above "Cognizone" wordmark
│   └── wordmark/             ← "Cognizone" text only
│
├── png/                      ← raster, transparent background
│   ├── icon/ {16,32,48,64,128,256,512,1024}
│   ├── horizontal/ {1x,2x,3x}   (1x = 560×140)
│   ├── stacked/    {1x,2x,3x}   (1x = 400×340)
│   └── wordmark/   {1x,2x,3x}   (1x = 480×100)
│
├── pdf/                      ← print-ready HTML pages (open → Cmd/Ctrl+P → Save as PDF)
│   ├── icon/
│   ├── horizontal/
│   └── stacked/
│
└── favicon/                  ← web-ready favicon bundle
    ├── favicon.svg
    ├── favicon-16x16.png
    ├── favicon-32x32.png
    ├── favicon-48x48.png
    ├── apple-touch-icon.png        (180×180)
    ├── android-chrome-192.png
    └── android-chrome-512.png
```

---

## Variants matrix

| Variant          | When to use                                        | Files                     |
|------------------|----------------------------------------------------|---------------------------|
| **color-light**  | Full-color logo on **light / cream backgrounds**   | `…color-light.*`          |
| **color-dark**   | Full-color logo on **dark / plum backgrounds**     | `…color-dark.*`           |
| **mono-black**   | Single-color **black (plum)** for stamps, fax, etc | `…mono-black.*`           |
| **mono-white**   | Single-color **white (cream)** on dark photography | `…mono-white.*`           |

Wordmark variants: `plum`, `cream`, `black`, `white`.

---

## Brand colors

Use **plum** as primary ink; **cream** as ground; **pink** as the primary accent.
The six colored nodes of the logo form a supporting palette.

| Name          | Hex       | Role                       |
|---------------|-----------|----------------------------|
| Plum          | `#2F2450` | Primary ink                |
| Cream         | `#FBF6F1` | Primary ground             |
| Pink          | `#E17B9E` | Accent (node · lower-left) |
| Pink deep     | `#C85A8A` | Accent (node · upper-left) |
| Teal          | `#49C6D4` | Accent (node · top-right)  |
| Cyan          | `#5BB8E2` | Accent (node · top)        |
| Blue          | `#3D6BB8` | Center node                |
| Blue deep     | `#3450A0` | Accent (node · bottom-right) |
| Purple        | `#9B5DB8` | Accent (node · bottom)     |

---

## Usage rules

1. **Clear space** — keep at least one node-diameter of breathing room on all sides.
2. **Minimum size** — icon no smaller than **16 px** (screen) or **8 mm** (print); horizontal lockup no smaller than **90 px** / **30 mm** tall.
3. **Don't recolor** the nodes individually. Use the monochrome variants for single-color applications.
4. **Don't rotate, skew, or distort.** The hexagonal grid must stay square.
5. **Don't add effects** (drop shadows, gradients, strokes) to the marks.

---

## Which file should I use?

- **Website, app, any screen** → SVG (icon) or PNG @ 2x/3x (lockups).
- **Social media avatar** → `icon/cognizone-icon-color-light-512.png` or `1024`.
- **Favicon** → everything in `favicon/` — drop it at your site root.
- **Print / merchandise** → SVG first; if the vendor needs bitmap, PNG @ 1024.
- **Office docs (PPT/Word)** → PNG @ 2x is safe everywhere; SVG works in modern Office.
- **Print shop / business card** → open the matching `pdf/**.html` → Print → Save as PDF.

---

## Need AI / EPS / CMYK source?

The SVGs are vector and will import cleanly into Illustrator, Figma, Affinity Designer, Sketch, Inkscape, and Canva. From there you can:
- Save As `.ai` or `.eps`
- Convert colors to **CMYK** (Illustrator → Edit → Colors → Convert to CMYK)
- Export to PDF/X for press

---

## File naming convention

`cognizone-{layout}-{variant}[-{size|multiplier}].{ext}`

- **layout**: `icon`, `horizontal`, `stacked`, `wordmark`
- **variant**: `color-light`, `color-dark`, `mono-black`, `mono-white` (for wordmark: `plum`, `cream`, `black`, `white`)
- **size**: `16`, `32`, …, `1024` (icons only)
- **multiplier**: `1x`, `2x`, `3x` (lockups, wordmark)

---

© 2026 Cognizone SRL · Brussels · cogni.zone
