import { describe, expect, it } from 'vitest';
import { addEntry, countEntries, entryMarkdown, tickEntry } from '../src/entries.js';

const LOG = `# Minor UI bugs

## Policy
A running log for minor UI bugs.

- [ ] **Title cut off**: long titles truncate
  ![](/.devtool/assets/x/a.webp)
- [x] **Row date column**: too narrow
\`\`\`
- [ ] not an entry, in code
\`\`\`
`;

describe('log entries', () => {
  it('counts top-level task entries outside code', () => {
    expect(countEntries(LOG)).toEqual({ open: 1, done: 1 });
  });

  it('writes an entry with its text indented under it', () => {
    expect(entryMarkdown({ title: 'Inspector', text: 'cut off\n![](/x.webp)' })).toBe('- [ ] **Inspector**: cut off\n  ![](/x.webp)');
    expect(entryMarkdown({ text: 'Just text' })).toBe('- [ ] Just text');
    expect(() => entryMarkdown({ title: ' ', text: '' })).toThrow(/needs a title or text/);
  });

  it('adds an entry after a blank line', () => {
    const added = addEntry('- [ ] one\n  ![](/a.webp)\n', '- [ ] two');
    expect(added).toBe('- [ ] one\n  ![](/a.webp)\n\n- [ ] two\n');
    expect(addEntry('# Log\n\nIntro text.\n', '- [ ] first')).toBe('# Log\n\nIntro text.\n\n- [ ] first\n');
    expect(addEntry('', '- [ ] first')).toBe('- [ ] first\n');
  });

  it('ticks the one open entry that matches, and explains otherwise', () => {
    expect(tickEntry(LOG, 'title cut')).toContain('- [x] **Title cut off**');
    expect(() => tickEntry(LOG, 'row date')).toThrow(/already done/);
    expect(() => tickEntry(LOG, 'nothing like it')).toThrow(/No open entry/);
    expect(() => tickEntry('- [ ] a bug\n- [ ] another bug\n', 'bug')).toThrow(/2 open entries match/);
    expect(() => tickEntry(LOG, 'not an entry')).toThrow(/No open entry/);
  });
});
