/**
 * Session memory: one markdown file, outside the card folders, holding the
 * latest snapshot(s) of where work stands, so a new session (or another agent)
 * can pick up without the old conversation. Newest entry first; entries beyond
 * the configured limit (1–10) are dropped. Card details stay on the cards.
 */

export const DEFAULT_MEMORY_FILE = '.devtool/session-memory.md';
export const MAX_MEMORY_ENTRIES = 10;

const HEADER = `# Session memory

<!-- Maintained by KanbanBananas: the latest state of the work, newest first; older entries are dropped.
     Agents add entries with \`kanban memory --body -\`; card details belong on the cards. -->
`;

export interface MemoryEntry {
  /** ISO timestamp from the entry heading. */
  at: string;
  /** Markdown under the heading, trimmed. */
  body: string;
}

/** Entries in file order (newest first). Anything before the first entry heading is the header. */
export function parseMemory(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  // Headings: "## 2026-09-30 10:00 UTC" (written now) or an ISO timestamp (1.1 previews).
  const re = /^## (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::[\d.]+)?(?: UTC|Z)?[^\n]*\n/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : text.length;
    entries.push({ at: `${m[1]}T${m[2]}:00.000Z`, body: text.slice(start, end).trim() });
  });
  return entries;
}

/** "2026-09-30 10:00 UTC", the entry heading. */
function heading(at: string): string {
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** The file with `body` added as the newest entry, keeping at most `keep` entries. */
export function addMemoryEntry(text: string, body: string, now: Date, keep: number): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('A session memory entry needs some text.');
  const limit = Math.min(Math.max(Math.floor(keep) || 1, 1), MAX_MEMORY_ENTRIES);
  const entries = [{ at: now.toISOString(), body: trimmed }, ...parseMemory(text)].slice(0, limit);
  return HEADER + entries.map((e) => `\n## ${heading(e.at)}\n\n${e.body}\n`).join('');
}

/** The text after "Next:" in an entry (first line of it), for the board's summary. */
export function memoryNext(entry: MemoryEntry | undefined): string | null {
  const m = entry && /\*{0,2}Next:?\*{0,2}:?\s*(.+)/i.exec(entry.body);
  return m ? m[1]!.replace(/\*\*/g, '').trim() : null;
}
