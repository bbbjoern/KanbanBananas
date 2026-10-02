---
id: "marketplace-try-keywords-and-product-names-again-2026-10-02"
status: "backlog"
priority: "low"
assignee: null
epic: "Publishing"
dueDate: null
created: "2026-10-02T10:41:34.524Z"
modified: "2026-10-02T10:41:34.583Z"
completedAt: null
labels: ["release", "marketplace"]
order: "a7"
---
# Marketplace: try keywords and product names again

To get past the Marketplace's "suspicious content" filter, 1.0.0 shipped without `keywords` and without other products' names in the README/description (Claude Code, Cursor, Kanban Markdown).

Found by bisecting uploads: the keyword list (kanban, markdown, board, task, project management, cards) alone triggered it. Product names were never tested on their own.

## Idea
In later releases, add one change at a time and see whether the upload passes:
- single keywords (start with `kanban`, `markdown`),
- product names in the README (helps discovery: "works with Claude Code").
Record findings in PUBLISHING.md.

## Done when
We know which keyword(s) the filter objects to, and the listing has as much as it accepts.
