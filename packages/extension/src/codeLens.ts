import { parseCard } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { SECTION } from './settings.js';

/**
 * Native mode's header (spec §5): one row of CodeLens links above a card's
 * frontmatter in VS Code's own editor. Lenses aren't part of the text, so
 * showing or refreshing them can't move the cursor. The row always has the
 * same items, so its height never changes. Each link runs a card command,
 * which goes through the CardStore like every other change.
 */
export class CardHeaderLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly controller: BoardController) {
    controller.onDidChange(() => this.changed.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.showHeaderInEditor`) || e.affectsConfiguration(`${SECTION}.columns`)) this.changed.fire();
    });
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration(SECTION).get<boolean>('showHeaderInEditor', true)) return [];
    const root = this.controller.root;
    if (!root || !isCardFile(root, doc.uri)) return [];

    const top = new vscode.Range(0, 0, 0, 0);
    const parsed = parseCard(doc.getText());
    if (!parsed.ok) {
      return [new vscode.CodeLens(top, { title: `$(warning) Not a valid card: ${parsed.error.message}`, command: '' })];
    }
    const f = parsed.card.fields;
    const ctx = { cardId: f.id };
    const column = this.controller.settingsNow.view.columns.find((c) => c.id === f.status);
    const lens = (title: string, command: string, tooltip: string) =>
      new vscode.CodeLens(top, { title, command, arguments: [ctx], tooltip });

    return [
      lens(`$(layout) ${column?.name ?? f.status ?? 'No status'}`, 'kanbanBananas.card.moveTo', 'Move to another column'),
      lens(`Priority: ${cap(f.priority) ?? 'none'}`, 'kanbanBananas.card.setPriority', 'Set priority'),
      lens(`Labels: ${f.labels.length ? f.labels.join(', ') : 'none'}`, 'kanbanBananas.card.editLabels', 'Edit labels'),
      lens(`Due: ${f.dueDate?.slice(0, 10) ?? 'none'}`, 'kanbanBananas.card.setDueDate', 'Set due date'),
      lens(`Assignee: ${f.assignee ?? 'none'}`, 'kanbanBananas.card.setAssignee', 'Set assignee'),
      lens(`Epic: ${f.epic ?? 'none'}`, 'kanbanBananas.card.setEpic', 'Set epic'),
      lens('$(link-external) Board', 'kanbanBananas.card.showOnBoard', 'Show this card on the board'),
    ];
  }
}

function isCardFile(root: vscode.Uri, uri: vscode.Uri): boolean {
  if (uri.scheme !== root.scheme || !uri.path.endsWith('.md')) return false;
  const prefix = root.path.endsWith('/') ? root.path : root.path + '/';
  if (!uri.path.startsWith(prefix)) return false;
  const rel = uri.path.slice(prefix.length);
  return !rel.includes('/') || (rel.startsWith('done/') && !rel.slice(5).includes('/'));
}

function cap(s: string | null): string | null {
  return s ? s[0]!.toUpperCase() + s.slice(1) : null;
}
