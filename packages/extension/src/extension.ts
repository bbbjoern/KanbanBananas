import type { HostMessage } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { attachBoard, webviewOptions, type AttachedBoard } from './boardWebview.js';
import { CardHeaderLens } from './codeLens.js';
import { registerCardCommands } from './cardCommands.js';
import { BoardController } from './controller.js';
import { registerDiffProvider } from './diffView.js';
import { registerBoardCommands } from './boardCommands.js';
import { registerLabelCommands } from './labelCommands.js';
import { registerImagePasteAndDrop } from './images.js';
import { storeImagesWithLfs } from './lfs.js';
import { installPreCommitHook } from './preCommit.js';
import { setupBoard } from './setup.js';
import { createLog, log, reportError } from './log.js';
import { checkSkill, installSkill, skillInstalled, skillState, type SkillState } from './skill.js';

let panel: { view: vscode.WebviewPanel; board: AttachedBoard } | undefined;

/** Returned from `activate` so integration tests can inspect the board. */
export interface ExtensionApi {
  ready: Promise<void>;
  state: () => HostMessage;
  controller: BoardController;
  skillState: () => Promise<SkillState | null>;
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
  // The skill check runs once a board exists: now, or after the board is created on first run.
  const afterBoardReady = async () => {
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
  };
  void ready.then(afterBoardReady);

  const openBoard = (): AttachedBoard => {
    if (panel) {
      panel.view.reveal();
      return panel.board;
    }
    const view = vscode.window.createWebviewPanel('kanbanBananas.board', 'KanbanBananas', vscode.ViewColumn.Active, {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    });
    view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    const board = attachBoard(view.webview, context.extensionUri, 'panel', controller, context.workspaceState);
    panel = { view, board };
    view.onDidDispose(() => {
      board.dispose();
      panel = undefined;
    });
    return board;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('kanbanBananas.openBoard', () => openBoard()),

    vscode.commands.registerCommand('kanbanBananas.card.showOnBoard', (ctx: { cardId?: string } | undefined) => {
      const board = openBoard();
      if (ctx?.cardId) board.select(ctx.cardId);
    }),

    vscode.languages.registerCodeLensProvider({ language: 'markdown' }, new CardHeaderLens(controller)),

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

    registerImagePasteAndDrop(controller, controller.images),

    vscode.commands.registerCommand('kanbanBananas.createBoard', async (action?: 'create' | 'choose' | 'openFolder') => {
      try {
        if (await setupBoard(controller, action ?? 'create')) void afterBoardReady();
      } catch (e) {
        reportError('Setting up the board failed', e);
      }
    }),

    vscode.commands.registerCommand('kanbanBananas.imagesWithLfs', async () => {
      const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
      if (!folder) return reportError('Store Images with Git LFS', new Error('no board folder found in this workspace'));
      try {
        await storeImagesWithLfs(folder, controller.settingsNow.imagesFolder);
      } catch (e) {
        reportError('Setting up Git LFS failed', e);
      }
    }),

    vscode.commands.registerCommand('kanbanBananas.installPreCommitHook', async () => {
      const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
      if (!folder || !controller.root) {
        reportError('Install Pre-commit Hook', new Error('no board folder found in this workspace'));
        return;
      }
      try {
        // The hook runs the skill's CLI, so make sure the skill is there and current.
        if (!skillInstalled(folder)) await installSkill(context.extensionUri, folder, version, { quiet: true });
        await installPreCommitHook(folder, controller.root);
      } catch (e) {
        reportError('Installing the pre-commit hook failed', e);
      }
    }),

    // The skill's wording and policy.json follow the setting, so rewrite it when the setting changes.
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      // Also the columns: the skill lists them and the CLI accepts only those statuses.
      if (!e.affectsConfiguration('kanbanBananas.agentsMayMoveCards') && !e.affectsConfiguration('kanbanBananas.columns')) return;
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
    registerDiffProvider(),
    registerLabelCommands(controller),
    registerBoardCommands(controller),

    vscode.window.registerWebviewViewProvider('kanbanBananas.sidebar', {
      resolveWebviewView(view) {
        view.webview.options = webviewOptions(context.extensionUri);
        const attached = attachBoard(view.webview, context.extensionUri, 'sidebar', controller, context.workspaceState);
        view.onDidDispose(() => attached.dispose());
      },
    }),
  );

  return {
    ready,
    state: () => controller.state(),
    controller,
    skillState: async () => {
      const folder = controller.root && vscode.workspace.getWorkspaceFolder(controller.root);
      return folder ? skillState(context.extensionUri, folder, version) : null;
    },
  };
}

export function deactivate(): void {}
