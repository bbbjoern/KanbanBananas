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

/** Fields the board can be grouped into lanes by. `lane` is a free-text field of its own. */
export const GROUP_FIELDS = ['epic', 'assignee', 'priority', 'lane'] as const;
export type GroupField = (typeof GROUP_FIELDS)[number];

/**
 * A lane from settings: shown even when empty, in list order, optionally
 * coloured. An entry with `none: true` (and an empty name) marks where the
 * lane for cards without a value goes; without one, that lane is last.
 */
export interface LaneDef {
  name: string;
  color?: string;
  none?: boolean;
}

export interface ViewSettings {
  columns: ColumnConfig[];
  compactMode: boolean;
  /** New cards go to the top of their column instead of the bottom. */
  addNewCardsToTop: boolean;
  /** Colours for epic lanes and chips, by epic name. Epics not listed get a colour from a fixed palette. */
  epicColors: Record<string, string>;
  /** Configured lanes per grouping (order, colours, empty lanes). */
  lanes: Record<GroupField, LaneDef[]>;
  /** Board panel: columns side by side, or stacked. */
  layout: 'horizontal' | 'vertical';
  hideScrollbars: boolean;
  /** Column for new cards from the N shortcut. */
  defaultStatus: string;
  /** How pasted images are stored: format (lossless WebP or PNG) and optional maximum width (0 = keep). */
  images: { format: 'webp' | 'png'; maxWidth: number };
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
  /** `assetBase` is the project root as the page can load it, for showing `/…` image links. */
  | { type: 'state'; board: BoardView; settings: ViewSettings; assetBase?: string }
  | { type: 'error'; message: string }
  /** No board yet: offer to create one (`folderOpen`: a workspace folder is open to create it in). */
  | { type: 'noBoard'; featuresDirectory: string; folderOpen: boolean }
  /** The inline editor's card: its body when opened, and again whenever someone else changes it. */
  | { type: 'editorBody'; id: string; path: string; body: string }
  /** A pasted image was saved; `link` is what the card should reference. */
  | { type: 'imageSaved'; requestId: string; link: string }
  | { type: 'imageError'; requestId: string; message: string }
  /** A save from the inline editor was written; `body` is what the card holds now. */
  | { type: 'bodySaved'; id: string; body: string }
  /** A save overlapped someone else's change to the same lines; nothing was written. */
  | { type: 'bodyConflict'; id: string; theirs: string }
  | { type: 'bodyError'; id: string; message: string }
  /** Card ids matching a search, in board order. */
  | { type: 'searchResults'; query: string; ids: string[] }
  /** Open this card in the split view (from "Show on Board"). */
  | { type: 'selectCard'; id: string }
  /** The card went away (deleted, broken, renamed): close the editor. */
  | { type: 'editorClosed'; id: string; reason: string };

/** Messages from the board webview to the extension host: intents, never whole cards (spec §2.1). */
export type WebviewMessage =
  /** The page loaded; `build` identifies its bundle (extension version + build time). */
  | { type: 'ready'; build?: string }
  | { type: 'openCard'; path: string }
  | { type: 'move'; id: string; toStatus: string; beforeId: string | null }
  | { type: 'create'; title: string; status: string }
  | { type: 'setFields'; id: string; changes: Partial<Record<'priority' | 'assignee' | 'epic' | 'dueDate' | 'labels' | 'lane', string | string[] | null>> }
  | { type: 'openEditor'; id: string }
  | { type: 'closeEditor' }
  /** Body edited from `base` in the inline editor (\n line endings). */
  | { type: 'saveBody'; id: string; base: string; body: string }
  /** Show the editor's text next to the card file. */
  | { type: 'showDiff'; id: string; mine: string }
  /** Full-text search over the cards (the host has the bodies). */
  | { type: 'search'; query: string }
  /** Add, rename or delete a lane of the current grouping. `to` is a new name typed on the board (else the host asks). */
  | { type: 'laneCommand'; action: 'new' | 'rename' | 'delete'; field: GroupField; value?: string | null; to?: string }
  /** Lanes were dragged into a new order; null is the lane for cards without a value. */
  | { type: 'laneOrder'; field: GroupField; order: (string | null)[] }
  /** Add, rename, recolour or delete a column. `to` is a new name typed on the board (else the host asks). */
  | { type: 'columnCommand'; action: 'new' | 'rename' | 'delete' | 'color'; status?: string; to?: string }
  /** Columns were dragged into a new order (their ids). */
  | { type: 'columnOrder'; order: string[] }
  /** First run: create the board folder, point the setting at an existing folder, or open a folder. */
  | { type: 'setupBoard'; action: 'create' | 'choose' | 'openFolder' }
  /** Open VS Code's Settings at this extension's settings. */
  | { type: 'openSettings' }
  /** View choices (lanes, wide editor, collapsed columns, filters…) to keep across sessions. Opaque to the host. */
  | { type: 'uiState'; state: unknown }
  /** Rename or delete a label across all cards; the host asks for details and confirmation. */
  | { type: 'labelCommand'; action: 'rename' | 'delete'; label?: string }
  /** An image pasted or dropped into the inline editor, base64-encoded, to store for card `id`. */
  | { type: 'saveImage'; requestId: string; id: string; ext: string; data: string }
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
