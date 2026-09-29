# Changelog

## 1.1.0 (Preview)

- **Paste screenshots** into a card in the board's editor, or drag image files onto it. Images are stored per card in `.devtool/assets/<card-id>/`, linked from the project root so the links survive moving a card to Done, and shown in the live preview. Stored as lossless WebP by default (or PNG, whichever is smaller for that image); optionally scaled down (`kanbanBananas.images.*` settings).
- Pasting or dropping an image into a card opened in VS Code's own editor stores it the same way.
- **Deleting a card deletes its images**, except those another card (active or archived) also links to.
- **Clean Up Unused Images** finds images no card links to.
- **Store Images with Git LFS** sets up LFS for the images folder, after explaining what that entails.
- **First run:** in a project without a board, the board offers **Create board** (makes `.devtool/features/` and `done/`) or **Use an existing folder…** instead of showing an error. Also available as **KanbanBananas: Create Board**.

## 1.0.0 (Preview)

First public release.

- Board with drag and drop, configurable columns managed on the board, swimlanes by epic, assignee, priority or lane.
- Split view with a live-preview markdown editor that merges outside changes into what you're typing.
- Search, filters, labels, archive, delete, bulk moves, filename patterns with a rename migration.
- One safe write path: minimal frontmatter patches, atomic writes, respect for unsaved editor buffers, broken files never written.
- `kanban` CLI and agent skill, applied through the running extension when VS Code is open; agent move policy enforced by the CLI.
- Pre-commit hook running `kanban check`.
