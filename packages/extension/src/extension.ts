import type { HostMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { attachBoard, webviewOptions } from './boardWebview.js';
import { registerCardCommands } from './cardCommands.js';
import { BoardController } from './controller.js';

let panel: vscode.WebviewPanel | undefined;

/** Returned from `activate` so integration tests can inspect the board. */
export interface ExtensionApi {
  ready: Promise<void>;
  state: () => HostMessage;
  controller: BoardController;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const controller = new BoardController();
  context.subscriptions.push(controller);
  const ready = controller.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('kanbanBananas.openBoard', () => {
      if (panel) {
        panel.reveal();
        return;
      }
      panel = vscode.window.createWebviewPanel('kanbanBananas.board', 'KanbanBananas', vscode.ViewColumn.Active, {
        ...webviewOptions(context.extensionUri),
        retainContextWhenHidden: true,
      });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'board.svg');
      const attached = attachBoard(panel.webview, context.extensionUri, 'panel', controller);
      panel.onDidDispose(() => {
        attached.dispose();
        panel = undefined;
      });
    }),

    vscode.commands.registerCommand('kanbanBananas.reload', () => controller.start()),
    registerCardCommands(controller),

    vscode.window.registerWebviewViewProvider('kanbanBananas.sidebar', {
      resolveWebviewView(view) {
        view.webview.options = webviewOptions(context.extensionUri);
        const attached = attachBoard(view.webview, context.extensionUri, 'sidebar', controller);
        view.onDidDispose(() => attached.dispose());
      },
    }),
  );

  return { ready, state: () => controller.state(), controller };
}

export function deactivate(): void {}
