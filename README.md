# Ephemera Pad (Obsidian plugin)

A little post-it notepad that lives in the Obsidian sidebar for quick notes.

> ⚡ **Vibe-coded.** This plugin was built conversationally with Claude Code — design decisions made on the fly, iterated by feel rather than spec. It works and it's tidy, but it hasn't been battle-tested. Use at your own risk, and back up your vault.

## Features

- **Post-it notes in the sidebar.** Open from the ribbon (sticky-note icon) or the command palette ("Open Ephemera Pad").
- **One note per "page"**, paged through with ◀ / ▶ and a `2 / 5` counter. Newest note is on top.
- **`+` / `−`** in the toolbar to add a new note on top, or delete the current one (with a confirmation dialog — deleted notes go to trash).
- **Light formatting only:** bullet lists (`•`), numbered lists (`1.`), and checklists with real check-on/off boxes. Toolbar buttons toggle the focused line's type; `Enter` continues a list, `Enter` on an empty item or `Backspace` at line start exits it.
- **Inline arithmetic.** Write `=expr` anywhere on any line — in plain text, bullets, numbered items, or checklists (e.g. `lunch =12.50*2`). Each formula renders as a result pill showing just the answer, in the note's complementary color. Click a pill to edit its formula; it recomputes when you click away. Supports `+ - * / %`, parentheses, and `×`/`÷`.
- **`/t` timestamp command.** Type `/t` (at the start of a line or after a space) and it expands into the current date/time as plain text, using the format set in settings (moment.js tokens).
- **`/[` wikilink command.** Type `/[` to insert a `[[wikilink]]` to the currently active note (its title as the text).
- **Clickable links.** `[[wikilinks]]` (dashed underline) open the linked note; `http(s)://` URLs (solid underline) open in your browser. Click anywhere else on the line to edit it.
- **Per-note color** via a full color picker. The text color is derived automatically to stay readable *and* hue-matched — e.g. dark blue text on a light-blue note rather than plain black.
- **Obscured create / edit timestamps** shown faintly, centered along the bottom of each note (`+` created, `Δ` edited).
- **Configurable font** for note text (Settings → Ephemera Pad).

Notes are stored as ordinary Markdown files (lists/checklists are real Markdown; color + timestamps live in frontmatter), so they remain readable and editable outside the plugin.

## Settings

- **Notes folder** — vault folder where notes are created/deleted. Pick an existing folder or type a new path (it's created on first note).
- **Font** — font family for note text (blank = Obsidian's text font).
- **Timestamp format** — moment.js format string used by the `/t` command (default `YYYY-MM-DD HH:mm`).
- **Default note color** — color used for newly created notes.

## Install (local / manual)

1. Build it:
   ```bash
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault at
   `<vault>/.obsidian/plugins/ephemera/`.
3. In Obsidian: **Settings → Community plugins**, enable **Ephemera Pad**.

For development, `npm run dev` watches and rebuilds on change.
