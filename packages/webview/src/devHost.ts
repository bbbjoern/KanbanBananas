// Vite dev server only, loaded before main.tsx: `?hub` plays a page that hosts
// the board outside VS Code (hub mode), through the same window messages the
// fake host in dev.ts answers. `?readonly` shows the board as read-only (the
// machine away); `?requests` puts a request of every state on the first cards.
import type { BoardHost, CardRequest, HostMessage, WebviewMessage } from '@kanban-bananas/core';

const params = new URLSearchParams(location.search);
if (params.has('hub')) {
  const host: BoardHost = {
    postMessage: (m: WebviewMessage) => {
      console.log('[board → hub host]', m);
      (window as { __kanbanDevHost?: (m: WebviewMessage) => void }).__kanbanDevHost?.(m);
    },
    onMessage: (handler) => {
      const listener = (e: MessageEvent<HostMessage>) => handler(e.data);
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    options: { mode: 'hub' },
  };
  (window as { kanbanBananasHost?: BoardHost }).kanbanBananasHost = host;

  // Once the board is there (dev.ts posts it), the hub state follows, as a real host would send it.
  window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
    if (e.data?.type !== 'state') return;
    const cards = e.data.board.cards;
    const status = e.data.settings.columns[0]?.id ?? 'backlog';
    const machine = 'MacBook Pro';
    const now = Date.now();
    const at = (i: number) => cards[i]?.fields.id ?? null;
    const requests: CardRequest[] = params.has('requests')
      ? [
          { id: 'r-pending', cardId: at(0), state: 'pending', since: now - 3000 },
          { id: 'r-fresh', cardId: at(1), state: 'pending', since: now },
          { id: 'r-applied', cardId: at(2), state: 'applied', since: now - 500 },
          {
            id: 'r-stale',
            cardId: at(3),
            state: 'stale',
            since: now - 9000,
            note: 'Not moved: it changed in VS Code meanwhile. This is the card as it is now.',
            actions: [
              { id: 'retry', label: 'Move to Review' },
              { id: 'dismiss', label: 'Dismiss' },
            ],
          },
          {
            id: 'r-conflict',
            cardId: at(4),
            state: 'conflict',
            since: now - 9000,
            note: 'Not saved: your edit overlaps a change made in VS Code.',
            actions: [
              { id: 'compare', label: 'Compare' },
              { id: 'dismiss', label: 'Dismiss' },
            ],
          },
          {
            id: 'r-gone',
            cardId: 'a-card-that-was-deleted-2026-10-01',
            state: 'gone',
            since: now - 9000,
            note: "This card was deleted or renamed in the repo. Your change wasn't applied.",
            actions: [
              { id: 'copy', label: 'Copy my text' },
              { id: 'dismiss', label: 'Dismiss' },
            ],
            placeholder: { title: 'A card that was deleted', status },
          },
          {
            id: 'r-expired',
            cardId: at(5),
            state: 'expired',
            since: now - 16 * 60_000,
            note: `Dropped: ${machine} stayed away for 15 minutes. Nothing was changed.`,
            actions: [
              { id: 'resend', label: 'Send again' },
              { id: 'dismiss', label: 'Dismiss' },
            ],
          },
          { id: 'r-create', cardId: null, state: 'pending', since: now - 2000, placeholder: { title: 'A card being created', status } },
        ]
      : [];
    const hubState: HostMessage = { type: 'hubState', readOnly: params.has('readonly'), machine, requests };
    setTimeout(() => window.postMessage(hubState, '*'), 0);
  });
}

export {};
