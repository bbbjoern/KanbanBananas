import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM in these tests: a window and document that are just event targets.
const sent: { type: string; requestId?: string }[] = [];
vi.mock('./vscode.js', () => ({ vscode: { postMessage: (m: { type: string }) => sent.push(m) } }));

const win = new EventTarget();
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
Object.assign(globalThis, { window: win, document: doc });

const reply = (data: unknown) => win.dispatchEvent(Object.assign(new Event('message'), { data }));

describe('connection', () => {
  let c: typeof import('./connection.js');
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    sent.length = 0;
    c = await import('./connection.js');
    c.startConnectionChecks();
  });
  afterEach(() => vi.useRealTimers());

  it('resolves a request with the extension’s ack', async () => {
    const result = c.request({ type: 'move', id: 'a', toStatus: 'done', beforeId: null });
    expect(sent[0]).toMatchObject({ type: 'move', id: 'a' });
    reply({ type: 'ack', requestId: sent[0]!.requestId, ok: false, error: 'No such card' });
    await expect(result).resolves.toEqual({ ok: false, error: 'No such card' });
  });

  it('reports a request without an answer and marks the connection as lost', async () => {
    const result = c.request({ type: 'ping' });
    vi.advanceTimersByTime(c.ACK_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ ok: false, timedOut: true });
  });

  it('tells listeners when the connection comes back, once', () => {
    const back = vi.fn();
    c.onReconnect(back);
    reply({ type: 'board' });
    expect(back).not.toHaveBeenCalled(); // it never went away
    c.markDisconnected();
    reply({ type: 'ack', requestId: 'old', ok: true });
    reply({ type: 'board' });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('checks again soon while disconnected', () => {
    c.markDisconnected();
    vi.advanceTimersByTime(5000);
    expect(sent.some((m) => m.type === 'ping')).toBe(true);
  });
});
