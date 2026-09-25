import type { HostMessage, WebviewMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';

export type Layout = 'panel' | 'sidebar';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')] };
}

/** Load the board UI into a webview and keep it in sync with the controller. */
export function attachBoard(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  layout: Layout,
  controller: BoardController,
): vscode.Disposable {
  webview.html = html(webview, extensionUri, layout);
  const post = (m: HostMessage) => void webview.postMessage(m);
  let ready = false;

  return vscode.Disposable.from(
    webview.onDidReceiveMessage((m: WebviewMessage) => {
      if (m.type === 'ready') {
        ready = true;
        post(controller.state());
      } else if (m.type === 'openCard') {
        void controller.openCard(m.path);
      }
    }),
    controller.onDidChange(() => {
      if (ready) post(controller.state());
    }),
  );
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
