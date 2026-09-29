import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Node-only: no vscode import, so this is testable (and killable) in plain Node.

/** What a file looked like when it was read. A write is refused if it has changed since. */
export interface FileVersion {
  mtimeMs: number;
  size: number;
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}

export interface WriteHooks {
  /** Test hook: runs after the temp file is durable, just before it replaces the card. */
  beforeCommit?: () => void | Promise<void>;
}

/** Read a file with the version it had while being read. Retries if it changed mid-read. */
export async function readVersioned(path: string): Promise<{ text: string; version: FileVersion }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await stat(path);
    const fh = await open(path, 'r');
    let bytes: Buffer;
    try {
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
    const after = await stat(path);
    if (sameVersion(before, after) && bytes.length === after.size) {
      return { text: decode(bytes), version: { mtimeMs: after.mtimeMs, size: after.size } };
    }
  }
  throw new ConflictError(`${basename(path)} keeps changing while being read.`);
}

/**
 * Replace `path` with `text` atomically (spec §2.4): write a temp file in the
 * same directory, fsync it, then rename() it over the card. If the card no
 * longer matches `expected`, nothing is changed and ConflictError is thrown.
 * With `expected === null` the file must not exist yet; it is never overwritten.
 */
export async function writeAtomic(
  path: string,
  text: string | Uint8Array,
  expected: FileVersion | null,
  hooks: WriteHooks = {},
): Promise<FileVersion> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const mode = expected ? (await stat(path)).mode & 0o777 : 0o644;

  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();

  try {
    await hooks.beforeCommit?.();
    if (expected === null) {
      // link() fails if the target exists, so a new card can never replace another.
      try {
        await link(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ConflictError(`${basename(path)} already exists.`);
        throw e;
      }
      await unlink(tmp);
    } else {
      const current = await stat(path).catch(() => null);
      if (!current || !sameVersion(current, expected)) {
        throw new ConflictError(`${basename(path)} changed on disk since it was read.`);
      }
      await rename(tmp, path);
    }
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }

  await syncDir(dir);
  const done = await stat(path);
  return { mtimeMs: done.mtimeMs, size: done.size };
}

/** rename() that refuses to replace an existing file (spec §2.6). Creates the target folder (e.g. `archived/`) if needed. */
export async function renameNoClobber(from: string, to: string): Promise<void> {
  if (await exists(to)) throw new ConflictError(`${basename(to)} already exists.`);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  await syncDir(dirname(to));
  if (dirname(from) !== dirname(to)) await syncDir(dirname(from));
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

// Keep a BOM if there is one, so text matches the bytes on disk.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** fsync the directory so a rename survives a crash. Not supported everywhere; best effort. */
async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // e.g. EISDIR/EPERM on some platforms
  }
}
