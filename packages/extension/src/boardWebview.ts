import { createHash } from 'node:crypto';
import { BodyConflictError, MEMORY_EDITOR_ID, type HostMessage, type WebviewMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { showDiff } from './diffView.js';
import { log } from './log.js';

export type Layout = 'panel' | 'sidebar';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  // The workspace folders too, so the editor can show images pasted into cards.
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)],
  };
}

/** Load the board UI into a webview and keep it in sync with the controller. */
export interface AttachedBoard extends vscode.Disposable {
  /** Open a card in the split view, once the webview is ready. */
  select(id: string): void;
}

export function attachBoard(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  layout: Layout,
  controller: BoardController,
  /** Per-project storage for the page's view choices, which VS Code drops when the page closes. */
  memento: vscode.Memento,
): AttachedBoard {
  const uiKey = `kanbanBananas.ui.${layout}`;
  webview.html = html(webview, extensionUri, layout, memento.get(uiKey));
  const post = (m: HostMessage) => void webview.postMessage(m);
  const editor = new EditorSession(controller, post);
  // Board state plus where the page can load project files from (for /… image links).
  const state = (): HostMessage => {
    const s = controller.state();
    const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
    return s.type === 'state' && folder ? { ...s, assetBase: webview.asWebviewUri(folder.uri).toString() } : s;
  };
  let ready = false;
  let pendingSelect: string | null = null;

  const disposable = vscode.Disposable.from(
    webview.onDidReceiveMessage(async (m: WebviewMessage) => {
      // Messages with a requestId get an ack once handled: the page uses it to know the
      // change reached the extension (and that the connection is alive).
      let error: string | null = null;
      try {
        error = await handle(m);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        log.error(`Board message ${m.type} failed: ${error}`);
      }
      if (m.requestId && m.type !== 'saveImage') {
        post({ type: 'ack', requestId: m.requestId, ok: error === null, ...(error ? { error } : {}) });
      }
    }),
    controller.onDidChange(() => {
      if (!ready) return;
      post(state());
      editor.boardChanged();
    }),
  );

  /** Handle one message from the page; resolves to an error message, or null when done. */
  async function handle(m: WebviewMessage): Promise<string | null> {
      switch (m.type) {
        case 'ping':
          return null;
        case 'ready':
          if (m.reconnect) log.warn(`Board page (${layout}) reconnected after VS Code didn't answer it for ${ACK_SECONDS} s; sent it the board again`);
          else log.info(`Board page (${layout}) loaded: build ${m.build ?? 'unknown (older than 0.5.4)'}`);
          ready = true;
          post(state());
          if (pendingSelect) post({ type: 'selectCard', id: pendingSelect });
          pendingSelect = null;
          break;
        case 'openCard':
          void controller.openCard(m.path);
          break;
        case 'move':
          return controller.move({ id: m.id, toStatus: m.toStatus, beforeId: m.beforeId });
        case 'create':
          return controller.create({ title: m.title, status: m.status });
        case 'setFields':
          return controller.setFields({ id: m.id, changes: m.changes });
        case 'openEditor':
          editor.open(m.id);
          break;
        case 'closeEditor':
          editor.close();
          break;
        case 'saveBody':
          void editor.save(m.id, m.base, m.body);
          break;
        case 'showDiff':
          void editor.diff(m.id, m.mine);
          break;
        case 'search':
          post({ type: 'searchResults', query: m.query, ids: controller.search(m.query) });
          break;
        case 'laneCommand':
          log.info(`Board: lane ${m.action} (${m.field}${m.value ? ` "${m.value}"` : ''}${m.to ? ` → "${m.to}"` : ''})`);
          void vscode.commands.executeCommand(
            m.action === 'new' ? 'kanbanBananas.lane.new' : m.action === 'rename' ? 'kanbanBananas.lane.rename' : 'kanbanBananas.lane.delete',
            { field: m.field, value: m.value ?? null, ...(m.to !== undefined ? { to: m.to } : {}) },
          );
          break;
        case 'laneOrder':
          log.info(`Board: lane order (${m.field}): ${m.order.map((n) => n ?? '(none)').join(', ')}`);
          void controller
            .updateLanes(m.field, (lanes) =>
              m.order.map((name) => (name === null ? { name: '', none: true } : lanes.find((l) => l.name === name && !l.none) ?? { name })),
            )
            .catch((e) => log.error(`Saving the lane order failed: ${e instanceof Error ? e.message : String(e)}`));
          break;
        case 'uiState':
          void memento.update(uiKey, m.state);
          break;
        case 'columnCommand':
          log.info(`Board: column ${m.action}${m.status ? ` (${m.status})` : ''}${m.to ? ` → "${m.to}"` : ''}`);
          void vscode.commands.executeCommand(`kanbanBananas.column.${m.action}`, {
            ...(m.status ? { status: m.status } : {}),
            ...(m.to !== undefined ? { to: m.to } : {}),
          });
          break;
        case 'columnOrder':
          log.info(`Board: column order: ${m.order.join(', ')}`);
          void controller
            .updateColumns((cols) => m.order.map((id) => cols.find((c) => c.id === id)).filter((c) => c !== undefined))
            .catch((e) => log.error(`Saving the column order failed: ${e instanceof Error ? e.message : String(e)}`));
          break;
        case 'setupBoard':
          void vscode.commands.executeCommand('kanbanBananas.createBoard', m.action);
          break;
        case 'openMemory': {
          const uri = controller.memory.uri();
          if (uri) void vscode.workspace.fs.stat(uri).then(
            () => vscode.window.showTextDocument(uri, { preview: false }),
            () => vscode.window.showInformationMessage('KanbanBananas: no session memory yet. Agents add the first entry, e.g. with /session-memory in Claude Code.'),
          );
          break;
        }
        case 'copyPath':
          void controller.copyCardPath(m.path).then((text) => {
            if (text) post({ type: 'pathCopied', path: m.path, text });
          });
          break;
        case 'openSettings':
          // The id is publisher.name; look it up rather than hard-coding the publisher.
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            `@ext:${vscode.extensions.all.find((e) => e.packageJSON?.name === 'kanban-bananas')?.id ?? 'kanban-bananas'}`,
          );
          break;
        case 'labelCommand':
          void vscode.commands.executeCommand(m.action === 'rename' ? 'kanbanBananas.renameLabel' : 'kanbanBananas.deleteLabel', m.label);
          break;
        case 'saveImage':
          void controller.images
            .save(m.id, Buffer.from(m.data, 'base64'), m.ext)
            .then((link) => post({ type: 'imageSaved', requestId: m.requestId, link }))
            .catch((e) => {
              const message = e instanceof Error ? e.message : String(e);
              log.error(`Saving a pasted image failed: ${message}`);
              post({ type: 'imageError', requestId: m.requestId, message });
            });
          break;
        case 'clientLog':
          log.info(`Board page: ${m.message}`);
          break;
        case 'clientError':
          log.error(`Board webview (${layout}): ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
          controller.clientErrors.push(m.message + (m.stack ? '\n' + m.stack.split('\n').slice(0, 6).join('\n') : ''));
          break;
        case 'editorShown':
          controller.shownInEditor.push(m.id);
          break;
      }
      return null;
  }

  return {
    dispose: () => disposable.dispose(),
    select: (id) => {
      if (ready) post({ type: 'selectCard', id });
      else pendingSelect = id;
    },
  };
}

/**
 * The inline editor's side of the conversation for one webview. Tracks the
 * body the webview last knew, so it pushes only real outside changes; the
 * board's own writes of that same text are recognised and not echoed (§2.7).
 */
class EditorSession {
  private id: string | null = null;
  private known: string | null = null;

  constructor(
    private readonly controller: BoardController,
    private readonly post: (m: HostMessage) => void,
  ) {}

  open(id: string): void {
    const card = this.controller.editorDoc(id);
    if (!card) {
      this.post({ type: 'editorClosed', id, reason: id === MEMORY_EDITOR_ID ? 'Session memory is off.' : 'The card is broken or gone.' });
      return;
    }
    this.id = id;
    this.known = card.body;
    this.post({ type: 'editorBody', id, path: card.path, body: card.body });
  }

  close(): void {
    this.id = null;
    this.known = null;
  }

  /** After any board change: push the body if someone else changed it. */
  boardChanged(): void {
    if (this.id === null) return;
    const card = this.controller.editorDoc(this.id);
    if (!card) {
      this.post({ type: 'editorClosed', id: this.id, reason: 'The card was deleted, renamed or can no longer be read.' });
      this.close();
      return;
    }
    if (card.body === this.known) return;
    this.known = card.body;
    this.post({ type: 'editorBody', id: this.id, path: card.path, body: card.body });
  }

  /**
   * The page ignores outside changes while its save is in flight (the save's
   * answer carries the merged text). One that lands after the merge, before the
   * answer, would be missed, so once the answer is out, push whatever is newer.
   */
  async save(id: string, base: string, body: string): Promise<void> {
    try {
      const result = await this.controller.saveEditorDoc({ id, base, body });
      log.info(
        `Inline editor saved ${id}: base ${hash(base)}, sent ${hash(body)}, stored ${hash(result)}` +
          (result === body ? '' : ' (merged with outside changes)'),
      );
      if (this.id === id) this.known = result;
      this.post({ type: 'bodySaved', id, body: result });
    } catch (e) {
      if (e instanceof BodyConflictError) {
        log.warn(`Inline editor conflict on ${id}: base ${hash(base)}, sent ${hash(body)}, theirs ${hash(e.theirs)}`);
        if (this.id === id) this.known = e.theirs;
        this.post({ type: 'bodyConflict', id, theirs: e.theirs });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      log.error(`Saving ${id} from the inline editor failed: ${message}`);
      this.post({ type: 'bodyError', id, message });
      if (this.id === id) this.known = null; // the page may have missed changes meanwhile: send the current text
    }
    if (this.id === id) this.boardChanged();
  }

  async diff(id: string, mine: string): Promise<void> {
    const card = this.controller.editorDoc(id);
    if (card) await showDiff(card.body, mine, card.path.slice(card.path.lastIndexOf('/') + 1));
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri, layout: Layout, uiState: unknown): string {
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name));
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('index.css')}">
</head>
<body data-layout="${layout}">
  <div id="root"></div>
  <script nonce="${nonce}">window.__KANBAN_UI_STATE__ = ${JSON.stringify(uiState ?? null).replace(/</g, '\\u003c')};</script>
  <script type="module" nonce="${nonce}" src="${asset('index.js')}"></script>
</body>
</html>`;
}

/** How long the page waits for an answer before it calls the connection lost (webview connection.ts). */
const ACK_SECONDS = 8;

/** A short fingerprint of a text, for the log (to reconstruct what was saved over what). */
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}
