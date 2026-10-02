---
id: "validate-board-command-problems-panel-2026-10-02"
status: "backlog"
priority: "low"
assignee: null
epic: "Repair"
dueDate: null
created: "2026-10-02T10:41:34.254Z"
modified: "2026-10-02T10:41:34.299Z"
completedAt: null
labels: ["feature"]
order: "a4"
---
# Validate Board command (Problems panel)

`kanban check` and the Broken column cover validation today. A VS Code command could show the same results in the Problems panel, with links to the files. Spec §6.

## Idea
- *KanbanBananas: Validate Board* → diagnostics (errors and warnings) per card file, cleared when fixed.
- Optionally keep diagnostics live while the board is open.

## Done when
Every `kanban check` issue shows up as a diagnostic on the right file and line where possible.
