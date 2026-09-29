import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { SECTION } from './settings.js';

/** First run, when the workspace has no board yet. Called from the board's welcome and the Command Palette. */
export async function setupBoard(controller: BoardController, action: 'create' | 'choose' | 'openFolder'): Promise<boolean> {
  if (action === 'openFolder') {
    await vscode.commands.executeCommand('workbench.action.files.openFolder');
    return false;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('KanbanBananas: open the project folder first; the board lives inside it.');
    return false;
  }

  if (action === 'create') {
    const folder =
      folders.length === 1
        ? folders[0]!
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Create the board in which folder?' });
    if (!folder) return false;
    await controller.createBoard(folder);
    return true;
  }

  // Use an existing folder: it must be inside a workspace folder, and becomes the featuresDirectory setting.
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: folders[0]!.uri,
    openLabel: 'Use as Board Folder',
    title: 'Choose the folder that holds your cards',
  });
  const uri = picked?.[0];
  if (!uri) return false;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    void vscode.window.showErrorMessage('KanbanBananas: choose a folder inside the open project.');
    return false;
  }
  const rel = relative(folder.uri.fsPath, uri.fsPath).split(sep).join('/');
  await vscode.workspace.getConfiguration(SECTION).update('featuresDirectory', rel || '.', vscode.ConfigurationTarget.Workspace);
  // The settings change restarts the board (see BoardController); wait until it has loaded.
  await new Promise<void>((resolve) => {
    const done = () => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = controller.onDidChange(() => controller.root && done());
    const timer = setTimeout(done, 5000);
  });
  return controller.root !== undefined;
}
