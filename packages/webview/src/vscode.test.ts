import type { BoardHost, BoardHostOptions, HostMessage } from '@kanban-bananas/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The transport is chosen when the module loads: a page's `kanbanBananasHost`
 * wins over VS Code's API. Each test loads the module afresh.
 */
describe('transport', () => {
  const g = globalThis as { kanbanBananasHost?: BoardHost; window?: unknown; location?: unknown };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete g.kanbanBananasHost;
    delete g.window;
    delete g.location;
  });

  it('talks to the page that hosts the board, and takes its options', async () => {
    const posted: unknown[] = [];
    const handlers = new Set<(m: HostMessage) => void>();
    let state: unknown = { collapsed: ['x'] };
    g.kanbanBananasHost = {
      postMessage: (m) => posted.push(m),
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      getState: () => state,
      setState: (s) => (state = s),
      options: { mode: 'hub', cspNonce: 'n0nce' },
    };
    const t = await import('./vscode.js');
    expect(t.hubMode).toBe(true);
    expect(t.hostOptions.cspNonce).toBe('n0nce');
    t.vscode.postMessage({ type: 'ping' });
    expect(posted).toEqual([{ type: 'ping' }]);
    expect(t.vscode.getState()).toEqual({ collapsed: ['x'] });
    expect(t.vscode.setState({ collapsed: [] })).toEqual({ collapsed: [] });
    expect(state).toEqual({ collapsed: [] });
    const got: HostMessage[] = [];
    const off = t.onHostMessage((m) => got.push(m));
    for (const h of handlers) h({ type: 'error', message: 'x' });
    expect(got).toEqual([{ type: 'error', message: 'x' }]);
    off();
    expect(handlers.size).toBe(0);
  });

  it('falls back to the dev stub outside VS Code, which is not hub mode and keeps state in memory', async () => {
    const win = new EventTarget();
    g.window = win;
    g.location = { search: '?state=%7B%22live%22%3Afalse%7D' };
    const t = await import('./vscode.js');
    expect(t.hubMode).toBe(false);
    expect(t.vscode.getState()).toEqual({ live: false });
    const got: HostMessage[] = [];
    t.onHostMessage((m) => got.push(m));
    win.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'error', message: 'dev' } }));
    expect(got).toEqual([{ type: 'error', message: 'dev' }]);
  });

  const pageHost = (options: BoardHostOptions): BoardHost => ({
    postMessage: () => undefined,
    onMessage: () => () => undefined,
    options,
  });

  it("shows one card's pane when a hub host names it (pane-only mode, a host's inspector)", async () => {
    g.kanbanBananasHost = pageHost({ mode: 'hub', pane: 'card-7' });
    const t = await import('./vscode.js');
    expect(t.paneCard).toBe('card-7');
  });

  it('ignores the pane outside hub mode, and an empty one', async () => {
    g.kanbanBananasHost = pageHost({ pane: 'card-7' });
    expect((await import('./vscode.js')).paneCard).toBeNull();
    vi.resetModules();
    g.kanbanBananasHost = pageHost({ mode: 'hub', pane: '' });
    expect((await import('./vscode.js')).paneCard).toBeNull();
    vi.resetModules();
    g.kanbanBananasHost = pageHost({ mode: 'hub' });
    expect((await import('./vscode.js')).paneCard).toBeNull();
  });
});
