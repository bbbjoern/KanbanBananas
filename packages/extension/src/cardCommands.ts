import type { BoardCard } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';

/** What VS Code passes to a webview/context command: the card's data-vscode-context. */
interface CardContext {
  cardId?: string;
}

const PRIORITIES = ['critical', 'high', 'medium', 'low'];

/** Commands behind the card's right-click menu. Each ends in one store intent. */
export function registerCardCommands(controller: BoardController): vscode.Disposable {
  const withCard = (fn: (card: BoardCard) => Promise<void>) => async (ctx: CardContext | undefined) => {
    const card = controller.board()?.cards.find((c) => c.card.fields.id === ctx?.cardId);
    if (card) await fn(card);
  };
  const set = (card: BoardCard, changes: Parameters<BoardController['setFields']>[0]['changes']) =>
    controller.setFields({ id: card.card.fields.id!, changes });

  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      'kanbanBananas.card.open',
      withCard((card) => controller.openCard(card.path)),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.card.copyPath',
      withCard(async (card) => {
        await controller.copyCardPath(card.path);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.card.setPriority',
      withCard(async (card) => {
        const current = card.card.fields.priority;
        const pick = await vscode.window.showQuickPick(
          [...PRIORITIES.map((p) => ({ label: p, picked: p === current })), { label: 'None', value: null }],
          { title: `Priority: ${card.card.title ?? card.filename}`, placeHolder: current ?? 'none' },
        );
        if (pick) await set(card, { priority: 'value' in pick ? null : pick.label });
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.card.editLabels',
      withCard(async (card) => {
        const current = card.card.fields.labels;
        const all = [...new Set([...(controller.board()?.cards ?? []).flatMap((c) => c.card.fields.labels), ...current])].sort();
        const NEW = '$(add) New labels…';
        const picks = await vscode.window.showQuickPick(
          [...all.map((l) => ({ label: l, picked: current.includes(l) })), { label: NEW, alwaysShow: true }],
          { title: `Labels: ${card.card.title ?? card.filename}`, canPickMany: true },
        );
        if (!picks) return;
        const labels = picks.filter((p) => p.label !== NEW).map((p) => p.label);
        if (picks.some((p) => p.label === NEW)) {
          const typed = await vscode.window.showInputBox({ title: 'New labels', prompt: 'Comma-separated' });
          if (typed === undefined) return;
          labels.push(...typed.split(',').map((l) => l.trim()).filter(Boolean));
        }
        await set(card, { labels });
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.card.setDueDate',
      withCard(async (card) => {
        const value = await vscode.window.showInputBox({
          title: `Due date: ${card.card.title ?? card.filename}`,
          prompt: 'YYYY-MM-DD. Leave empty to clear.',
          value: card.card.fields.dueDate ?? '',
          validateInput: (v) => (v.trim() === '' || isDate(v.trim()) ? null : 'Use YYYY-MM-DD, e.g. 2026-10-01.'),
        });
        if (value !== undefined) await set(card, { dueDate: value.trim() || null });
      }),
    ),

    ...(['assignee', 'epic'] as const).map((field) =>
      vscode.commands.registerCommand(
        field === 'assignee' ? 'kanbanBananas.card.setAssignee' : 'kanbanBananas.card.setEpic',
        withCard(async (card) => {
          const value = await vscode.window.showInputBox({
            title: `${field === 'assignee' ? 'Assignee' : 'Epic'}: ${card.card.title ?? card.filename}`,
            prompt: 'Leave empty to clear.',
            value: card.card.fields[field] ?? '',
          });
          if (value !== undefined) await set(card, { [field]: value.trim() || null });
        }),
      ),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.card.moveTo',
      withCard(async (card) => {
        const columns = controller.settingsNow.view.columns.filter((c) => c.id !== card.card.fields.status);
        const pick = await vscode.window.showQuickPick(
          columns.map((c) => ({ label: c.name, id: c.id })),
          { title: `Move: ${card.card.title ?? card.filename}` },
        );
        if (pick) await controller.move({ id: card.card.fields.id!, toStatus: pick.id, beforeId: null });
      }),
    ),
  );
}

function isDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
