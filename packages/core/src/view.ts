import type { Board } from './board.js';
import { countEntries, type EntryCounts } from './entries.js';
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
  /** A log card's entries (`type: log`): how many are open and done. */
  entries?: EntryCounts;
  /**
   * A hub's copy that holds the card's title and fields only (the repo shares
   * no text: `CardText.fieldsOnly`). The board shows "Text not shared" instead
   * of an excerpt, the pane a note instead of the editor. Never set in VS Code.
   */
  fieldsOnly?: true;
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

/** The id the board's editor uses for the session memory file (cards use their own ids). */
export const MEMORY_EDITOR_ID = '#session-memory';

/** Messages from the extension host to the board webview. */
export type HostMessage =
  /** Answer to a webview message with a `requestId`: done, or what went wrong. */
  /** A request was handled; `result` is what it produced, e.g. a created card's id. */
  | { type: 'ack'; requestId: string; ok: boolean; error?: string; result?: string }
  /** `assetBase` is the project root as the page can load it, for showing `/…` image links. */
  | {
      type: 'state';
      board: BoardView;
      settings: ViewSettings;
      assetBase?: string;
      /** Session memory summary, when it's turned on: newest entry and its "Next:". */
      memory?: { file: string; updated: string | null; next: string | null; latest: string | null };
    }
  | { type: 'error'; message: string }
  /** No board yet: offer to create one (`folderOpen`: a workspace folder is open to create it in). */
  | { type: 'noBoard'; featuresDirectory: string; folderOpen: boolean }
  /** The inline editor's card: its body when opened, and again whenever someone else changes it. */
  | { type: 'editorBody'; id: string; path: string; body: string }
  /** A card's path was copied to the clipboard (as `text`). */
  | { type: 'pathCopied'; path: string; text: string }
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
  | { type: 'editorClosed'; id: string; reason: string }
  /**
   * Hub mode only (BoardHostOptions): whether the board can be changed right
   * now, the machine that owns the files, and every change asked of it with
   * its state. The whole list each time; the board draws it on the cards.
   */
  | { type: 'hubState'; readOnly: boolean; machine: string | null; requests: CardRequest[] };

/**
 * Messages from the board webview to the extension host: intents, never whole cards (spec §2.1).
 * A message with a `requestId` gets an `ack` back once it's done (or failed), so the page knows
 * the change really reached the extension. Without one it assumes the connection is gone.
 */
export type WebviewMessage = { requestId?: string } & (
  /** The page loaded; `build` identifies its bundle (extension version + build time). */
  /** The page loaded, or (reconnect) got its connection back and wants the board again. */
  | { type: 'ready'; build?: string; reconnect?: boolean }
  | { type: 'openCard'; path: string }
  | { type: 'move'; id: string; toStatus: string; beforeId: string | null }
  /** A new card; `body` for one made from a log entry ("→ Card"). */
  | { type: 'create'; title: string; status: string; body?: string }
  | { type: 'setFields'; id: string; changes: Partial<Record<'priority' | 'assignee' | 'epic' | 'dueDate' | 'labels' | 'lane' | 'type', string | string[] | null>> }
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
  /** Open the session memory file in VS Code's editor. */
  | { type: 'openMemory' }
  /** Copy a card's path (relative to the project), e.g. to paste into an agent's chat. */
  | { type: 'copyPath'; path: string }
  /** Open VS Code's Settings at this extension's settings. */
  | { type: 'openSettings' }
  /** View choices (lanes, wide editor, collapsed columns, filters…) to keep across sessions. Opaque to the host. */
  | { type: 'uiState'; state: unknown }
  /** Rename or delete a label across all cards; the host asks for details and confirmation. */
  | { type: 'labelCommand'; action: 'rename' | 'delete'; label?: string }
  /** An image pasted or dropped into the inline editor, base64-encoded, to store for card `id`. */
  | { type: 'saveImage'; requestId: string; id: string; ext: string; data: string }
  /** A line for the KanbanBananas log (diagnostics, e.g. what a paste contained). */
  | { type: 'clientLog'; message: string }
  /** Something in the webview threw; the host logs it. */
  | { type: 'clientError'; message: string; stack?: string }
  /** The split view rendered this card (for tests). */
  | { type: 'editorShown'; id: string }
  /** Is the extension still there? Answered with an ack. */
  | { type: 'ping' }
  /** Hub mode: a button under a request was pressed (`action` is one of the request's `actions`). */
  | { type: 'requestAction'; request: string; action: string }
);

/**
 * A change a hub host asked the machine for, as the board shows it (hub mode).
 * The host owns the list and sends it whole with every `hubState`. The board
 * draws the state on the card, shows the note and the buttons under it, and
 * reports a press as `requestAction`. A request whose card isn't on the board
 * (a card being created, or one that is gone) shows as a card of its own in
 * `placeholder.status`.
 */
export interface CardRequest {
  /** The host's id for the request (the hub's intent id). */
  id: string;
  /** The card it concerns; null for a card that doesn't exist yet. */
  cardId: string | null;
  state: CardRequestState;
  /** When it was sent, in ms since the epoch: a pending request shows "Waiting for…" only after a second. */
  since: number;
  /** Shown under the card, e.g. "Not moved: it changed in VS Code meanwhile." */
  note?: string;
  /** Buttons under the note; a press comes back as `requestAction` with the action's id. */
  actions?: CardRequestAction[];
  /** Title and column for a request whose card isn't on the board. */
  placeholder?: { title: string; status: string };
  /**
   * Who asked, when it is not the viewer (SuperTask Board 4c, D-133): a
   * pending request then reads "‹name›'s change · waiting for ‹machine›" with
   * their avatar. `color` is any CSS colour. Absent for the viewer's own.
   */
  by?: CardRequestBy;
}

export interface CardRequestBy {
  name: string;
  initials: string;
  color: string;
}

/**
 * pending: sent, no answer yet · applied: done (the host shows it briefly, then drops it) ·
 * stale: refused, a field it depends on changed meanwhile · conflict: a body save overlapped
 * someone else's change · gone: the card was deleted or renamed · expired: dropped unanswered ·
 * refused: the machine could not apply it for a reason of its own (the note says why; drawn
 * like stale with its own icon, SuperTask Board 4c, D-132).
 */
export type CardRequestState = 'pending' | 'applied' | 'stale' | 'conflict' | 'gone' | 'expired' | 'refused';

export interface CardRequestAction {
  id: string;
  label: string;
}

/**
 * What a page that shows the board outside VS Code provides, as
 * `window.kanbanBananasHost`, before the bundle loads. The board then talks to
 * it instead of VS Code's webview API: `postMessage` carries its
 * `WebviewMessage`s to the host, `onMessage` delivers the host's
 * `HostMessage`s. The host acks every message that has a `requestId`, as the
 * extension does; an ack means the host took the change, not that the machine
 * applied it (that comes through `hubState`).
 */
export interface BoardHost {
  postMessage(message: WebviewMessage): void;
  onMessage(handler: (message: HostMessage) => void): () => void;
  /** The page's view state across reloads (VS Code's getState/setState); optional. */
  getState?(): unknown;
  setState?(state: unknown): void;
  options?: BoardHostOptions;
}

export interface BoardHostOptions {
  /**
   * `hub`: the board is a host's copy of a repo's cards, changed only through
   * requests to the machine that owns them. The board hides what only VS Code
   * can do (new, renamed or reordered columns and swimlanes, the settings,
   * opening files, the label commands) and follows `hubState`. `vscode` (the
   * default) is the board as in the extension.
   */
  mode?: 'vscode' | 'hub';
  /** The page's CSP nonce, for the style elements the editor adds to the document. */
  cspNonce?: string;
  /**
   * Hub mode: the host takes an image pasted or dropped into the editor
   * (`saveImage`, answered with `imageSaved` or `imageError` as in VS Code)
   * and passes it on to the machine. Without it the editor refuses the paste
   * and says images are added in VS Code.
   */
  images?: boolean;
  /**
   * Hub mode: what the editor says when it refuses a paste because `images` is
   * off, in place of "Images are added in VS Code: the board here holds the
   * text only." (a repo that shares titles and fields only has its own line).
   */
  pasteNote?: string;
}

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
      ...(c.card.fields.type === 'log' ? { entries: countEntries(c.card.source.body) } : {}),
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
