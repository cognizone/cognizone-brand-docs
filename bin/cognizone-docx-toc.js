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
    -- If the open did not bring the file to the front (cancelled dialog, protected file),
    -- there is no active document or it is some other one: never update, save or close that.
    if (count of documents) is 0 or name of active document is not fname then error "Word did not open " & fname & "; nothing was changed. Check Word for a dialog waiting for an answer."
    set d to active document
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
  const r = spawnSync('osascript', ['-', abs], { input: SCRIPT, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1); // null when osascript was killed by a signal
  console.log(`page numbers updated: ${f}`);
}
