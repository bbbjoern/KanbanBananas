import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserMenu, foldsAfter, laneKey, listenForMenus, LONG_PRESS_MS, targetOf } from './menus.js';

const ctx = (o: Record<string, unknown>) => JSON.stringify({ preventDefaultContextMenuItems: true, ...o });

describe('host menus: the target', () => {
  it('reads a card, a column and a lane from data-vscode-context, with their folds', () => {
    expect(targetOf(ctx({ webviewSection: 'card', cardId: 'a-1' }), [])).toEqual({ section: 'card', cardId: 'a-1' });
    expect(targetOf(ctx({ webviewSection: 'column', status: 'todo' }), ['todo'])).toEqual({ section: 'column', status: 'todo', folded: true });
    expect(targetOf(ctx({ webviewSection: 'lane', field: 'epic', value: 'Board' }), [])).toEqual({ section: 'lane', field: 'epic', value: 'Board', folded: false });
    expect(targetOf(ctx({ webviewSection: 'laneNone', field: 'epic', value: null }), [laneKey('epic', null)])).toEqual({ section: 'lane', field: 'epic', value: null, folded: true });
  });

  it('is nothing for anything else, or text that is not JSON', () => {
    expect(targetOf(undefined, [])).toBeNull();
    expect(targetOf('{', [])).toBeNull();
    expect(targetOf(ctx({ webviewSection: 'card' }), [])).toBeNull();
    expect(targetOf(ctx({ webviewSection: 'other' }), [])).toBeNull();
  });

  it('keeps the browser’s menu with Shift, in text fields, the editor and on links', () => {
    const at = (inside: string | null) => ({ closest: (sel: string) => (inside && sel.split(', ').includes(inside) ? {} : null) }) as unknown as Element;
    expect(browserMenu(at(null), true)).toBe(true);
    for (const inside of ['input', 'textarea', 'select', '[contenteditable="true"]', 'a[href]', '.cm-editor']) expect(browserMenu(at(inside), false)).toBe(true);
    expect(browserMenu(at(null), false)).toBe(false);
  });
});

describe('host menus: folds', () => {
  const lanes = [laneKey('epic', 'A'), laneKey('epic', 'B'), laneKey('epic', null)];
  it('folds and unfolds a column or a lane', () => {
    expect(foldsAfter([], { action: 'foldColumn', status: 'todo' }, lanes)).toEqual(['todo']);
    expect(foldsAfter(['todo'], { action: 'foldColumn', status: 'todo' }, lanes)).toEqual([]);
    expect(foldsAfter([], { action: 'foldLane', field: 'epic', value: null }, lanes)).toEqual(['#lane:epic:']);
  });

  it('folds every lane of the grouping, or opens them all, and leaves the columns', () => {
    expect(foldsAfter(['todo', laneKey('epic', 'A')], { action: 'foldAllLanes' }, lanes)).toEqual(['todo', ...lanes]);
    expect(foldsAfter(['todo', ...lanes], { action: 'expandAllLanes' }, lanes)).toEqual(['todo']);
    expect(foldsAfter(['todo'], { action: 'openCard', id: 'x' }, lanes)).toEqual(['todo']);
  });
});

describe('host menus: the listener', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.document;
    delete g.Element;
    vi.useRealTimers();
  });

  function page() {
    class FakeElement {
      constructor(
        readonly context: string | null,
        readonly field = false,
      ) {}
      dataset = {} as Record<string, string>;
      closest(sel: string) {
        if (sel === '[data-vscode-context]') return this.context ? Object.assign(this, { dataset: { vscodeContext: this.context } }) : null;
        return this.field && sel.includes('input') ? this : null;
      }
      getBoundingClientRect() {
        return { right: 300, top: 40 };
      }
    }
    const listeners = new Map<string, (e: unknown) => void>();
    g.Element = FakeElement;
    g.document = { addEventListener: (t: string, h: (e: unknown) => void) => listeners.set(t, h), removeEventListener: (t: string) => listeners.delete(t) };
    const opened: unknown[] = [];
    const stop = listenForMenus(() => ['todo'], (target, x, y) => opened.push({ ...target, x, y }));
    const fire = (type: string, e: Record<string, unknown>) => {
      const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn(), ...e };
      listeners.get(type)!(ev);
      return ev;
    };
    return { FakeElement, listeners, opened, stop, fire };
  }

  it('a right-click on a card or head opens the host’s menu there; elsewhere, with Shift or in a field, the browser’s', () => {
    const { FakeElement, opened, fire, stop, listeners } = page();
    const card = new FakeElement(ctx({ webviewSection: 'card', cardId: 'a-1' }));
    const e1 = fire('contextmenu', { target: card, button: 2, clientX: 120, clientY: 80, shiftKey: false });
    expect(e1.preventDefault).toHaveBeenCalled();
    const column = new FakeElement(ctx({ webviewSection: 'column', status: 'todo' }));
    fire('contextmenu', { target: column, button: 2, clientX: 10, clientY: 20, shiftKey: false });
    expect(opened).toEqual([
      { section: 'card', cardId: 'a-1', x: 120, y: 80 },
      { section: 'column', status: 'todo', folded: true, x: 10, y: 20 },
    ]);
    const shifted = fire('contextmenu', { target: card, button: 2, clientX: 1, clientY: 1, shiftKey: true });
    const ground = fire('contextmenu', { target: new FakeElement(null), button: 2, clientX: 1, clientY: 1, shiftKey: false });
    const typing = fire('contextmenu', { target: new FakeElement(ctx({ webviewSection: 'card', cardId: 'a-1' }), true), button: 2, clientX: 1, clientY: 1, shiftKey: false });
    for (const e of [shifted, ground, typing]) expect(e.preventDefault).not.toHaveBeenCalled();
    expect(opened).toHaveLength(2);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('from the keyboard (no pointer) it opens at the element’s top-right corner', () => {
    const { FakeElement, opened, fire } = page();
    fire('contextmenu', { target: new FakeElement(ctx({ webviewSection: 'card', cardId: 'a-1' })), button: 0, clientX: 0, clientY: 0, shiftKey: false });
    expect(opened).toEqual([{ section: 'card', cardId: 'a-1', x: 292, y: 48 }]);
  });

  it('a touch press of 500 ms opens it and swallows the click that ends it; moving first cancels', () => {
    vi.useFakeTimers();
    const { FakeElement, opened, fire } = page();
    const card = new FakeElement(ctx({ webviewSection: 'card', cardId: 'a-1' }));
    fire('pointerdown', { target: card, pointerType: 'touch', clientX: 50, clientY: 60 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(opened).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(opened).toEqual([{ section: 'card', cardId: 'a-1', x: 50, y: 60 }]);
    const click = fire('click', {});
    expect(click.preventDefault).toHaveBeenCalled();
    fire('pointerdown', { target: card, pointerType: 'touch', clientX: 50, clientY: 60 });
    fire('pointermove', { clientX: 50, clientY: 75 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(opened).toHaveLength(1);
    fire('pointerdown', { target: card, pointerType: 'mouse', clientX: 50, clientY: 60 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(opened).toHaveLength(1);
    expect(fire('click', {}).preventDefault).not.toHaveBeenCalled();
  });
});
