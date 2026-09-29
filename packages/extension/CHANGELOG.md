# Changelog

## Unreleased

- **Clearer settings:** grouped into Board, Cards, New cards, Swimlanes, Images and Agents, in VS Code's Settings and on the extension page.
- Clearer names for card and column actions in the right-click menus (for example "Archive Card", "Move All Cards in Column to…").
- Extension page (Details) updated: screenshots in cards, first-run setup, keyboard shortcuts, the pre-commit hook.

## 1.1.0 (Preview)

**Screenshots in cards**

- Paste a screenshot into a card in the board's editor, or drag an image file onto it. It's saved per card in `.devtool/assets/<card-id>/` and linked from the project root (`![](/.devtool/assets/…)`), so the link keeps working when the card moves to Done. The editor shows it inline.
- Stored as lossless WebP by default, or kept as the pasted PNG when that's smaller; optionally scaled down. See the **Images** settings.
- Pasting or dropping an image into a card opened in VS Code's own editor stores it the same way.
- Deleting a card deletes its images too, except those another card (active or archived) also links to.
- **Clean Up Unused Images** finds images no card links to any more.
- **Store Images with Git LFS** sets up Git LFS for the images folder, after explaining what that means for the repository.

**First run**

- In a project without a board, the board offers **Create board** (makes `.devtool/features/` and `done/`) or **Use an existing folder…** instead of showing an error. Also available as **KanbanBananas: Create Board**. Nothing is created until you choose.

## 1.0.0 (Preview)

First public release.

**Board**

- Columns with drag and drop; add, rename, reorder, recolour and delete columns on the board. Deleting a column asks where its cards go.
- Split view with a live-preview markdown editor: saves automatically, never rewrites markdown you didn't touch, merges outside changes into what you're typing, and asks when edits really overlap.
- Full-text search and filters (priority, assignee, label, due date).
- Swimlanes by epic, assignee, priority or a free lane field, with order and colours.
- Archive and restore, delete, move or archive a whole column, rename or delete labels across cards, rename card files to a new filename pattern.
- A one-line header of card fields above cards opened in VS Code's own editor.
- Compact and vertical layouts; follows the VS Code theme.

**Safe writes**

- One write path for the board, the editors and the command line: minimal frontmatter patches, atomic writes, unsaved editor changes respected, broken files never written.

**Coding agents**

- `kanban` command line and agent skill; while VS Code runs, agent changes go through the extension too. How far agents may move cards is a setting, enforced by the command line.
- Pre-commit hook that runs `kanban check`.
