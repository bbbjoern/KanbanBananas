import type { HostMessage, WebviewMessage } from '@kanban-bananas/core';

/**
 * Typed as VS Code behaves: setState returns the state and postMessage returns
 * a value too. So neither can be the whole body of a React effect (React would
 * call the result as a cleanup function and crash); the compiler now says so.
 */
interface VsCodeApi {
  postMessage(message: WebviewMessage): unknown;
  getState(): unknown;
  setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Outside VS Code (the Vite dev server), fall back to a stub that logs and keeps state in memory. */
export const vscode: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : (() => {
        // Dev server: ?state=<json> seeds the UI state; dev.ts may install a fake host.
        let state: unknown;
        try {
          const seeded = new URLSearchParams(location.search).get('state');
          if (seeded) state = JSON.parse(seeded);
        } catch {
          // ignore
        }
        return {
          postMessage: (m) => {
            console.log('[webview → host]', m);
            (window as { __kanbanDevHost?: (m: WebviewMessage) => void }).__kanbanDevHost?.(m);
            return true;
          },
          getState: () => state,
          setState: <T,>(s: T): T => (state = s) as T,
        };
      })();

export function onHostMessage(handler: (m: HostMessage) => void): () => void {
  const listener = (e: MessageEvent<HostMessage>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
