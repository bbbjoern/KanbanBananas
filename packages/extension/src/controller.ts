import { labelCounts, loadBoard, MEMORY_EDITOR_ID, parseCard, planRenameToPattern, relabel, searchCards, type GroupField, type ColumnConfig, type LaneDef, type PatternRename, type CreateIntent, type HostMessage, type MoveIntent, type SaveBodyIntent, type SetFieldsIntent } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { BoardSource } from './boardSource.js';
import { CardStore } from './cardStore.js';
import { CliServer } from './cliServer.js';
import { CardImages } from './images.js';
import { SessionMemory } from './sessionMemory.js';
import { log } from './log.js';
import { readSettings, SECTION, type Settings } from './settings.js';

/**
 * Owns the board for the workspace: finds the features folder, keeps a
 * BoardSource and the CardStore on it, and tells webviews when to redraw.
 */
export class BoardController implements vscode.Disposable {
  private settings: Settings = readSettings();
  private source: BoardSource | undefined;
  private store: CardStore | undefined;
  private cliServer: CliServer | undefined;
  private sourceSub: vscode.Disposable | undefined;
  private problem: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  /** Errors reported by board webviews, and cards the split view showed. Read by integration tests. */
  readonly clientErrors: string[] = [];
  /** Pasted images: saving, references, deleting with their card. */
  readonly images = new CardImages(this);
  /** The session memory file, when turned on in the settings. */
  readonly memory = new SessionMemory(this);
  readonly shownInEditor: string[] = [];

  constructor(private readonly version: string) {
    this.memory.onDidChange(() => this.changed.fire());
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration('kanban-markdown')) return;
        const dirChanged = readSettings().featuresDirectory !== this.settings.featuresDirectory;
        this.settings = readSettings();
        if (dirChanged) void this.start();
        else if (e.affectsConfiguration(`${SECTION}.sessionMemory`)) void this.memory.restart();
        else this.changed.fire();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.start()),
    );
  }

  /**
   * First run: create the features folder (and done/) in a workspace folder,
   * then load the board. Only on request; nothing is created unasked.
   */
  async createBoard(folder: vscode.WorkspaceFolder): Promise<void> {
    const root = vscode.Uri.joinPath(folder.uri, ...this.settings.featuresDirectory.split('/').filter(Boolean));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'done'));
    log.info(`Created the board folder ${root.fsPath}`);
    await this.start();
  }

  /** Find the features folder and load every card. Safe to call again to reload. */
  async start(): Promise<void> {
    this.sourceSub?.dispose();
    this.source?.dispose();
    this.cliServer?.dispose();
    this.cliServer = undefined;
    this.source = undefined;
    this.store = undefined;
    this.problem = undefined;

    const root = await this.findRoot();
    log.info(root ? `Board folder: ${root.fsPath}` : `No "${this.settings.featuresDirectory}" folder in the workspace`);
    if (!root) {
      this.problem = `No "${this.settings.featuresDirectory}" folder in this workspace.`;
      this.changed.fire();
      return;
    }
    const source = new BoardSource(root, () => this.settings.view.columns.map((c) => c.id));
    this.source = source;
    this.store = new CardStore(source);
    this.sourceSub = source.onDidChange(() => this.changed.fire());
    await source.reload();
    await this.memory.restart();

    const server = new CliServer(root.fsPath, this.store, () => this.settings, this.version, (body) => this.memory.add(body));
    try {
      await server.start();
      this.cliServer = server;
      log.info(`CLI socket listening; record at ${server.recordLocation}`);
    } catch (e) {
      // The CLI still works without it, writing files directly.
      server.dispose();
      log.warn(`CLI socket not available, the CLI will write files directly: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Board state, with the session memory summary when it's on. */
  state(): HostMessage {
    if (this.problem) {
      // Not an error on a fresh project: the page offers to create the board.
      return { type: 'noBoard', featuresDirectory: this.settings.featuresDirectory, folderOpen: (vscode.workspace.workspaceFolders?.length ?? 0) > 0 };
    }
    if (!this.source) return { type: 'error', message: 'Loading…' };
    const memory = this.memory.summary();
    return { type: 'state', board: this.source.view(), settings: this.settings.view, ...(memory ? { memory } : {}) };
  }

  get settingsNow(): Settings {
    return this.settings;
  }

  /** The store itself, for integration tests that need to see write errors. */
  get cardStore(): CardStore | undefined {
    return this.store;
  }

  /** The current board, for commands that need to look up cards. */
  board() {
    return this.source?.board();
  }

  move(intent: MoveIntent): Promise<string | null> {
    return this.write((store) => store.move(intent));
  }

  setFields(intent: SetFieldsIntent): Promise<string | null> {
    return this.write((store) => store.setFields(intent));
  }

  create(intent: Omit<CreateIntent, 'top' | 'priority'>): Promise<string | null> {
    const full = {
      ...intent,
      top: this.settings.view.addNewCardsToTop,
      priority: this.settings.defaultPriority,
      filenamePattern: this.settings.filenamePattern,
    };
    return this.write((store) => store.create(full));
  }

  /**
   * Run a change; on failure, tell the user and redraw so optimistic UI snaps
   * back. Resolves to the error message, or null when it was written.
   */
  private async write(change: (store: CardStore) => Promise<unknown>): Promise<string | null> {
    try {
      if (!this.store) throw new Error('The board is not loaded.');
      await change(this.store);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`Change failed: ${message}`);
      void vscode.window.showErrorMessage(`KanbanBananas: ${message}`);
      this.changed.fire();
      return message;
    }
  }

  /** A card's path and body (with \n line endings, as editors use), or null if it's not a valid card. */
  cardBody(id: string): { path: string; body: string } | null {
    const card = this.board()?.cards.find((c) => c.card.fields.id === id);
    const text = card && this.source?.text(card.path);
    if (!card || text === undefined) return null;
    const parsed = parseCard(text);
    return parsed.ok ? { path: card.path, body: parsed.card.source.body.replace(/\r\n/g, '\n') } : null;
  }

  /** What the board's editor edits: a card's body, or the whole session memory file. */
  editorDoc(id: string): { path: string; body: string } | null {
    if (id === MEMORY_EDITOR_ID) {
      return this.settings.sessionMemory.enabled && this.root ? { path: this.settings.sessionMemory.file, body: this.memory.text() } : null;
    }
    return this.cardBody(id);
  }

  /** Save from the board's editor (card or session memory); returns the text now stored. */
  saveEditorDoc(intent: SaveBodyIntent): Promise<string> {
    return intent.id === MEMORY_EDITOR_ID ? this.memory.saveFromEditor(intent.base, intent.body) : this.saveBody(intent);
  }

  /** Save the inline editor's body. Throws BodyConflictError and others to the caller, which reports them. */
  async saveBody(intent: SaveBodyIntent): Promise<string> {
    if (!this.store) throw new Error('The board is not loaded.');
    await this.store.saveBody(intent);
    const now = this.cardBody(intent.id);
    if (!now) throw new Error('The card is gone after saving.');
    return now.body;
  }

  search(query: string): string[] {
    const board = this.board();
    return board ? searchCards(board, query) : [];
  }

  labels(): { label: string; count: number }[] {
    const board = this.board();
    return board ? labelCounts(board) : [];
  }

  /**
   * Rename a label on every card that has it, or remove it (to = null). One
   * store write per card, in turn; returns how many cards changed and which failed.
   */
  async relabelAll(from: string, to: string | null): Promise<{ changed: number; failed: string[] }> {
    if (!this.store) throw new Error('The board is not loaded.');
    const ids = (this.board()?.cards ?? []).filter((c) => c.card.fields.labels.includes(from)).map((c) => c.card.fields.id!);
    let changed = 0;
    const failed: string[] = [];
    for (const id of ids) {
      // Re-read the card's current labels right before each write.
      const card = this.board()?.cards.find((c) => c.card.fields.id === id);
      if (!card) continue;
      try {
        await this.store.setFields({ id, changes: { labels: relabel(card.card.fields.labels, from, to) } });
        changed++;
      } catch (e) {
        failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log.info(`${to === null ? 'Deleted' : 'Renamed'} label "${from}"${to === null ? '' : ` to "${to}"`} on ${changed} card(s)${failed.length ? `; ${failed.length} failed` : ''}`);
    return { changed, failed };
  }

  /** Card ids in a column, in board order. */
  columnIds(status: string): string[] {
    return (this.board()?.cards ?? []).filter((c) => c.card.fields.status === status).map((c) => c.card.fields.id!);
  }

  /**
   * Run one store change per card, in turn, collecting failures instead of
   * stopping. For bulk moves, archiving a column, and lane renames.
   */
  private async eachCard(ids: string[], what: string, change: (store: CardStore, id: string) => Promise<unknown>) {
    if (!this.store) throw new Error('The board is not loaded.');
    let changed = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await change(this.store, id);
        changed++;
      } catch (e) {
        failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log.info(`${what}: ${changed} card(s)${failed.length ? `, ${failed.length} failed: ${failed.join('; ')}` : ''}`);
    return { changed, failed };
  }

  /** Move every card of a column to another, keeping their order (each goes to the end). */
  moveAll(status: string, toStatus: string) {
    return this.eachCard(this.columnIds(status), `Moved ${status} → ${toStatus}`, (s, id) => s.move({ id, toStatus, beforeId: null }));
  }

  archiveAll(status: string) {
    return this.eachCard(this.columnIds(status), `Archived ${status}`, (s, id) => s.archive(id));
  }

  async archive(id: string): Promise<void> {
    await this.write((store) => store.archive(id));
  }

  async archivedCards(): Promise<{ id: string; title: string | null; status: string | null; path: string }[]> {
    if (!this.store) return [];
    const board = loadBoard(await this.store.archivedFiles());
    return board.cards.map((c) => ({ id: c.card.fields.id!, title: c.card.title, status: c.card.fields.status, path: c.path }));
  }

  async restore(id: string): Promise<void> {
    await this.write((store) => store.restore(id));
  }

  async deleteCard(id: string, permanently: boolean): Promise<void> {
    if (!this.store) throw new Error('The board is not loaded.');
    await this.store.deleteCard(id, { permanently });
  }

  /**
   * Change a lane value on every card that has it: `from` → `to`, or clear it
   * (to = null). For labels use relabelAll, since a card can have several.
   */
  setFieldAll(field: Exclude<GroupField, never>, from: string, to: string | null) {
    const ids = (this.board()?.cards ?? []).filter((c) => c.card.fields[field] === from).map((c) => c.card.fields.id!);
    return this.eachCard(ids, `Set ${field} "${from}" → ${to === null ? 'none' : `"${to}"`}`, (s, id) => s.setFields({ id, changes: { [field]: to } }));
  }

  /** Change the board's columns (workspace settings; the first edit copies inherited columns into the project). */
  async updateColumns(change: (columns: ColumnConfig[]) => ColumnConfig[]): Promise<void> {
    const next = change(this.settings.view.columns.map((c) => ({ ...c })));
    if (next.length === 0) throw new Error('A board needs at least one column.');
    await vscode.workspace.getConfiguration(SECTION).update('columns', next, vscode.ConfigurationTarget.Workspace);
    log.info(`Saved columns to workspace settings: ${next.map((c) => `${c.id} "${c.name}"`).join(', ')}`);
  }

  /** Change the configured lane list of a grouping (workspace settings). */
  async updateLanes(field: GroupField, change: (lanes: LaneDef[]) => LaneDef[]): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const current = { ...(config.get<Record<string, LaneDef[]>>('lanes') ?? {}) };
    current[field] = change(this.settings.view.lanes[field]);
    await config.update('lanes', current, vscode.ConfigurationTarget.Workspace);
    log.info(`Saved ${field} lanes to workspace settings: ${current[field]!.map((l) => l.name).join(', ') || '(none)'}`);
  }

  /** Cards the current filename pattern would rename. */
  pendingRenames(): PatternRename[] {
    const board = this.board();
    return board ? planRenameToPattern(board, this.settings.filenamePattern, new Date()) : [];
  }

  renameAll(renames: PatternRename[]) {
    const byId = new Map(renames.map((r) => [r.id, r.filename]));
    return this.eachCard([...byId.keys()], `Renamed to pattern ${this.settings.filenamePattern}`, (s, id) => s.rename(id, byId.get(id)!));
  }

  /** A card file's current text (its buffer if it has unsaved edits). */
  cardText(path: string): string | undefined {
    return this.source?.text(path);
  }

  /** Files in archived/, for image references and restore. */
  async archivedFiles() {
    return this.store ? this.store.archivedFiles() : [];
  }

  /** The id of the card a document is, if it is a card on the board. */
  cardIdForDocument(uri: vscode.Uri): string | undefined {
    if (!this.source) return undefined;
    const target = uri.toString();
    const card = this.board()?.cards.find((c) => this.source!.uriFor(c.path).toString() === target);
    return card?.card.fields.id ?? undefined;
  }

  /**
   * Copy a card's path, relative to the project, to the clipboard: as an `@`
   * mention or plain, per the setting. Returns what was copied.
   */
  async copyCardPath(path: string): Promise<string | undefined> {
    if (!this.source?.has(path)) return undefined;
    const rel = vscode.workspace.asRelativePath(this.source.uriFor(path), false);
    const format = vscode.workspace.getConfiguration(SECTION).get<string>('copyPathFormat', 'mention');
    const text = format === 'path' ? rel : `@${rel}`;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`KanbanBananas: copied ${text}`, 3000);
    return text;
  }

  uriFor(path: string): vscode.Uri | undefined {
    return this.source?.uriFor(path);
  }

  async openCardById(id: string): Promise<void> {
    const card = this.board()?.cards.find((c) => c.card.fields.id === id);
    if (card) await this.openCard(card.path);
  }

  async openCard(path: string): Promise<void> {
    // Only open files the board knows about; the path comes from the webview.
    if (!this.source?.has(path)) return;
    await vscode.window.showTextDocument(this.source.uriFor(path), { preview: false });
  }

  private async findRoot(): Promise<vscode.Uri | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, ...this.settings.featuresDirectory.split('/').filter(Boolean));
      try {
        if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) return uri;
      } catch {
        // not in this folder
      }
    }
    return undefined;
  }

  /** The features folder, once found. */
  get root(): vscode.Uri | undefined {
    return this.source?.root;
  }

  dispose(): void {
    this.cliServer?.dispose();
    this.sourceSub?.dispose();
    this.source?.dispose();
    this.changed.dispose();
    for (const s of this.subs) s.dispose();
  }
}
