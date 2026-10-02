---
id: "same-project-open-in-two-vs-code-windows-2026-10-02"
status: "backlog"
priority: "high"
assignee: null
epic: "Quality"
dueDate: null
created: "2026-10-02T10:41:34.916Z"
modified: "2026-10-02T10:41:34.965Z"
completedAt: null
labels: ["safety", "investigate"]
order: "aB"
---
# Same project open in two VS Code windows

Two windows on the same folder run two copies of the extension: two write queues on the same cards, and the CLI socket record points at whichever started last. That's close to the two-writer problem this project exists to prevent.

## Questions
- Do writes from both windows stay correct? (Each write re-reads and checks mtime, so probably yes, but untested.)
- Should the second window detect the first (socket record with a live pid) and go read-only, or forward its writes to the first?

## Done when
Tested with two windows writing to the same card at the same time, and the chosen behaviour documented.
