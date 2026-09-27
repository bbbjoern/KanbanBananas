import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardFilename, compareCards, loadBoard, slugify, type CardFields } from '../src/index.js';
import { FIXTURES, readBoardDir } from './helpers.js';

const STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'done'];

describe('loadBoard', () => {
  it('loads every valid fixture with no errors', () => {
    const board = loadBoard(readBoardDir(join(FIXTURES, 'valid')), { statuses: STATUSES });
    expect(board.broken).toEqual([]);
    expect(board.cards.map((c) => c.path)).toHaveLength(5);
    expect(board.cards.flatMap((c) => c.issues)).toEqual([]);
  });

  it('sends each damaged fixture to the Broken lane for the right reason', () => {
    const board = loadBoard(readBoardDir(join(FIXTURES, 'broken')), { statuses: STATUSES });
    expect(board.cards).toEqual([]);
    const reasons = Object.fromEntries(
      board.broken.map((b) => [b.path, b.parseError?.code ?? b.issues.map((i) => i.code).join(',')]),
    );
    expect(reasons).toEqual({
      'id-mismatch-2026-08-25.md': 'id-mismatch',
      'no-frontmatter-2026-06-15.md': 'no-frontmatter',
      'zero-bytes-2026-09-01.md': 'empty-file',
    });
  });

  it('flags duplicate ids on every card that shares one', () => {
    const card = (status: string) => `---\nid: "a-2026-01-01"\nstatus: "${status}"\n---\n`;
    const board = loadBoard([
      { path: 'a-2026-01-01.md', text: card('todo') },
      { path: 'done/a-2026-01-01.md', text: card('done') },
    ]);
    expect(board.cards).toEqual([]);
    expect(board.broken.map((b) => b.issues.map((i) => i.code))).toEqual([['duplicate-id'], ['duplicate-id']]);
  });

  it('warns, without breaking the card, when status and folder disagree', () => {
    const board = loadBoard([{ path: 'x-2026-01-01.md', text: '---\nid: "x-2026-01-01"\nstatus: "done"\n---\n' }]);
    expect(board.cards[0]?.issues.map((i) => i.code)).toEqual(['wrong-folder']);
  });

  it('reports missing required fields and unknown statuses', () => {
    const board = loadBoard(
      [
        { path: 'a-2026-01-01.md', text: '---\nstatus: "todo"\n---\n' },
        { path: 'b-2026-01-01.md', text: '---\nid: "b-2026-01-01"\nstatus: "someday"\n---\n' },
      ],
      { statuses: STATUSES },
    );
    expect(board.broken.map((b) => b.issues.map((i) => i.code))).toEqual([['missing-field'], ['unknown-status']]);
  });
});

describe('compareCards', () => {
  const f = (order: string | null, created: string | null, id: string): CardFields => ({
    id, order, created,
    status: null, priority: null, assignee: null, epic: null, dueDate: null,
    modified: null, completedAt: null, labels: [], lane: null,
  });

  it('sorts by order (base-62 code-unit order), then created, then id', () => {
    const cards = [
      f('a1', '2026-01-01', 'a'),
      f('Zl', '2026-01-03', 'b'),
      f('Zl', '2026-01-02', 'd'),
      f('Zl', '2026-01-02', 'c'),
      f('ZSV', '2026-01-01', 'e'),
      f('0', '2026-01-01', 'f'),
      f(null, '2026-01-01', 'g'),
    ];
    expect(cards.sort(compareCards).map((c) => c.id)).toEqual(['f', 'e', 'c', 'd', 'b', 'a', 'g']);
  });
});

describe('filenames', () => {
  it('slugifies to lowercase [a-z0-9-], at most 50 characters', () => {
    expect(slugify('Parser: add click-on-word to display alternatives!')).toBe(
      'parser-add-click-on-word-to-display-alternatives',
    );
    expect(slugify('Café  über   Größe')).toBe('cafe-uber-grosse');
    const long = slugify('a'.repeat(49) + ' bcd');
    expect(long).toBe('a'.repeat(49));
    expect(long.length).toBeLessThanOrEqual(50);
  });

  it('builds <slug>-<YYYY-MM-DD>.md', () => {
    expect(cardFilename('New module: subtitles', new Date('2026-09-01T12:00:00Z'))).toBe(
      'new-module-subtitles-2026-09-01.md',
    );
  });
});
