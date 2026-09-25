import type { HostMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { BoardSource } from './boardSource.js';
import { readSettings, SECTION, type Settings } from './settings.js';

/**
 * Owns the board for the workspace: finds the features folder, keeps a
 * BoardSource on it, and tells webviews when to redraw. Read-only (M1).
 */
export class BoardController implements vscode.Disposable {
  private settings: Settings = readSettings();
  private source: BoardSource | undefined;
  private sourceSub: vscode.Disposable | undefined;
  private problem: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
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
    this.source = undefined;
    this.problem = undefined;

    const root = await this.findRoot();
    if (!root) {
      this.problem = `No "${this.settings.featuresDirectory}" folder in this workspace. Set kanbanBananas.featuresDirectory to the folder that holds your cards.`;
      this.changed.fire();
      return;
    }
    const source = new BoardSource(root, () => this.settings.view.columns.map((c) => c.id));
    this.source = source;
    this.sourceSub = source.onDidChange(() => this.changed.fire());
    await source.reload();
  }

  state(): HostMessage {
    if (this.problem) return { type: 'error', message: this.problem };
    if (!this.source) return { type: 'error', message: 'Loading…' };
    return { type: 'state', board: this.source.view(), settings: this.settings.view };
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

  dispose(): void {
    this.sourceSub?.dispose();
    this.source?.dispose();
    this.changed.dispose();
    for (const s of this.subs) s.dispose();
  }
}
