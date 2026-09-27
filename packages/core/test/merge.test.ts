import { describe, expect, it } from 'vitest';
import { applyCardEdit, BodyConflictError, mergeText, parseCard } from '../src/index.js';

describe('mergeText', () => {
  const base = '# T\n\nline one\nline two\nline three\n';

  it('keeps both: my edit in the middle and a note appended by someone else', () => {
    const mine = '# T\n\nline ONE edited\nline two\nline three\n';
    const theirs = base + '\n## Done — agent\n\nNote.\n';
    expect(mergeText(base, mine, theirs)).toBe('# T\n\nline ONE edited\nline two\nline three\n\n## Done — agent\n\nNote.\n');
  });

  it('short-cuts the trivial cases', () => {
    expect(mergeText(base, base, 'x')).toBe('x');
    expect(mergeText(base, 'x', base)).toBe('x');
    expect(mergeText(base, 'x', 'x')).toBe('x');
  });

  it('reports a conflict when both changed the same line', () => {
    expect(mergeText(base, base.replace('two', 'mine'), base.replace('two', 'theirs'))).toBeNull();
  });
});

describe('applyCardEdit with rebase', () => {
  const card = '---\nid: "a"\nstatus: "todo"\n---\n# T\n\nline one\nline two\n';
  const base = '# T\n\nline one\nline two\n';

  it('writes mine when the body is unchanged', () => {
    const out = applyCardEdit(card, { fields: {}, rebase: { base, mine: base + 'typed\n' } });
    expect(out).toBe(card + 'typed\n');
  });

  it('merges with an outside change, and keeps CRLF', () => {
    const crlf = card.replace(/\n/g, '\r\n') + '\r\n## Note\r\n';
    const out = applyCardEdit(crlf, { fields: {}, rebase: { base, mine: base.replace('one', 'ONE') } });
    const parsed = parseCard(out);
    expect(parsed.ok && parsed.card.source.body).toBe('# T\r\n\r\nline ONE\r\nline two\r\n\r\n## Note\r\n');
  });

  it('throws BodyConflictError with their text, and writes nothing', () => {
    const theirs = card.replace('line two', 'line 2');
    expect(() => applyCardEdit(theirs, { fields: {}, rebase: { base, mine: base.replace('line two', 'line II') } })).toThrow(BodyConflictError);
  });
});
