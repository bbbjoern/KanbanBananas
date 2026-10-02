---
id: "session-memory-load-it-automatically-at-session-st-2026-10-02"
status: "backlog"
priority: "medium"
assignee: null
epic: "Session memory"
dueDate: null
created: "2026-10-02T10:41:34.344Z"
modified: "2026-10-02T10:41:34.388Z"
completedAt: null
labels: ["feature", "agents", "session-memory"]
order: "a5"
---
# Session memory: load it automatically at session start

Today agents read the session memory because the skill tells them to (`kanban memory` first thing). A Claude Code session-start hook could hand it to them without relying on that.

## Idea
- Optional setting under Session memory: *Load at session start (Claude Code hook)*.
- Installs a SessionStart hook in the project's Claude Code settings that runs `<skill>/scripts/kanban memory` and passes the output as context. Removed again when switched off.
- Check first how SessionStart hooks inject context (stdout vs JSON) and how project vs user settings merge.

## Done when
A new Claude Code session in the project starts with the latest memory in context, without the agent running anything; switching the setting off removes the hook cleanly.
