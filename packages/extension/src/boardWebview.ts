import { BodyConflictError, type HostMessage, type WebviewMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { showDiff } from './diffView.js';
import { log } from './log.js';

export type Layout = 'panel' | 'sidebar';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')] };
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
): AttachedBoard {
  webview.html = html(webview, extensionUri, layout);
  const post = (m: HostMessage) => void webview.postMessage(m);
  const editor = new EditorSession(controller, post);
  let ready = false;
  let pendingSelect: string | null = null;

  const disposable = vscode.Disposable.from(
    webview.onDidReceiveMessage((m: WebviewMessage) => {
      switch (m.type) {
        case 'ready':
          ready = true;
          post(controller.state());
          if (pendingSelect) post({ type: 'selectCard', id: pendingSelect });
          pendingSelect = null;
          break;
        case 'openCard':
          void controller.openCard(m.path);
          break;
        case 'move':
          void controller.move({ id: m.id, toStatus: m.toStatus, beforeId: m.beforeId });
          break;
        case 'create':
          void controller.create({ title: m.title, status: m.status });
          break;
        case 'setFields':
          void controller.setFields({ id: m.id, changes: m.changes });
          break;
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
        case 'clientError':
          log.error(`Board webview (${layout}): ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
          controller.clientErrors.push(m.message + (m.stack ? '\n' + m.stack.split('\n').slice(0, 6).join('\n') : ''));
          break;
        case 'editorShown':
          controller.shownInEditor.push(m.id);
          break;
      }
    }),
    controller.onDidChange(() => {
      if (!ready) return;
      post(controller.state());
      editor.boardChanged();
    }),
  );
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
    const card = this.controller.cardBody(id);
    if (!card) {
      this.post({ type: 'editorClosed', id, reason: 'The card is broken or gone.' });
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
    const card = this.controller.cardBody(this.id);
    if (!card) {
      this.post({ type: 'editorClosed', id: this.id, reason: 'The card was deleted, renamed or can no longer be read.' });
      this.close();
      return;
    }
    if (card.body === this.known) return;
    this.known = card.body;
    this.post({ type: 'editorBody', id: this.id, path: card.path, body: card.body });
  }

  async save(id: string, base: string, body: string): Promise<void> {
    try {
      const result = await this.controller.saveBody({ id, base, body });
      if (this.id === id) this.known = result;
      this.post({ type: 'bodySaved', id, body: result });
    } catch (e) {
      if (e instanceof BodyConflictError) {
        log.warn(`Inline editor conflict on ${id}`);
        if (this.id === id) this.known = e.theirs;
        this.post({ type: 'bodyConflict', id, theirs: e.theirs });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      log.error(`Saving ${id} from the inline editor failed: ${message}`);
      this.post({ type: 'bodyError', id, message });
    }
  }

  async diff(id: string, mine: string): Promise<void> {
    const card = this.controller.cardBody(id);
    if (card) await showDiff(card.body, mine, card.path.slice(card.path.lastIndexOf('/') + 1));
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri, layout: Layout): string {
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name));
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
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
  <script type="module" nonce="${nonce}" src="${asset('index.js')}"></script>
</body>
</html>`;
}
