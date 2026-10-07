import { DONE_STATUS, GROUP_FIELDS, slugify, type GroupField } from '@kanban-bananas/core';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { log, reportError } from './log.js';

/** What VS Code passes from the board's right-click menus (data-vscode-context). */
interface MenuContext {
  cardId?: string;
  status?: string;
  field?: GroupField;
  value?: string | null;
  /** A new lane name typed on the board; skips the input box. */
  to?: string;
  /** The board's current lane order, null for the "none" lane (for Move Up/Down). */
  order?: (string | null)[];
  /** Deleting a column: where its cards go (a column id, or "archive"); skips the question. */
  moveTo?: string;
  /** Renaming a column: also change its status to match the name (true) or not (false); skips the question. */
  changeStatus?: boolean;
}

/** Colours offered for columns; new columns take the first one not in use. */
const COLUMN_COLORS: [string, string][] = [
  ['Grey', '#6b7280'],
  ['Blue', '#3b82f6'],
  ['Amber', '#f59e0b'],
  ['Violet', '#8b5cf6'],
  ['Green', '#22c55e'],
  ['Red', '#ef4444'],
  ['Teal', '#14b8a6'],
  ['Pink', '#ec4899'],
];

const FIELD_NAMES: Record<GroupField, string> = { epic: 'Epic', assignee: 'Assignee', priority: 'Priority', lane: 'Lane' };

/** Archive, delete, bulk column actions, lanes and the filename migration (spec §5, M5). */
export function registerBoardCommands(controller: BoardController): vscode.Disposable {
  const cardTitle = (id: string) => controller.board()?.cards.find((c) => c.card.fields.id === id)?.card.title ?? id;
  const columnName = (status: string) => controller.settingsNow.view.columns.find((c) => c.id === status)?.name ?? status;
  const summary = (verb: string, r: { changed: number; failed: string[] }) => {
    if (r.failed.length === 0) void vscode.window.showInformationMessage(`KanbanBananas: ${verb} ${r.changed} card${r.changed === 1 ? '' : 's'}.`);
    else void vscode.window.showWarningMessage(`KanbanBananas: ${verb} ${r.changed} card(s); ${r.failed.length} couldn't be changed: ${r.failed.join('; ')}`);
  };
  const guarded = (what: string, fn: (ctx: MenuContext) => Promise<void>) => async (ctx: MenuContext = {}) => {
    try {
      await fn(ctx);
    } catch (e) {
      reportError(what, e);
    }
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      'kanbanBananas.card.archive',
      guarded('Archiving failed', async ({ cardId }) => {
        if (cardId) await controller.archive(cardId);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.card.delete',
      guarded('Deleting the card failed', async ({ cardId }) => {
        if (!cardId) return;
        // Its images go with it, except those another card (active or archived) also links to.
        const images = await controller.images.ofCard(cardId);
        const n = images.own.length;
        const withImages = n ? `, together with its ${n} image${n === 1 ? '' : 's'}` : '';
        const kept = images.shared.length
          ? ` ${images.shared.length} image${images.shared.length === 1 ? ' is' : 's are'} kept because other cards use ${images.shared.length === 1 ? 'it' : 'them'}.`
          : '';
        const ok = await vscode.window.showWarningMessage(
          `Delete the card "${cardTitle(cardId)}"${withImages}? The files go to the trash.${kept}`,
          { modal: true },
          'Delete',
        );
        if (ok !== 'Delete') return;
        try {
          await controller.deleteCard(cardId, false);
          await controller.images.delete(images.own, false);
        } catch (e) {
          // Remote machines often have no trash. Ask before deleting for good.
          const again = await vscode.window.showWarningMessage(
            `This machine has no trash, so "${cardTitle(cardId)}" would be deleted permanently. If the card is committed, git can still restore it.`,
            { modal: true, detail: e instanceof Error ? e.message : String(e) },
            'Delete Permanently',
          );
          if (again === 'Delete Permanently') {
            if (controller.board()?.cards.some((c) => c.card.fields.id === cardId)) await controller.deleteCard(cardId, true);
            await controller.images.delete(images.own, true);
          }
        }
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.column.moveAll',
      guarded('Moving the cards failed', async ({ status }) => {
        if (!status) return;
        const count = controller.columnIds(status).length;
        if (count === 0) return void vscode.window.showInformationMessage(`KanbanBananas: ${columnName(status)} is empty.`);
        const target = await vscode.window.showQuickPick(
          controller.settingsNow.view.columns.filter((c) => c.id !== status).map((c) => ({ label: c.name, id: c.id })),
          { title: `Move all ${count} cards from ${columnName(status)} to…` },
        );
        if (!target) return;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Moving ${count} cards to ${target.label}…` },
          () => controller.moveAll(status, target.id),
        );
        summary(`moved to ${target.label}:`, r);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.column.archiveAll',
      guarded('Archiving the cards failed', async ({ status }) => {
        if (!status) return;
        const count = controller.columnIds(status).length;
        if (count === 0) return void vscode.window.showInformationMessage(`KanbanBananas: ${columnName(status)} is empty.`);
        const ok = await vscode.window.showWarningMessage(
          `Archive all ${count} cards in ${columnName(status)}? They move to archived/ and leave the board. "Restore Archived Card" brings one back.`,
          { modal: true },
          'Archive All',
        );
        if (ok !== 'Archive All') return;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Archiving ${count} cards…` },
          () => controller.archiveAll(status),
        );
        summary('archived', r);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.column.new',
      guarded('Adding the column failed', async (ctx) => {
        const columns = controller.settingsNow.view.columns;
        const name = (
          ctx?.to ??
          (await vscode.window.showInputBox({
            title: 'New column',
            prompt: 'Its name on the board. Cards in it get a status made from the name, e.g. "Blocked" → blocked.',
            validateInput: (v) => (v.trim() ? null : 'Enter a name.'),
          }))
        )?.trim();
        if (!name) return;
        const base = slugify(name) || 'column';
        let id = base;
        for (let n = 2; columns.some((c) => c.id === id); n++) id = `${base}-${n}`;
        const used = new Set(columns.map((c) => c.color.toLowerCase()));
        const color = COLUMN_COLORS.find(([, hex]) => !used.has(hex))?.[1] ?? COLUMN_COLORS[0]![1];
        // New columns go before Done when Done is last, else at the end.
        await controller.updateColumns((cols) =>
          cols.at(-1)?.id === DONE_STATUS ? [...cols.slice(0, -1), { id, name, color }, cols.at(-1)!] : [...cols, { id, name, color }],
        );
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.column.rename',
      guarded('Renaming the column failed', async ({ status, to: typed, changeStatus: given }) => {
        const column = controller.settingsNow.view.columns.find((c) => c.id === status);
        if (!column) return;
        const to = (
          typed ??
          (await vscode.window.showInputBox({
            title: `Rename column "${column.name}"`,
            value: column.name,
            prompt: `The name on the board. You can change the status in its cards ("${column.id}") to match next.`,
            validateInput: (v) => (v.trim() ? null : 'Enter a name.'),
          }))
        )?.trim();
        if (!to) return;
        // The status is what agents and the CLI use; offer to make it match the name (not for Done: done/ depends on it).
        const newStatus = slugify(to);
        const statusFree = !!newStatus && !controller.settingsNow.view.columns.some((c) => c.id === newStatus);
        const offerStatus = column.id !== DONE_STATUS && newStatus !== column.id && statusFree;
        if (to === column.name && !offerStatus) return;
        let changeStatus = false;
        if (offerStatus && given !== undefined) changeStatus = given;
        else if (offerStatus) {
          const count = controller.columnIds(column.id).length;
          const pick = await vscode.window.showInformationMessage(
            `Also change the status of "${to}" from "${column.id}" to "${newStatus}"?`,
            {
              modal: true,
              detail:
                `Agents and the kanban CLI refer to columns by their status, so a status that matches the name avoids mix-ups. ` +
                (count
                  ? `${count} card${count === 1 ? '' : 's'} in this column change their status line (and modified date). Archived cards keep the old status.`
                  : 'The column has no cards, so no file changes.'),
            },
            'Change Status Too',
            'Only the Name',
          );
          if (!pick) return;
          changeStatus = pick === 'Change Status Too';
        }
        if (!changeStatus) {
          if (to !== column.name) await controller.updateColumns((cols) => cols.map((c) => (c.id === column.id ? { ...c, name: to } : c)));
          return;
        }
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Changing status ${column.id} → ${newStatus}…` },
          () => controller.changeColumnStatus(column.id, newStatus, to),
        );
        if (r.failed.length) {
          void vscode.window.showWarningMessage(
            `KanbanBananas: ${r.failed.length} card(s) kept status "${column.id}", so that column was kept too: ${r.failed.join('; ')}`,
          );
        }
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.column.color',
      guarded('Changing the colour failed', async ({ status }) => {
        const column = controller.settingsNow.view.columns.find((c) => c.id === status);
        if (!column) return;
        const pick = await vscode.window.showQuickPick(
          [
            ...COLUMN_COLORS.map(([label, hex]) => ({ label, description: hex, hex, picked: hex === column.color })),
            { label: 'Custom…', description: 'Any CSS colour, e.g. #ff8800', hex: '' },
          ],
          { title: `Colour of "${column.name}"` },
        );
        if (!pick) return;
        const color = pick.hex || (await vscode.window.showInputBox({ title: 'Column colour', value: column.color }))?.trim();
        if (color) await controller.updateColumns((cols) => cols.map((c) => (c.id === column.id ? { ...c, color } : c)));
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.column.delete',
      guarded('Deleting the column failed', async ({ status, moveTo }) => {
        const columns = controller.settingsNow.view.columns;
        const column = columns.find((c) => c.id === status);
        if (!column) return;
        if (column.id === DONE_STATUS) {
          return void vscode.window.showInformationMessage(
            'KanbanBananas: the Done column can\'t be deleted: its cards live in done/ and get a completion date. You can rename it.',
          );
        }
        if (columns.length === 1) return void vscode.window.showInformationMessage('KanbanBananas: a board needs at least one column.');
        const count = controller.columnIds(column.id).length;
        let target = moveTo;
        if (count > 0 && !target) {
          const pick = await vscode.window.showQuickPick(
            [
              ...columns.filter((c) => c.id !== column.id).map((c) => ({ label: `Move them to ${c.name}`, target: c.id })),
              { label: 'Archive them', target: 'archive' },
            ],
            { title: `Delete "${column.name}": where should its ${count} card${count === 1 ? '' : 's'} go?` },
          );
          if (!pick) return;
          target = pick.target;
        } else if (count === 0) {
          const ok = await vscode.window.showWarningMessage(`Delete the empty column "${column.name}"?`, { modal: true }, 'Delete Column');
          if (ok !== 'Delete Column') return;
        }
        if (count > 0) {
          const r = target === 'archive' ? await controller.archiveAll(column.id) : await controller.moveAll(column.id, target!);
          if (r.failed.length > 0) {
            // Keep the column so no card is left with a status that has no column.
            return void vscode.window.showWarningMessage(
              `KanbanBananas: ${r.failed.length} card(s) couldn't be moved, so "${column.name}" was kept: ${r.failed.join('; ')}`,
            );
          }
        }
        await controller.updateColumns((cols) => cols.filter((c) => c.id !== column.id));
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.cleanUpImages',
      guarded('Cleaning up images failed', async () => {
        const unused = await controller.images.unused();
        const folder = controller.settingsNow.imagesFolder;
        if (unused.length === 0) return void vscode.window.showInformationMessage(`KanbanBananas: every image in ${folder} is used by a card.`);
        const picked = await vscode.window.showQuickPick(
          unused.map((p) => ({ label: p.slice(folder.length + 1), path: p, picked: true })),
          { title: `${unused.length} image${unused.length === 1 ? '' : 's'} no card links to. Untick any to keep.`, canPickMany: true },
        );
        if (!picked?.length) return;
        const ok = await vscode.window.showWarningMessage(`Delete ${picked.length} unused image${picked.length === 1 ? '' : 's'}? They go to the trash.`, { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
        try {
          await controller.images.delete(picked.map((p) => p.path), false);
        } catch (e) {
          const again = await vscode.window.showWarningMessage(
            'This machine has no trash, so the images would be deleted permanently. Committed images can still be restored from git.',
            { modal: true, detail: e instanceof Error ? e.message : String(e) },
            'Delete Permanently',
          );
          if (again === 'Delete Permanently') await controller.images.delete(picked.map((p) => p.path), true);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.restoreArchived',
      guarded('Restoring failed', async () => {
        const archived = await controller.archivedCards();
        if (archived.length === 0) return void vscode.window.showInformationMessage('KanbanBananas: nothing is archived.');
        const pick = await vscode.window.showQuickPick(
          archived.map((a) => ({ label: a.title ?? a.id, description: a.status ? columnName(a.status) : '', id: a.id })),
          { title: 'Restore which card?', matchOnDescription: true },
        );
        if (pick) await controller.restore(pick.id);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.lane.new',
      guarded('Adding the lane failed', async (arg) => {
        const ctx: MenuContext = typeof arg === 'string' ? { field: arg as GroupField } : (arg ?? {});
        const field = ctx.field ?? (await pickField());
        if (!field) return;
        const existing = new Set(controller.settingsNow.view.lanes[field].filter((l) => !l.none).map((l) => l.name));
        const name = ctx.to?.trim() || (
          await vscode.window.showInputBox({
            title: `New ${FIELD_NAMES[field]} lane`,
            prompt: 'It appears on the board even while empty. Drop cards into it to set their ' + FIELD_NAMES[field].toLowerCase() + '.',
            validateInput: (v) => (!v.trim() ? 'Enter a name.' : existing.has(v.trim()) ? 'That lane already exists.' : null),
          })
        )?.trim();
        if (!name) return;
        if (existing.has(name)) return void vscode.window.showInformationMessage(`KanbanBananas: there's already a lane "${name}".`);
        // New lanes go above the "none" lane while it's last; otherwise at the end.
        await controller.updateLanes(field, (lanes) =>
          lanes.at(-1)?.none ? [...lanes.slice(0, -1), { name }, lanes.at(-1)!] : [...lanes, { name }],
        );
        log.info(`Added ${field} lane "${name}"`);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.lane.rename',
      guarded('Renaming the lane failed', async ({ field, value, to: typed }) => {
        if (!field || !value) {
          return void vscode.window.showInformationMessage('KanbanBananas: the "none" lane holds cards without a value; it has no name to change.');
        }
        const to = typed?.trim() || (
          await vscode.window.showInputBox({
            title: `Rename ${FIELD_NAMES[field]} lane "${value}"`,
            value,
            prompt: `Changes the ${FIELD_NAMES[field].toLowerCase()} on every card in it. Renaming onto another lane merges the two.`,
            validateInput: (v) => (v.trim() ? null : 'Enter a name.'),
          })
        )?.trim();
        if (!to || to === value) return;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Renaming lane "${value}"…` },
          () => controller.setFieldAll(field, value, to),
        );
        await controller.updateLanes(field, (lanes) => {
          const merged = lanes.some((l) => l.name === to);
          return merged ? lanes.filter((l) => l.name !== value) : lanes.map((l) => (l.name === value ? { ...l, name: to } : l));
        });
        summary(`renamed "${value}" to "${to}" on`, r);
      }),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.lane.delete',
      guarded('Deleting the lane failed', async ({ field, value }) => {
        if (!field || !value) return;
        const count = (controller.board()?.cards ?? []).filter((c) => c.card.fields[field] === value).length;
        const ok = await vscode.window.showWarningMessage(
          count
            ? `Delete the lane "${value}"? Its ${count} card${count === 1 ? '' : 's'} lose their ${FIELD_NAMES[field].toLowerCase()} and move to the "none" lane. The cards themselves stay.`
            : `Delete the empty lane "${value}"?`,
          { modal: true },
          'Delete Lane',
        );
        if (ok !== 'Delete Lane') return;
        const r = count ? await controller.setFieldAll(field, value, null) : { changed: 0, failed: [] };
        await controller.updateLanes(field, (lanes) => lanes.filter((l) => l.name !== value));
        if (count) summary(`cleared "${value}" on`, r);
      }),
    ),

    ...(['moveUp', 'moveDown'] as const).map((dir) =>
      vscode.commands.registerCommand(
        `kanbanBananas.lane.${dir}`,
        guarded('Moving the lane failed', async ({ field, value, order }) => {
          if (!field || value === undefined || !order) return;
          const i = order.indexOf(value);
          const j = dir === 'moveUp' ? i - 1 : i + 1;
          if (i === -1 || j < 0 || j >= order.length) return;
          const next = [...order];
          [next[i], next[j]] = [next[j]!, next[i]!];
          await controller.updateLanes(field, (lanes) =>
            next.map((name) => (name === null ? { name: '', none: true } : lanes.find((l) => l.name === name && !l.none) ?? { name })),
          );
        }),
      ),
    ),

    vscode.commands.registerCommand(
      'kanbanBananas.renameFilesToPattern',
      guarded('Renaming the card files failed', async () => {
        const pattern = controller.settingsNow.filenamePattern;
        const renames = controller.pendingRenames();
        if (renames.length === 0) {
          return void vscode.window.showInformationMessage(`KanbanBananas: every card already matches the pattern ${pattern}.`);
        }
        // The list doubles as a preview: untick cards to leave them as they are.
        const picked = await vscode.window.showQuickPick(
          renames.map((r) => ({ label: r.filename, description: `from ${r.path}`, picked: true, rename: r })),
          { title: `Rename ${renames.length} card files to ${pattern}? Untick any to keep.`, canPickMany: true },
        );
        if (!picked?.length) return;
        const ok = await vscode.window.showWarningMessage(
          `Rename ${picked.length} card files? Each card's id changes with its filename, so notes or commits that mention the old ids won't follow.`,
          { modal: true },
          'Rename',
        );
        if (ok !== 'Rename') return;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Renaming ${picked.length} card files…` },
          () => controller.renameAll(picked.map((p) => p.rename)),
        );
        summary('renamed', r);
      }),
    ),
  );
}

async function pickField(): Promise<GroupField | undefined> {
  const pick = await vscode.window.showQuickPick(
    GROUP_FIELDS.map((f) => ({ label: FIELD_NAMES[f], field: f })),
    { title: 'New lane for which grouping?' },
  );
  return pick?.field;
}
