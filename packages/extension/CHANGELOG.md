# Changelog

## 1.0.0 (Preview)

First public release.

- Board with drag and drop, configurable columns managed on the board, swimlanes by epic, assignee, priority or lane.
- Split view with a live-preview markdown editor that merges outside changes into what you're typing.
- Search, filters, labels, archive, delete, bulk moves, filename patterns with a rename migration.
- One safe write path: minimal frontmatter patches, atomic writes, respect for unsaved editor buffers, broken files never written.
- `kanban` CLI and agent skill, applied through the running extension when VS Code is open; agent move policy enforced by the CLI.
- Pre-commit hook running `kanban check`.
