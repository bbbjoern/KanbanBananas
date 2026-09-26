import type { HostMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { attachBoard, webviewOptions } from './boardWebview.js';
import { registerCardCommands } from './cardCommands.js';
import { BoardController } from './controller.js';
import { createLog, log, reportError } from './log.js';
import { checkSkill, installSkill, skillInstalled } from './skill.js';

let panel: vscode.WebviewPanel | undefined;

/** Returned from `activate` so integration tests can inspect the board. */
export interface ExtensionApi {
  ready: Promise<void>;
  state: () => HostMessage;
  controller: BoardController;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  context.subscriptions.push(createLog());
  log.info(
    `Activated v${context.extension.packageJSON.version} on ${vscode.env.remoteName ? `remote "${vscode.env.remoteName}"` : 'this machine'}`,
  );
  const controller = new BoardController(String(context.extension.packageJSON.version));
  context.subscriptions.push(controller);
  const version = String(context.extension.packageJSON.version);
  const ready = controller.start();
  void ready.then(async () => {
    const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
    if (!folder) {
      log.info('No board folder found, so no skill check');
      return;
    }
    if (context.extensionMode === vscode.ExtensionMode.Test) return;
    try {
      await checkSkill(context.extensionUri, folder, version, context.workspaceState);
    } catch (e) {
      reportError('Agent skill check failed', e);
    }
  });

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
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
      const attached = attachBoard(panel.webview, context.extensionUri, 'panel', controller);
      panel.onDidDispose(() => {
        attached.dispose();
        panel = undefined;
      });
    }),

    vscode.commands.registerCommand('kanbanBananas.reload', () => controller.start()),

    vscode.commands.registerCommand('kanbanBananas.installSkill', async () => {
      log.info('Install / Update Agent Skill: started');
      const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
      if (!folder) {
        reportError('Install / Update Agent Skill', new Error('no board folder found in this workspace; open the project that holds the board first'));
        return;
      }
      try {
        await installSkill(context.extensionUri, folder, version);
      } catch (e) {
        reportError('Installing the agent skill failed', e);
      }
    }),

    vscode.commands.registerCommand('kanbanBananas.showLog', () => log.show()),

    // The skill's wording and policy.json follow the setting, so rewrite it when the setting changes.
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('kanbanBananas.agentsMayMoveCards')) return;
      const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
      if (!folder || !skillInstalled(folder)) return;
      try {
        await installSkill(context.extensionUri, folder, version, { quiet: true });
        void vscode.window.showInformationMessage('KanbanBananas: updated the agent skill to match your settings.');
      } catch (e) {
        reportError('Updating the agent skill failed', e);
      }
    }),
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
