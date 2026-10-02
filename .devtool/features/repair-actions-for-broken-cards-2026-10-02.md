---
id: "repair-actions-for-broken-cards-2026-10-02"
status: "backlog"
priority: "medium"
assignee: null
epic: "Repair"
dueDate: null
created: "2026-10-02T10:41:33.982Z"
modified: "2026-10-02T10:41:34.030Z"
completedAt: null
labels: ["feature", "safety"]
order: "a1"
---
# Repair actions for broken cards

Broken cards land in the read-only Broken column, but fixing them is manual. Spec §6.

## Idea
Right-click a broken card for the fix its problem calls for:
- id ≠ filename → *Fix the id to match the filename* (patch the one line).
- Missing frontmatter / 0-byte file → *Restore from git* (see the restore card) or *Open file*.
- Duplicate id → show both files, offer to rename one (id follows the filename).
Every repair goes through the CardStore and is re-validated; nothing is guessed.

## Done when
Each problem type in `kanban check` has a repair or a clear manual step; integration tests per repair.
