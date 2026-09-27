import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cardFilename,
  isValidFilenamePattern,
  loadBoard,
  planArchive,
  planCreate,
  planRenameToPattern,
  planRestore,
  planSetFields,
} from '../src/index.js';
import { applyPlanToFile, readBoardDir, resolveTarget, ARCHIVE_DIRS } from '../src/node/index.js';

const NOW = new Date('2026-09-27T10:00:00.000Z');
const card = (path: string, status: string, extra = '', title = 'T') => ({
  path,
  text: `---\nid: "${path.replace(/^.*\//, '').replace('.md', '')}"\nstatus: "${status}"\ncreated: "2026-01-05T09:00:00.000Z"\norder: "a0"\n${extra}---\n# ${title}\n`,
});

describe('filename patterns', () => {
  it('fills {slug} and {date}, and falls back to the default for invalid patterns', () => {
    expect(cardFilename('Fix login', NOW, '{date}-{slug}')).toBe('2026-09-27-fix-login.md');
    expect(cardFilename('Fix login', NOW, '{slug}')).toBe('fix-login.md');
    expect(cardFilename('Fix login', NOW, 'no-slug')).toBe('fix-login-2026-09-27.md');
    expect(isValidFilenamePattern('{slug}-{date}')).toBe(true);
    expect(isValidFilenamePattern('{title}')).toBe(false);
    expect(isValidFilenamePattern('../{slug}')).toBe(false);
  });

  it('new cards follow the pattern', () => {
    const c = planCreate(loadBoard([]), { title: 'Fix login', status: 'todo', filenamePattern: '{date}-{slug}' }, NOW, new Set());
    expect(c.path).toBe('2026-09-27-fix-login.md');
    expect(c.text).toContain('id: "2026-09-27-fix-login"');
  });

  it('lists the cards a new pattern would rename, dated by `created`', () => {
    const board = loadBoard([card('fix-login-2026-01-05.md', 'todo', '', 'Fix login'), card('2026-01-05-other.md', 'todo', '', 'Other')]);
    expect(planRenameToPattern(board, '{date}-{slug}', NOW)).toEqual([
      { id: 'fix-login-2026-01-05', path: 'fix-login-2026-01-05.md', filename: '2026-01-05-fix-login.md' },
    ]);
  });
});

describe('pattern renames with clashes', () => {
  it('treats a clash suffix as matching, so a rename is not offered again', () => {
    const board = loadBoard([card('2026-01-05-fix-login.md', 'todo', '', 'Fix login'), card('2026-01-05-fix-login-2.md', 'todo', '', 'Fix login')]);
    expect(planRenameToPattern(board, '{date}-{slug}', NOW)).toEqual([]);
  });
});

describe('lane field', () => {
  it('is read, and can be set like the other fields', () => {
    const board = loadBoard([card('a.md', 'todo', 'lane: "Q4"\n')]);
    expect(board.cards[0]!.card.fields.lane).toBe('Q4');
    expect(planSetFields(board, { id: 'a', changes: { lane: 'Q1' } }, NOW).changes.lane).toBe('Q1');
  });
});

describe('archive, restore and rename on disk', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'kb-m5-'));
    mkdirSync(join(root, 'done'));
    for (const f of [card('a.md', 'todo'), card('done/b.md', 'done')]) writeFileSync(join(root, f.path), f.text);
    return root;
  }

  it('archives into archived/ and restores to the folder the status belongs in', async () => {
    const root = setup();
    let board = loadBoard(await readBoardDir(root));
    const known = new Set(board.cards.map((c) => c.path));
    const archived = await applyPlanToFile(root, 'b', await resolveTarget(root, planArchive(board, 'b', NOW), known));
    expect(archived.path).toBe('archived/b.md');
    board = loadBoard(await readBoardDir(root));
    expect(board.cards.map((c) => c.path)).toEqual(['a.md']);

    const archive = loadBoard(await readBoardDir(root, ARCHIVE_DIRS));
    const restored = await applyPlanToFile(root, 'b', await resolveTarget(root, planRestore(archive, 'b', NOW), new Set()));
    expect(restored.path).toBe('done/b.md');
  });

  it('renames to a new filename and the id follows', async () => {
    const root = setup();
    const board = loadBoard(await readBoardDir(root));
    const plan = await resolveTarget(root, { path: 'a.md', changes: { modified: NOW.toISOString() }, rename: 'renamed.md' }, new Set(['a.md']));
    const result = await applyPlanToFile(root, 'a', plan);
    expect(result.path).toBe('renamed.md');
    const after = loadBoard(await readBoardDir(root));
    expect(after.broken).toEqual([]);
    expect(after.cards.map((c) => c.card.fields.id).sort()).toEqual(['b', 'renamed']);
    expect(board.cards).toHaveLength(2);
    expect(after.cards.find((c) => c.path === 'renamed.md')!.card.title).toBe('T');
  });
});
