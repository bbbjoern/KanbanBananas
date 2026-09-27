import type { Board } from './board.js';
import type { CardFields } from './parse.js';

/** Serializable board for the webview and `--json` output. No YAML document, no raw source. */
export interface BoardView {
  cards: CardView[];
  broken: BrokenView[];
}

export interface CardView {
  path: string;
  dir: string;
  filename: string;
  title: string | null;
  /** First paragraph of the body after the title, flattened to plain text. */
  excerpt: string | null;
  fields: CardFields;
  warnings: string[];
}

export interface BrokenView {
  path: string;
  filename: string;
  title: string | null;
  problems: string[];
}

export interface ColumnConfig {
  id: string;
  name: string;
  color: string;
}

export const DEFAULT_COLUMNS: readonly ColumnConfig[] = [
  { id: 'backlog', name: 'Backlog', color: '#6b7280' },
  { id: 'todo', name: 'To Do', color: '#3b82f6' },
  { id: 'in-progress', name: 'In Progress', color: '#f59e0b' },
  { id: 'review', name: 'Review', color: '#8b5cf6' },
  { id: 'done', name: 'Done', color: '#22c55e' },
];

export interface ViewSettings {
  columns: ColumnConfig[];
  compactMode: boolean;
  /** New cards go to the top of their column instead of the bottom. */
  addNewCardsToTop: boolean;
  show: {
    priority: boolean;
    assignee: boolean;
    dueDate: boolean;
    labels: boolean;
    epic: boolean;
    filename: boolean;
  };
}

/** Messages from the extension host to the board webview. */
export type HostMessage =
  | { type: 'state'; board: BoardView; settings: ViewSettings }
  | { type: 'error'; message: string }
  /** The inline editor's card: its body when opened, and again whenever someone else changes it. */
  | { type: 'editorBody'; id: string; path: string; body: string }
  /** A save from the inline editor was written; `body` is what the card holds now. */
  | { type: 'bodySaved'; id: string; body: string }
  /** A save overlapped someone else's change to the same lines; nothing was written. */
  | { type: 'bodyConflict'; id: string; theirs: string }
  | { type: 'bodyError'; id: string; message: string }
  /** Open this card in the split view (from "Show on Board"). */
  | { type: 'selectCard'; id: string }
  /** The card went away (deleted, broken, renamed): close the editor. */
  | { type: 'editorClosed'; id: string; reason: string };

/** Messages from the board webview to the extension host: intents, never whole cards (spec §2.1). */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openCard'; path: string }
  | { type: 'move'; id: string; toStatus: string; beforeId: string | null }
  | { type: 'create'; title: string; status: string }
  | { type: 'setFields'; id: string; changes: Partial<Record<'priority' | 'assignee' | 'epic' | 'dueDate' | 'labels', string | string[] | null>> }
  | { type: 'openEditor'; id: string }
  | { type: 'closeEditor' }
  /** Body edited from `base` in the inline editor (\n line endings). */
  | { type: 'saveBody'; id: string; base: string; body: string }
  /** Show the editor's text next to the card file. */
  | { type: 'showDiff'; id: string; mine: string }
  /** Something in the webview threw; the host logs it. */
  | { type: 'clientError'; message: string; stack?: string }
  /** The split view rendered this card (for tests). */
  | { type: 'editorShown'; id: string };

const EXCERPT_LENGTH = 160;

export function toBoardView(board: Board): BoardView {
  return {
    cards: board.cards.map((c) => ({
      path: c.path,
      dir: c.dir,
      filename: c.filename,
      title: c.card.title,
      excerpt: excerpt(c.card.source.body),
      fields: c.card.fields,
      warnings: c.issues.map((i) => i.message),
    })),
    broken: board.broken.map((b) => ({
      path: b.path,
      filename: b.filename,
      title: b.card?.title ?? null,
      problems: b.parseError ? [b.parseError.message] : b.issues.filter((i) => i.severity === 'error').map((i) => i.message),
    })),
  };
}

function excerpt(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^# /.test(l)) + 1;
  const para: string[] = [];
  let inFence = false;
  for (const line of lines.slice(start)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (para.length) break;
      continue;
    }
    if (inFence) continue;
    const text = line.trim();
    if (text === '' || /^#{1,6} /.test(text) || /^(-{3,}|\*{3,})$/.test(text)) {
      if (para.length) break;
      continue;
    }
    para.push(text.replace(/^(>\s*)+/, '').replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, ''));
  }
  if (para.length === 0) return null;
  const plain = para
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > EXCERPT_LENGTH ? plain.slice(0, EXCERPT_LENGTH - 1).trimEnd() + '…' : plain;
}
