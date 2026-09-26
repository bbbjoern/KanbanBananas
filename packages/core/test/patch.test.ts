import { describe, expect, it } from 'vitest';
import { parseCard, patchFields, PatchError } from '../src/index.js';
import { CORPUS, readBoardDir } from './helpers.js';

/** Lines that differ between two texts with the same number of lines, as [old, new] pairs. */
function changedLines(a: string, b: string): [string, string][] {
  const la = a.split('\n');
  const lb = b.split('\n');
  expect(lb.length).toBe(la.length);
  return la.flatMap((line, i) => (line === lb[i] ? [] : [[line, lb[i]!] as [string, string]]));
}

const CARD = `---
id: "x-2026-01-01"
status: "todo"
priority: "medium"
assignee: null
epic: null
dueDate: null
created: "2026-01-01T00:00:00.000Z"
modified: "2026-01-01T00:00:00.000Z"
completedAt: null
labels: ["ui", "auth"]
order: "a1"
---
# Title`;

describe('patchFields', () => {
  it('changes exactly the one value line per field', () => {
    const out = patchFields(CARD, { status: 'done', order: 'a2', labels: ['bug'], completedAt: '2026-02-01T00:00:00.000Z' });
    expect(changedLines(CARD, out)).toEqual([
      ['status: "todo"', 'status: "done"'],
      ['completedAt: null', 'completedAt: "2026-02-01T00:00:00.000Z"'],
      ['labels: ["ui", "auth"]', 'labels: ["bug"]'],
      ['order: "a1"', 'order: "a2"'],
    ]);
  });

  it('writes null and empty lists the way the old board did', () => {
    const out = patchFields(CARD, { priority: null, labels: [] });
    expect(changedLines(CARD, out)).toEqual([
      ['priority: "medium"', 'priority: null'],
      ['labels: ["ui", "auth"]', 'labels: []'],
    ]);
  });

  it('keeps comments, unknown keys, CRLF and the BOM', () => {
    const text = '﻿---\r\nid: "x" # keep me\r\ncustom: yes\r\nstatus: todo\r\n---\r\n# T\r\n';
    const out = patchFields(text, { status: 'review' });
    expect(out).toBe('﻿---\r\nid: "x" # keep me\r\ncustom: yes\r\nstatus: review\r\n---\r\n# T\r\n');
  });

  it('keeps single-quoted style, and falls back to double quotes when plain would be ambiguous', () => {
    expect(patchFields("---\nid: 'x'\n---\n", { id: "it's" })).toBe("---\nid: 'it''s'\n---\n");
    expect(patchFields('---\nid: x\n---\n', { id: 'true' })).toBe('---\nid: "true"\n---\n');
    expect(patchFields('---\nid: x\n---\n', { id: 'a: b' })).toBe('---\nid: "a: b"\n---\n');
  });

  it('turns a numeric order into a string key', () => {
    expect(patchFields('---\nid: "x"\norder: 0\n---\n', { order: 'a0' })).toBe('---\nid: "x"\norder: "a0"\n---\n');
  });

  it('fills an empty value and replaces a block list with an inline one', () => {
    const text = '---\nid: "x"\nepic:\nlabels:\n  - a\n  - b\norder: "a0"\n---\n# T\n';
    expect(patchFields(text, { epic: 'E', labels: ['c'] })).toBe('---\nid: "x"\nepic: "E"\nlabels: ["c"]\norder: "a0"\n---\n# T\n');
  });

  it('appends a missing key at the end of the frontmatter', () => {
    expect(patchFields('---\nid: "x"\n---\n# T', { completedAt: null })).toBe('---\nid: "x"\ncompletedAt: null\n---\n# T');
  });

  it('escapes values that need it', () => {
    const out = patchFields(CARD, { assignee: 'Zoë "Z" \\ Doe', labels: ['a"b'] });
    const r = parseCard(out);
    expect(r.ok && r.card.fields.assignee).toBe('Zoë "Z" \\ Doe');
    expect(r.ok && r.card.fields.labels).toEqual(['a"b']);
  });

  it('refuses to patch a file that does not parse', () => {
    expect(() => patchFields('', { status: 'todo' })).toThrow(PatchError);
    expect(() => patchFields('# no frontmatter', { status: 'todo' })).toThrow(PatchError);
  });
});

const corpus = readBoardDir(CORPUS);

describe.skipIf(corpus.length === 0)('patchFields on the corpus', () => {
  it('changes exactly the expected lines and leaves the body byte-identical on every card', () => {
    for (const file of corpus) {
      const out = patchFields(file.text, { status: 'review', order: 'a0V', priority: 'high', labels: ['x', 'y'] });
      const changed = changedLines(file.text, out).map(([, next]) => next);
      const expected = ['status: "review"', 'priority: "high"', 'labels: ["x", "y"]', 'order: "a0V"'];
      // A line only counts as changed if its old value differed.
      expect(changed.every((l) => expected.includes(l)), file.path).toBe(true);
      const before = parseCard(file.text);
      const after = parseCard(out);
      expect(before.ok && after.ok && after.card.source.body === before.card.source.body, file.path).toBe(true);
    }
  });
});
