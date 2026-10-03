---
id: "flaky-integration-tests-that-type-into-an-editor-2026-10-03"
status: "backlog"
priority: "medium"
assignee: null
epic: "Quality"
dueDate: null
created: "2026-10-03T16:40:17.295Z"
modified: "2026-10-03T16:40:17.341Z"
completedAt: null
labels: ["testing", "tech-debt"]
order: "aC"
---
# Flaky integration tests that type into an editor

Three integration tests fail together now and then, and pass on rerun (seen 2026-09-27 and 2026-10-03):

- open card with unsaved edits: move patches the buffer, keeps the edits and undo, disk untouched
- native editor: cursor stays put while the board, an agent and a save change the card
- native editor: the CodeLens header is one fixed row of card fields (fails because the cursor test stopped early)

All of them type with the `type` command or check `undo`, which act on the focused editor. Likely cause: the test VS Code window doesn't have keyboard focus at that moment (e.g. another window took focus during the run).

## Ideas
- Before typing, `workbench.action.focusActiveEditorGroup` and wait until `window.activeTextEditor` is the card's editor.
- Insert text with `editor.edit` instead of the `type` command where the test isn't about keystrokes.
- Retry once with a note in the output rather than fail silently.

## Done when
Ten runs in a row pass.
