import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardFile } from '../board.js';
import { editCard } from '../edit.js';
import { idForFilename } from '../filenames.js';
import type { WriteRoute } from '../cliProtocol.js';
import type { NewCard, Plan } from '../ops.js';
import { ConflictError, exists, readVersioned, renameNoClobber, writeAtomic } from './atomicFile.js';

/** Card files are `<root>/*.md` and `<root>/done/*.md`. `archived/` is not on the board. */
export const CARD_DIRS = ['', 'done'];
const MAX_ATTEMPTS = 3;

export interface WriteResult {
  /** Final path, relative to the features directory. */
  path: string;
  /** mtime of the file on disk afterwards. Pass it to `edit --expect-mtime`. */
  mtimeMs: number;
  /** How the change was applied; see WriteRoute. */
  route: WriteRoute;
}

// Keep a BOM if there is one, so text matches the bytes on disk.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export async function readBoardDir(root: string): Promise<BoardFile[]> {
  const files: BoardFile[] = [];
  for (const dir of CARD_DIRS) {
    let names: string[];
    try {
      names = (await readdir(join(root, dir), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = dir ? `${dir}/${name}` : name;
      files.push({ path, text: decoder.decode(await readFile(join(root, dir, name))) });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Where a card moving into `dir` can go without replacing anything: its own
 * filename, else `-2`, `-3`… The caller must change the id to match.
 */
export async function freeName(root: string, dir: string, filename: string, known: ReadonlySet<string>): Promise<string> {
  const stem = filename.replace(/\.md$/i, '');
  for (let n = 1; ; n++) {
    const name = n === 1 ? filename : `${stem}-${n}.md`;
    const path = dir ? `${dir}/${name}` : name;
    if (!known.has(path) && !(await exists(join(root, path)))) return name;
  }
}

/** Resolve a plan's target path, adding an id change to `changes` if the name needed a suffix. */
export async function resolveTarget(root: string, plan: Plan, known: ReadonlySet<string>): Promise<Plan & { targetPath?: string }> {
  if (plan.toDir === undefined) return plan;
  const filename = plan.path.slice(plan.path.lastIndexOf('/') + 1);
  const free = await freeName(root, plan.toDir, filename, known);
  const targetPath = plan.toDir ? `${plan.toDir}/${free}` : free;
  const changes = free === filename ? plan.changes : { ...plan.changes, id: idForFilename(free) };
  return { ...plan, changes, targetPath };
}

/**
 * Apply a plan to a card file that isn't open in an editor: re-read it,
 * patch it, write it atomically, retry if it changed underneath, verify,
 * then rename it if it moves between folders.
 */
export async function applyPlanToFile(root: string, id: string, plan: Plan & { targetPath?: string }): Promise<WriteResult> {
  const fsPath = join(root, plan.path);
  let next = '';
  for (let attempt = 1; ; attempt++) {
    const { text, version } = await readVersioned(fsPath);
    if (plan.expectMtimeMs !== undefined && version.mtimeMs !== plan.expectMtimeMs) {
      throw new ConflictError(`${plan.path} changed since you read it (mtime ${version.mtimeMs}, expected ${plan.expectMtimeMs}). Read it again.`);
    }
    next = editCard(text, id, cardEdit(plan));
    try {
      await writeAtomic(fsPath, next, version);
      break;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= MAX_ATTEMPTS || plan.expectMtimeMs !== undefined) throw e;
    }
  }
  const written = await readVersioned(fsPath);
  if (written.text !== next) throw new Error(`${plan.path} changed right after it was written. Check the file.`);

  if (!plan.targetPath) return { path: plan.path, mtimeMs: written.version.mtimeMs, route: 'disk' };
  await renameNoClobber(fsPath, join(root, plan.targetPath));
  const moved = await readVersioned(join(root, plan.targetPath));
  return { path: plan.targetPath, mtimeMs: moved.version.mtimeMs, route: 'disk' };
}

/** Write a new card; never replaces an existing file (ConflictError if the name is taken). */
export async function createCardFile(root: string, card: NewCard): Promise<WriteResult> {
  const version = await writeAtomic(join(root, card.path), card.text, null);
  return { path: card.path, mtimeMs: version.mtimeMs, route: 'disk' };
}

export function cardEdit(plan: Plan) {
  return {
    fields: plan.changes,
    ...(plan.append !== undefined ? { append: plan.append } : {}),
    ...(plan.body !== undefined ? { body: plan.body } : {}),
    ...(plan.rebase !== undefined ? { rebase: plan.rebase } : {}),
  };
}
