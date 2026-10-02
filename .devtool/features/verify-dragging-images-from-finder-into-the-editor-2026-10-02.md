---
id: "verify-dragging-images-from-finder-into-the-editor-2026-10-02"
status: "backlog"
priority: "low"
assignee: null
epic: "Quality"
dueDate: null
created: "2026-10-02T10:41:34.818Z"
modified: "2026-10-02T10:41:34.868Z"
completedAt: null
labels: ["testing", "images"]
order: "aA"
---
# Verify dragging images from Finder into the editor

Pasting screenshots is confirmed (local and over Remote SSH). Dropping image files from Finder onto the board's editor is implemented but untested: VS Code may intercept drops into webviews (holding Shift sometimes lets them through).

## Check
- Drop a PNG from Finder onto a card's text in the split view, with and without Shift.
- Drop into a card opened in VS Code's own editor.
- The KanbanBananas log shows a "drop: …" line per attempt.

## Done when
It works, or the README says how (Shift) or that only paste is supported.
