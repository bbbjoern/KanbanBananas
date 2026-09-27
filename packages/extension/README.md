# KanbanBananas

A kanban board for the markdown cards in your repository, built so that your cards never get corrupted, and so that coding agents can work with them safely too.

Each card is a markdown file with a small frontmatter block (status, priority, labels, dates…). The board shows them as columns and lets you drag, edit and search them, while the files stay plain, readable and diff-friendly in git.

![The board](media/screenshots/board.png)

## Safe by design

Every change goes through one write path that treats your files with care:

- **Only what changed is touched.** Moving a card edits just its `status` and `order` lines. Quoting, comments, unknown keys, line endings and the body stay byte-for-byte identical.
- **Unsaved edits are respected.** If a card is open in an editor with unsaved changes, the board edits the editor instead of the file, so your changes and your undo history survive.
- **Atomic writes.** Files are written to a temporary file and renamed into place, so a crash never leaves a half-written card. A file that changed on disk since it was read is re-read, never overwritten.
- **Broken files are never written.** Cards that don't parse go to a read-only *Broken* lane, and `kanban check` (also as a pre-commit hook) reports them.

## The board

- Drag cards between and within columns. Add, rename (click the title), reorder (drag ⋮⋮), recolour and delete columns right on the board.
- Split view: click a card to edit it next to the board, in a live-preview markdown editor that saves automatically and never rewrites markdown you didn't touch. Outside changes merge into what you're typing; real overlaps ask you to choose.
- Full-text search (`/`), and filters for priority, assignee, label and due date.
- Swimlanes: group the board by epic, assignee, priority or a free lane field. Drag cards between swimlanes to change that field.
- Archive, delete, bulk-move a whole column, rename or delete labels across all cards.
- Cards opened in VS Code's own editor get a one-line header of their fields.
- Follows your VS Code theme, light or dark.

![Split view with the inline editor](media/screenshots/split-view.png)

![Swimlanes by epic, light theme](media/screenshots/swimlanes.png)

## For coding agents

KanbanBananas ships a `kanban` command line and an agent skill for coding agents. Agents never edit card files directly: they run `kanban find`, `note`, `move`, `set` and friends, and while VS Code is running, their changes go through the same safe path as the board, including into your open editors.

Run **KanbanBananas: Install / Update Agent Skill** to add it to your project . The skill teaches the workflow: log the plan on the card before building, log progress as you go, and a summary when done. A setting decides how far agents may move cards (never, anything but Done, or anywhere), and the CLI enforces it.

## Getting started

1. Put your cards in `.devtool/features/` (done cards in `.devtool/features/done/`), or point **KanbanBananas: Features Directory** at your folder.
2. Run **KanbanBananas: Open Board**, or click the banana in the activity bar.
3. Press `N` for a new card.

A card looks like this:

```markdown
---
id: "offline-mode-2026-09-20"
status: "in-progress"
priority: "high"
assignee: null
epic: "Mobile"
dueDate: null
created: "2026-09-20T09:00:00.000Z"
modified: "2026-09-27T09:00:00.000Z"
completedAt: null
labels: ["mobile", "sync"]
order: "a1"
---
# Offline mode for the mobile app

Queue writes while offline; replay them in order.
```

The format is plain frontmatter plus markdown, so existing boards in this layout open as they are. Don't run two board extensions on the same folder at the same time.

## Settings

Open them from the ⚙ on the board. Highlights: columns, compact mode, vertical layout, which fields cards show, filename pattern for new cards, default priority and column, swimlane order and colours, and the agent policy.

## Works remotely

The extension runs where your files are, so it works over Remote SSH, in containers and in WSL. The agent CLI uses Node from your PATH, or the Node that VS Code's remote server ships with.
