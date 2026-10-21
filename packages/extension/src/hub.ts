import { BodyConflictError, idForFilename, IntentError, PatchError, staleFields, type CardText, type HubIntent, type IntentAck } from '@kanban-bananas/core';
import { cardHash, ConflictError, HubClient, repoIdentityFor, type HubStatus, type WriteResult } from '@kanban-bananas/core/node';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { log } from './log.js';
import { SECTION } from './settings.js';

/**
 * The project hub, when the user turned it on: `kanbanBananas.hub.url` names
 * the hub, the token lives in VS Code's secret storage. With the URL unset
 * (the default) nothing here runs. The HubClient in core does the talking;
 * this host feeds it the board, applies its intents through the CardStore
 * (open editors, atomic writes and the three-way merge all honoured) and
 * shows the state in the status bar.
 */
export class HubHost implements vscode.Disposable {
  private client: HubClient | undefined;
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private status: HubStatus | undefined;
  private restarting: Promise<void> = Promise.resolve();

  constructor(
    private readonly controller: BoardController,
    private readonly secrets: vscode.SecretStorage,
    private readonly version: string,
  ) {
    this.item = vscode.window.createStatusBarItem('kanbanBananas.hub', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'KanbanBananas: Project hub';
    this.item.command = 'kanbanBananas.hub.status';
    this.subs.push(
      controller.onDidStart(() => this.restart()),
      controller.onDidChange(() => this.client?.notifyChanged()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.hub`)) this.restart();
        else if (e.affectsConfiguration(`${SECTION}.columns`)) this.client?.notifyColumns();
      }),
      secrets.onDidChange((e) => {
        if (e.key === tokenKey(this.url())) this.restart();
      }),
    );
  }

  /** The hub URL from the settings, without a trailing slash; empty when the hub is off. */
  url(): string {
    return (vscode.workspace.getConfiguration(SECTION).get<string>('hub.url') ?? '').trim().replace(/\/+$/, '');
  }

  /** `kanbanBananas.hub.shareText`: off means the hub gets titles and fields only, never a card's text. */
  shareText(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('hub.shareText') ?? true;
  }

  /** Stop the client and start a new one when a hub, a token and a board are there. */
  restart(): void {
    this.restarting = this.restarting.then(() => this.doRestart()).catch((e) => log.error(`Hub: restart failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  private async doRestart(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = undefined;
    }
    const url = this.url();
    if (!url) {
      this.item.hide();
      return;
    }
    const root = this.controller.root;
    if (!root) {
      this.showText('$(cloud) Hub: no board', 'The hub syncs the board once there is one.');
      return;
    }
    const token = await this.secrets.get(tokenKey(url));
    if (!token) {
      this.showText('$(cloud) Hub: no token', `No token for ${url}. Run "KanbanBananas: Project Hub: Set Token…".`);
      return;
    }
    const repo = repoIdentityFor(root.fsPath);
    this.client = new HubClient({
      hub: { url, token },
      repo,
      client: { kind: 'extension', version: this.version },
      columns: () => this.controller.settingsNow.view.columns,
      files: () => this.controller.boardFiles(),
      apply: (intent) => this.apply(intent),
      fieldsOnly: !this.shareText(),
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
      onStatus: (s) => this.renderStatus(s),
    });
    log.info(`Hub: connecting to ${url} for ${repo.remote} (${repo.featuresDir})${this.shareText() ? '' : ', titles and fields only'}`);
    this.client.start();
  }

  async setToken(): Promise<void> {
    const url = this.url();
    if (!url) {
      void vscode.window.showWarningMessage('KanbanBananas: set the hub URL first (setting "kanbanBananas.hub.url").');
      return;
    }
    const token = await vscode.window.showInputBox({
      title: `Token for ${url}`,
      prompt: 'The machine token the hub gave you. It is kept in VS Code\'s secret storage, not in the settings.',
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (!token.trim()) {
      await this.secrets.delete(tokenKey(url));
      return;
    }
    await this.secrets.store(tokenKey(url), token.trim());
    void vscode.window.showInformationMessage(`KanbanBananas: token for ${url} saved.`);
  }

  async clearToken(): Promise<void> {
    const url = this.url();
    if (!url) return;
    await this.secrets.delete(tokenKey(url));
    void vscode.window.showInformationMessage(`KanbanBananas: token for ${url} removed.`);
  }

  async showStatus(): Promise<void> {
    const url = this.url();
    const s = this.status;
    const detail = !url
      ? 'The hub is off: no URL in the settings.'
      : !this.client
        ? this.item.tooltip?.toString() ?? ''
        : `${s?.state ?? 'off'}${s?.message ? `: ${s.message}` : ''}${s?.lastSyncAt ? ` · last sync ${new Date(s.lastSyncAt).toLocaleTimeString()}` : ''}${this.shareText() ? '' : ' · titles and fields only'}`;
    const pick = await vscode.window.showQuickPick(
      [
        { label: url ? `$(cloud) ${url}` : '$(cloud) No hub', detail, action: 'none' },
        { label: '$(sync) Reconnect', action: 'reconnect' },
        { label: '$(key) Set token…', action: 'set' },
        { label: '$(trash) Clear token', action: 'clear' },
        { label: '$(output) Show log', action: 'log' },
      ],
      { title: 'KanbanBananas: Project hub' },
    );
    switch (pick?.action) {
      case 'reconnect':
        this.restart();
        return;
      case 'set':
        await this.setToken();
        return;
      case 'clear':
        await this.clearToken();
        return;
      case 'log':
        log.show();
        return;
    }
  }

  private renderStatus(s: HubStatus): void {
    this.status = s;
    const icon = { off: '$(cloud)', connecting: '$(sync~spin)', connected: '$(cloud)', offline: '$(cloud-offline)', refused: '$(warning)' }[s.state];
    const text = { off: 'Hub', connecting: 'Hub…', connected: 'Hub', offline: 'Hub: offline', refused: 'Hub: refused' }[s.state];
    const when = s.lastSyncAt ? `Last sync ${new Date(s.lastSyncAt).toLocaleTimeString()}, ${s.cards} card(s).` : 'Not synced yet.';
    this.showText(`${icon} ${text}`, `${this.url()}\n${s.state}${s.message ? `: ${s.message}` : ''}\n${when}`);
  }

  private showText(text: string, tooltip: string): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  /** Apply a hub intent through the CardStore and answer with the card as written. */
  private async apply(intent: HubIntent): Promise<IntentAck> {
    const store = this.controller.cardStore;
    const board = this.controller.board();
    const fail = (code: Extract<IntentAck, { ok: false }>['code'], error: string, path?: string): IntentAck => {
      const card = path ? this.cardText(path) : undefined;
      return { intentId: intent.intentId, ok: false, code, error, ...(card ? { card } : {}) };
    };
    if (!store || !board) return fail('error', 'The board is not loaded.');
    const find = (id: string) => board.cards.find((c) => c.card.fields.id === id);
    const targetId = intent.op === 'create' ? undefined : intent.intent.id;
    try {
      let result: WriteResult;
      switch (intent.op) {
        case 'move':
        case 'set': {
          const card = find(intent.intent.id);
          if (!card) return fail('gone', `No card "${intent.intent.id}" on the board.`);
          const stale = staleFields(card.card.fields, intent.expect);
          if (stale.length > 0) return fail('stale', `${stale.join(', ')} changed since the change was planned.`, card.path);
          result = intent.op === 'move' ? await store.move(intent.intent) : await store.setFields(intent.intent);
          break;
        }
        case 'note':
        case 'saveBody': {
          const card = find(intent.intent.id);
          if (!card) return fail('gone', `No card "${intent.intent.id}" on the board.`);
          result = intent.op === 'note' ? await store.note(intent.intent) : await store.saveBody(intent.intent);
          break;
        }
        case 'create': {
          const s = this.controller.settingsNow;
          result = await store.create({ top: s.view.addNewCardsToTop, priority: s.defaultPriority, filenamePattern: s.filenamePattern, ...intent.intent });
          break;
        }
      }
      const card = this.cardText(result.path);
      if (!card) return fail('error', `${result.path} could not be read after writing.`);
      const from = targetId !== undefined && card.id !== targetId ? targetId : undefined;
      return { intentId: intent.intentId, ok: true, card, route: result.route, ...(from ? { from } : {}) };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const path = targetId !== undefined ? find(targetId)?.path : undefined;
      if (e instanceof BodyConflictError) return fail('conflict', error, path);
      if (e instanceof ConflictError) return fail('stale', error, path);
      if (e instanceof IntentError || e instanceof PatchError) return fail('invalid', error);
      return fail('error', error);
    }
  }

  private cardText(path: string): CardText | undefined {
    const text = this.controller.cardText(path);
    if (text === undefined) return undefined;
    return { id: idForFilename(path.slice(path.lastIndexOf('/') + 1)), path, hash: cardHash(text), text };
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.item.dispose();
    void this.client?.stop();
  }
}

function tokenKey(url: string): string {
  return `kanbanBananas.hub.token:${url}`;
}
