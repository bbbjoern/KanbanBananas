import { describe, expect, it } from 'vitest';
import { addMemoryEntry, memoryNext, parseMemory, updateMemory } from '../src/index.js';

const T1 = new Date('2026-09-30T10:00:00.000Z');
const T2 = new Date('2026-09-30T12:00:00.000Z');

describe('session memory', () => {
  it('adds entries newest first and keeps only the limit', () => {
    let text = addMemoryEntry('', '**Working on:** a\n**Next:** build it', T1, 1);
    expect(parseMemory(text)).toEqual([{ at: T1.toISOString(), body: '**Working on:** a\n**Next:** build it' }]);
    expect(text).toContain('## 2026-09-30 10:00 UTC');
    text = addMemoryEntry(text, '**Next:** test it', T2, 1);
    expect(parseMemory(text).map((e) => e.at)).toEqual([T2.toISOString()]);
    text = addMemoryEntry(addMemoryEntry('', 'one', T1, 3), 'two', T2, 3);
    expect(parseMemory(text).map((e) => e.body)).toEqual(['two', 'one']);
  });

  it('caps the limit at 10 and at least 1', () => {
    let text = '';
    for (let i = 0; i < 12; i++) text = addMemoryEntry(text, `entry ${i}`, new Date(T1.getTime() + i * 1000), 50);
    expect(parseMemory(text)).toHaveLength(10);
    expect(parseMemory(addMemoryEntry(text, 'x', T2, 0))).toHaveLength(1);
  });

  it('still reads ISO headings from earlier previews', () => {
    expect(parseMemory('## 2026-09-29T08:15:30.123Z\n\nold')).toEqual([{ at: '2026-09-29T08:15:00.000Z', body: 'old' }]);
  });

  it('shows hand-written text outside the entries, dated by the file, and never drops it silently', () => {
    const hand = '# Session memory\n\nStatus from the card:\n- parser done\n- next: UI\n';
    const mtime = '2026-10-01T09:00:00.000Z';
    expect(parseMemory(hand, mtime)).toEqual([{ at: mtime, body: 'Status from the card:\n- parser done\n- next: UI', handWritten: true }]);
    // Carried by keep: with room for two, it stays (now with a heading); with one, it's reported as dropped.
    const two = updateMemory(hand, 'new', T2, 2, mtime);
    expect(parseMemory(two.text).map((e) => e.body)).toEqual(['new', 'Status from the card:\n- parser done\n- next: UI']);
    expect(two.dropped).toEqual([]);
    const one = updateMemory(hand, 'new', T2, 1, mtime);
    expect(one.dropped.map((e) => e.handWritten)).toEqual([true]);
  });

  it('ignores only the title and comments', () => {
    const fresh = addMemoryEntry('', 'x', T1, 1);
    expect(parseMemory(fresh).filter((e) => e.handWritten)).toEqual([]);
    expect(parseMemory('# Session memory (edited)\n<!-- note -->\n')).toEqual([]);
  });

  it('refuses an empty entry', () => {
    expect(() => addMemoryEntry('', '  ', T1, 1)).toThrow();
  });

  it('finds the Next line in common spellings', () => {
    expect(memoryNext({ at: '', body: '**Next:** wire up the UI' })).toBe('wire up the UI');
    expect(memoryNext({ at: '', body: 'Done: x\nNext: ship' })).toBe('ship');
    expect(memoryNext({ at: '', body: 'nothing' })).toBeNull();
  });
});
