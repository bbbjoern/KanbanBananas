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
  /** ISO timestamp from the entry heading (or the file's mtime, for hand-written text). */
  at: string;
  /** Markdown under the heading, trimmed. */
  body: string;
  /** Text someone wrote outside the dated entries (no heading of ours). */
  handWritten?: boolean;
}

/**
 * Entries in file order (newest first). Text before the first dated heading,
 * other than the file's title and HTML comments, is hand-written content: it
 * becomes an entry of its own, dated `undatedAt` (pass the file's mtime), so
 * it's shown and never silently dropped.
 */
export function parseMemory(text: string, undatedAt?: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  // Headings: "## 2026-09-30 10:00 UTC" (written now) or an ISO timestamp (1.1 previews).
  const re = /^## (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::[\d.]+)?(?: UTC|Z)?[^\n]*\n/gm;
  const heads = [...text.matchAll(re)];
  const preamble = text
    .slice(0, heads[0]?.index ?? text.length)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*# [^\n]*\n?/, '')
    .trim();
  if (preamble) {
    const at = undatedAt && !Number.isNaN(Date.parse(undatedAt)) ? new Date(undatedAt).toISOString() : new Date(0).toISOString();
    entries.push({ at, body: preamble, handWritten: true });
  }
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

export interface MemoryUpdate {
  text: string;
  /** Entries dropped to stay within `keep` (oldest last). */
  dropped: MemoryEntry[];
}

/**
 * Add `body` as the newest entry, keeping at most `keep` entries; reports what
 * was dropped. Hand-written text (see parseMemory) is kept as a dated entry.
 */
export function updateMemory(text: string, body: string, now: Date, keep: number, undatedAt?: string): MemoryUpdate {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('A session memory entry needs some text.');
  const limit = Math.min(Math.max(Math.floor(keep) || 1, 1), MAX_MEMORY_ENTRIES);
  const all = [{ at: now.toISOString(), body: trimmed }, ...parseMemory(text, undatedAt)];
  const kept = all.slice(0, limit);
  return {
    text: HEADER + kept.map((e) => `\n## ${heading(e.at)}\n\n${e.body}\n`).join(''),
    dropped: all.slice(limit),
  };
}

/** The file with `body` added as the newest entry, keeping at most `keep` entries. */
export function addMemoryEntry(text: string, body: string, now: Date, keep: number, undatedAt?: string): string {
  return updateMemory(text, body, now, keep, undatedAt).text;
}

/** A note for the writer about entries dropped to stay within `keep`, or undefined if none were. */
export function droppedNote(dropped: MemoryEntry[]): string | undefined {
  if (dropped.length === 0) return undefined;
  const hand = dropped.filter((e) => e.handWritten).length;
  const what = `${dropped.length} older entr${dropped.length === 1 ? 'y' : 'ies'}`;
  return hand
    ? `replaced ${what}, including text written by hand outside the dated entries. If it mattered, it should be in the new entry (or raise the "keep" setting).`
    : `replaced ${what} (newest entries kept, per the "keep" setting).`;
}

/** A card's text as a memory entry: "From card <id>:" and its body without the frontmatter. */
export function memoryFromCard(id: string, body: string): string {
  return `From card \`${id}\`:\n\n${body.trim()}`;
}

/** The text after "Next:" in an entry (first line of it), for the board's summary. */
export function memoryNext(entry: MemoryEntry | undefined): string | null {
  const m = entry && /\*{0,2}Next:?\*{0,2}:?\s*(.+)/i.exec(entry.body);
  return m ? m[1]!.replace(/\*\*/g, '').trim() : null;
}
