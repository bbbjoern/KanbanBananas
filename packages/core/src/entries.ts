import type { Board } from './board.js';
import { findCard, IntentError, type Plan } from './ops.js';

/**
 * Entries of a log card (`type: log`): top-level list items, usually tasks,
 * each one unit with its description and screenshots indented under it:
 *
 *   - [ ] **Title cut off in Inspector**: long titles truncate
 *     ![](/.devtool/assets/<card>/shot.webp)
 *
 * Plain markdown; these helpers only count, add and tick them.
 */

export interface EntryCounts {
  open: number;
  done: number;
}

const TASK = /^[-*+] \[([ xX])\] /;
const ITEM = /^[-*+] /;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Top-level lines of the body outside code fences, with their index. */
function topLevel(lines: string[]): { line: string; i: number }[] {
  const out: { line: string; i: number }[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (m) {
      const marker = m[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence === null) out.push({ line, i });
  });
  return out;
}

/** Open and done task entries (top-level `- [ ]` / `- [x]` items). */
export function countEntries(body: string): EntryCounts {
  const counts = { open: 0, done: 0 };
  for (const { line } of topLevel(body.split(/\r?\n/))) {
    const m = TASK.exec(line);
    if (m) m[1] === ' ' ? counts.open++ : counts.done++;
  }
  return counts;
}

/** An entry: `- [ ] **title**: text`, further lines of the text indented under it. */
export function entryMarkdown(entry: { title?: string; text?: string; done?: boolean }): string {
  const title = entry.title?.replace(/\s+/g, ' ').trim();
  const lines = (entry.text ?? '').replace(/\s+$/, '').split('\n');
  const first = lines[0]!.trim();
  if (!title && !first) throw new IntentError('An entry needs a title or text.');
  const head = title ? `**${title}**${first ? `: ${first}` : ''}` : first;
  const rest = lines.slice(1).map((l) => (l.trim() ? `  ${l}` : ''));
  return [`- [${entry.done ? 'x' : ' '}] ${head}`, ...rest].join('\n').replace(/\n+$/, '');
}

/**
 * Add an entry at the end of the body: right under the last entry when the
 * body ends with the list, else after a blank line.
 */
export function addEntry(body: string, entry: string): string {
  const trimmed = body.replace(/\s+$/, '');
  if (!trimmed) return entry + '\n';
  const lines = trimmed.split('\n');
  // The last top-level line: is it a list item, or a line inside one (indented)?
  let k = lines.length - 1;
  while (k > 0 && /^\s+\S/.test(lines[k]!)) k--;
  const inList = ITEM.test(lines[k]!);
  return trimmed + (inList ? '\n' : '\n\n') + entry + '\n';
}

/** Tick the one open entry whose text contains `match` (any capitals). */
export function tickEntry(body: string, match: string): string {
  const lines = body.split('\n');
  const needle = match.trim().toLowerCase();
  if (!needle) throw new IntentError('Say which entry: --done "<words from it>".');
  const items = topLevel(lines).filter(({ line }) => TASK.test(line));
  const textOf = (i: number) => {
    const parts = [lines[i]!];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]!); j++) parts.push(lines[j]!);
    return parts.join('\n').toLowerCase().replace(/\*\*/g, '');
  };
  const open = items.filter(({ line }) => / \[ \] /.test(line.slice(0, 6)));
  const hits = open.filter(({ i }) => textOf(i).includes(needle));
  if (hits.length === 0) {
    const done = items.some(({ i, line }) => !/ \[ \] /.test(line.slice(0, 6)) && textOf(i).includes(needle));
    throw new IntentError(done ? `The entry matching "${match}" is already done.` : `No open entry matches "${match}".`);
  }
  if (hits.length > 1) {
    const shown = hits.map(({ line }) => `  ${line.slice(0, 80)}`).join('\n');
    throw new IntentError(`${hits.length} open entries match "${match}"; use more of the words:\n${shown}`);
  }
  const i = hits[0]!.i;
  lines[i] = lines[i]!.replace('[ ]', '[x]');
  return lines.join('\n');
}

export interface LogIntent {
  id: string;
  /** Add an entry: its title and/or text. */
  title?: string;
  text?: string;
  /** Instead, tick the open entry containing these words. */
  done?: string;
}

/** `kanban log`: add an entry to a card, or tick one; worked out on the body as it is when written. */
export function planLog(board: Board, intent: LogIntent, now: Date): Plan {
  const card = findCard(board, intent.id);
  const entry =
    intent.done === undefined
      ? entryMarkdown({ ...(intent.title !== undefined ? { title: intent.title } : {}), ...(intent.text !== undefined ? { text: intent.text } : {}) })
      : null; // refuse an empty entry before anything is written
  return {
    path: card.path,
    changes: { modified: now.toISOString() },
    bodyEdit: (body) => (entry === null ? tickEntry(body, intent.done!) : addEntry(body, entry)),
  };
}
