import { addMemoryEntry, BodyConflictError, memoryNext, mergeText, parseMemory } from '@kanban-bananas/core';
import { ConflictError, readVersioned, writeAtomic, type WriteResult } from '@kanban-bananas/core/node';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { log } from './log.js';

const run = promisify(execFile);

/** What the board shows in its top-left corner. */
export interface MemorySummary {
  file: string;
  /** ISO time of the newest entry, or null when there is none yet. */
  updated: string | null;
  next: string | null;
  latest: string | null;
}

/**
 * The session memory file: read for the board, written by agents through the
 * CLI (socket) with the same care as cards. An open editor with unsaved edits
 * gets the change in its buffer; otherwise the file is written atomically.
 */
export class SessionMemory implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private summaryCache: MemorySummary | null = null;
  /** The file's current text (its buffer if that has unsaved edits), '' when it doesn't exist yet. */
  private textCache = '';
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly controller: BoardController) {}

  private config() {
    return this.controller.settingsNow.sessionMemory;
  }

  private folder(): vscode.WorkspaceFolder | undefined {
    const root = this.controller.root;
    return root && vscode.workspace.getWorkspaceFolder(root);
  }

  uri(): vscode.Uri | undefined {
    const folder = this.folder();
    return folder && vscode.Uri.joinPath(folder.uri, ...this.config().file.split('/'));
  }

  /** (Re)start watching the file; call when the board or the settings change. */
  async restart(): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.summaryCache = null;
    const folder = this.folder();
    if (!this.config().enabled || !folder) {
      this.changed.fire();
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, this.config().file));
    const reload = () => void this.refresh();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
    await this.refresh();
    await this.applyPersonal().catch((e) => log.warn(`Session memory: couldn't update .git/info/exclude: ${e instanceof Error ? e.message : String(e)}`));
  }

  summary(): MemorySummary | null {
    return this.config().enabled ? this.summaryCache : null;
  }

  private async refresh(): Promise<void> {
    const uri = this.uri();
    if (!uri) return;
    const text = await this.currentText(uri);
    this.textCache = (text ?? '').replace(/\r\n/g, '\n');
    const latest = parseMemory(text ?? '')[0];
    this.summaryCache = { file: this.config().file, updated: latest?.at ?? null, next: memoryNext(latest), latest: latest?.body ?? null };
    this.changed.fire();
  }

  private async currentText(uri: vscode.Uri): Promise<string | null> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc?.isDirty) return doc.getText();
    return readFile(uri.fsPath, 'utf8').catch(() => null);
  }

  /** The file's text as last read (for the board's editor). */
  text(): string {
    return this.textCache;
  }

  /** Add an entry (from the CLI or a command). One write at a time. */
  add(body: string): Promise<WriteResult> {
    return this.enqueue(() => this.write((current) => addMemoryEntry(current, body, new Date(), this.config().keep)));
  }

  /**
   * Save the board editor's text, edited from `base`: merged with anything
   * written meanwhile (e.g. an agent's entry), like a card body. Overlapping
   * edits throw BodyConflictError. Returns the file's text afterwards.
   */
  saveFromEditor(base: string, mine: string): Promise<string> {
    return this.enqueue(async () => {
      await this.write((current) => {
        const merged = mergeText(base, mine, current.replace(/\r\n/g, '\n'));
        if (merged === null) throw new BodyConflictError(current.replace(/\r\n/g, '\n'));
        return merged;
      });
      return this.textCache;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(change: (current: string) => string): Promise<WriteResult> {
    if (!this.config().enabled) throw new Error('Session memory is off for this project.');
    const uri = this.uri();
    if (!uri) throw new Error('No board folder in this workspace.');
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const onDisk = await readFile(uri.fsPath, 'utf8').catch(() => null);

    if (doc && (doc.isDirty || doc.getText() === onDisk)) {
      // Open in an editor: change the buffer, so unsaved edits there survive. Save only if it had none.
      const wasDirty = doc.isDirty;
      const next = change(doc.getText());
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the edit to the session memory.');
      if (!wasDirty) await doc.save();
      await this.refresh();
      return { path: this.config().file, mtimeMs: Date.now(), route: wasDirty ? 'editor-unsaved' : 'editor-saved' };
    }

    for (let attempt = 1; ; attempt++) {
      const current = onDisk === null && attempt === 1 ? null : await readVersioned(uri.fsPath).catch(() => null);
      const next = change(current?.text ?? '');
      try {
        await mkdir(dirname(uri.fsPath), { recursive: true });
        const version = await writeAtomic(uri.fsPath, next, current?.version ?? null);
        await this.refresh();
        return { path: this.config().file, mtimeMs: version.mtimeMs, route: 'disk' };
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 3) throw e;
      }
    }
  }

  /**
   * "Personal": list the file in .git/info/exclude (this clone only), or take
   * it out again. Warns when the file is already tracked, since excluding
   * doesn't untrack.
   */
  private async applyPersonal(): Promise<void> {
    const folder = this.folder();
    if (!folder) return;
    const cwd = folder.uri.fsPath;
    let excludePath: string;
    let top: string;
    try {
      top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
      const p = (await run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd })).stdout.trim();
      excludePath = p.startsWith('/') ? p : join(cwd, p);
    } catch {
      return; // not a git repository
    }
    const rel = this.config().file;
    const line = `/${rel}`;
    const marker = '# KanbanBananas session memory (personal)';
    const current = await readFile(excludePath, 'utf8').catch(() => '');
    const lines = current.split('\n');
    const has = lines.includes(line);
    if (this.config().personal && !has) {
      await mkdir(dirname(excludePath), { recursive: true });
      await writeFile(excludePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${marker}\n${line}\n`);
      log.info(`Session memory: added ${line} to ${excludePath}`);
      const tracked = await run('git', ['ls-files', '--error-unmatch', rel], { cwd: top }).then(() => true, () => false);
      if (tracked) {
        void vscode.window.showWarningMessage(
          `KanbanBananas: ${rel} is already committed, so git keeps tracking it. To make it personal, run: git rm --cached "${rel}" (and commit that).`,
        );
      }
    } else if (!this.config().personal && has) {
      const kept = lines.filter((l) => l !== line && l !== marker).join('\n');
      await writeFile(excludePath, kept);
      log.info(`Session memory: removed ${line} from ${excludePath}`);
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.changed.dispose();
  }
}
