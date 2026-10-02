---
id: "automated-tests-for-the-board-page-2026-10-02"
status: "backlog"
priority: "medium"
assignee: null
epic: "Quality"
dueDate: null
created: "2026-10-02T10:41:34.721Z"
modified: "2026-10-02T10:41:34.772Z"
completedAt: null
labels: ["testing", "tech-debt"]
order: "a9"
---
# Automated tests for the board page

Clicking, dragging, right-click menus and pasting in the board page have only been checked by hand or with one-off scripts. Regressions like the black screen (1.0 preview) or the lane controls slipped through.

## Idea
- Browser tests (puppeteer-core with the system Chrome, or Playwright) against the Vite dev server with demo cards (`scripts/demo-board.mjs`) and the fake host in `dev.ts`.
- Cover: open card in split view, drag a card, add/rename/reorder/delete a column, swimlane drag, paste an image, session memory widget, welcome screen.
- Run in CI and in `npm test`.

## Done when
A failing interaction in the board page fails the test run.
