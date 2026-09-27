import {
  editCard,
  loadBoard,
  patchFields,
  planArchive,
  planRename,
  planRestore,
  planCreate,
  planEditBody,
  planMove,
  planNote,
  planSaveBody,
  planSetFields,
  type Board,
  type CreateIntent,
  type EditBodyIntent,
  type MoveIntent,
  type NoteIntent,
  type Plan,
  type SaveBodyIntent,
  type SetFieldsIntent,
} from '@kanban-bananas/core';
import {
  applyPlanToFile,
  ARCHIVE_DIRS,
  cardEdit,
  ConflictError,
  createCardFile,
  readBoardDir,
  resolveTarget,
  type WriteResult,
} from '@kanban-bananas/core/node';
import { readFile, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { BoardSource } from './boardSource.js';

const MAX_ATTEMPTS = 3;

/**
 * The one write path for cards (spec §2). Every change is an intent, planned
 * against the current board, then applied as a small patch to the card's
 * current text: its open buffer if it has one, else the file on disk.
 * Changes run one at a time. The board, commands and the CLI socket all
 * come through here.
 */
export class CardStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly source: BoardSource) {}

  move(intent: MoveIntent): Promise<WriteResult> {
    return this.enqueue(() => this.apply(intent.id, (board) => planMove(board, intent, new Date())));
  }

  setFields(intent: SetFieldsIntent): Promise<WriteResult> {
    return this.enqueue(() => this.apply(intent.id, (board) => planSetFields(board, intent, new Date())));
  }

  note(intent: NoteIntent): Promise<WriteResult> {
    return this.enqueue(() => this.apply(intent.id, (board) => planNote(board, intent, new Date())));
  }

  editBody(intent: EditBodyIntent): Promise<WriteResult> {
    return this.enqueue(() => this.apply(intent.id, (board) => planEditBody(board, intent, new Date())));
  }

  /** Save the inline editor's body, merged with any change made since it was loaded. */
  saveBody(intent: SaveBodyIntent): Promise<WriteResult> {
    return this.enqueue(() => this.apply(intent.id, (board) => planSaveBody(board, intent, new Date())));
  }

  /** Move a card into `archived/` (off the board). */
  archive(id: string): Promise<WriteResult> {
    return this.enqueue(() => this.apply(id, (board) => planArchive(board, id, new Date())));
  }

  /** Rename a card's file (to a new filename pattern); its id follows. */
  rename(id: string, filename: string): Promise<WriteResult> {
    return this.enqueue(() => this.apply(id, (board) => planRename(board, id, filename, new Date())));
  }

  /** Bring an archived card back to the column its status names. */
  restore(id: string): Promise<WriteResult> {
    return this.enqueue(async () => {
      const archive = loadBoard(await this.archivedFiles());
      return this.applyResolved(id, planRestore(archive, id, new Date()));
    });
  }

  /** Cards in `archived/`, for the restore picker. */
  async archivedFiles() {
    return readBoardDir(this.source.root.fsPath, ARCHIVE_DIRS);
  }

  /**
   * Delete a card's file: to the trash when the machine has one, otherwise
   * for good (`permanently`, which the caller confirms first). Refused while
   * the card has unsaved edits in an editor.
   */
  deleteCard(id: string, { permanently = false }: { permanently?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      const card = this.source.board().cards.find((c) => c.card.fields.id === id);
      if (!card) throw new ConflictError(`No card "${id}" on the board.`);
      if (this.source.document(card.path)?.isDirty) {
        throw new ConflictError(`${card.path} has unsaved edits in an editor. Save or close it first.`);
      }
      await vscode.workspace.fs.delete(this.source.uriFor(card.path), { useTrash: !permanently });
      await this.source.refresh([card.path]);
    });
  }

  create(intent: CreateIntent): Promise<WriteResult> {
    return this.enqueue(async () => {
      // Never reuse an id that an archived card still has.
      const taken = new Set([...this.source.paths(), ...(await this.archivedFiles()).map((f) => f.path.replace(/^archived\//, ''))]);
      for (let attempt = 1; ; attempt++) {
        const card = planCreate(this.source.board(), intent, new Date(), taken);
        try {
          const result = await createCardFile(this.source.root.fsPath, card);
          await this.source.refresh([card.path]);
          return result;
        } catch (e) {
          // A file with that name appeared on disk; take the next suffix.
          if (e instanceof ConflictError && attempt < MAX_ATTEMPTS) {
            taken.add(card.path);
            continue;
          }
          throw e;
        }
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(id: string, makePlan: (board: Board) => Plan): Promise<WriteResult> {
    return this.applyResolved(id, makePlan(this.source.board()));
  }

  private async applyResolved(id: string, planned: Plan): Promise<WriteResult> {
    const plan = await resolveTarget(this.source.root.fsPath, planned, new Set(this.source.paths()));
    const doc = await this.editableBuffer(plan.path);
    const result = doc
      ? await this.applyToBuffer(doc, id, plan)
      : await applyPlanToFile(this.source.root.fsPath, id, plan);
    await this.source.refresh(plan.targetPath ? [plan.path, plan.targetPath] : [plan.path]);
    return result;
  }

  /**
   * The open editor buffer to change, if any. A buffer with unsaved edits is
   * always used, to protect them. A buffer without them is used only if it
   * matches the file: when VS Code hasn't caught up with an outside change
   * yet, the file is the truth, so it's written directly and VS Code reloads.
   */
  private async editableBuffer(path: string): Promise<vscode.TextDocument | undefined> {
    const doc = this.source.document(path);
    if (!doc || doc.isDirty) return doc;
    const onDisk = await readFile(doc.uri.fsPath, 'utf8').catch(() => null);
    return onDisk === doc.getText() ? doc : undefined;
  }

  /**
   * The card is open in an editor: apply minimal edits to the buffer so
   * unsaved edits and undo survive. Save only if it had no unsaved edits.
   */
  private async applyToBuffer(doc: vscode.TextDocument, id: string, plan: Plan & { targetPath?: string }): Promise<WriteResult> {
    const wasDirty = doc.isDirty;
    if (plan.expectMtimeMs !== undefined) {
      // A whole-body replacement is based on what the caller read from disk.
      const mtimeMs = (await stat(doc.uri.fsPath)).mtimeMs;
      if (wasDirty || mtimeMs !== plan.expectMtimeMs) {
        throw new ConflictError(
          `${plan.path} ${wasDirty ? 'has unsaved edits in VS Code' : 'changed since you read it'}. Read it again.`,
        );
      }
    }

    const current = doc.getText();
    const next = editCard(current, id, cardEdit(plan));

    // Two separate edits: frontmatter lines, and the body change at the end.
    // Edits elsewhere in the buffer (the user's) are left alone.
    const edit = new vscode.WorkspaceEdit();
    const fmOnly = patchFields(current, plan.changes);
    const fm = minimalReplace(current, fmOnly);
    if (fm.start !== fm.end || fm.text) {
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(fm.start), doc.positionAt(fm.end)), fm.text);
    }
    if (plan.append !== undefined || plan.body !== undefined || plan.rebase !== undefined) {
      // Everything after the frontmatter edit is body; replace only the part that differs.
      const tail = minimalReplace(current.slice(fm.end), next.slice(fm.start + fm.text.length));
      const offset = fm.end;
      edit.replace(
        doc.uri,
        new vscode.Range(doc.positionAt(offset + tail.start), doc.positionAt(offset + tail.end)),
        tail.text,
      );
    }
    const target = plan.targetPath ? this.source.uriFor(plan.targetPath) : undefined;
    if (target) edit.renameFile(doc.uri, target, { overwrite: false, ignoreIfExists: false });
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`VS Code refused the edit to ${plan.path}.`);
    }

    const after = target ? await vscode.workspace.openTextDocument(target) : doc;
    if (after.getText() !== next) {
      throw new Error(`Edit to ${plan.targetPath ?? plan.path} did not produce the expected text. Check the file.`);
    }
    if (!wasDirty && !(await after.save())) {
      // The file changed on disk in the moment since the check. Put the buffer
      // back as it was (no unsaved edits of ours left behind) and report it.
      if (!target) {
        const undo = new vscode.WorkspaceEdit();
        undo.replace(after.uri, new vscode.Range(after.positionAt(0), after.positionAt(after.getText().length)), current);
        await vscode.workspace.applyEdit(undo);
      }
      throw new ConflictError(`${plan.targetPath ?? plan.path} changed on disk while it was being saved. Nothing was written; try again.`);
    }
    return {
      path: plan.targetPath ?? plan.path,
      mtimeMs: (await stat(after.uri.fsPath)).mtimeMs,
      route: wasDirty ? 'editor-unsaved' : 'editor-saved',
    };
  }
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
