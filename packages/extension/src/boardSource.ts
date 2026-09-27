import { loadBoard, toBoardView, type Board, type BoardView } from '@kanban-bananas/core';
import * as vscode from 'vscode';

/** Card files are `<root>/*.md` and `<root>/done/*.md`. `archived/` is not on the board. */
const CARD_DIRS = ['', 'done'];
const FILE_DEBOUNCE_MS = 150;
const EMIT_DEBOUNCE_MS = 50;

// Keep a BOM if there is one, so text matches the bytes on disk.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * The latest text of every card file, re-read one file at a time as the
 * watcher reports changes. A card open in an editor with unsaved edits is
 * read from its buffer, so the board shows what the user sees.
 */
export class BoardSource implements vscode.Disposable {
  private readonly files = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Latest read started per path; a read that finishes after a newer one is dropped. */
  private readonly readSeq = new Map<string, number>();
  private emitTimer: NodeJS.Timeout | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    readonly root: vscode.Uri,
    private readonly statuses: () => readonly string[],
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{*.md,done/*.md}'));
    const onEvent = (uri: vscode.Uri) => {
      const path = this.relativePath(uri);
      if (path !== null) this.scheduleRead(path);
    };
    this.watcher.onDidCreate(onEvent);
    this.watcher.onDidChange(onEvent);
    this.watcher.onDidDelete(onEvent);

    // A buffer with unsaved edits is what the user sees, so the board shows it.
    // A clean buffer may lag behind an outside change, so then the file is read.
    const fromDocument = (doc: vscode.TextDocument) => {
      const path = this.relativePath(doc.uri);
      if (path === null) return;
      if (doc.isDirty) {
        this.files.set(path, doc.getText());
        this.scheduleEmit();
      } else {
        this.scheduleRead(path);
      }
    };
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument(fromDocument),
      vscode.workspace.onDidChangeTextDocument((e) => fromDocument(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const path = this.relativePath(doc.uri);
        if (path !== null) this.scheduleRead(path);
      }),
    );
  }

  /** Read every card file from scratch. */
  async reload(): Promise<void> {
    const found: string[] = [];
    for (const dir of CARD_DIRS) {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir ? vscode.Uri.joinPath(this.root, dir) : this.root);
      } catch {
        continue;
      }
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith('.md')) found.push(dir ? `${dir}/${name}` : name);
      }
    }
    this.files.clear();
    await Promise.all(found.map((p) => this.read(p)));
    this.emit();
  }

  /** Re-read these files now (after the board wrote them) and redraw. */
  async refresh(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.read(p)));
    this.emit();
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Current text of a card file (its buffer if open), as last read. */
  text(path: string): string | undefined {
    return this.files.get(path);
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  /** The open editor buffer for a card, if there is one. */
  document(path: string): vscode.TextDocument | undefined {
    const uri = this.uriFor(path).toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  }

  uriFor(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...path.split('/'));
  }

  board(): Board {
    const files = [...this.files].map(([path, text]) => ({ path, text }));
    return loadBoard(files, { statuses: this.statuses() });
  }

  view(): BoardView {
    return toBoardView(this.board());
  }

  private relativePath(uri: vscode.Uri): string | null {
    const prefix = this.root.path.endsWith('/') ? this.root.path : this.root.path + '/';
    if (!uri.path.startsWith(prefix)) return null;
    const rel = uri.path.slice(prefix.length);
    const slash = rel.indexOf('/');
    const dir = slash === -1 ? '' : rel.slice(0, slash);
    if (!rel.endsWith('.md') || rel.indexOf('/', slash + 1) !== -1 || !CARD_DIRS.includes(dir)) return null;
    return rel;
  }

  /** Debounce per file: a burst of events for one file causes one read. */
  private scheduleRead(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.read(path).then(() => this.scheduleEmit());
      }, FILE_DEBOUNCE_MS),
    );
  }

  private async read(path: string): Promise<void> {
    const seq = (this.readSeq.get(path) ?? 0) + 1;
    this.readSeq.set(path, seq);
    const doc = this.document(path);
    let text: string | undefined = doc?.isDirty ? doc.getText() : undefined;
    if (text === undefined) {
      try {
        text = decoder.decode(await vscode.workspace.fs.readFile(this.uriFor(path)));
      } catch {
        text = undefined; // deleted, or not readable
      }
    }
    if (this.readSeq.get(path) !== seq) return;
    if (text === undefined) this.files.delete(path);
    else this.files.set(path, text);
  }

  private scheduleEmit(): void {
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.emit(), EMIT_DEBOUNCE_MS);
  }

  private emit(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
    for (const s of this.subs) s.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
    clearTimeout(this.emitTimer);
  }
}
