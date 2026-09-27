import { parseCard, type CreateIntent, type HostMessage, type MoveIntent, type SaveBodyIntent, type SetFieldsIntent } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { BoardSource } from './boardSource.js';
import { CardStore } from './cardStore.js';
import { CliServer } from './cliServer.js';
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
  readonly shownInEditor: string[] = [];

  constructor(private readonly version: string) {
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration('kanban-markdown')) return;
        const dirChanged = readSettings().featuresDirectory !== this.settings.featuresDirectory;
        this.settings = readSettings();
        if (dirChanged) void this.start();
        else this.changed.fire();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.start()),
    );
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
      this.problem = `No "${this.settings.featuresDirectory}" folder in this workspace. Set kanbanBananas.featuresDirectory to the folder that holds your cards.`;
      this.changed.fire();
      return;
    }
    const source = new BoardSource(root, () => this.settings.view.columns.map((c) => c.id));
    this.source = source;
    this.store = new CardStore(source);
    this.sourceSub = source.onDidChange(() => this.changed.fire());
    await source.reload();

    const server = new CliServer(root.fsPath, this.store, () => this.settings, this.version);
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

  state(): HostMessage {
    if (this.problem) return { type: 'error', message: this.problem };
    if (!this.source) return { type: 'error', message: 'Loading…' };
    return { type: 'state', board: this.source.view(), settings: this.settings.view };
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

  move(intent: MoveIntent): Promise<void> {
    return this.write((store) => store.move(intent));
  }

  setFields(intent: SetFieldsIntent): Promise<void> {
    return this.write((store) => store.setFields(intent));
  }

  create(intent: Omit<CreateIntent, 'top' | 'priority'>): Promise<void> {
    const full = { ...intent, top: this.settings.view.addNewCardsToTop, priority: this.settings.defaultPriority };
    return this.write((store) => store.create(full));
  }

  /** Run a change; on failure, tell the user and redraw so optimistic UI snaps back. */
  private async write(change: (store: CardStore) => Promise<unknown>): Promise<void> {
    try {
      if (!this.store) throw new Error('The board is not loaded.');
      await change(this.store);
    } catch (e) {
      log.error(`Change failed: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showErrorMessage(`KanbanBananas: ${e instanceof Error ? e.message : String(e)}`);
      this.changed.fire();
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

  /** Save the inline editor's body. Throws BodyConflictError and others to the caller, which reports them. */
  async saveBody(intent: SaveBodyIntent): Promise<string> {
    if (!this.store) throw new Error('The board is not loaded.');
    await this.store.saveBody(intent);
    const now = this.cardBody(intent.id);
    if (!now) throw new Error('The card is gone after saving.');
    return now.body;
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
