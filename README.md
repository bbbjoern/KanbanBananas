<p align="center">
  <img src="Assets/app%20icon/icon-2x.png" width="128" height="128" alt="KanbanBananas icon">
</p>

<h1 align="center">KanbanBananas</h1>

<p align="center">
  A kanban board for the markdown cards in your repository, for VS Code and Cursor.<br>
  Built so your cards never get corrupted, and so AI agents can work with them safely too.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Hypertxtorg.kanban-bananas">VS Code Marketplace</a> ·
  <a href="packages/extension/CHANGELOG.md">Changelog</a> ·
  <a href="LICENSE">MIT License</a>
</p>

![The board](packages/extension/media/screenshots/board.png)

## What it is

Each card is a markdown file with a small frontmatter block: status, priority, labels, dates. KanbanBananas shows them as a board you can drag, edit, search and group, while the files stay plain text, readable and diff-friendly in git.

It started as a replacement for an extension that corrupted cards: two parts of it wrote the same files without coordinating, rewrote whole files from stale memory, and read files mid-write. KanbanBananas is built the other way round:

- **One write path.** The board, the editor integration and the agent CLI all change cards through the same store.
- **Small patches, not rewrites.** Moving a card edits its `status` and `order` lines. Everything else, including the body, quoting, comments, unknown keys and line endings, stays byte-for-byte identical.
- **Unsaved edits are respected.** If a card is open with unsaved changes, the change goes into that editor, not over it.
- **Atomic writes.** Temp file, `fsync`, `rename`. A file that changed on disk since it was read is re-read, never overwritten.
- **Broken files are never written.** They go to a read-only *Broken* lane; `kanban check` and a pre-commit hook report them.

## Features

- Drag and drop between and within columns; add, rename, reorder, recolour and delete columns on the board.
- Split view with a live-preview markdown editor (CodeMirror 6) that saves automatically, never rewrites markdown you didn't touch, and merges outside changes into what you're typing.
- Full-text search and filters (priority, assignee, label, due date).
- Swimlanes by epic, assignee, priority or a free `lane` field.
- Archive, delete, bulk-move a column, rename or delete labels across cards, filename patterns with a rename migration.
- A field header above cards opened in VS Code's own editor.
- `kanban` CLI and an agent skill, so agents (e.g. Claude Code) update cards through the same safe path, with a configurable policy for how far they may move cards.

![Split view](packages/extension/media/screenshots/split-view.png)

## Install

- **VS Code:** install **KanbanBananas** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Hypertxtorg.kanban-bananas), or from a `.vsix`: Extensions view → ⋯ → *Install from VSIX…*
- **Cursor and other VS Code forks:** install from a `.vsix` (Open VSX listing to follow).

Then put cards in `.devtool/features/` (done cards in `.devtool/features/done/`) and run **KanbanBananas: Open Board**. The [extension README](packages/extension/README.md) has the card format and settings.

## The `kanban` CLI

Agents and scripts never edit card files directly; they use the CLI, which the extension installs as an agent skill (**KanbanBananas: Install / Update Agent Skill** → `.claude/skills/kanban/`):

```sh
kanban find subtitles                       # current path of a card
kanban note <id> --heading "Progress — parser done" --body - <<'NOTE'
Tokenizer passes; next: wire up the UI.
NOTE
kanban move <id> review
kanban set <id> priority=high labels=+ui
kanban check                                # integrity scan, non-zero exit on problems
```

While VS Code is running, CLI changes go through the extension (including into open editors); otherwise the CLI writes atomically itself. Every change reports its route: `disk`, `editor-saved` or `editor-unsaved`.

## Repository layout

```
packages/
  core/       Pure TypeScript: parse, patch, validate, order keys, merge, search.
              core/node: atomic file writes and the file-based store.
  extension/  The VS Code extension: CardStore, board host, CLI socket, commands,
              CodeLens header, agent skill installer, pre-commit hook.
  webview/    The board UI: React, dnd-kit, CodeMirror 6.
  cli/        The `kanban` command line, bundled into the agent skill.
spec/         The design spec and milestone notes.
```

## Development

Requires Node 20+.

```sh
npm install
npm run typecheck
npm test                                    # unit tests: core, cli, webview
npm run test:integration -w kanban-bananas  # integration tests in a real VS Code
npm run package -w kanban-bananas           # builds packages/extension/kanban-bananas.vsix
```

- **Run the extension:** open this folder in VS Code and press F5 ("Run extension").
- **Work on the board UI in a browser:** `node packages/extension/scripts/demo-board.mjs` (invented demo cards), then `npm run dev -w @kanban-bananas/webview`. Add `?theme=light` to try the light theme.
- **Corpus tests:** copy a real `.devtool/features` folder to `packages/core/test/corpus/features/` (git-ignored) to check that every card round-trips byte for byte.

Releases: see [PUBLISHING.md](PUBLISHING.md).

## License

[MIT](LICENSE) © 2026 Hypertxt.org
