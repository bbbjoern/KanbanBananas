import type { BoardHost, BoardHostOptions, HostMessage, WebviewMessage } from '@kanban-bananas/core';

/**
 * The board's transport to its host, chosen once when the page loads:
 * 1. `window.kanbanBananasHost`: a page that shows the board outside VS Code (a
 *    project hub such as SuperTask) defines it before the bundle loads; see
 *    `BoardHost` in core. Its options can turn on hub mode.
 * 2. VS Code's webview API: the extension.
 * 3. The Vite dev server: a stub that logs and keeps state in memory; dev.ts
 *    installs a fake host that answers through window messages.
 */
interface Transport {
  postMessage(message: WebviewMessage): void;
  onMessage(handler: (message: HostMessage) => void): () => void;
  getState(): unknown;
  setState<T>(state: T): T;
  options: BoardHostOptions;
}

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

/** Host messages as `window.postMessage` events: VS Code's way, and the dev server's. */
function windowMessages(handler: (message: HostMessage) => void): () => void {
  const listener = (e: MessageEvent<HostMessage>) => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

function pageTransport(page: BoardHost): Transport {
  return {
    postMessage: (m) => page.postMessage(m),
    onMessage: (handler) => page.onMessage(handler),
    getState: () => page.getState?.(),
    setState: <T,>(s: T): T => {
      page.setState?.(s);
      return s;
    },
    options: page.options ?? {},
  };
}

function vsCodeTransport(api: VsCodeApi): Transport {
  return {
    postMessage: (m) => void api.postMessage(m),
    onMessage: windowMessages,
    getState: () => api.getState(),
    setState: (s) => api.setState(s),
    options: {},
  };
}

function devTransport(): Transport {
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
    },
    onMessage: windowMessages,
    getState: () => state,
    setState: <T,>(s: T): T => (state = s) as T,
    options: {},
  };
}

const page = (globalThis as { kanbanBananasHost?: BoardHost }).kanbanBananasHost;
const transport: Transport = page ? pageTransport(page) : typeof acquireVsCodeApi === 'function' ? vsCodeTransport(acquireVsCodeApi()) : devTransport();

/** Send to the host, and keep the page's view state (the names are VS Code's; the host may be another). */
export const vscode: Pick<Transport, 'postMessage' | 'getState' | 'setState'> = transport;

export const hostOptions: BoardHostOptions = transport.options;

/** Hub mode: the board shows a host's copy of the cards, changed only through requests (BoardHostOptions in core). */
export const hubMode = hostOptions.mode === 'hub';

export function onHostMessage(handler: (m: HostMessage) => void): () => void {
  return transport.onMessage(handler);
}
