---
id: "column-info-describe-what-a-column-is-for-2026-10-02"
status: "backlog"
priority: "medium"
assignee: null
epic: "Features"
dueDate: null
created: "2026-10-02T10:41:33.883Z"
modified: "2026-10-02T10:41:33.936Z"
completedAt: null
labels: ["feature", "columns"]
order: "a0"
---
# Column info: describe what a column is for

Some columns' purpose isn't obvious. Let users leave a short note per column.

## Idea
- Stored as an optional `description` on the column in `kanbanBananas.columns` (no card files involved).
- Edit via right-click → *Edit Column Info…* (input box, like renaming).
- Shown as a small ⓘ after the column name, only when set, with the text on hover; as a grey line under the name in the vertical layout.
- The agent skill lists the descriptions next to the statuses, so agents know which column a card belongs in.

## Done when
Description can be set, edited and cleared from the board; shows on hover; appears in SKILL.md; tests cover the setting round trip.
