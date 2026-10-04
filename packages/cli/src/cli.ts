import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  droppedNote,
  EDITABLE_FIELDS,
  findCard,
  idAfter,
  IntentError,
  loadBoard,
  parseCard,
  memoryFromCard,
  parseMemory,
  PatchError,
  planCreate,
  planEditBody,
  planMove,
  planNote,
  planSetFields,
  policyRefusal,
  updateMemory,
  type Board,
  type BoardCard,
  type CliRequest,
  type CliResult,
  type CreateIntent,
  type FieldValue,
  type Plan,
  type SkillPolicy,
} from '@kanban-bananas/core';
import {
  applyPlanToFile,
  ConflictError,
  createCardFile,
  readBoardDir,
  readVersioned,
  resolveTarget,
  writeAtomic,
} from '@kanban-bananas/core/node';
import { sendToExtension } from './client.js';
import { findProject, UsageError, type Project } from './project.js';

declare const KANBAN_VERSION: string;
const VERSION = typeof KANBAN_VERSION === 'string' ? KANBAN_VERSION : 'dev';

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  /** The policy installed with the skill (policy.json next to SKILL.md), if any. */
  skillPolicy?: SkillPolicy;
}

/** Exit codes, for scripts and hooks. */
export const EXIT = { ok: 0, problems: 1, usage: 2, conflict: 3, refused: 4 } as const;

class PolicyError extends Error {
  override name = 'PolicyError';
}

const HELP = `kanban ${VERSION}: read and change KanbanBananas cards safely.

  kanban find <id|text>                   Current path of a card (always look up before acting)
  kanban show <id>                        Frontmatter, body, path and mtime
  kanban ls [--status s] [--label l] [--priority p]
  kanban new "<title>" [--status s] [--priority p] [--labels a,b] [--body -|text]
  kanban note <id> --heading "..." [--body -|text]   Append a section to the card
  kanban move <id> <status> [--before <id> | --after <id>]
  kanban set <id> key=value...            priority, assignee, epic, lane, dueDate, labels
                                          labels=a,b sets; labels=+a,-b adds/removes; key= clears
  kanban edit <id> --body -|text --expect-mtime <mtime>   Replace the whole body
  kanban check                            Integrity scan; exit 1 on problems
  kanban memory [--all]                   Show the session memory (latest entry)
  kanban memory --body -|text             Save the current state of the work as the newest entry
  kanban memory --from-card <id>          Save a card's text as the newest entry (the card stays)

Options: --json (machine output), --dir <features dir>, --force (override .devtool/kanban.json policy).
--body - reads stdin. Changes go through VS Code when it is running, else straight to the file.`;

export async function run(argv: string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${HELP}\n`);
    return EXIT.usage;
  }
  const [command, ...rest] = args.positional;
  if (!command || args.flags.help || command === 'help') {
    io.stdout(HELP + '\n');
    return command || args.flags.help ? EXIT.ok : EXIT.usage;
  }
  if (command === 'version' || args.flags.version) {
    io.stdout(VERSION + '\n');
    return EXIT.ok;
  }

  try {
    const project = findProject(io.cwd, str(args.flags.dir) ?? io.env.KANBAN_DIR);
    // The board's columns, as installed with the skill, unless .devtool/kanban.json sets statuses itself.
    if (!project.config.statuses?.length && io.skillPolicy?.statuses?.length) project.statuses = io.skillPolicy.statuses;
    const ctx = new Context(project, args, io);
    switch (command) {
      case 'find':
        return await ctx.find(need(rest[0], 'find <id|text>'));
      case 'show':
        return await ctx.show(need(rest[0], 'show <id>'));
      case 'ls':
        return await ctx.ls();
      case 'check':
        return await ctx.check();
      case 'new':
        return await ctx.create(need(rest[0], 'new "<title>"'));
      case 'note':
        return await ctx.note(need(rest[0], 'note <id> --heading "..."'));
      case 'move':
        return await ctx.move(need(rest[0], 'move <id> <status>'), need(rest[1], 'move <id> <status>'));
      case 'set':
        return await ctx.set(need(rest[0], 'set <id> key=value...'), rest.slice(1));
      case 'edit':
        return await ctx.edit(need(rest[0], 'edit <id> --body - --expect-mtime <t>'));
      case 'memory':
        return await ctx.memory();
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError) {
      io.stderr(`kanban: ${message}\n`);
      return EXIT.usage;
    }
    if (e instanceof ConflictError) {
      io.stderr(`kanban: conflict: ${message}\n`);
      return EXIT.conflict;
    }
    if (e instanceof PolicyError) {
      io.stderr(`kanban: refused: ${message}\n`);
      return EXIT.refused;
    }
    io.stderr(`kanban: ${message}\n`);
    return EXIT.problems;
  }
}

class Context {
  private cachedBoard: Board | undefined;

  constructor(
    private readonly project: Project,
    private readonly args: Args,
    private readonly io: Io,
  ) {}

  private get json(): boolean {
    return this.args.flags.json === true;
  }

  private async board(): Promise<Board> {
    this.cachedBoard ??= loadBoard(await readBoardDir(this.project.features), { statuses: this.project.statuses });
    return this.cachedBoard;
  }

  /** Path as the user should type it: relative to where they are. */
  private display(path: string): string {
    return relative(this.io.cwd, `${this.project.features}/${path}`) || path;
  }

  private out(value: unknown, text: string): void {
    this.io.stdout(this.json ? JSON.stringify(value, null, 2) + '\n' : text.endsWith('\n') ? text : text + '\n');
  }

  private now(): Date {
    // Test hook: a fixed clock makes created files comparable byte for byte.
    return this.io.env.KANBAN_NOW ? new Date(this.io.env.KANBAN_NOW) : new Date();
  }

  // Reading

  async find(query: string): Promise<number> {
    const board = await this.board();
    const matches = matchCards(board, query);
    const rows = matches.map((c) => ({ id: c.card.fields.id, path: this.display(c.path), status: c.card.fields.status, title: c.card.title }));
    if (rows.length === 0) {
      const broken = board.broken.filter((b) => b.filename.includes(query));
      this.io.stderr(
        broken.length
          ? `kanban: only broken files match: ${broken.map((b) => this.display(b.path)).join(', ')}. Run kanban check.\n`
          : `kanban: no card matches "${query}".\n`,
      );
      return EXIT.problems;
    }
    this.out(rows, rows.map((r) => (rows.length === 1 ? r.path : `${r.path}\t${r.status}\t${r.title ?? ''}`)).join('\n'));
    return EXIT.ok;
  }

  async show(id: string): Promise<number> {
    const card = findCard(await this.board(), this.resolveId(await this.board(), id));
    const { text, version } = await readVersioned(`${this.project.features}/${card.path}`);
    const parsed = parseCard(text);
    if (!parsed.ok) throw new Error(`${card.path} no longer parses.`);
    this.out(
      {
        id: parsed.card.fields.id,
        path: this.display(card.path),
        mtimeMs: version.mtimeMs,
        fields: parsed.card.fields,
        title: parsed.card.title,
        body: parsed.card.source.body,
      },
      `path: ${this.display(card.path)}\nmtime: ${version.mtimeMs}\n\n${text}`,
    );
    return EXIT.ok;
  }

  async ls(): Promise<number> {
    const { status, label, priority } = this.args.flags;
    const cards = (await this.board()).cards.filter(
      (c) =>
        (status === undefined || c.card.fields.status === status) &&
        (label === undefined || c.card.fields.labels.includes(String(label))) &&
        (priority === undefined || c.card.fields.priority === priority),
    );
    const order = new Map(this.project.statuses.map((s, i) => [s, i]));
    cards.sort((a, b) => (order.get(a.card.fields.status!) ?? 99) - (order.get(b.card.fields.status!) ?? 99));
    const rows = cards.map((c) => ({
      id: c.card.fields.id,
      status: c.card.fields.status,
      priority: c.card.fields.priority,
      labels: c.card.fields.labels,
      title: c.card.title,
      path: this.display(c.path),
    }));
    this.out(rows, rows.map((r) => [r.status, r.priority ?? '-', r.id, r.title ?? ''].join('\t')).join('\n') || '(no cards)');
    return EXIT.ok;
  }

  async check(): Promise<number> {
    const board = await this.board();
    const problems = [
      ...board.broken.flatMap((b) =>
        b.parseError
          ? [{ severity: 'error', path: b.path, message: b.parseError.message }]
          : b.issues.map((i) => ({ severity: i.severity, path: b.path, message: i.message })),
      ),
      ...board.cards.flatMap((c) => c.issues.map((i) => ({ severity: i.severity, path: c.path, message: i.message }))),
    ];
    const errors = problems.filter((p) => p.severity === 'error').length;
    const summary = `${board.cards.length} cards OK, ${errors} error(s), ${problems.length - errors} warning(s).`;
    this.out(
      { ok: errors === 0, cards: board.cards.length, problems },
      [...problems.map((p) => `${p.severity.toUpperCase()}\t${this.display(p.path)}\t${p.message}`), summary].join('\n'),
    );
    return errors === 0 ? EXIT.ok : EXIT.problems;
  }

  // Writing

  async create(title: string): Promise<number> {
    const status = str(this.args.flags.status) ?? this.project.statuses[0]!;
    this.checkStatus(status);
    this.enforcePolicy('create', status);
    const labels = str(this.args.flags.labels)?.split(',').map((l) => l.trim()).filter(Boolean);
    const body = await this.body();
    const priority = str(this.args.flags.priority);
    const intent: CreateIntent = {
      title,
      status,
      ...(priority ? { priority } : {}),
      ...(labels?.length ? { labels } : {}),
      ...(body !== undefined ? { body } : {}),
    };

    const viaExtension = await this.viaExtension({ op: 'create', intent });
    if (viaExtension) return this.reportWrite(viaExtension, 'vscode');

    const full: CreateIntent = {
      ...intent,
      top: this.project.config.addNewCardsToTop ?? false,
      priority: intent.priority ?? this.project.config.defaultPriority ?? 'medium',
    };
    const board = await this.board();
    const taken = new Set([...board.cards.map((c) => c.path), ...board.broken.map((b) => b.path)]);
    for (let attempt = 1; ; attempt++) {
      const card = planCreate(board, full, this.now(), taken);
      try {
        return this.reportWrite(await createCardFile(this.project.features, card), 'cli');
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 3) throw e;
        taken.add(card.path);
      }
    }
  }

  async note(idArg: string): Promise<number> {
    const heading = str(this.args.flags.heading);
    if (!heading) throw new UsageError('note needs --heading "...".');
    const body = await this.body();
    const board = await this.board();
    const id = this.resolveId(board, idArg);
    const intent = { id, heading, ...(body !== undefined ? { body } : {}) };
    return this.write({ op: 'note', intent }, id, () => planNote(board, intent, this.now()));
  }

  async move(idArg: string, status: string): Promise<number> {
    this.checkStatus(status);
    this.enforcePolicy('move', status);
    const board = await this.board();
    const id = this.resolveId(board, idArg);
    const before = str(this.args.flags.before);
    const after = str(this.args.flags.after);
    if (before && after) throw new UsageError('Use --before or --after, not both.');
    const beforeId = before ? this.resolveId(board, before) : after ? idAfter(board, status, this.resolveId(board, after)) : null;
    const intent = { id, toStatus: status, beforeId };
    return this.write({ op: 'move', intent }, id, () => planMove(board, intent, this.now()));
  }

  async set(idArg: string, assignments: string[]): Promise<number> {
    if (assignments.length === 0) throw new UsageError('set needs at least one key=value.');
    const board = await this.board();
    const id = this.resolveId(board, idArg);
    const card = findCard(board, id);
    const changes: Record<string, FieldValue> = {};
    for (const a of assignments) {
      const eq = a.indexOf('=');
      if (eq <= 0) throw new UsageError(`Expected key=value, got "${a}".`);
      const key = a.slice(0, eq);
      const value = a.slice(eq + 1).trim();
      if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) {
        throw new UsageError(`Can't set "${key}". Settable: ${EDITABLE_FIELDS.join(', ')}. Use move for status.`);
      }
      if (key === 'labels') changes.labels = parseLabels(value, card.card.fields.labels);
      else if (key === 'dueDate' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError('dueDate must be YYYY-MM-DD.');
      else changes[key] = value === '' ? null : value;
    }
    const intent = { id, changes };
    return this.write({ op: 'set', intent }, id, () => planSetFields(board, intent, this.now()));
  }

  async edit(idArg: string): Promise<number> {
    const body = await this.body();
    if (body === undefined) throw new UsageError('edit needs --body - (stdin) or --body "text".');
    const expect = Number(this.args.flags['expect-mtime']);
    if (!this.args.flags['expect-mtime'] || !Number.isFinite(expect)) {
      throw new UsageError('edit needs --expect-mtime <mtime> from `kanban show`, so it can refuse if the card changed.');
    }
    const board = await this.board();
    const id = this.resolveId(board, idArg);
    const intent = { id, body, expectMtimeMs: expect };
    return this.write({ op: 'edit', intent }, id, () => planEditBody(board, intent, this.now()));
  }

  /** Show the session memory, or add an entry to it (`--body`). */
  async memory(): Promise<number> {
    const config = this.io.skillPolicy?.sessionMemory;
    if (!config) {
      throw new UsageError('Session memory is off for this project. The user can turn it on in the KanbanBananas settings.');
    }
    const file = join(this.project.root, config.file);
    const mtime = () => (existsSync(file) ? statSync(file).mtime.toISOString() : undefined);
    const fromCard = str(this.args.flags['from-card']);
    let body = await this.body();
    if (fromCard) {
      if (body !== undefined) throw new UsageError('Use --body or --from-card, not both.');
      const board = await this.board();
      const id = this.resolveId(board, fromCard);
      const card = findCard(board, id);
      const parsed = parseCard((await readVersioned(join(this.project.features, card.path))).text);
      if (!parsed.ok) throw new Error(`${card.path} no longer parses.`);
      body = memoryFromCard(id, parsed.card.source.body);
    }
    if (body === undefined) {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const entries = parseMemory(text, mtime());
      const shown = this.args.flags.all === true ? entries : entries.slice(0, 1);
      const label = (e: (typeof entries)[number]) => (e.handWritten ? `${e.at} (written by hand, no entry heading)` : e.at);
      this.out(
        { file: this.display2(file), entries: shown },
        shown.length ? shown.map((e) => `## ${label(e)}\n\n${e.body}`).join('\n\n') : '(no session memory yet)',
      );
      return EXIT.ok;
    }
    const viaExtension = await this.viaExtension({ op: 'memory', body });
    // The extension reports the memory file relative to the project root.
    if (viaExtension) return this.reportWrite(viaExtension, 'vscode', this.display2(join(this.project.root, viaExtension.path)));
    // No VS Code: read, add, write atomically; retry if it changed in between.
    for (let attempt = 1; ; attempt++) {
      const exists = existsSync(file);
      const current = exists ? await readVersioned(file) : null;
      const update = updateMemory(current?.text ?? '', body, this.now(), config.keep, mtime());
      try {
        mkdirSync(dirname(file), { recursive: true });
        const version = await writeAtomic(file, update.text, current?.version ?? null);
        const note = droppedNote(update.dropped);
        return this.reportWrite({ path: config.file, mtimeMs: version.mtimeMs, route: 'disk', ...(note ? { note } : {}) }, 'cli', this.display2(file));
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 3) throw e;
      }
    }
  }

  /** A path outside the features directory, relative to where the user is. */
  private display2(abs: string): string {
    return relative(this.io.cwd, abs) || abs;
  }

  /** Send to the extension if it's running; otherwise plan and write the file here. */
  private async write(request: CliRequest, id: string, makePlan: () => Plan): Promise<number> {
    const viaExtension = await this.viaExtension(request);
    if (viaExtension) return this.reportWrite(viaExtension, 'vscode');
    const board = await this.board();
    const known = new Set([...board.cards.map((c) => c.path), ...board.broken.map((b) => b.path)]);
    const plan = await resolveTarget(this.project.features, makePlan(), known);
    return this.reportWrite(await applyPlanToFile(this.project.features, id, plan), 'cli');
  }

  private async viaExtension(request: CliRequest): Promise<CliResult | null> {
    if (this.io.env.KANBAN_NO_SOCKET) return null;
    const response = await sendToExtension(this.project.socketRecord, request, (m) => this.io.stderr(`kanban: ${m}\n`));
    if (response === null) return null;
    if (response.ok) return response.result ?? null;
    if (response.code === 'conflict') throw new ConflictError(response.error);
    if (response.code === 'invalid') throw new IntentError(response.error);
    throw new Error(response.error);
  }

  /**
   * Every write says how it was applied (`route`) and who applied it
   * (`handledBy`: the running VS Code extension, or this CLI directly).
   */
  private reportWrite(result: CliResult, handledBy: 'vscode' | 'cli', displayPath?: string): number {
    const path = displayPath ?? this.display(result.path);
    const lines = [path, `mtime: ${result.mtimeMs}`, `route: ${result.route} (${handledBy === 'vscode' ? 'applied by VS Code' : 'written by the CLI'})`];
    if (result.note) lines.push(`note: ${result.note}`);
    if (result.route === 'editor-unsaved') {
      lines.push('note: the card has unsaved edits in an editor; your change is in that editor and reaches the file when the user saves.');
    }
    this.out(
      { path, mtimeMs: result.mtimeMs, route: result.route, handledBy, unsaved: result.route === 'editor-unsaved', ...(result.note ? { note: result.note } : {}) },
      lines.join('\n'),
    );
    return EXIT.ok;
  }

  private async body(): Promise<string | undefined> {
    const b = this.args.flags.body;
    if (b === undefined) return undefined;
    if (b === '-') return this.io.readStdin();
    if (b === true) throw new UsageError('--body needs a value, or - for stdin.');
    return String(b);
  }

  /** Accept an id, a filename, or a path to the card. */
  private resolveId(board: Board, arg: string): string {
    const name = arg.slice(arg.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const exact = board.cards.find((c) => c.card.fields.id === name);
    if (exact) return name;
    const broken = board.broken.find((b) => b.filename.replace(/\.md$/i, '') === name);
    if (broken) throw new PatchError(`${this.display(broken.path)} is broken and can't be changed. Run kanban check and tell the user.`);
    throw new IntentError(`No card with id "${name}". Use kanban find to look it up.`);
  }

  private checkStatus(status: string): void {
    if (!this.project.statuses.includes(status)) {
      throw new UsageError(`Unknown status "${status}". Statuses: ${this.project.statuses.join(', ')}.`);
    }
  }

  private enforcePolicy(action: 'move' | 'create', status: string): void {
    if (this.args.flags.force === true) return;
    const skill = this.io.skillPolicy;
    const refusal = skill && policyRefusal(skill.agentsMayMoveCards, action, status);
    if (refusal) throw new PolicyError(`${refusal} Ask the user; only they can allow it (--force).`);
    const allowed = this.project.config.agents?.allowStatus;
    if (allowed && !allowed.includes(status)) {
      throw new PolicyError(
        `.devtool/kanban.json doesn't allow agents to put cards in "${status}" (allowed: ${allowed.join(', ')}). Ask the user; they can pass --force.`,
      );
    }
  }
}

function matchCards(board: Board, query: string): BoardCard[] {
  const name = query.slice(query.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const exact = board.cards.filter((c) => c.card.fields.id === name);
  if (exact.length) return exact;
  const q = query.toLowerCase();
  return board.cards.filter((c) => c.card.fields.id!.toLowerCase().includes(q) || c.card.title?.toLowerCase().includes(q));
}

function parseLabels(value: string, current: string[]): string[] {
  const parts = value.split(',').map((l) => l.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => p.startsWith('+') || p.startsWith('-'))) {
    let labels = [...current];
    for (const p of parts) {
      const label = p.slice(1).trim();
      labels = p.startsWith('+') ? [...labels.filter((l) => l !== label), label] : labels.filter((l) => l !== label);
    }
    return labels;
  }
  return parts;
}

// Argument parsing: positionals plus --flag, --flag value and --flag=value.

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['json', 'force', 'help', 'version', 'all']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (i + 1 < argv.length) flags[name] = argv[++i]!;
      else throw new Error(`--${name} needs a value.`);
    } else if (a === '-h') {
      flags.help = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new UsageError(`Usage: kanban ${usage}`);
  return v;
}
