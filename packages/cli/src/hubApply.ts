import { join } from 'node:path';
import {
  BodyConflictError,
  idForFilename,
  IntentError,
  loadBoard,
  PatchError,
  planCreate,
  planMove,
  planNote,
  planSaveBody,
  planSetFields,
  staleFields,
  type Board,
  type CardText,
  type HubIntent,
  type IntentAck,
  type Plan,
} from '@kanban-bananas/core';
import {
  applyPlanToFile,
  cardHash,
  ConflictError,
  createCardFile,
  readBoardDir,
  readVersioned,
  resolveTarget,
  type WriteResult,
} from '@kanban-bananas/core/node';
import type { Project } from './project.js';

/**
 * `kanban sync --write`: apply the hub's intents straight to the files while
 * VS Code is not open. The same checks as the extension's hub host (stale
 * fields, three-way body merge, never overwrite), through the same atomic
 * disk path as `kanban move` and friends. Agent policy does not apply: an
 * intent is a person's edit in the hub, as on the board.
 */

export const VSCODE_TOOK_OVER = 'VS Code just opened this project and applies changes now; try again.';

export interface DiskApplyOptions {
  now: () => Date;
  /** True while the extension runs in the project; checked right before every write. */
  extensionRunning: () => boolean;
}

export function diskApply(project: Project, opts: DiskApplyOptions): (intent: HubIntent) => Promise<IntentAck> {
  // One write at a time: the hub client answers intents concurrently.
  let queue: Promise<unknown> = Promise.resolve();
  return (intent) => {
    const next = queue.then(() => applyOne(project, opts, intent));
    queue = next.catch(() => undefined);
    return next;
  };
}

async function applyOne(project: Project, opts: DiskApplyOptions, intent: HubIntent): Promise<IntentAck> {
  const root = project.features;
  const board = loadBoard(await readBoardDir(root), { statuses: project.statuses });
  const find = (id: string) => board.cards.find((c) => c.card.fields.id === id);
  const fail = async (code: Extract<IntentAck, { ok: false }>['code'], error: string, path?: string): Promise<IntentAck> => {
    const card = path ? await cardText(root, path) : undefined;
    return { intentId: intent.intentId, ok: false, code, error, ...(card ? { card } : {}) };
  };
  const targetId = intent.op === 'create' ? undefined : intent.intent.id;
  const checkStatus = (status: string) => {
    if (!project.statuses.includes(status)) throw new IntentError(`No column "${status}" on this board.`);
  };

  try {
    if (targetId !== undefined && !find(targetId)) return await fail('gone', `No card "${targetId}" on the board.`);
    if (opts.extensionRunning()) return await fail('error', VSCODE_TOOK_OVER);
    let result: WriteResult;
    switch (intent.op) {
      case 'move':
      case 'set': {
        const card = find(intent.intent.id)!;
        const stale = staleFields(card.card.fields, intent.expect);
        if (stale.length > 0) return await fail('stale', `${stale.join(', ')} changed since the change was planned.`, card.path);
        if (intent.op === 'move') checkStatus(intent.intent.toStatus);
        const plan = intent.op === 'move' ? planMove(board, intent.intent, opts.now()) : planSetFields(board, intent.intent, opts.now());
        result = await writePlan(root, board, intent.intent.id, plan);
        break;
      }
      case 'note':
        result = await writePlan(root, board, intent.intent.id, planNote(board, intent.intent, opts.now()));
        break;
      case 'saveBody':
        result = await writePlan(root, board, intent.intent.id, planSaveBody(board, intent.intent, opts.now()));
        break;
      case 'create': {
        checkStatus(intent.intent.status);
        result = await create(root, board, {
          top: project.config.addNewCardsToTop ?? false,
          priority: project.config.defaultPriority ?? 'medium',
          ...(project.config.filenamePattern ? { filenamePattern: project.config.filenamePattern } : {}),
          ...intent.intent,
        }, opts.now());
        break;
      }
      case 'saveImage':
        // The hub sends pastes only to a client whose hello says `uploads`; sync never does. Add the image in the repo.
        return await fail('invalid', 'kanban sync takes no pasted images; add the image in the repo.');
    }
    const card = await cardText(root, result.path);
    if (!card) return await fail('error', `${result.path} could not be read after writing.`);
    const from = targetId !== undefined && card.id !== targetId ? targetId : undefined;
    return { intentId: intent.intentId, ok: true, card, route: result.route, ...(from ? { from } : {}) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const path = targetId !== undefined ? find(targetId)?.path : undefined;
    if (e instanceof BodyConflictError) return fail('conflict', error, path);
    if (e instanceof ConflictError) return fail('stale', error, path);
    if (e instanceof IntentError || e instanceof PatchError) return fail('invalid', error);
    return fail('error', error);
  }
}

function taken(board: Board): Set<string> {
  return new Set([...board.cards.map((c) => c.path), ...board.broken.map((b) => b.path)]);
}

async function writePlan(root: string, board: Board, id: string, plan: Plan): Promise<WriteResult> {
  return applyPlanToFile(root, id, await resolveTarget(root, plan, taken(board)));
}

async function create(root: string, board: Board, intent: Parameters<typeof planCreate>[1], now: Date): Promise<WriteResult> {
  const known = taken(board);
  for (let attempt = 1; ; attempt++) {
    const card = planCreate(board, intent, now, known);
    try {
      return await createCardFile(root, card);
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= 3) throw e;
      known.add(card.path);
    }
  }
}

async function cardText(root: string, path: string): Promise<CardText | undefined> {
  try {
    const { text } = await readVersioned(join(root, path));
    return { id: idForFilename(path.slice(path.lastIndexOf('/') + 1)), path, hash: cardHash(text), text };
  } catch {
    return undefined;
  }
}
