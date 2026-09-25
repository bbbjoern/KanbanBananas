import type { HostMessage, WebviewMessage } from '@kanban-bananas/core';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Outside VS Code (the Vite dev server), fall back to a stub that logs and keeps state in memory. */
export const vscode: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : (() => {
        let state: unknown;
        return {
          postMessage: (m) => console.log('[webview → host]', m),
          getState: () => state,
          setState: (s) => void (state = s),
        };
      })();

export function onHostMessage(handler: (m: HostMessage) => void): () => void {
  const listener = (e: MessageEvent<HostMessage>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
