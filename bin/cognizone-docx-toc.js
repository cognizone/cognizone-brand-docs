#!/usr/bin/env node
'use strict';
// Fill in the contents page numbers of rendered Word copies by having Word
// itself run References > Update Table > Update page numbers only (keeps the
// 2026 styling; "Update entire table" would not). macOS + Microsoft Word only.
// Opens Word once per file; batch them in one AppleScript call if it gets slow.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = `on run argv
  set p to item 1 of argv
  set AppleScript's text item delimiters to "/"
  set fname to last text item of p
  tell application "Microsoft Word"
    -- Word would reuse the open copy and save its stale content over the new render.
    if (name of documents) contains fname then error fname & " is open in Word: close it and run again."
    open (POSIX file p)
    -- Work only on the document at this path. If the open failed (cancelled dialog,
    -- protected file), there is none: never update, save or close another document,
    -- even one of the same name.
    try
      set d to document fname
      set opened to (posix full name of d is p)
    on error
      set opened to false
    end try
    if not opened then error "Word did not open " & fname & "; nothing was changed. Check Word for a dialog waiting for an answer."
    if (count of tables of contents of d) is 0 then
      close d saving no
      error fname & " has no contents page; nothing was changed."
    end if
    update page numbers (table of contents 1 of d)
    save d
    close d saving no
  end tell
end run
`;

// Did Word fill in the page numbers? Every PAGEREF field (the contents page entries)
// must show a number as its result, the text between its "separate" and "end" field
// characters; before Word runs that is the "–" placeholder. A contents page without
// entries has no PAGEREF: nothing to check. A file unzip cannot read is not verified.
function pageNumbersFilled(file) {
  const r = spawnSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 1024 ** 3 });
  if (r.status !== 0) return false;
  const xml = r.stdout;
  for (const m of xml.matchAll(/<w:instrText\b[^>]*>\s*PAGEREF\b/g)) {
    const field = xml.slice(m.index);
    const separate = field.indexOf('w:fldCharType="separate"');
    const end = field.indexOf('w:fldCharType="end"');
    if (separate === -1 || end < separate) return false;
    const result = [...field.slice(separate, end).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join('').trim();
    if (!/^\d+$/.test(result)) return false;
  }
  return true;
}

const USAGE = 'usage: cognizone-docx-toc file.docx [...]';
const args = process.argv.slice(2);

if (args[0] === '-h' || args[0] === '--help') {
  console.log(USAGE);
  process.exit(0);
}

if (args.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

// Word would open any other file (a .md, say) as text and save over it
const notDocx = args.find(f => path.extname(f).toLowerCase() !== '.docx');
if (notDocx !== undefined) {
  console.error(`not a .docx file: ${notDocx}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.error('cognizone-docx-toc needs macOS with Microsoft Word. Elsewhere, do it in Word: References > Update Table > "Update page numbers only".');
  process.exit(1);
}

// ponytail: only the two standard install folders; Word elsewhere gets the manual steps.
// Asking AppleScript for an app that is not there can open a "Where is Microsoft Word?" dialog.
if (!['/Applications', path.join(os.homedir(), 'Applications')].some(d => fs.existsSync(path.join(d, 'Microsoft Word.app')))) {
  console.error('Microsoft Word was not found in /Applications. Open the file in Word and choose References > Update Table > "Update page numbers only".');
  process.exit(1);
}

for (const f of args) {
  const abs = path.resolve(f);
  if (!fs.existsSync(abs)) {
    console.error(`not found: ${f}`);
    process.exit(1);
  }
  // Real path: Word reports the resolved one (/private/tmp, not /tmp)
  const r = spawnSync('osascript', ['-', fs.realpathSync(abs)], { input: SCRIPT, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1); // null when osascript was killed by a signal
  if (!pageNumbersFilled(abs)) {
    console.error(`Word finished, but the contents page of ${f} still has no page numbers; nothing more can be done automatically.`);
    process.exit(1);
  }
  console.log(`page numbers updated: ${f}`);
}
