#!/usr/bin/env bash
# Export a Markdown file to PDF using Cognizone brand styles.
#
# Usage:
#   ./export-to-pdf.sh path/to/file.md
#   ./export-to-pdf.sh path/to/file.md output/custom-name.pdf
#
# Requirements: pandoc  (brew install pandoc)
#               node    (brew install node)
#               npm install  (run once in repo root)

set -euo pipefail

INPUT="${1:-}"
if [[ -z "$INPUT" ]]; then
  echo "Usage: $0 <input.md> [output.pdf]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSS="$SCRIPT_DIR/templates/styles.css"
LOGO="$SCRIPT_DIR/templates/logo.png"
DEFAULT_OUTPUT="${INPUT%.md}.pdf"
OUTPUT="${2:-$DEFAULT_OUTPUT}"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"

# ── Parse frontmatter ────────────────────────────────────────────────────────

get_field() {
  local field="$1"
  awk -v f="$field" '
    /^---$/ { if (NR==1) { fm=1; next } else { exit } }
    fm && $0 ~ "^"f":" {
      sub("^"f":[[:space:]]*", "")
      gsub(/"/, "")
      print
      exit
    }
  ' "$INPUT"
}

TITLE=$(get_field "title")
ID=$(get_field "id")
TYPE=$(get_field "type")
STATUS=$(get_field "status")
DATE=$(get_field "date")
TITLE="${TITLE:-$(basename "$INPUT" .md)}"
HEADER_TITLE="${ID:+$ID - }$TITLE"

# ── Strip frontmatter from body ───────────────────────────────────────────────

TMPMD=$(mktemp /tmp/export-md-XXXXXX.md)
TMPBODY=$(mktemp /tmp/export-body-XXXXXX.html)
TMPTOC=$(mktemp /tmp/export-toc-XXXXXX.html)
TMPFULL=$(mktemp /tmp/export-full-XXXXXX.html)
trap 'rm -f "$TMPMD" "$TMPBODY" "$TMPTOC" "$TMPFULL"' EXIT

awk '/^---$/{if(NR==1){found=1;next}if(found){found=0;next}}!found' "$INPUT" \
  | awk '!done && /^# /{done=1; next} {print}' \
  > "$TMPMD"

# ── Generate TOC and body HTML fragments ──────────────────────────────────────

pandoc "$TMPMD" --from markdown --to html5 --toc --number-sections --standalone \
  | awk '/<nav /,/<\/nav>/' > "$TMPTOC"

pandoc "$TMPMD" \
  --from markdown \
  --to html5 \
  --number-sections \
  -o "$TMPBODY"

# ── Build metadata table rows ─────────────────────────────────────────────────

meta_row() {
  local label="$1" value="$2"
  [[ -z "$value" ]] && return
  echo "<tr><td class=\"meta-label\">$label</td><td>$value</td></tr>"
}

META_ROWS=$(
  meta_row "ID"             "$ID"
  meta_row "Document title" "$TITLE"
  meta_row "Type"            "$TYPE"
  meta_row "Date"            "$DATE"
  meta_row "Status"          "$STATUS"
  meta_row "Author"          "Cognizone"
  meta_row "Client"          "ERA — European Union Agency for Railways"
  meta_row "Project"         "REG+"
)

# ── Assemble full HTML ────────────────────────────────────────────────────────

cat > "$TMPFULL" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="$CSS">
</head>
<body>

  <!-- Cover page -->
  <div class="cover-page">
    <div class="cover-contact">
      <a href="mailto:info@cogni.zone">info@cogni.zone</a>
      <a href="https://cogni.zone">cogni.zone</a>
    </div>
    ${ID:+<p class="cover-id">$ID</p>}
    <h1 class="cover-title">$TITLE</h1>
    <table class="cover-meta-table">
      $META_ROWS
    </table>
  </div>

  <!-- Page break before TOC -->
  <div class="page-break"></div>

  <!-- Table of contents -->
  <div class="document-body toc-page">
    <h2 class="toc-heading">Contents</h2>
$(cat "$TMPTOC")
  </div>

  <!-- Page break before document body -->
  <div class="page-break"></div>

  <!-- Document body -->
  <div class="document-body">
$(cat "$TMPBODY")
  </div>

</body>
</html>
HTML

# ── Render PDF via Puppeteer ──────────────────────────────────────────────────

node "$SCRIPT_DIR/templates/pdf-print.js" \
  "$TMPFULL" "$OUTPUT" "$HEADER_TITLE" "$DATE" "$LOGO"

echo "Written: $OUTPUT"
