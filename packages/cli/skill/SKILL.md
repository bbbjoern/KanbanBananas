---
name: kanban
description: Read and change the project's kanban cards (.devtool/features) with the `kanban` CLI. Use for anything about the board, a card, a ticket or feature card, adding a done note, moving a card, creating a card from a bug report, or finding a card by topic. Never edit card files directly.
---

<!-- Installed by the KanbanBananas VS Code extension, version {{VERSION}}. Don't edit: "KanbanBananas: Install / Update Agent Skill" overwrites this folder. -->

# Kanban cards

The board is a folder of markdown cards in `.devtool/features/` (done cards in `.devtool/features/done/`).
A VS Code extension shows them as a kanban board and may have cards open with unsaved edits.
**All changes go through the CLI**, which applies them through the same safe path as the board.

Run it as:

```sh
{{KANBAN}} <command> [--json]
```

## Hard rules

1. **Never create, edit, move, rename or delete files under `.devtool/features/`** with Write, Edit, `sed`, `mv`, `rm` or any other tool. Only use the CLI. Reading cards with `cat`, `grep` or Read is fine.
2. **Always run `{{KANBAN}} find <id>` right before acting on a card**, and use the path it prints. Cards move (for example into `done/`); never reuse a path from earlier in the session.
3. **If the CLI reports a conflict, a broken card or a refusal, stop and tell the user.** Don't repair card files by hand, and don't retry with `--force` unless the user says so.
4. {{MOVE_RULE}}

## Commands

| Command | What it does |
|---|---|
| `find <id\|text>` | Current path of a card, by id, filename or text in its title |
| `show <id>` | Path, mtime, frontmatter and body |
| `ls [--status s] [--label l] [--priority p]` | List cards |
| `new "<title>" [--status s] [--priority p] [--labels a,b] [--body -]` | Create a card; id, order and timestamps are filled in |
| `note <id> --heading "..." [--body -]` | Append a `## heading` section to the end of the card |
| `move <id> <status> [--before <id> \| --after <id>]` | Change status (moves into or out of `done/` as needed) |
| `set <id> key=value...` | `priority`, `assignee`, `epic`, `lane`, `dueDate` (YYYY-MM-DD), `labels`. `labels=a,b` sets, `labels=+a,-b` adds/removes, `key=` clears |
| `edit <id> --body - --expect-mtime <mtime>` | Replace the whole body (everything after the frontmatter); refused if the card changed since `show` |
| `check` | Integrity scan of the whole board; non-zero exit on problems |

**Screenshots:** cards may include images like `![](/.devtool/assets/<card-id>/2026-09-29-143012.webp)`. The path is relative to the project root (drop the leading `/`); open the file to see it. Don't add, move or delete files in the images folder yourself.

`--body -` reads the text from stdin; use a heredoc for multi-line text. Every change prints the card's final path and new mtime.
Statuses (the board's columns, in order): {{STATUSES}}.

## Recipes

The card is the task's record: the plan goes on it before building, progress while building, and a summary when done. Someone (you, after an interruption, or another agent) should be able to pick up the work from the card alone.

**Start work on a card**

{{START_WORK}}

**Log the plan before building.** Once the plan is agreed, and before changing code, put the complete plan on the card:

```sh
{{KANBAN}} note <id> --heading "Plan — <short summary>" --body - <<'PLAN'
Goal, the steps, which files change, decisions made and why, open questions.
PLAN
```

**Log progress while building.** After each meaningful step (a part working, tests passing, a commit, a decision, a blocker), add a short entry, ending with what comes next:

```sh
{{KANBAN}} note <id> --heading "Progress — <what happened>" --body - <<'NOTE'
What was done, anything that changed from the plan and why.
Next: <the next step>.
NOTE
```

Keep entries short. Write them as you go rather than at the end: sessions can end without warning.

**Record completed work** (at the end of a task)

```sh
{{KANBAN}} note <id> --heading "Done — <short summary>" --body - <<'NOTE'
What changed, where, and anything the user should check.
NOTE
```

{{AFTER_NOTE}}

**Pick up work after a break**

```sh
{{KANBAN}} ls --status in-progress
{{KANBAN}} show <id>        # read the Plan and the latest Progress entry, then continue from its "Next"
```

**Create a card from a bug report**

```sh
{{KANBAN}} new "<short title>" --status todo --labels bug --body - <<'BODY'
## Report
<what the user saw>

## Steps to reproduce
...
BODY
```

**Find a card by topic**

```sh
{{KANBAN}} find subtitles        # titles and ids
{{KANBAN}} ls --label parser
grep -ril "whitespace" .devtool/features   # body text
```

**Rewrite a card's body** (rare; prefer `note`)

```sh
{{KANBAN}} show <id> --json      # note the mtimeMs
{{KANBAN}} edit <id> --expect-mtime <mtimeMs> --body - <<'BODY'
# Title
...
BODY
```

## Exit codes

`0` ok · `1` problem (no such card, broken card, `check` found errors) · `2` usage · `3` conflict (the card changed; re-read it) · `4` refused by project policy (`.devtool/kanban.json`).

Every change also reports its `route`: `disk` (the file was written), `editor-saved` (the card was open in an editor; the change went in and was saved) or `editor-unsaved` (the card has unsaved edits in the user's editor; your change is in that editor and reaches the file when they save). `editor-unsaved` is expected and fine; don't retry.
