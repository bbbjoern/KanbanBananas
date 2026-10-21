import type { CardRequest } from '@kanban-bananas/core';
import { createContext, useContext, useEffect, useState } from 'react';
import { NO_HUB, noteFor, PENDING_NOTE_DELAY_MS, placeholdersIn, requestFor, type HubState } from './requestState.js';
import { vscode } from './vscode.js';

/**
 * Hub mode: the host's `hubState` for the components that draw it (design 3e).
 * A request shows on its card as a class per state, a note and the host's
 * buttons; a press goes back as `requestAction`. Outside hub mode the context
 * stays at its default and nothing here renders.
 */
export interface HubContextValue extends HubState {
  /** Is a card with this id on the board? A request for one that isn't shows as a placeholder. */
  onBoard: (id: string) => boolean;
}

const Context = createContext<HubContextValue>({ ...NO_HUB, onBoard: () => true });
export const HubProvider = Context.Provider;

export function useHub(): HubContextValue {
  return useContext(Context);
}

export function useCardRequest(cardId: string | null | undefined): CardRequest | undefined {
  const { requests } = useHub();
  return cardId && requests.length > 0 ? requestFor(requests, cardId) : undefined;
}

/** The note and buttons of a request, under its card. Pointer events stay here, so a press doesn't start a drag. */
export function RequestNote({ request }: { request: CardRequest }) {
  const { machine } = useHub();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (request.state !== 'pending') return;
    const wait = request.since + PENDING_NOTE_DELAY_MS - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [request]);
  const note = noteFor(request, machine, now);
  const actions = request.actions ?? [];
  if (!note && actions.length === 0) return null;
  return (
    <div className="request-note" role="status" onPointerDown={(e) => e.stopPropagation()}>
      {note && <div>{note}</div>}
      {actions.length > 0 && (
        <div className="request-actions">
          {actions.map((a) => (
            <button key={a.id} type="button" className="tool" onClick={() => vscode.postMessage({ type: 'requestAction', request: request.id, action: a.id })}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Requests without a card on the board (a card being created, a gone card), as cards in their column. */
export function RequestPlaceholders({ status, wrapped }: { status: string; wrapped?: boolean }) {
  const { requests, onBoard } = useHub();
  if (requests.length === 0) return null;
  const mine = placeholdersIn(requests, status, onBoard);
  if (mine.length === 0) return null;
  const items = mine.map((r) => (
    <div key={r.id} className={`request-card request-${r.state}`}>
      <div className="card pending" role="status">
        <div className="title-row">
          <span className="title">{r.placeholder!.title}</span>
        </div>
      </div>
      <RequestNote request={r} />
    </div>
  ));
  return wrapped ? <div className="cards">{items}</div> : <>{items}</>;
}
