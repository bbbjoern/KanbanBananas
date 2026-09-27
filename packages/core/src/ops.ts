import { generateKeyBetween } from 'fractional-indexing';
import type { Board, BoardCard } from './board.js';
import { cardFilename, DEFAULT_FILENAME_PATTERN, idForFilename } from './filenames.js';
import { compareCards } from './order.js';
import { noteSection } from './edit.js';
import type { FieldValue } from './patch.js';
import { DONE_DIR, DONE_STATUS } from './validate.js';

/**
 * Board intents (spec §2.1): what the user asked for, never a whole card.
 * `plan*` functions turn an intent plus the current board into field changes
 * and a target path. The extension (or CLI) then applies them to the file.
 */

/** Place the card directly before `beforeId`, or at the end of the column when null. */
export interface MoveIntent {
  id: string;
  toStatus: string;
  beforeId: string | null;
}

/** Fields a user may edit directly. `status`, `order` and timestamps are managed by moves. */
export const EDITABLE_FIELDS = ['priority', 'assignee', 'epic', 'dueDate', 'labels', 'lane'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface SetFieldsIntent {
  id: string;
  changes: Partial<Record<EditableField, FieldValue>>;
}

export interface CreateIntent {
  title: string;
  status: string;
  priority?: string;
  labels?: string[];
  /** Add at the top of the column instead of the bottom. */
  top?: boolean;
  /** Body text after the title. */
  body?: string;
  /** Filename pattern, e.g. `{slug}-{date}` (the default). */
  filenamePattern?: string;
}

/** Where archived cards live, next to `done/`. They're not on the board. */
export const ARCHIVE_DIR = 'archived';

export interface Plan {
  /** Current path of the card, relative to the features directory. */
  path: string;
  changes: Record<string, FieldValue>;
  /** Directory the card must end up in, when it has to move (into or out of `done/` or `archived/`). */
  toDir?: string;
  /** New filename (a rename to the filename pattern). The id follows it. */
  rename?: string;
  /** Text to add at the end of the body. */
  append?: string;
  /** Replacement for the whole body. */
  body?: string;
  /** Refuse unless the file's mtime is exactly this (the version the caller read). */
  expectMtimeMs?: number;
  /** An editor's body edited from `base`; merged with any change made since (see CardEdit.rebase). */
  rebase?: { base: string; mine: string };
}

export interface SaveBodyIntent {
  id: string;
  base: string;
  body: string;
}

export function planSaveBody(board: Board, intent: SaveBodyIntent, now: Date): Plan {
  const card = findCard(board, intent.id);
  return { path: card.path, changes: { modified: now.toISOString() }, rebase: { base: intent.base, mine: intent.body } };
}

export interface NoteIntent {
  id: string;
  heading: string;
  body?: string;
}

export interface EditBodyIntent {
  id: string;
  body: string;
  expectMtimeMs: number;
}

export class IntentError extends Error {
  override name = 'IntentError';
}

export function dirForStatus(status: string): string {
  return status === DONE_STATUS ? DONE_DIR : '';
}

export function findCard(board: Board, id: string): BoardCard {
  const card = board.cards.find((c) => c.card.fields.id === id);
  if (!card) {
    const broken = board.broken.find((b) => b.card?.fields.id === id || idForFilename(b.filename) === id);
    throw new IntentError(broken ? `Card "${id}" is broken and can't be changed: ${broken.path}` : `No card with id "${id}".`);
  }
  return card;
}

export function planMove(board: Board, intent: MoveIntent, now: Date): Plan {
  const moving = findCard(board, intent.id);
  const from = moving.card.fields.status!;
  const column = columnCards(board, intent.toStatus).filter((c) => c !== moving);

  let index = column.length;
  if (intent.beforeId !== null) {
    index = column.findIndex((c) => c.card.fields.id === intent.beforeId);
    if (index === -1) throw new IntentError(`No card "${intent.beforeId}" in column "${intent.toStatus}".`);
  }

  const changes: Record<string, FieldValue> = {};
  if (from !== intent.toStatus) changes.status = intent.toStatus;
  changes.order = keyAt(column, index);
  const stamp = now.toISOString();
  changes.modified = stamp;
  if (intent.toStatus === DONE_STATUS && from !== DONE_STATUS) changes.completedAt = stamp;
  if (intent.toStatus !== DONE_STATUS && from === DONE_STATUS) changes.completedAt = null;

  const toDir = dirForStatus(intent.toStatus);
  return { path: moving.path, changes, ...(toDir !== moving.dir ? { toDir } : {}) };
}

export function planSetFields(board: Board, intent: SetFieldsIntent, now: Date): Plan {
  const card = findCard(board, intent.id);
  const changes: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(intent.changes)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) throw new IntentError(`Field "${key}" can't be set directly.`);
    if (value === undefined) continue;
    if (key === 'labels' ? !isStringList(value) : !(value === null || typeof value === 'string')) {
      throw new IntentError(`Invalid value for "${key}".`);
    }
    changes[key] = key === 'labels' ? dedupe(value as string[]) : value;
  }
  changes.modified = now.toISOString();
  return { path: card.path, changes };
}

/** Move a card into `archived/`. Its status and everything else stay as they are. */
export function planArchive(board: Board, id: string, now: Date): Plan {
  const card = findCard(board, id);
  return { path: card.path, changes: { modified: now.toISOString() }, toDir: ARCHIVE_DIR };
}

/** Bring an archived card back to the folder its status belongs in. `archive` is a board of the archived cards. */
export function planRestore(archive: Board, id: string, now: Date): Plan {
  const card = findCard(archive, id);
  return { path: card.path, changes: { modified: now.toISOString() }, toDir: dirForStatus(card.card.fields.status ?? '') };
}

export interface PatternRename {
  id: string;
  path: string;
  /** Filename the pattern asks for (before any suffix for a clash). */
  filename: string;
}

/**
 * Cards whose filename doesn't match the pattern, and what it should be. The
 * slug comes from the title, the date from `created` (else the date in the
 * current filename, else today). Renaming changes the card's id.
 */
export function planRenameToPattern(board: Board, pattern: string, now: Date): PatternRename[] {
  const out: PatternRename[] = [];
  for (const c of board.cards) {
    const created = c.card.fields.created ? new Date(c.card.fields.created) : null;
    const fromName = /(\d{4}-\d{2}-\d{2})/.exec(c.filename)?.[1];
    const date = created && !Number.isNaN(created.getTime()) ? created : fromName ? new Date(`${fromName}T12:00:00Z`) : now;
    const filename = cardFilename(c.card.title ?? idForFilename(c.filename), date, pattern);
    // A `-2`, `-3`… suffix from a name clash still counts as matching.
    const stem = filename.replace(/\.md$/, '');
    const matches = c.filename === filename || new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.md$`).test(c.filename);
    if (!matches) out.push({ id: c.card.fields.id!, path: c.path, filename });
  }
  return out;
}

export function planRename(board: Board, id: string, filename: string, now: Date): Plan {
  const card = findCard(board, id);
  return { path: card.path, changes: { modified: now.toISOString() }, rename: filename };
}

export function planNote(board: Board, intent: NoteIntent, now: Date): Plan {
  const card = findCard(board, intent.id);
  return { path: card.path, changes: { modified: now.toISOString() }, append: noteSection(intent.heading, intent.body) };
}

export function planEditBody(board: Board, intent: EditBodyIntent, now: Date): Plan {
  const card = findCard(board, intent.id);
  return {
    path: card.path,
    changes: { modified: now.toISOString() },
    body: intent.body,
    expectMtimeMs: intent.expectMtimeMs,
  };
}

/** The id of the card right after `afterId` in its column, for "move after" (null: it's last). */
export function idAfter(board: Board, status: string, afterId: string): string | null {
  const column = columnCards(board, status);
  const i = column.findIndex((c) => c.card.fields.id === afterId);
  if (i === -1) throw new IntentError(`No card "${afterId}" in column "${status}".`);
  return column[i + 1]?.card.fields.id ?? null;
}

export interface NewCard {
  /** Path relative to the features directory. */
  path: string;
  id: string;
  text: string;
}

/**
 * A new card in the format the old board wrote (every known key in a fixed
 * order, double-quoted strings, then `# Title`), always ending with a newline
 * whoever creates it: the board, a command or the CLI.
 * `taken` holds every existing path; the filename gets a `-2`, `-3`… suffix
 * rather than reuse an id.
 */
export function planCreate(board: Board, intent: CreateIntent, now: Date, taken: ReadonlySet<string>): NewCard {
  const title = intent.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new IntentError('A card needs a title.');

  const dir = dirForStatus(intent.status);
  const ids = new Set([...taken].map((p) => idForFilename(p.slice(p.lastIndexOf('/') + 1))));
  const base = idForFilename(cardFilename(title, now, intent.filenamePattern ?? DEFAULT_FILENAME_PATTERN));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;

  const column = columnCards(board, intent.status);
  const order = intent.top ? keyAt(column, 0) : keyAt(column, column.length);
  const stamp = now.toISOString();
  const q = (v: string) => JSON.stringify(v);
  const labels = dedupe(intent.labels ?? []);
  const text = [
    '---',
    `id: ${q(id)}`,
    `status: ${q(intent.status)}`,
    `priority: ${q(intent.priority ?? 'medium')}`,
    'assignee: null',
    'epic: null',
    'dueDate: null',
    `created: ${q(stamp)}`,
    `modified: ${q(stamp)}`,
    `completedAt: ${intent.status === DONE_STATUS ? q(stamp) : 'null'}`,
    `labels: [${labels.map(q).join(', ')}]`,
    `order: ${q(order)}`,
    '---',
    `# ${title}`,
  ].join('\n');
  const body = intent.body?.replace(/\s+$/, '');
  const full = body ? `${text}\n\n${body}\n` : `${text}\n`;

  return { path: dir ? `${dir}/${id}.md` : `${id}.md`, id, text: full };
}

/** Cards in a column, in board order. */
function columnCards(board: Board, status: string): BoardCard[] {
  return board.cards.filter((c) => c.card.fields.status === status).sort((a, b) => compareCards(a.card.fields, b.card.fields));
}

/**
 * An order key that sorts at position `index` of `column` (which excludes the
 * card being placed). Only the placed card gets a new key; neighbours are never
 * rewritten. Two limits, both from existing data:
 * - Neighbours that share a key (duplicates exist) leave no room between them,
 *   so the card goes after the last of the duplicates.
 * - Keys that aren't valid fractional-index keys (e.g. a numeric `0`) are
 *   skipped as bounds.
 */
export function keyAt(column: readonly BoardCard[], index: number): string {
  const keys = column.map((c) => c.card.fields.order);
  let lower: string | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const k = keys[i];
    if (k != null && isValidKey(k)) {
      lower = k;
      break;
    }
  }
  let upper: string | null = null;
  for (let i = index; i < keys.length; i++) {
    const k = keys[i];
    if (k != null && isValidKey(k) && (lower === null || k > lower)) {
      upper = k;
      break;
    }
  }
  return generateKeyBetween(lower, upper);
}

function isValidKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function dedupe(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
}
