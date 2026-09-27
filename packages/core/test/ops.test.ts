import { describe, expect, it } from 'vitest';
import {
  IntentError,
  loadBoard,
  parseCard,
  patchFields,
  planCreate,
  planMove,
  planSetFields,
  type Board,
  type BoardFile,
} from '../src/index.js';

const NOW = new Date('2026-09-25T10:00:00.000Z');

function card(id: string, status: string, order: string | number, extra = ''): BoardFile {
  const dir = status === 'done' ? 'done/' : '';
  const o = typeof order === 'number' ? String(order) : `"${order}"`;
  return {
    path: `${dir}${id}.md`,
    text: `---\nid: "${id}"\nstatus: "${status}"\ncreated: "2026-01-01T00:00:00.000Z"\ncompletedAt: ${status === 'done' ? '"2026-01-02T00:00:00.000Z"' : 'null'}\norder: ${o}\n${extra}---\n# ${id}`,
  };
}

/** Apply a plan's changes in memory and return the column's ids in board order. */
function applyAndList(files: BoardFile[], plan: ReturnType<typeof planMove>, status: string): string[] {
  const next = files.map((f) => (f.path === plan.path ? { ...f, text: patchFields(f.text, plan.changes) } : f));
  return loadBoard(next)
    .cards.filter((c) => c.card.fields.status === status)
    .map((c) => c.card.fields.id!);
}

describe('planMove', () => {
  const files = [card('a', 'todo', 'a0'), card('b', 'todo', 'a1'), card('c', 'todo', 'a2'), card('d', 'review', 'a0')];
  const board = loadBoard(files);

  it('reorders within a column, rewriting only the moved card', () => {
    const plan = planMove(board, { id: 'c', toStatus: 'todo', beforeId: 'a' }, NOW);
    expect(plan.path).toBe('c.md');
    expect(Object.keys(plan.changes).sort()).toEqual(['modified', 'order']);
    expect(applyAndList(files, plan, 'todo')).toEqual(['c', 'a', 'b']);
  });

  it('moves to another column at a position', () => {
    const plan = planMove(board, { id: 'b', toStatus: 'review', beforeId: 'd' }, NOW);
    expect(plan.changes.status).toBe('review');
    expect(plan.toDir).toBeUndefined();
    expect(applyAndList(files, plan, 'review')).toEqual(['b', 'd']);
  });

  it('moves to the end of a column', () => {
    const plan = planMove(board, { id: 'a', toStatus: 'todo', beforeId: null }, NOW);
    expect(applyAndList(files, plan, 'todo')).toEqual(['b', 'c', 'a']);
  });

  it('sets completedAt and targets done/ when moving to done, and clears it when moving back', () => {
    const toDone = planMove(board, { id: 'a', toStatus: 'done', beforeId: null }, NOW);
    expect(toDone.changes).toMatchObject({ status: 'done', completedAt: NOW.toISOString(), modified: NOW.toISOString() });
    expect(toDone.toDir).toBe('done');

    const withDone = loadBoard([...files, card('e', 'done', 'a0')]);
    const back = planMove(withDone, { id: 'e', toStatus: 'todo', beforeId: null }, NOW);
    expect(back.changes).toMatchObject({ status: 'todo', completedAt: null });
    expect(back.toDir).toBe('');
  });

  it('places a card after a run of duplicate keys when dropped inside it', () => {
    const dupes = [card('p', 'todo', 'Zk'), card('q', 'todo', 'Zl'), card('r', 'todo', 'Zl'), card('s', 'todo', 'Zm'), card('t', 'todo', 'a0')];
    const plan = planMove(loadBoard(dupes), { id: 't', toStatus: 'todo', beforeId: 'r' }, NOW);
    const key = plan.changes.order as string;
    expect(key > 'Zl' && key < 'Zm').toBe(true);
  });

  it('skips a numeric order key as a bound', () => {
    const files2 = [card('z', 'todo', 0), card('y', 'todo', 'a0'), card('x', 'todo', 'a5')];
    const plan = planMove(loadBoard(files2), { id: 'x', toStatus: 'todo', beforeId: 'y' }, NOW);
    expect(applyAndList(files2, plan, 'todo')).toEqual(['z', 'x', 'y']);
  });

  it('refuses unknown and broken cards', () => {
    expect(() => planMove(board, { id: 'nope', toStatus: 'todo', beforeId: null }, NOW)).toThrow(IntentError);
    const withBroken: Board = loadBoard([...files, { path: 'bad.md', text: '' }]);
    expect(() => planMove(withBroken, { id: 'bad', toStatus: 'todo', beforeId: null }, NOW)).toThrow(/broken/);
  });
});

describe('planSetFields', () => {
  const board = loadBoard([card('a', 'todo', 'a0')]);

  it('sets editable fields, dedupes labels and bumps modified', () => {
    const plan = planSetFields(board, { id: 'a', changes: { priority: 'high', labels: ['x', ' x', 'y', ''] } }, NOW);
    expect(plan.changes).toEqual({ priority: 'high', labels: ['x', 'y'], modified: NOW.toISOString() });
  });

  it('rejects fields managed by moves', () => {
    expect(() => planSetFields(board, { id: 'a', changes: { status: 'done' } as never }, NOW)).toThrow(IntentError);
  });
});

describe('planCreate', () => {
  it('writes the old board format exactly', () => {
    const board = loadBoard([card('a', 'todo', 'ZN')]);
    const created = planCreate(board, { title: 'API Use for Admins/User Dashboard', status: 'todo', top: true }, NOW, new Set(['a.md']));
    expect(created.path).toBe('api-use-for-admins-user-dashboard-2026-09-25.md');
    expect(created.text).toBe(
      [
        '---',
        'id: "api-use-for-admins-user-dashboard-2026-09-25"',
        'status: "todo"',
        'priority: "medium"',
        'assignee: null',
        'epic: null',
        'dueDate: null',
        'created: "2026-09-25T10:00:00.000Z"',
        'modified: "2026-09-25T10:00:00.000Z"',
        'completedAt: null',
        'labels: []',
        'order: "ZM"',
        '---',
        '# API Use for Admins/User Dashboard',
        '',
      ].join('\n'),
    );
    const parsed = parseCard(created.text);
    expect(parsed.ok && parsed.card.title).toBe('API Use for Admins/User Dashboard');
  });

  it('adds to the bottom by default, in done/ for done cards', () => {
    const board = loadBoard([card('a', 'done', 'a0')]);
    const created = planCreate(board, { title: 'Shipped', status: 'done', labels: ['x'] }, NOW, new Set(['done/a.md']));
    expect(created.path).toBe('done/shipped-2026-09-25.md');
    expect(created.text).toContain('completedAt: "2026-09-25T10:00:00.000Z"');
    expect(created.text).toContain('labels: ["x"]');
    expect(created.text).toContain('order: "a1"');
  });

  it('never reuses an id, in either folder', () => {
    const taken = new Set(['done/fix-it-2026-09-25.md', 'fix-it-2026-09-25-2.md']);
    const created = planCreate(loadBoard([]), { title: 'Fix it', status: 'todo' }, NOW, taken);
    expect(created.id).toBe('fix-it-2026-09-25-3');
  });

  it('refuses an empty title', () => {
    expect(() => planCreate(loadBoard([]), { title: '  ', status: 'todo' }, NOW, new Set())).toThrow(IntentError);
  });
});
