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
| `set <id> key=value...` | `priority`, `assignee`, `epic`, `dueDate` (YYYY-MM-DD), `labels`. `labels=a,b` sets, `labels=+a,-b` adds/removes, `key=` clears |
| `edit <id> --body - --expect-mtime <mtime>` | Replace the whole body (everything after the frontmatter); refused if the card changed since `show` |
| `check` | Integrity scan of the whole board; non-zero exit on problems |

`--body -` reads the text from stdin; use a heredoc for multi-line text. Every change prints the card's final path and new mtime.
Statuses: `backlog`, `todo`, `in-progress`, `review`, `done` (unless the project configures others).

## Recipes

**Start work on a card**

{{START_WORK}}

**Record completed work** (the main thing to do at the end of a task)

```sh
{{KANBAN}} note <id> --heading "Done — <short summary>" --body - <<'NOTE'
What changed, where, and anything the user should check.
NOTE
```

{{AFTER_NOTE}}

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

If the output says a change went into an open editor with unsaved edits, that's expected: the user's editor has it, and the file updates when they save.
