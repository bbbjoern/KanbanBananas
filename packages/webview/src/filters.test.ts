import type { CardView } from '@kanban-bananas/core';
import { describe, expect, it } from 'vitest';
import { epicColor, NO_FILTERS, passes, UNLABELLED } from './filters.js';

const NOW = new Date(2026, 8, 27, 12, 0);

function card(id: string, f: Partial<CardView['fields']>): CardView {
  return {
    path: `${id}.md`,
    dir: '',
    filename: `${id}.md`,
    title: id,
    excerpt: null,
    warnings: [],
    fields: {
      id, status: 'todo', priority: 'medium', assignee: null, epic: null, dueDate: null,
      created: null, modified: null, completedAt: null, labels: [], order: 'a0', lane: null, ...f,
    },
  };
}

describe('passes', () => {
  const a = card('a', { priority: 'high', assignee: 'sam', labels: ['ui'], dueDate: '2026-09-26' });
  const b = card('b', { dueDate: '2026-09-27' });
  const c = card('c', { dueDate: '2026-10-02', labels: ['bug'] });
  const d = card('d', {});
  const all = [a, b, c, d];
  const ids = (f: Partial<typeof NO_FILTERS>, search: Set<string> | null = null) =>
    all.filter((x) => passes(x, { ...NO_FILTERS, ...f }, NOW, search)).map((x) => x.fields.id);

  it('filters by priority, assignee and label', () => {
    expect(ids({ priority: 'high' })).toEqual(['a']);
    expect(ids({ assignee: 'sam' })).toEqual(['a']);
    expect(ids({ label: 'bug' })).toEqual(['c']);
    expect(ids({ label: UNLABELLED })).toEqual(['b', 'd']);
  });

  it('filters by due date', () => {
    expect(ids({ due: 'overdue' })).toEqual(['a']);
    expect(ids({ due: 'today' })).toEqual(['b']);
    expect(ids({ due: 'week' })).toEqual(['b', 'c']);
    expect(ids({ due: 'none' })).toEqual(['d']);
  });

  it('uses the host search results, and ignores the query until they arrive', () => {
    expect(ids({ query: 'x' }, new Set(['c']))).toEqual(['c']);
    expect(ids({ query: 'x' }, null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('combines filters', () => {
    expect(ids({ due: 'week', label: 'bug' })).toEqual(['c']);
  });
});

describe('epicColor', () => {
  it('uses the configured colour, else a stable palette colour', () => {
    expect(epicColor('Media', { Media: '#123456' })).toBe('#123456');
    expect(epicColor('Media', {})).toBe(epicColor('Media', {}));
    expect(epicColor('Media', {})).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('laneValues and laneColor', () => {
  const cards = [card('a', { epic: 'Parser', priority: 'low' }), card('b', { epic: 'Compose', priority: 'critical' }), card('c', {})];

  it('puts configured lanes first (even empty), then used values, then none', async () => {
    const { laneValues } = await import('./filters.js');
    expect(laneValues(cards, 'epic', [{ name: 'Zeta' }, { name: 'Parser' }])).toEqual(['Zeta', 'Parser', 'Compose', null]);
    expect(laneValues(cards, 'priority', [])).toEqual(['critical', 'medium', 'low', null]);
    expect(laneValues(cards, 'lane', [])).toEqual([null]);
    // A "none" marker places that lane; unlisted values follow the last listed lane.
    expect(laneValues(cards, 'epic', [{ name: '', none: true }, { name: 'Zeta' }])).toEqual([null, 'Zeta', 'Compose', 'Parser']);
    expect(laneValues(cards, 'epic', [{ name: '', none: true }])).toEqual(['Compose', 'Parser', null]);
  });

  it('colours: configured, then priority colours, then the palette', async () => {
    const { laneColor } = await import('./filters.js');
    expect(laneColor('epic', 'Parser', [{ name: 'Parser', color: '#010203' }], {})).toBe('#010203');
    expect(laneColor('priority', 'critical', [], {})).toBe('#e5484d');
    expect(laneColor('epic', 'Parser', [], { Parser: '#aabbcc' })).toBe('#aabbcc');
  });
});

describe('reorderLanes', async () => {
  const { reorderLanes } = await import('./filters.js');
  it('moves down after the target and up before it; "none" (null) moves like any lane', () => {
    expect(reorderLanes(['A', 'B', 'C', null], 'A', 'C')).toEqual(['B', 'C', 'A', null]);
    expect(reorderLanes(['A', 'B', 'C', null], 'C', 'A')).toEqual(['C', 'A', 'B', null]);
    expect(reorderLanes(['A', 'B', 'C', null], 'B', null)).toEqual(['A', 'C', null, 'B']);
    expect(reorderLanes(['A', 'B', null], null, 'A')).toEqual([null, 'A', 'B']);
  });
});
