import { describe, expect, it } from 'vitest';
import { cardFromEntry, entryAt, entryBlocks, imagePlacement, listIndentAt } from './entries.js';

const apply = (doc: string, p: { from: number; insert: string }) => doc.slice(0, p.from) + p.insert + doc.slice(p.from);

describe('entries in the editor', () => {
  it('finds the indent that keeps a line inside a list item', () => {
    const doc = '- [ ] one\n  more\n\nplain';
    expect(listIndentAt(doc, 3)).toBe(2);
    expect(listIndentAt(doc, doc.indexOf('more'))).toBe(2);
    expect(listIndentAt(doc, doc.indexOf('plain'))).toBeNull();
    expect(listIndentAt('1. first', 4)).toBe(3);
  });

  it('puts a pasted image under the entry the cursor is in', () => {
    const doc = '- [ ] Title cut off\n- [ ] next';
    const p = imagePlacement(doc, 10, '/a.webp', false);
    expect(apply(doc, p)).toBe('- [ ] Title cut off\n  ![](/a.webp)\n- [ ] next');
  });

  it('in a log card, an image pasted on an empty line starts a new entry', () => {
    const doc = '# Log\n\n- [ ] one\n';
    const p = imagePlacement(doc, doc.length, '/b.webp', true);
    expect(apply(doc, p)).toBe('# Log\n\n- [ ] one\n\n- [ ] \n  ![](/b.webp)');
    expect(p.cursor).toBe(doc.length + 7);
    // Not a log card: on a line of its own, as before.
    expect(apply('Text', imagePlacement('Text', 4, '/c.webp', false))).toBe('Text\n![](/c.webp)');
  });

  it('finds the whole entry, screenshot lines included', () => {
    const doc = 'Intro\n\n- [ ] **Title**: cut off\n  ![](/a.webp)\n- [x] done one\n';
    const e = entryAt(doc, doc.indexOf('a.webp'))!;
    expect(e.text).toBe('- [ ] **Title**: cut off\n  ![](/a.webp)');
    expect(entryAt(doc, 2)).toBeNull();
  });

  it('makes a card from an entry: title from the first line, the rest as body', () => {
    expect(cardFromEntry('- [ ] **Title cut off**: long titles truncate\n  ![](/a.webp)')).toEqual({
      title: 'Title cut off',
      body: 'long titles truncate\n![](/a.webp)',
    });
    expect(cardFromEntry('- [ ] Row date: too narrow')).toEqual({ title: 'Row date', body: 'too narrow' });
    expect(cardFromEntry('- [ ] Just a short note')).toEqual({ title: 'Just a short note', body: '' });
  });
});

describe('log card entries', () => {
  it('finds each entry with its indented lines, also an empty one just typed', () => {
    const doc = '# Log\n\n- [ ] one\n  desc\n  \n\n- [x] two\n```\n- [ ] code\n```\ntext';
    expect(entryBlocks(doc)).toEqual([
      { first: 2, last: 4 },
      { first: 6, last: 6 },
    ]);
  });

  it('a screenshot pasted into an entry stays in it, also on its empty line', () => {
    const doc = '- [ ] one\n  ';
    const p = imagePlacement(doc, doc.length, '/a.webp', true);
    expect(doc.slice(0, p.from) + p.insert + doc.slice(p.to ?? p.from)).toBe('- [ ] one\n  ![](/a.webp)');
  });
});
