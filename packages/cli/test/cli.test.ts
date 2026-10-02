import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBoard, planCreate, type SkillPolicy } from '@kanban-bananas/core';
import { readBoardDir } from '@kanban-bananas/core/node';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../src/cli.js';

const FIXTURES = join(import.meta.dirname, '../../core/test/fixtures/valid');
const NOW = '2026-09-25T10:00:00.000Z';

let project: string;
let features: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'kb-cli-'));
  features = join(project, '.devtool/features');
  cpSync(FIXTURES, features, { recursive: true });
});

async function kanban(args: string[], opts: { stdin?: string; cwd?: string; policy?: SkillPolicy['agentsMayMoveCards'] } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    cwd: opts.cwd ?? project,
    env: { KANBAN_NOW: NOW },
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    readStdin: async () => opts.stdin ?? '',
    ...(opts.policy ? { skillPolicy: { agentsMayMoveCards: opts.policy } } : {}),
  });
  return { code, stdout, stderr };
}

const read = (rel: string) => readFileSync(join(features, rel), 'utf8');

describe('reading', () => {
  it('finds the board from a subdirectory and prints the path relative to it', async () => {
    const r = await kanban(['find', 'add-login-page-2026-09-01'], { cwd: join(project, '.devtool') });
    expect(r).toMatchObject({ code: EXIT.ok, stdout: 'features/add-login-page-2026-09-01.md\n' });
  });

  it('finds by text, and fails clearly when nothing matches', async () => {
    expect((await kanban(['find', 'login'])).stdout).toContain('add-login-page-2026-09-01.md');
    expect(await kanban(['find', 'nothing-like-this'])).toMatchObject({ code: EXIT.problems });
  });

  it('shows a card with its mtime', async () => {
    const r = await kanban(['show', 'add-login-page-2026-09-01', '--json']);
    const shown = JSON.parse(r.stdout);
    expect(shown.title).toBe('Add login page');
    expect(shown.mtimeMs).toBe(statSync(join(features, 'add-login-page-2026-09-01.md')).mtimeMs);
  });

  it('lists with filters', async () => {
    const r = await kanban(['ls', '--status', 'todo', '--json']);
    expect(JSON.parse(r.stdout).map((c: { id: string }) => c.id)).toEqual(['add-login-page-2026-09-01']);
  });

  it('check passes on a clean board and fails on a broken one', async () => {
    expect((await kanban(['check'])).code).toBe(EXIT.ok);
    writeFileSync(join(features, 'empty-2026-01-01.md'), '');
    const r = await kanban(['check']);
    expect(r.code).toBe(EXIT.problems);
    expect(r.stdout).toContain('empty-2026-01-01.md');
  });
});

describe('session memory', () => {
  const policy = { agentsMayMoveCards: 'notToDone' as const, sessionMemory: { file: '.devtool/session-memory.md', keep: 1 } };
  async function mem(args: string[], stdin = '', withPolicy = true) {
    let stdout = '';
    let stderr = '';
    const code = await run(args, {
      cwd: project,
      env: { KANBAN_NOW: NOW },
      stdout: (s) => void (stdout += s),
      stderr: (s) => void (stderr += s),
      readStdin: async () => stdin,
      ...(withPolicy ? { skillPolicy: policy } : {}),
    });
    return { code, stdout, stderr };
  }

  it('is refused while the setting is off', async () => {
    const r = await mem(['memory'], '', false);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toMatch(/Session memory is off/);
  });

  it('field report: hand-written text is shown, kept with keep > 1, and reported when replaced', async () => {
    const file = join(project, '.devtool/session-memory.md');
    writeFileSync(file, 'Status copied from a card:\n- parser done\n- next: UI\n');
    const read = await mem(['memory']);
    expect(read.stdout).toContain('written by hand');
    expect(read.stdout).toContain('parser done');

    const keep2 = { ...policy, sessionMemory: { ...policy.sessionMemory, keep: 2 } };
    let out = '';
    await run(['memory', '--body', 'new state'], {
      cwd: project, env: { KANBAN_NOW: NOW }, stdout: (x) => void (out += x), stderr: () => {}, readStdin: async () => '', skillPolicy: keep2,
    });
    expect(readFileSync(file, 'utf8')).toContain('parser done');
    expect(readFileSync(file, 'utf8')).toContain('new state');

    writeFileSync(file, 'Hand-written again\n');
    const replaced = await mem(['memory', '--body', 'newest', '--json']);
    expect(JSON.parse(replaced.stdout).note).toMatch(/written by hand/);
  });

  it('--from-card saves a card as the newest entry and leaves the card alone', async () => {
    const card = readFileSync(join(features, 'add-login-page-2026-09-01.md'), 'utf8');
    expect((await mem(['memory', '--from-card', 'add-login-page-2026-09-01'])).code).toBe(EXIT.ok);
    const file = readFileSync(join(project, '.devtool/session-memory.md'), 'utf8');
    expect(file).toContain('From card `add-login-page-2026-09-01`');
    expect(file).toContain('# Add login page');
    expect(readFileSync(join(features, 'add-login-page-2026-09-01.md'), 'utf8')).toBe(card);
  });

  it('saves the newest entry, keeps only the limit, and shows it', async () => {
    expect((await mem(['memory'])).stdout).toMatch(/no session memory yet/);
    expect((await mem(['memory', '--body', '-'], '**Next:** first')).code).toBe(EXIT.ok);
    const r = await mem(['memory', '--body', '-', '--json'], '**Working on:** x\n**Next:** second');
    expect(JSON.parse(r.stdout)).toMatchObject({ path: '.devtool/session-memory.md', route: 'disk' });
    const file = readFileSync(join(project, '.devtool/session-memory.md'), 'utf8');
    expect(file).toContain('**Next:** second');
    expect(file).not.toContain('**Next:** first');
    expect((await mem(['memory'])).stdout).toContain('**Next:** second');
  });
});

describe('writing (no VS Code running)', () => {
  it('spec §12: a note on a card that moved to done/ lands in done/, and no new file appears', async () => {
    await kanban(['move', 'add-login-page-2026-09-01', 'done']);
    const before = readdirSync(features).sort();
    const r = await kanban(['note', 'add-login-page-2026-09-01', '--heading', 'Done — shipped', '--body', '-'], {
      stdin: 'Merged in #42.\n',
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain('done/add-login-page-2026-09-01.md');
    expect(readdirSync(features).sort()).toEqual(before);
    expect(read('done/add-login-page-2026-09-01.md').endsWith('\n\n## Done — shipped\n\nMerged in #42.\n')).toBe(true);
    expect((await kanban(['check'])).code).toBe(EXIT.ok);
  });

  it('spec §12: a created card is byte-identical to one the board creates', async () => {
    const r = await kanban(['new', 'Board parity check', '--status', 'todo', '--json']);
    const { path } = JSON.parse(r.stdout);
    const board = loadBoard(await readBoardDir(features));
    // Same planner, same clock: what the board would write for this card, before the CLI wrote it.
    const others = board.cards.filter((c) => !c.path.startsWith('board-parity-check'));
    const expected = planCreate({ cards: others, broken: [] }, { title: 'Board parity check', status: 'todo', priority: 'medium' }, new Date(NOW), new Set(others.map((c) => c.path)));
    expect(read(path.replace('.devtool/features/', ''))).toBe(expected.text);
  });

  it('spec §12: edit with an outdated --expect-mtime is refused and the file is unchanged', async () => {
    const rel = 'add-login-page-2026-09-01.md';
    const shown = JSON.parse((await kanban(['show', 'add-login-page-2026-09-01', '--json'])).stdout);
    const future = new Date(shown.mtimeMs + 10_000);
    writeFileSync(join(features, rel), read(rel) + '\nsomeone else\n');
    utimesSync(join(features, rel), future, future);
    const before = read(rel);
    const r = await kanban(['edit', 'add-login-page-2026-09-01', '--body', '# New', '--expect-mtime', String(shown.mtimeMs)]);
    expect(r.code).toBe(EXIT.conflict);
    expect(read(rel)).toBe(before);
  });

  it('edit with the current mtime replaces the body only', async () => {
    const shown = JSON.parse((await kanban(['show', 'title-only-2026-09-03', '--json'])).stdout);
    const r = await kanban(['edit', 'title-only-2026-09-03', '--body', '-', '--expect-mtime', String(shown.mtimeMs)], {
      stdin: '# Title only\n\nNow with text.\n',
    });
    expect(r.code).toBe(EXIT.ok);
    expect(read('title-only-2026-09-03.md')).toMatch(/order: "Zl"\n---\n# Title only\n\nNow with text.\n$/);
  });

  it('every write reports its route, in text and JSON', async () => {
    const text = await kanban(['set', 'title-only-2026-09-03', 'priority=low']);
    expect(text.stdout).toContain('route: disk (written by the CLI)');
    const created = JSON.parse((await kanban(['new', 'Routed', '--json'])).stdout);
    expect(created).toMatchObject({ route: 'disk', handledBy: 'cli' });
  });

  it('a new card ends with a newline, with or without a body', async () => {
    const plain = JSON.parse((await kanban(['new', 'Plain', '--json'])).stdout).path;
    const withBody = JSON.parse((await kanban(['new', 'Bodied', '--body', 'Text', '--json'])).stdout).path;
    expect(read(plain.replace('.devtool/features/', '')).endsWith('---\n# Plain\n')).toBe(true);
    expect(read(withBody.replace('.devtool/features/', '')).endsWith('# Bodied\n\nText\n')).toBe(true);
  });

  it('set patches fields, with relative labels', async () => {
    await kanban(['set', 'crlf-with-bom-2026-09-04', 'priority=high', 'labels=+ui,-bug', 'assignee=sam', 'epic=']);
    const text = read('crlf-with-bom-2026-09-04.md');
    expect(text).toContain('priority: "high"\r\n');
    expect(text).toContain('labels: ["ui"]\r\n');
    expect(text).toContain('assignee: "sam"\r\n');
    expect(text).toContain('epic: null\r\n');
    expect(text.startsWith('﻿')).toBe(true);
  });

  it('move --after places the card', async () => {
    await kanban(['new', 'Second', '--status', 'todo']);
    await kanban(['new', 'Third', '--status', 'todo']);
    await kanban(['move', 'third-2026-09-25', 'todo', '--after', 'add-login-page-2026-09-01']);
    const ids = JSON.parse((await kanban(['ls', '--status', 'todo', '--json'])).stdout).map((c: { id: string }) => c.id);
    expect(ids).toEqual(['add-login-page-2026-09-01', 'third-2026-09-25', 'second-2026-09-25']);
  });

  it('refuses unknown fields, statuses and ids without writing', async () => {
    expect((await kanban(['set', 'title-only-2026-09-03', 'status=done'])).code).toBe(EXIT.usage);
    expect((await kanban(['move', 'title-only-2026-09-03', 'someday'])).code).toBe(EXIT.usage);
    expect((await kanban(['note', 'no-such-card', '--heading', 'x'])).code).toBe(EXIT.problems);
  });

  it('refuses to touch a broken card and says so', async () => {
    writeFileSync(join(features, 'broken-2026-01-01.md'), '# no frontmatter');
    const r = await kanban(['note', 'broken-2026-01-01', '--heading', 'x']);
    expect(r.code).toBe(EXIT.problems);
    expect(r.stderr).toMatch(/broken/);
    expect(read('broken-2026-01-01.md')).toBe('# no frontmatter');
  });

  it('enforces the project policy unless --force', async () => {
    writeFileSync(join(project, '.devtool/kanban.json'), JSON.stringify({ agents: { allowStatus: ['todo', 'in-progress', 'review'] } }));
    const refused = await kanban(['move', 'add-login-page-2026-09-01', 'done']);
    expect(refused.code).toBe(EXIT.refused);
    expect(existsSync(join(features, 'add-login-page-2026-09-01.md'))).toBe(true);
    expect((await kanban(['move', 'add-login-page-2026-09-01', 'done', '--force'])).code).toBe(EXIT.ok);
    expect(existsSync(join(features, 'done/add-login-page-2026-09-01.md'))).toBe(true);
  });

  it('skill policy "never": no moves at all, no new cards in done, unless --force', async () => {
    const id = 'add-login-page-2026-09-01';
    const r = await kanban(['move', id, 'review'], { policy: 'never' });
    expect(r.code).toBe(EXIT.refused);
    expect(r.stderr).toMatch(/moves cards between columns themselves/);
    expect(read(`${id}.md`)).toContain('status: "todo"');
    expect((await kanban(['new', 'Shipped', '--status', 'done'], { policy: 'never' })).code).toBe(EXIT.refused);
    expect((await kanban(['new', 'Idea', '--status', 'backlog'], { policy: 'never' })).code).toBe(EXIT.ok);
    expect((await kanban(['note', id, '--heading', 'Done — x'], { policy: 'never' })).code).toBe(EXIT.ok);
    expect((await kanban(['move', id, 'review', '--force'], { policy: 'never' })).code).toBe(EXIT.ok);
  });

  it('skill policy "notToDone": any column but done', async () => {
    const id = 'add-login-page-2026-09-01';
    expect((await kanban(['move', id, 'review'], { policy: 'notToDone' })).code).toBe(EXIT.ok);
    expect((await kanban(['move', id, 'done'], { policy: 'notToDone' })).code).toBe(EXIT.refused);
    expect((await kanban(['move', id, 'done'], { policy: 'anywhere' })).code).toBe(EXIT.ok);
  });

  it('falls back to writing the file when the socket record is stale', async () => {
    writeFileSync(join(project, '.devtool/.kanban.sock'), JSON.stringify({ socket: join(project, 'gone.sock'), pid: 1, version: 'x' }));
    const r = await kanban(['set', 'title-only-2026-09-03', 'priority=low', '--json']);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout)).toMatchObject({ handledBy: 'cli', route: 'disk', unsaved: false });
  });
});
