import { describe, expect, it, vi } from 'vitest';
import { focusFromMenu } from './menuFocus.js';

// A pane with one field row, its control and the calls made on them.
function pane(field: string, control: 'enabled' | 'disabled' | 'none' = 'enabled') {
  const calls: string[] = [];
  const blur: (() => void)[] = [];
  const target = {
    focus: vi.fn((o: unknown) => calls.push(`focus ${JSON.stringify(o)}`)),
    addEventListener: (type: string, fn: () => void, o: unknown) => {
      calls.push(`listen ${type} ${JSON.stringify(o)}`);
      blur.push(fn);
    },
  };
  const dataset: Record<string, string> = {};
  const row = {
    dataset,
    get offsetWidth() {
      calls.push(`layout ${'menuFocus' in dataset ? 'marked' : 'clear'}`);
      return 100;
    },
    scrollIntoView: (o: unknown) => calls.push(`scroll ${JSON.stringify(o)}`),
    querySelector: (sel: string) => {
      calls.push(`find ${sel}`);
      return control === 'enabled' ? target : null;
    },
  };
  const root = { querySelector: (sel: string) => (sel === `[data-field="${field}"]` ? row : null) } as unknown as ParentNode;
  return { root, row, calls, blur };
}

describe('a field focused from a host menu (8f)', () => {
  it('scrolls to the row, focuses the control and marks the row', () => {
    const p = pane('dueDate');
    expect(focusFromMenu(p.root, 'dueDate')).toBe(true);
    expect(p.calls).toEqual([
      'find input:not([disabled]), select:not([disabled]), button:not([disabled])',
      'scroll {"block":"nearest"}',
      'focus {"preventScroll":true}',
      'layout clear',
      'listen blur {"once":true}',
    ]);
    expect(p.row.dataset).toEqual({ menuFocus: '' });
  });

  it('restarts the tint when asked again, and drops the mark with the focus', () => {
    const p = pane('labels');
    focusFromMenu(p.root, 'labels');
    focusFromMenu(p.root, 'labels');
    // The second time the mark is off for the layout read, so the animation starts over.
    expect(p.calls.filter((c) => c.startsWith('layout'))).toEqual(['layout clear', 'layout clear']);
    expect(p.row.dataset).toEqual({ menuFocus: '' });
    p.blur[1]!();
    expect(p.row.dataset).toEqual({});
  });

  it('does nothing for a field the pane does not show, or a control that is off', () => {
    expect(focusFromMenu(pane('epic').root, 'assignee')).toBe(false);
    const off = pane('epic', 'disabled');
    expect(focusFromMenu(off.root, 'epic')).toBe(false);
    expect(off.row.dataset).toEqual({});
    expect(off.calls.some((c) => c.startsWith('scroll'))).toBe(false);
  });
});
