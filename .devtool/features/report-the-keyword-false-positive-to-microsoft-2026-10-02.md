---
id: "report-the-keyword-false-positive-to-microsoft-2026-10-02"
status: "backlog"
priority: "low"
assignee: null
epic: "Publishing"
dueDate: null
created: "2026-10-02T10:41:34.627Z"
modified: "2026-10-02T10:41:34.676Z"
completedAt: null
labels: ["marketplace"]
order: "a8"
---
# Report the keyword false positive to Microsoft

Help the next publisher: the Marketplace rejected our uploads as "suspicious content" because of the package.json `keywords` (kanban, markdown, board, task, project management, cards), with no hint which part.

## Plan
- Issue at github.com/microsoft/vsmarketplace: publisher Hypertxtorg, extension kanban-bananas, the bisect (empty code still failed; no keywords passed; keywords alone failed), and a request for clearer error messages.
- Optionally also email vsmarketplace@microsoft.com.
