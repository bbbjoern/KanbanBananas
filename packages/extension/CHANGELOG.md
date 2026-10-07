# Changelog

## 1.3.3 (Preview)
- **Fix: `kanban note` dropped note text given without `--body`.** `kanban note <id> --heading "Done" "What changed…"` wrote only the heading and reported success, so an agent's notes came out empty. The CLI now refuses anything a command doesn't take, and writes nothing: extra arguments, with a hint that text goes in `--body`, and unknown options such as `--bdy`. `note` also needs `--body` and refuses empty stdin. For a heading without text, pass `--body ""`.

## 1.3.2 (Preview)
- **Fix: new cards could vanish after the computer slept.** When the board lost its connection to VS Code (sleep, a dropped remote connection), changes went nowhere while the board looked as if they'd been made. Now every change from the board waits for VS Code to confirm it:
  - A new card shows as *Creating…* until it's saved. If VS Code doesn't confirm, it stays on the board as *Not created*, with **Retry** and **Discard**, so the title isn't lost.
  - A moved card goes back where it was if the move wasn't confirmed.
  - The editor says *Not saved* instead of staying on *Saving…*, keeps your text, and saves it as soon as the connection is back.
  - A banner says the board isn't connected. The board checks when you come back to it, and every few seconds while disconnected; once reconnected it reloads the cards and the banner goes.
- **Small windows:** below about 800 px, an open card (or the session memory) takes the whole width and the board returns when it's closed, instead of being squeezed to a sliver. In the card's header the title keeps its room, the buttons move to their own row when they don't fit, and the filename stays on one line (full name on hover).

## 1.3.1 (Preview)

- **Fix: a slow VS Code made the CLI report failures for changes that were saved.** CLI requests now carry an id: when VS Code is slow, the CLI says it's still waiting, asks again with the same id (up to a minute in total), and the extension applies the change only once. If it still times out, the message says the change may still land and to check before repeating.
- The agent skill's description (what an agent sees before loading the skill) now gives the CLI's full path and says there's no plain `kanban` command, after an agent shortened it in its own notes and got "command not found".
- The KanbanBananas log records each CLI request with how long it took, and warns when saving a card takes more than 2 seconds, to find what makes VS Code slow.

## 1.3.0 (Preview)

- **Copy a card's path** to share it with an agent: a small button on each card (on hover), in the split view's header, and *Copy Card Path* in the card's right-click menu. Copies `@.devtool/features/<card>.md` by default, which attaches the file when pasted into an agent's chat; the *Copy path as* setting switches to the plain path.

## 1.2.1 (Preview)

- **Fix: hand-written text in the session memory was lost.** Text without a dated entry heading (e.g. pasted from a card) wasn't shown by `kanban memory`, and the next write dropped it without warning. It's now shown as an entry (dated by the file), kept like any other entry, and a write that replaces it says so.
- `kanban memory --from-card <id>` saves a card's text as the newest session memory entry; the card stays.

## 1.2.0 (Preview)

- **Session memory** (Settings → Session memory, off by default): where the work stands, for the next session. The board shows it in the top-left corner (when it was updated and what's next) and opens it in the split view like a card. Agents read it when a session starts and update it at checkpoints with `kanban memory`, as completely as the next session needs (no length limit); a `/session-memory` project command asks the agent to save the current state. The file's location is a setting; *Personal* keeps it out of git for your clone only. Keeps the newest entry (up to 10).
- **The board reopens after a window reload**, where it was, instead of closing.

## 1.1.1 (Preview)

- **Clearer settings:** grouped into Board, Cards, New cards, Swimlanes, Images and Agents, in VS Code's Settings and on the extension page.
- Clearer names for card and column actions in the right-click menus (for example "Archive Card", "Move All Cards in Column to…").
- Extension page (Details) updated: screenshots in cards, first-run setup, keyboard shortcuts, the pre-commit hook.
- The KanbanBananas log records what each image paste or drop contained, to diagnose paste problems. (If a new feature seems missing after an update, reload the window.)

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
