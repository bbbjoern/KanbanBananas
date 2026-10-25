import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COLUMNS, DEFAULT_IMAGES_FOLDER, type ColumnConfig, type SocketRecord } from '@kanban-bananas/core';
import { fsAssetSource, HubClient, readBoardDir, repoIdentityFor, type HubStatus } from '@kanban-bananas/core/node';
import { diskApply } from './hubApply.js';
import { UsageError, type Project } from './project.js';

/**
 * `kanban sync`: keep a project hub's copy of the board current from a machine
 * where VS Code is not open (a server, a cron job, a launchd agent). Read-only
 * by default: the hub's intents are refused with a pointer to VS Code. With
 * `--write` they are applied to the files (hubApply.ts). The images the cards
 * refer to (`<root>/.devtool/assets/…`) go up too, unless `--fields-only`.
 * While the extension runs in this project (its socket record names a live
 * process), the command waits, since the extension syncs and writes itself.
 */

export interface SyncIo {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Ends a continuous sync (Ctrl-C in the terminal). */
  signal?: AbortSignal;
}

export interface SyncOptions {
  /** The hub URL; else `KANBAN_HUB_URL`. */
  hub?: string | undefined;
  /** One reconcile, then exit. */
  once: boolean;
  /** Share titles and fields only: no card text leaves this machine (`--fields-only`). */
  fieldsOnly?: boolean;
  /** Apply the hub's intents to the files (else they are refused as read-only). */
  write?: boolean;
  version: string;
  /** How often to look whether VS Code has started or stopped. */
  pollMs?: number;
  fetch?: typeof fetch;
}

/** The token from the environment: never from the command line, where it would show in process lists. */
export function readToken(env: Record<string, string | undefined>): string | null {
  const direct = env.KANBAN_HUB_TOKEN?.trim();
  if (direct) return direct;
  const file = env.KANBAN_HUB_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text || null;
  } catch (e) {
    throw new UsageError(`Can't read the token file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Is the extension running in this project? True when its socket record names a live process. */
export function extensionRunning(socketRecord: string): boolean {
  let record: SocketRecord;
  try {
    record = JSON.parse(readFileSync(socketRecord, 'utf8')) as SocketRecord;
  } catch {
    return false;
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function runSync(project: Project, io: SyncIo, opts: SyncOptions): Promise<void> {
  const url = (opts.hub ?? io.env.KANBAN_HUB_URL ?? '').trim();
  if (!url) throw new UsageError('kanban sync needs the hub URL: --hub <url>, or KANBAN_HUB_URL in the environment.');
  const token = readToken(io.env);
  if (!token) throw new UsageError('kanban sync needs a token: KANBAN_HUB_TOKEN, or KANBAN_HUB_TOKEN_FILE naming a file that holds it.');

  const repo = repoIdentityFor(project.features);
  const columns = boardColumns(project);
  const say = (s: string) => io.stdout(`${s}\n`);
  const client = new HubClient({
    hub: { url, token },
    repo,
    client: { kind: 'cli', version: opts.version },
    columns: () => columns,
    files: () => readBoardDir(project.features),
    ...(opts.fieldsOnly ? { fieldsOnly: true } : {}),
    assets: fsAssetSource(project.root, { folder: DEFAULT_IMAGES_FOLDER, format: 'webp', maxWidth: 0 }),
    ...(opts.write ? { apply: diskApply(project, { now: () => now(io.env), extensionRunning: () => extensionRunning(project.socketRecord) }) } : {}),
    log: { info: say, warn: (m) => io.stderr(`${m}\n`), error: (m) => io.stderr(`${m}\n`) },
    onStatus: (s: HubStatus) => say(`sync: ${s.state}${s.message ? ` (${s.message})` : ''}`),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  say(`sync: ${repo.remote} (${repo.featuresDir}) → ${url} (${opts.write ? 'applies changes' : 'read-only'}${opts.fieldsOnly ? ', titles and fields only' : ''})`);

  if (opts.once) {
    await client.syncOnce();
    say(`sync: the hub holds ${client.status().cards} card(s)${client.status().assets ? ` and ${client.status().assets} image(s)` : ''}`);
    return;
  }

  const watchers: FSWatcher[] = [];
  for (const dir of ['', 'done']) {
    const path = join(project.features, dir);
    if (!existsSync(path)) continue;
    try {
      watchers.push(watch(path, () => client.notifyChanged()));
    } catch (e) {
      io.stderr(`sync: can't watch ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // Idle while the extension runs here; take over when it is gone.
  let running = false;
  const check = () => {
    const vscodeOpen = extensionRunning(project.socketRecord);
    if (vscodeOpen && running) {
      running = false;
      say('sync: VS Code is open and syncs the board itself; waiting');
      void client.stop();
    } else if (!vscodeOpen && !running) {
      running = true;
      client.start();
    }
  };
  if (extensionRunning(project.socketRecord)) say('sync: VS Code is open and syncs the board itself; waiting');
  check();
  const poll = setInterval(check, opts.pollMs ?? (Number(io.env.KANBAN_SYNC_POLL_MS) || 10_000));

  await new Promise<void>((resolve) => {
    if (!io.signal) return; // nothing can end it but the process
    if (io.signal.aborted) resolve();
    else io.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  clearInterval(poll);
  for (const w of watchers) w.close();
  await client.stop();
  say('sync: stopped');
}

function now(env: Record<string, string | undefined>): Date {
  // Test hook, as in the other commands: a fixed clock makes written files comparable.
  return env.KANBAN_NOW ? new Date(env.KANBAN_NOW) : new Date();
}

/**
 * The columns as the hub shows them: the names the extension provided (with the skill), else the
 * standard columns' names and colours, else the id spelled as a name (`in-progress` → `In progress`).
 */
export function boardColumns(project: Pick<Project, 'statuses' | 'columnNames'>): ColumnConfig[] {
  return project.statuses.map((id) => {
    const standard = DEFAULT_COLUMNS.find((c) => c.id === id);
    const name = project.columnNames?.[id] ?? standard?.name ?? humanize(id);
    return { id, name, color: standard?.color ?? '#6b7280' };
  });
}

function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}
