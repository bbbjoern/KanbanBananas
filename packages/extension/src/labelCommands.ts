import * as vscode from 'vscode';
import type { BoardController } from './controller.js';

/** Rename or delete a label across all cards (spec §5, label management). */
export function registerLabelCommands(controller: BoardController): vscode.Disposable {
  const pick = async (title: string, preset?: string) => {
    if (preset) return preset;
    const labels = controller.labels();
    if (labels.length === 0) {
      void vscode.window.showInformationMessage('KanbanBananas: no card has a label yet.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(
      labels.map((l) => ({ label: l.label, description: `${l.count} card${l.count === 1 ? '' : 's'}` })),
      { title },
    );
    return choice?.label;
  };

  const report = (verb: string, result: { changed: number; failed: string[] }) => {
    if (result.failed.length === 0) {
      void vscode.window.showInformationMessage(`KanbanBananas: ${verb} on ${result.changed} card${result.changed === 1 ? '' : 's'}.`);
    } else {
      void vscode.window.showWarningMessage(
        `KanbanBananas: ${verb} on ${result.changed} card(s); ${result.failed.length} couldn't be changed: ${result.failed.join('; ')}`,
      );
    }
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand('kanbanBananas.renameLabel', async (preset?: string) => {
      const from = await pick('Rename which label?', preset);
      if (!from) return;
      const to = (
        await vscode.window.showInputBox({
          title: `Rename label "${from}"`,
          value: from,
          prompt: 'New name. If another label already has this name, the two are merged.',
          validateInput: (v) => (v.trim() === '' ? 'Enter a name.' : v.includes(',') ? 'Labels cannot contain commas.' : null),
        })
      )?.trim();
      if (!to || to === from) return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Renaming "${from}" to "${to}"…` },
        () => controller.relabelAll(from, to),
      );
      report(`renamed "${from}" to "${to}"`, result);
    }),

    vscode.commands.registerCommand('kanbanBananas.deleteLabel', async (preset?: string) => {
      const label = await pick('Delete which label?', preset);
      if (!label) return;
      const count = controller.labels().find((l) => l.label === label)?.count ?? 0;
      const ok = await vscode.window.showWarningMessage(
        `Remove the label "${label}" from ${count} card${count === 1 ? '' : 's'}? The cards themselves stay.`,
        { modal: true },
        'Remove Label',
      );
      if (ok !== 'Remove Label') return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Removing "${label}"…` },
        () => controller.relabelAll(label, null),
      );
      report(`removed "${label}"`, result);
    }),
  );
}
