import { describe, expect, it } from 'vitest';
import { loadBoard, toBoardView } from '../src/index.js';

const card = (body: string) => `---\nid: "a-2026-01-01"\nstatus: "todo"\n---\n${body}`;
const view = (body: string) => toBoardView(loadBoard([{ path: 'a-2026-01-01.md', text: card(body) }])).cards[0]!;

describe('toBoardView', () => {
  it('takes the first paragraph after the title as plain text', () => {
    const v = view('# Title\n\nSee [the docs](http://x) and **bold** `code`.\nSecond line.\n\nNext para.\n');
    expect(v.title).toBe('Title');
    expect(v.excerpt).toBe('See the docs and bold code. Second line.');
  });

  it('skips subheadings and code fences before the first paragraph', () => {
    expect(view('# T\n\n## Context\n\n```\ncode\n```\n\n- [ ] first task\n').excerpt).toBe('first task');
  });

  it('strips quote and list markers from every line', () => {
    expect(view('# T\n\n✅ Done.\n> - Settings → Appearance\n> 2. Second\n').excerpt).toBe(
      '✅ Done. Settings → Appearance Second',
    );
  });

  it('has no excerpt for a title-only card', () => {
    expect(view('# Title only').excerpt).toBeNull();
  });

  it('truncates long paragraphs', () => {
    const v = view('# T\n\n' + 'word '.repeat(100));
    expect(v.excerpt!.length).toBeLessThanOrEqual(160);
    expect(v.excerpt!.endsWith('…')).toBe(true);
  });

  it('lists broken files with the reason', () => {
    const b = toBoardView(loadBoard([{ path: 'x.md', text: '' }]));
    expect(b.broken).toEqual([{ path: 'x.md', filename: 'x.md', title: null, problems: ['File is empty.'] }]);
  });
});
