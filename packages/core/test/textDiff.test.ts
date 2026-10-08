import { describe, expect, it } from 'vitest';
import { textChanges, type TextChange } from '../src/textDiff.js';

function apply(a: string, changes: TextChange[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    expect(c.from).toBeGreaterThanOrEqual(pos);
    expect(c.to).toBeLessThanOrEqual(a.length);
    out += a.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + a.slice(pos);
}

describe('textChanges', () => {
  it('keeps separate edits separate', () => {
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'one\nTWO\nthree\nfour\nfive!';
    expect(textChanges(a, b)).toEqual([
      { from: 4, to: 7, insert: 'TWO' },
      { from: 23, to: 23, insert: '!' },
    ]);
  });

  it('handles lines added or removed at the start and end', () => {
    for (const [a, b] of [
      ['x', 'x\ny'],
      ['x\ny', 'x'],
      ['y', ''],
      ['', 'y'],
      ['a\nb', 'z\na\nb'],
      ['z\na\nb', 'a\nb'],
      ['a\n', 'a\n\n'],
      ['a\n\n', 'a\n'],
    ] as const) {
      expect(apply(a, textChanges(a, b)), JSON.stringify([a, b])).toBe(b);
    }
  });

  it('turns any text into any other (random edits)', () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const pieces = ['a', 'b', '\n', '\n\n', ' ', '- [ ] x', '## H', '.'];
    const text = () => Array.from({ length: rand(30) }, () => pieces[rand(pieces.length)]).join('');
    for (let i = 0; i < 2000; i++) {
      const a = text();
      const b = rand(2) ? text() : a.slice(0, rand(a.length + 1)) + text() + a.slice(rand(a.length + 1));
      expect(apply(a, textChanges(a, b)), JSON.stringify([a, b])).toBe(b);
    }
  });
});
