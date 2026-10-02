---
id: "publish-to-open-vsx-for-cursor-2026-10-02"
status: "backlog"
priority: "medium"
assignee: null
epic: "Publishing"
dueDate: null
created: "2026-10-02T10:41:34.433Z"
modified: "2026-10-02T10:41:34.479Z"
completedAt: null
labels: ["release"]
order: "a6"
---
# Publish to Open VSX (for Cursor)

The Marketplace only serves VS Code; Cursor and other forks install from Open VSX. Not published there yet.

## Steps (see PUBLISHING.md)
1. Eclipse account at open-vsx.org, sign the publisher agreement, create an access token.
2. `npx ovsx create-namespace Hypertxtorg -p <token>` (once).
3. `OVSX_PAT=<token> npm run publish:openvsx -w kanban-bananas` with the current `.vsix`.
4. Add the Open VSX link to both READMEs.

## Done when
The current version is installable from Cursor's extension view.
