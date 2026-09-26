import {
  idForFilename,
  parseCard,
  patchFields,
  planCreate,
  planMove,
  planSetFields,
  PatchError,
  type Board,
  type CreateIntent,
  type FieldValue,
  type MoveIntent,
  type Plan,
  type SetFieldsIntent,
} from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { ConflictError, exists, readVersioned, renameNoClobber, writeAtomic } from './atomicFile.js';
import type { BoardSource } from './boardSource.js';

const MAX_ATTEMPTS = 3;

/**
 * The one write path for cards (spec §2). Every change is an intent, planned
 * against the current board, then applied as a small patch to the card's
 * current text: its open buffer if it has one, else the file on disk.
 * Changes run one at a time.
 */
export class CardStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly source: BoardSource) {}

  move(intent: MoveIntent): Promise<void> {
    return this.enqueue(() => this.apply(intent.id, (board) => planMove(board, intent, new Date())));
  }

  setFields(intent: SetFieldsIntent): Promise<void> {
    return this.enqueue(() => this.apply(intent.id, (board) => planSetFields(board, intent, new Date())));
  }

  /** Create a card; resolves to its path relative to the features directory. */
  create(intent: CreateIntent): Promise<string> {
    return this.enqueue(async () => {
      const taken = new Set(this.source.paths());
      for (let attempt = 1; ; attempt++) {
        const card = planCreate(this.source.board(), intent, new Date(), taken);
        try {
          await writeAtomic(this.source.uriFor(card.path).fsPath, card.text, null);
        } catch (e) {
          // A file with that name appeared on disk; take the next suffix.
          if (e instanceof ConflictError && attempt < MAX_ATTEMPTS) {
            taken.add(card.path);
            continue;
          }
          throw e;
        }
        await this.source.refresh([card.path]);
        return card.path;
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(id: string, makePlan: (board: Board) => Plan): Promise<void> {
    const plan = makePlan(this.source.board());
    const changes = { ...plan.changes };

    let targetPath: string | undefined;
    if (plan.toDir !== undefined) {
      const filename = plan.path.slice(plan.path.lastIndexOf('/') + 1);
      const free = await this.freeName(plan.toDir, filename);
      targetPath = plan.toDir ? `${plan.toDir}/${free}` : free;
      // Never overwrite: a name clash gets a suffix, and the id follows the filename.
      if (free !== filename) changes.id = idForFilename(free);
    }

    const doc = this.source.document(plan.path);
    if (doc) await this.applyToBuffer(doc, id, changes, targetPath);
    else await this.applyToFile(plan.path, id, changes, targetPath);

    await this.source.refresh(targetPath ? [plan.path, targetPath] : [plan.path]);
  }

  /**
   * The card is open in an editor: apply a minimal edit to the buffer so
   * unsaved edits and undo survive. Save only if it had no unsaved edits.
   */
  private async applyToBuffer(
    doc: vscode.TextDocument,
    id: string,
    changes: Record<string, FieldValue>,
    targetPath: string | undefined,
  ): Promise<void> {
    const current = doc.getText();
    const next = patchCard(current, id, changes);
    const wasDirty = doc.isDirty;

    const edit = new vscode.WorkspaceEdit();
    const r = minimalReplace(current, next);
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), r.text);
    const target = targetPath ? this.source.uriFor(targetPath) : undefined;
    if (target) edit.renameFile(doc.uri, target, { overwrite: false, ignoreIfExists: false });
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`VS Code refused the edit to ${vscode.workspace.asRelativePath(doc.uri)}.`);
    }

    const after = target ? await vscode.workspace.openTextDocument(target) : doc;
    if (after.getText() !== next) {
      throw new Error(`Edit to ${vscode.workspace.asRelativePath(after.uri)} did not produce the expected text. Check the file.`);
    }
    if (!wasDirty && !(await after.save())) {
      throw new Error(`Could not save ${vscode.workspace.asRelativePath(after.uri)}.`);
    }
  }

  /** The card isn't open: write it atomically, re-reading and retrying if it changed underneath. */
  private async applyToFile(
    path: string,
    id: string,
    changes: Record<string, FieldValue>,
    targetPath: string | undefined,
  ): Promise<void> {
    const fsPath = this.source.uriFor(path).fsPath;
    let next = '';
    for (let attempt = 1; ; attempt++) {
      const { text, version } = await readVersioned(fsPath);
      next = patchCard(text, id, changes);
      try {
        await writeAtomic(fsPath, next, version);
        break;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= MAX_ATTEMPTS) throw e;
      }
    }
    const written = await readVersioned(fsPath);
    if (written.text !== next) throw new Error(`${path} changed right after it was written. Check the file.`);

    if (targetPath) await renameNoClobber(fsPath, this.source.uriFor(targetPath).fsPath);
  }

  private async freeName(dir: string, filename: string): Promise<string> {
    const known = new Set(this.source.paths());
    const stem = filename.replace(/\.md$/i, '');
    for (let n = 1; ; n++) {
      const name = n === 1 ? filename : `${stem}-${n}.md`;
      const path = dir ? `${dir}/${name}` : name;
      if (!known.has(path) && !(await exists(this.source.uriFor(path).fsPath))) return name;
    }
  }
}

/** Patch a card's current text, first checking it is still the card that was planned for. */
function patchCard(text: string, id: string, changes: Record<string, FieldValue>): string {
  const parsed = parseCard(text);
  if (!parsed.ok) throw new PatchError(`The card no longer parses (${parsed.error.message}). Nothing was written.`);
  if (parsed.card.fields.id !== id) {
    throw new PatchError(`The file now holds card "${parsed.card.fields.id}", not "${id}". Nothing was written.`);
  }
  return patchFields(text, changes);
}

/** The smallest single replacement that turns `a` into `b`. */
export function minimalReplace(a: string, b: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, end: endA, text: b.slice(start, endB) };
}
