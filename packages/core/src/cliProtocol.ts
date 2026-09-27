import type { CreateIntent, EditBodyIntent, MoveIntent, NoteIntent, SetFieldsIntent } from './ops.js';

/**
 * The CLI ↔ extension socket protocol: one JSON object per line each way.
 * While VS Code runs, the CLI sends its changes here so they go through the
 * same store as the board (open buffers included) (spec §12).
 */

/** File next to the features directory that says where the socket is: `.devtool/.kanban.sock`. */
export const SOCKET_RECORD = '.kanban.sock';

export interface SocketRecord {
  socket: string;
  pid: number;
  version: string;
}

/** `create` from the CLI leaves `top` and `priority` to the extension's settings when not given. */
export type CliRequest =
  | { op: 'ping' }
  | { op: 'move'; intent: MoveIntent }
  | { op: 'set'; intent: SetFieldsIntent }
  | { op: 'note'; intent: NoteIntent }
  | { op: 'edit'; intent: EditBodyIntent }
  | { op: 'create'; intent: CreateIntent };

/**
 * How a change was applied:
 * - `disk`: the file was written (atomically).
 * - `editor-saved`: the card was open in an editor with no unsaved edits; the edit went into it and it was saved.
 * - `editor-unsaved`: the card was open with unsaved edits; the edit went into the editor and the file on disk
 *   updates when the user saves.
 */
export type WriteRoute = 'disk' | 'editor-saved' | 'editor-unsaved';

export interface CliResult {
  path: string;
  mtimeMs: number;
  route: WriteRoute;
}

export type CliErrorCode = 'conflict' | 'invalid' | 'error';

export type CliResponse =
  | { ok: true; result?: CliResult; version: string }
  | { ok: false; code: CliErrorCode; error: string };
