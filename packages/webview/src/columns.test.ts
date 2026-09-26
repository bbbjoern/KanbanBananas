import { describe, expect, it } from 'vitest';
import { moveCard, moveIntent, type Columns } from './columns.js';

const cols: Columns = { todo: ['a', 'b', 'c'], review: ['d'], done: [] };

describe('moveCard + moveIntent', () => {
  it('reorders within a column', () => {
    const after = moveCard(cols, 'c', 'todo', 0);
    expect(after.todo).toEqual(['c', 'a', 'b']);
    expect(moveIntent(cols, after, 'c')).toEqual({ toStatus: 'todo', beforeId: 'a' });
  });

  it('moves to the end of another column', () => {
    const after = moveCard(cols, 'a', 'review', 5);
    expect(after.review).toEqual(['d', 'a']);
    expect(moveIntent(cols, after, 'a')).toEqual({ toStatus: 'review', beforeId: null });
  });

  it('moves into an empty column', () => {
    expect(moveIntent(cols, moveCard(cols, 'b', 'done', 0), 'b')).toEqual({ toStatus: 'done', beforeId: null });
  });

  it('reports no move when dropped where it started', () => {
    expect(moveIntent(cols, moveCard(cols, 'b', 'todo', 1), 'b')).toBeNull();
  });
});
