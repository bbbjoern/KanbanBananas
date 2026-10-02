---
id: "restore-card-from-git-2026-10-02"
status: "backlog"
priority: "medium"
assignee: null
epic: "Repair"
dueDate: null
created: "2026-10-02T10:41:34.076Z"
modified: "2026-10-02T10:41:34.122Z"
completedAt: null
labels: ["feature", "safety", "git"]
order: "a2"
---
# Restore card from git

Bring back a card's last committed version (`HEAD`), e.g. when it's empty or was overwritten, as happened with the old extension. Spec §6.

## Idea
- Right-click (card or Broken column) → *Restore from Git…*: shows a diff of the current file against `HEAD`, then restores after confirmation.
- Unsaved editor edits block it (or are offered to the diff).
- Also available for archived cards and as `kanban` command? (decide).

## Done when
Restoring works for active, done and broken cards; refuses when not in git or no committed version; tested with a real repo in the integration suite.
