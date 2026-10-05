import type { HostMessage, WebviewMessage } from '@kanban-bananas/core';
import { useSyncExternalStore } from 'react';
import { vscode } from './vscode.js';

/**
 * Is the extension still listening? The page can outlive its connection: over
 * Remote SSH, after the laptop sleeps, the extension may restart while this
 * page stays open, and messages then go nowhere. So changes are sent as
 * requests the extension acknowledges; a missing ack marks the connection as
 * lost, and the page says so instead of pretending the change was saved.
 */

export const ACK_TIMEOUT_MS = 8000;
const HEARTBEAT_MS = 20_000;
const RETRY_MS = 5000;

export interface RequestResult {
  ok: boolean;
  error?: string;
  /** No answer at all: the change probably didn't reach the extension. */
  timedOut?: boolean;
}

let connected = true;
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();
const pending = new Map<string, { resolve: (r: RequestResult) => void; timer: ReturnType<typeof setTimeout> }>();

function setConnected(value: boolean): void {
  if (value === connected) return;
  connected = value;
  for (const l of listeners) l();
  if (value) for (const l of reconnectListeners) l();
  schedule();
}

/** Send a message and wait for the extension's ack. Never rejects. */
export function request(message: WebviewMessage, timeoutMs = ACK_TIMEOUT_MS): Promise<RequestResult> {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      setConnected(false);
      resolve({ ok: false, timedOut: true, error: "VS Code didn't confirm the change" });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    vscode.postMessage({ ...message, requestId } as WebviewMessage);
  });
}

/** Mark the connection as lost (e.g. an editor save got no answer). */
export function markDisconnected(): void {
  setConnected(false);
}

/** Any message from the extension shows it's there. */
function onMessage(e: MessageEvent<HostMessage>): void {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  setConnected(true);
  if (m.type === 'ack') {
    const p = pending.get(m.requestId);
    if (!p) return;
    pending.delete(m.requestId);
    clearTimeout(p.timer);
    p.resolve({ ok: m.ok, ...(m.error ? { error: m.error } : {}) });
  }
}

/** Check now (e.g. when the user comes back to the board). */
export function checkConnection(): void {
  void request({ type: 'ping' });
}

let heartbeat: ReturnType<typeof setTimeout> | undefined;
function schedule(): void {
  clearTimeout(heartbeat);
  heartbeat = setTimeout(() => {
    if (document.visibilityState === 'visible') checkConnection();
    schedule();
  }, connected ? HEARTBEAT_MS : RETRY_MS);
}

let started = false;
/** Start listening for acks, and checking when the board becomes visible or focused, and now and then. */
export function startConnectionChecks(): void {
  if (started) return;
  started = true;
  window.addEventListener('message', onMessage);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkConnection();
  });
  window.addEventListener('focus', checkConnection);
  schedule();
}

/** React: is the extension connected? */
export function useConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => connected,
  );
}

/** Run `fn` whenever the connection comes back. Returns an unsubscribe function. */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}
