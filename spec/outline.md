
Written for: you, and whichever session picks this up in the new project. It stands on its own; nothing in it depends on this conversation.

---

# Markdown Kanban for VS Code: build outline

## 1. Why this exists

It replaces `lachyfs.kanban-markdown` 1.14.1, which corrupted card files on a 108-card board:
- Two cards were truncated to 0 bytes.
- One card was later refilled with a different card's body and no frontmatter.
- One card ended up with `id: "C"`: the board read a half-written file and saved that value back.

Root causes found in its source:

- **Two writers with no coordination.** The board rewrites the whole file from memory via `workspace.fs.writeFile`. The header panel above the text editor replaces the whole document via `WorkspaceEdit`, then calls `save()`. Neither checks whether the file has unsaved edits, so whichever saves last wins the entire file.
- **Every write rewrites the whole file from cached state.** One stale object in memory overwrites a whole card.
- **The file-change handling is racy.** A watcher reloads all cards on any change. It's suppressed during the board's own writes by a single panel-wide flag, but that flag is cleared before the watcher events arrive, so the board can read a file mid-write.
- **The two parsers disagree.** For a file with no frontmatter, the board treats it as nonexistent. The header panel treats the whole file as body text, fills in default frontmatter and writes that back.
- **The rich-text editor (Tiptap) is lossy by design.** It converts markdown to ProseMirror and back, so a round trip can rewrite your formatting.

**Goal:** the same features as today, with durability as the headline feature.

## 2. Storage rules (non-negotiable)

1. **One write path.** Every change goes through a single `CardStore` in the extension host. The webview sends intents such as `move {id, toStatus, beforeId}`, never whole card objects.
2. **The file is the source of truth.** Every change reads the current file (or the open buffer), applies a small patch and writes it back. Nothing is ever written from a cache.
3. **Patch only what changed.** Frontmatter changes touch only the affected frontmatter lines, using the `yaml` package's Document API, which keeps key order, quoting style, unknown keys and comments. The body stays byte-for-byte identical.
4. **Write differently depending on the file's editor state:**
   - **Open with unsaved edits:** apply a small `WorkspaceEdit` to the frontmatter range and don't save. Your pending edits survive and undo still works.
   - **Open with no unsaved edits:** apply the small `WorkspaceEdit`, then save.
   - **Not open:** write atomically. Write a temp file in the same directory, `fsync` it, then `rename()` it over the card. Check beforehand that the file's mtime and size haven't changed since it was read; if they have, re-read, re-apply and retry.
5. **Never write a file that didn't parse.** Such a file goes to a read-only "Broken" lane with repair actions.
6. **Moves use `rename()`**, never write-new-then-delete-old. If the target name already exists, add a suffix; never overwrite.
7. **Track changes per file.** Debounce watcher events per file, and recognise the board's own writes by content hash rather than a global flag.
8. **Check every write before committing it.** Required fields must be present, `id` must equal the filename, and the output must re-parse to the intended model. If any check fails, abort and report it.

## 3. File format: read existing cards unchanged

- **Layout:** `.devtool/features/*.md` for every status except `done`, which goes in `done/*.md`. Archived cards go in `archived/`, which doesn't exist yet. Current count: 60 active, 48 done.
- **Frontmatter:** `id, status, priority, assignee, epic, dueDate, created, modified, completedAt, labels, order`. Values are double-quoted strings or `null`, and `labels` is an inline array. No other keys exist today, but unknown keys must be preserved.
- **Statuses in use** (corpus snapshot, 2026-09-25): `backlog` 15, `todo` 25, `in-progress` 8, `review` 12, `done` 48. Columns are configurable.
- **Order:** fractional-index strings in base 62 (`"a1"`, `"Zl"`, `"ZSV"`), as produced by the `fractional-indexing` package. Duplicates exist (three cards share `"Zl"`), so sort by `order`, then `created`, then `id`. Only rewrite a card's key when that card is moved.
- **Title:** the first `# ` heading in the body. A body can be just the title with no trailing newline. **New cards** (board, commands or CLI) always end with a newline; existing cards keep whatever ending they have.
- **Filename:** `<slug>-<YYYY-MM-DD>.md`, where the slug is lowercase `[a-z0-9-]` and at most 50 characters. Other patterns can be configured. `id` must equal the filename.
- **Optional `lane` key (M5):** a free-text string used when the board is grouped by Lane. It's written only to cards the user puts in a lane in that grouping; other cards never get it. The CLI supports it like the other editable fields.
- **Field usage:** `labels` is used. `assignee`, `epic` and `dueDate` are never set on this board, but must still be supported.
- **Parser tolerance:** accept a BOM, CRLF line endings, and numeric `order: 0` (the readme shows this form).

## 4. Architecture

```
packages/
  core/       pure TS, no vscode import: parse, patch, validate, order keys,
              filenames, search index. Everything testable without VS Code.
  extension/  CardStore + I/O adapters (buffer / atomic fs), watcher, commands,
              board webview host, sidebar view, frontmatter header panel,
              settings, CLI socket server, "Install / update agent skill"
  webview/    React board: columns, drag and drop, detail pane, filters
  cli/        `kanban find | show | ls | new | note | move | set | edit | check`:
              same core, for agents and a pre-commit hook; bundled into the
              agent skill (§12)
```

The CLI gets its own package because agents edit cards too; the old extension's workflow even ships a `kanban-skill` for this. Giving agents the same safe write path closes the last uncoordinated writer.

**Stack:** TypeScript, esbuild (host), Vite + React (webview), `@dnd-kit` for drag and drop, `yaml`, `fractional-indexing`, Vitest, `@vscode/test-electron`.

## 5. Feature parity checklist

**Board**
- [x] Configurable columns (id, name, colour); default is the five statuses above
- [x] **Columns managed on the board (M5):** add (+ Add column / + Column), rename by clicking the title (display name only; cards keep their status), reorder by dragging the ⋮⋮ handle, recolour and delete from the right-click menu. Deleting asks where the cards go (another column or the archive); Done can't be deleted. Columns are saved to the workspace settings, and the skill and CLI get the new list. The chevron is the only thing that collapses a column.
- [x] Drag and drop between and within columns
- [x] Editor panel plus activity-bar sidebar view
- [x] Horizontal and vertical layouts; board view mode
- [x] Collapsible columns; epic lanes with collapsible epics and epic colours
- [x] **Lanes, generalised (M5):** a "Group by" choice (Epic, Assignee, Priority, or Lane: a custom `lane` field). Dropping a card into a lane sets that field. For every grouping: a lane list in settings (order, colours, empty lanes), and New lane / rename / delete from the board. Rename and delete change the field on every card that has it, one store write per card, like labels.
- [x] Compact mode, hide-scrollbar option
- [x] Keyboard shortcuts: `N` new, `Esc` close, `Cmd/Ctrl+Enter` submit
- [x] Follows the VS Code or Cursor theme (light and dark)

**Cards**
- [x] Priority (critical/high/medium/low) with colour badges
- [x] Assignee, epic, labels (up to 3 shown, then "+N more")
- [x] Due date with relative formatting (Overdue, Today, Tomorrow, `5d`)
- [x] Automatic `created`, `modified` and `completedAt`
- [x] Settings to show or hide each of: priority, assignee, due date, labels, epic, filename
- [x] Add new cards to the top or the bottom of a column
- [x] Filename pattern setting, plus a migration that renames existing files when the pattern changes

**Search and filters**
- [x] Full-text search across body, id, assignee and labels
- [x] Filter by priority, assignee, label, unlabelled, and due date (overdue / today / this week / none)

**Editing**
- [x] Split view: board on the left, inline editor on the right; saves automatically on change
- [x] Native mode: open the card in VS Code's own editor, with a frontmatter header panel above it (dropdowns and inputs)
- [x] Refreshes when files change outside the board
- [x] "Open file" from a card

**Bulk and management**
- [x] Move all cards in a column; archive all (with a confirmation dialog)
- [x] Rename and delete labels across all cards
- [x] Delete a card

**Configuration**
- [x] Features directory, default priority and status
- [x] English only; no localisation

**Dropped from parity:** "Build with AI" (the terminal launcher for Claude Code, Codex, Copilot and OpenCode) is not needed. Agents work through the CLI and skill (§12) instead.

## 6. Beyond parity (from the failures above)

- **Broken lane** and a `Validate board` command that flags 0-byte files, missing frontmatter, `id` ≠ filename and duplicate ids.
- **Restore card from git** (`HEAD` version) as a repair action.
- **Conflict prompt** when a card changes on disk while it's open in the inline editor: offer keep mine, take theirs, or diff.
- **"Not in git" marker** on cards git doesn't track yet, since git is the only real backup.
- **Pre-commit hook** running `kanban check`.
- **Agent writes** go through the same store as the board and are covered by the same guarantees (§12).

## 7. Decision: the inline editor

**Decided: CodeMirror 6, live-preview style, with a toggle to plain source.** WYSIWYG (Tiptap) is out: it rewrites markdown on save, which adds formatting-only noise to git diffs and reformats notes that agents add through the CLI.

- **Live preview:** the document is always plain markdown text. Decorations hide markup except on the line with the cursor, render headings and emphasis, and draw task checkboxes that toggle `[ ]` ↔ `[x]` in the text. Nothing is ever written that the user didn't type.
- **Cursor stability is a hard requirement.** The old editor's cursor jumped to the end of the document, which made it unusable. The usual cause is resetting the whole document on every update or re-render. So:
  - The editor is uncontrolled. React never passes the document back in as a prop, and re-renders never touch its content.
  - Changes from outside (a board move, an agent note, a change on disk) are applied as minimal CodeMirror transactions built from a text diff. Positions are mapped through them, so the cursor, selection, scroll position and undo history stay where they were. The document is never replaced wholesale.
  - The editor's own autosaves are recognised by content hash (§2.7) and are not applied back to it.
  - Frontmatter edits from the board don't touch the editor's text at all, because the inline editor shows the body only.
- **Tests:** type in the middle of a card while autosave runs, while the board moves the card, and while an agent appends a note. The cursor and selection must stay put and no keystroke may be lost.

## 8. Testing

- **Corpus:** a snapshot of `.devtool/features` in `packages/core/test/corpus/features/` (git-ignored). Taken on 2026-09-25 after the damaged cards were repaired: 108 cards, all valid. Parse → serialize must be byte-identical for every one. The damaged cases (a 0-byte file, a file with no frontmatter, `id: "C"`) are reproduced as synthetic negative fixtures in `packages/core/test/fixtures/broken/`.
- **Patch tests:** each frontmatter operation changes exactly the expected lines. Assert on the diff.
- **Atomicity:** kill the process between the temp-file write and the rename; the original file must be intact.
- **Concurrency:** simulate interleaved writers (board, editor, CLI). No write may be lost or torn.
- **Integration tests:** with a card open and unsaved, a board move must patch the buffer, keep the unsaved body edits, and leave the file on disk unchanged until you save.

## 9. Milestones

| | Scope | Exit criterion |
|---|---|---|
| **M0** | `core` + corpus tests Round trip byte-identical on all 108 cards; synthetic damaged fixtures rejected. **Done 2026-09-25.** |
| **M1** | Read-only board | Renders your real board identically; run it for a few days. **Built 2026-09-25; trial run in progress.** |
| **M2** | Frontmatter writes: move, reorder, create, field edits | Patch and atomicity tests green. **Done 2026-09-25**; see the M2 notes below. |
| **M2b** | CLI + agent skill (§12), socket to the running extension | Skill scenario tests green; agents use the CLI from here on. **Done 2026-09-26**; see §12 implementation notes. |
| **M3** | Editor integration: header panel, inline editor, native mode | Integration tests for unsaved buffers and cursor stability (§7) green. **Done 2026-09-26**; see the M3 notes below. |
| **M4** | Search, filters, epic lanes, label management | Parity checklist for these sections. **Done 2026-09-27**. |
| **M5** | Archive, bulk moves, generalised lanes, settings | Full parity checklist. **Done 2026-09-27**; see the M5 notes below. |
| **M6** | Pre-commit hook, VSIX packaging | `kanban check` clean on the corpus |

**M2 notes (known limits, all from existing data or deliberate):**
- **Duplicate order keys:** a card dropped between two cards that share a key (three cards share `"Zl"`) lands after the last of them. Neighbours are never re-keyed (§3).
- **Non-standard keys:** a numeric `order: 0` isn't a valid fractional-index key, so it's skipped as a bound; nothing can be placed above it.
- **Check-then-rename window:** the mtime/size check and the `rename()` are two steps, so an outside write landing in between (microseconds) can still be replaced. Inside the extension all writes are queued; the CLI closes the rest at M2b by routing through the extension's socket.
- **Moves across `done/`:** the card is patched in place, then renamed. If the rename fails, the card is left with its new status in the old folder (a `wrong-folder` warning, nothing lost).
- **Own-write detection (§2.7)** isn't needed yet: the board simply re-reads files it wrote. It becomes necessary with the inline editor in M3.

**M3 notes:**
- **Native mode header is a row of CodeLens links**, not a panel: VS Code can't put UI above its text editor, and a replacement editor would be a second writer. Lenses aren't text, so they can't move the cursor; the row always has the same seven items, so its height never changes.
- **Inline editor sync:** outside changes reach the editor as small CodeMirror transactions rebased over unsaved typing; saves carry the body they were based on and are merged three-way (line-based) with anything that changed meanwhile. Overlapping edits to the same lines raise the conflict prompt (keep mine, take theirs, show diff). 200 randomized interleavings are part of the tests.
- **Clean-but-stale buffers:** an open card without unsaved edits is only edited through its buffer if the buffer matches the file. If VS Code hasn't reloaded an outside change yet, the file is written directly and VS Code reloads. The board also reads clean buffers from disk. (Found by the integration tests: before this, a board change could land in a stale buffer and be left unsaved.)

**M4 notes:**
- **Search runs in the extension** (it has the bodies; the board page only has excerpts): every word must appear in the id, title, body, assignee, labels or epic. Filters run in the page on fields it already has. Column counts show "shown / total" while filtering.
- **Epic lanes** are a view toggle (panel only). Dropping a card into another lane sets its epic: a move plus a field edit, both through the store. Epic colours come from `kanbanBananas.epicColors` or a fixed palette by name.
- **Label rename/delete** is one store write per card, in turn, each re-reading the card's current labels; renaming onto an existing label merges them.

**M5 notes:**
- **Archive** moves a card into `archived/` (created on first use); it leaves the board and keeps its status. "Restore Archived Card" moves it back to the folder its status belongs in. New cards never reuse an archived card's id.
- **Delete** goes to the trash; on machines without one (typical for remotes) a second dialog asks before deleting permanently. Refused while the card has unsaved edits.
- **Filename migration** lists the cards a new pattern would rename (untick to keep), then asks, since ids change with filenames. A clash gets a `-2` suffix and counts as matching afterwards.
- **Lanes:** Group by Epic, Assignee, Priority or Lane. Configured lanes (`kanbanBananas.lanes`, workspace settings) come first and show when empty; used values follow; "none" is last. Right-click a lane to rename or delete it (changes the field on its cards); "+ New lane" adds one to settings.
- **Skill auto-update:** the extension compares the installed skill with what it would write. Older and untouched → updated automatically (notice afterwards); edited by hand → asks ("Update Anyway"); newer (e.g. a teammate's extension) → left alone. A `.manifest.json` in the skill folder records file hashes to tell hand edits apart. `kanbanBananas.autoUpdateSkill` turns it off.

**Terminology (settled 2026-09-27):** *columns* are the vertical status stages; *swimlanes* are the optional horizontal grouping by a field. Earlier notes that say "lanes" mean swimlanes.

The CLI and skill sit at M2b, right after frontmatter writes, because agents write cards every session and need the safe path from the start.

## 10. Cutover

1. **Never run both extensions on the same folder.** That recreates the two-writer bug. Disable the old one before the new one does its first write.
2. **Repair the known-damaged cards first.** Done before the 2026-09-25 corpus snapshot; the snapshot has no damaged cards. For the record:
   - `new-module-subtitles-2026-09-01.md`: 0 bytes. The last good version is at commit `2dec84d`.
   - `parser-add-click-on-word-to-display-alternatives-2026-06-15.md`: no frontmatter, and its body belongs to a different card. The last good version is at `a538b01`.
   - `feature-full-pass-2026-08-25.md`: `id: "C"`. Its `status: "backlog"` may also be a substituted default.
3. Use a new settings namespace and import `kanban-markdown.*` once on first run.
4. Delete `.agents/skills/kanban-markdown/` when the new skill is installed. Otherwise agents keep writing files by hand alongside it.

## 11. Open questions

- Private VSIX, or publish to the Marketplace / Open VSX? (Needed by M6.)

**Resolved**
- Localisation: English only.
- "Build with AI": not needed; dropped from parity.
- Inline editor: CodeMirror 6 with live preview (§7).
- `id` is the filename without `.md` (all 108 corpus cards).

---

## 12. Agent skill (first-class deliverable)

**Principle: agents never write card files. They call the CLI; the skill only teaches how.** The file format lives in one place, `core`, so the skill can't drift from it. Agents may still *read* cards freely (`cat`, `grep`).

### How it's packaged
- The skill folder contains `SKILL.md` plus `scripts/kanban.mjs`, a single-file esbuild bundle of `core` + `cli`. It's self-contained: no npm install, and it works in any agent sandbox, cloud agents included.
- The extension provides an **"Install / update agent skill"** command. It writes the skill folder into the workspace (`.claude/skills/` or `.agents/skills/`, configurable) and stamps it with the extension's version. On activation the extension warns if the installed skill is older than the extension.
- Optionally, also publish the CLI to npm for use outside VS Code.

### CLI commands the skill documents
Every command supports `--json`. Every command that changes something prints the card's final path and new mtime.

| Command | Purpose |
|---|---|
| `kanban find <id\|text>` | **Look up the card's current path by id.** The fix for the stale-path bug. |
| `kanban show <id>` | Frontmatter + body |
| `kanban ls [--status --label --priority]` | Listing and filtering |
| `kanban new "<title>" [--status --priority --labels] [--body -]` | Create; fills in id, order and timestamps |
| `kanban note <id> --heading "…" [--body -]` | **Append a section** to the end of the body and bump `modified`. The main agent operation. |
| `kanban move <id> <status> [--before/--after <id>]` | Status change; handles `done/` with `rename()` and sets or clears `completedAt` |
| `kanban set <id> priority=high labels=+ai,-bug` | Patch individual frontmatter fields |
| `kanban edit <id> --body - --expect-mtime <t>` | Replace the whole body; refused if the file changed since `--expect-mtime` |
| `kanban check` | Integrity scan; non-zero exit on problems |

### How the CLI writes
- **If the extension is running**, the CLI sends the change to it over a local socket (path recorded in `.devtool/.kanban.sock`). The extension applies it through the same path that handles open editors, so an agent's note can't be overwritten by an unsaved editor buffer.
- **Otherwise** it writes atomically with the mtime check from Section 2. If the card is open in VS Code with unsaved edits, VS Code's own "file is newer" warning on save is the fallback protection.

### What `SKILL.md` covers
- **Triggers:** kanban, card, board, `.devtool/features`, "add a done note", "move the card".
- **Hard rules:**
  - Never Write/Edit files under the features directory.
  - Always run `kanban find` before acting on a card; never reuse a path from earlier in the session.
  - If the CLI reports a conflict or a broken card, stop and tell the user. Don't repair it by hand.
- **Recipes:**
  - Start work: `move <id> in-progress`.
  - Record completed work: `note` with a "Done — …" heading.
  - Create a card from a bug report.
  - Find a card by topic: `ls` + `show`, or grep the body.
- **Project policy:** an optional `.devtool/kanban.json` enforced *by the CLI*, not just stated in the skill. Example: `{"agents": {"allowStatus": ["todo", "in-progress", "review"]}}`, so an agent can't mark a card done unless the user passes `--force`.

### Tests
Run scenarios against a fixture board and assert with `kanban check` plus a diff:
- Add a note to a card that has moved to `done/`: it lands in `done/`, and no new file appears.
- Create a card: the result is byte-identical to one the board creates.
- Edit with an outdated `--expect-mtime`: refused, and the file is unchanged.

### Implementation notes (M2b)
- **Remote projects:** the project lives on a remote machine and is opened with VS Code Remote. The extension declares `extensionKind: ["workspace"]` so it runs on the remote, next to the files and the agents.
- **Socket:** the socket itself is in the temp directory (socket paths are limited to ~100 characters), owner-only (`0600`). `.devtool/.kanban.sock` is a small JSON record pointing at it; the extension removes it on shutdown. A stale record just makes the CLI write directly. **Add `.devtool/.kanban.sock` to the project's `.gitignore`.**
- **Node on the remote isn't assumed:** `scripts/kanban` runs `node` from the PATH, else the Node that the VS Code remote server ships with.
- **Skill location:** `.claude/skills/kanban/` by default (Claude Code), set by `kanbanBananas.skillDirectory`. The command path in `SKILL.md` is filled in at install time. A `VERSION` file drives the out-of-date warning.
- **Old skill:** installing offers to delete `.agents/skills/kanban-markdown/`, always behind a confirmation dialog.
- **Exit codes:** 0 ok, 1 problem, 2 usage, 3 conflict, 4 refused by policy.
- **Shared code:** atomic writes and the file-based store live in `core/node`, used by both the CLI and the extension, so there is one implementation of the write path on disk.
