---
id: "not-in-git-marker-on-untracked-cards-2026-10-02"
status: "backlog"
priority: "low"
assignee: null
epic: "Repair"
dueDate: null
created: "2026-10-02T10:41:34.164Z"
modified: "2026-10-02T10:41:34.210Z"
completedAt: null
labels: ["feature", "git"]
order: "a3"
---
# "Not in git" marker on untracked cards

Git is the only real backup for cards. Mark cards git doesn't track yet, so they get committed. Spec §6.

## Idea
- Ask git once per board load / file change (`git ls-files` for the features folder), not per card.
- Small marker on the card (e.g. a dot or "new" chip with tooltip "Not committed yet"); maybe a toolbar count.
- Off when the project isn't a git repo.

## Done when
Marker appears for new cards and disappears after commit; no noticeable slowdown on a 100+ card board.
