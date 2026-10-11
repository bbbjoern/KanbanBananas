---
id: "project-hub-all-boards-online-with-edits-as-reques-2026-10-09"
status: "backlog"
priority: "low"
assignee: null
epic: null
dueDate: null
created: "2026-10-09T10:15:59.715Z"
modified: "2026-10-10T16:44:01.195Z"
completedAt: null
labels: ["feature", "hub"]
order: "aD"
---
# Project hub: all boards online, with edits as requests

Idea: a project-management hub (separate project) that shows the KanbanBananas boards of every project in one place, including projects developed on remote servers over SSH. The goal is full two-way editing; the hub stays a view of the repos, which remain the truth.

## Approach
- **Read-only first.** The extension sends a board snapshot on start, then small change events (the intents it already uses: move, set fields, note, create). Over Remote SSH the extension runs on the server next to the files, so it sees every change; the server only needs outbound HTTPS to the hub. Queue events while offline.
- **The CLI sends updates too**, so agent writes without VS Code open reach the hub. A full snapshot on every extension start corrects anything missed (git pull, other editors).
- **Projects nobody has open:** optionally read committed cards from the git host (only what's pushed).
- **Edits from the hub as requests, not file sync.** Queue them per project; the extension applies them through its normal write path when online. Each request carries the version it was based on and is refused if the card changed since (like `--expect-mtime`), never merged blindly. The hub shows pending and refused requests. Already there: minimal patches, version checks, request ids against double-applying. New: the queue and its UI. Committing stays with the user.
- **Identity:** project = git remote + features folder; card = card id (stable when a card moves to done/).
- Show "last seen" per board; be honest about staleness.

## Open questions
- Privacy: per-project opt-in, a token per machine, maybe without bodies or images.
- Servers that can't reach the hub (firewalls): relay through the local VS Code?
- Where the hub keeps state, so it never holds data the repo doesn't have.

## Done when
To be defined when we pick this up; first milestone is the read-only hub fed by the extension and the CLI.

## Alternative: the server as the source of truth (idea, to compare later)

Instead of the repos, the task management app holds the cards; KanbanBananas connects to it and acts as a client in VS Code.

- **Easier:** no sync between repos and server; the server decides, every change is a request with a version check (applied or refused). Teams see one shared state at once. The hub needs nothing extra.
- **Given up:** working offline (over SSH the server must reach the app, or board and CLI stop); cards in git (history next to the code, per branch, in pull requests); plain files for agents (the CLI becomes an API client with a token on every server).
- **Shape:** a mode per project, "files" (today) or "server", with the same board, CLI and skill; a second storage backend behind the CardStore. A local read-only copy of the cards as markdown (outside git) so agents can still read and `@` them. Offline edits queued; refused ones shown, never merged silently.
- **Deciding question:** do the cards belong with the code (one developer, agents, git history) or with the team (several people, one shared state)? If both, offer both modes.
- **Effort:** real (API, login, backend, offline queue), but simpler and more reliable than two-way sync between repos and server.
