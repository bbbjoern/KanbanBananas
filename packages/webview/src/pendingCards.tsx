import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { request } from './connection.js';

/**
 * New cards the extension hasn't confirmed yet. A card shows as "Creating…"
 * the moment it's submitted and disappears once the extension confirms it
 * (the real card arrives with the board). Without a confirmation it stays,
 * title and all, as "Not created" with Retry, so nothing typed is lost.
 */
export interface PendingCard {
  key: string;
  title: string;
  status: string;
  state: 'creating' | 'failed';
  error?: string;
}

interface PendingCards {
  pending: PendingCard[];
  create: (title: string, status: string) => void;
  retry: (key: string) => void;
  discard: (key: string) => void;
}

const Context = createContext<PendingCards>({ pending: [], create: () => {}, retry: () => {}, discard: () => {} });

export function PendingCardsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingCard[]>([]);

  const send = useCallback((card: PendingCard) => {
    void request({ type: 'create', title: card.title, status: card.status }).then((r) => {
      setPending((list) =>
        r.ok
          ? list.filter((p) => p.key !== card.key)
          : list.map((p) =>
              p.key === card.key
                ? {
                    ...p,
                    state: 'failed',
                    error: r.timedOut ? 'VS Code didn\'t confirm it, so it may not be saved' : r.error ?? 'not created',
                  }
                : p,
            ),
      );
    });
  }, []);

  const value = useMemo<PendingCards>(
    () => ({
      pending,
      create: (title, status) => {
        const card: PendingCard = { key: `${Date.now()}-${Math.random()}`, title, status, state: 'creating' };
        setPending((list) => [...list, card]);
        send(card);
      },
      retry: (key) => {
        const card = pending.find((p) => p.key === key);
        if (!card) return;
        const again: PendingCard = { ...card, state: 'creating' };
        setPending((list) => list.map((p) => (p.key === key ? again : p)));
        send(again);
      },
      discard: (key) => setPending((list) => list.filter((p) => p.key !== key)),
    }),
    [pending, send],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePendingCards(): PendingCards {
  return useContext(Context);
}

/** The pending cards of one column. */
export function PendingCardList({ status, wrapped }: { status: string; wrapped?: boolean }) {
  const { pending, retry, discard } = usePendingCards();
  const mine = pending.filter((p) => p.status === status);
  if (mine.length === 0) return null;
  const items = mine.map((p) => (
    <div key={p.key} className={`card pending ${p.state}`} role="status">
      <div className="title-row">
        <span className="title">{p.title}</span>
      </div>
      {p.state === 'creating' ? (
        <div className="pending-note">Creating…</div>
      ) : (
        <>
          <div className="pending-note">Not created: {p.error}.</div>
          <div className="pending-actions">
            <button type="button" className="tool" onClick={() => retry(p.key)}>
              Retry
            </button>
            <button type="button" className="tool" onClick={() => discard(p.key)}>
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  ));
  return wrapped ? <div className="cards">{items}</div> : <>{items}</>;
}
