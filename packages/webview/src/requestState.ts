import type { CardRequest } from '@kanban-bananas/core';

/**
 * Hub mode: what the host last said about the board (`hubState`). Pure helpers
 * for the components in requests.tsx; the default is a board that can be
 * changed and has no requests, which is also what VS Code gets.
 */
export interface HubState {
  readOnly: boolean;
  machine: string | null;
  requests: CardRequest[];
}

export const NO_HUB: HubState = { readOnly: false, machine: null, requests: [] };

/** A pending request shows "Waiting for ‹machine›…" this long after it was sent (design 3e). */
export const PENDING_NOTE_DELAY_MS = 1000;

/** The request shown on a card: the newest one that concerns it. */
export function requestFor(requests: CardRequest[], cardId: string): CardRequest | undefined {
  let found: CardRequest | undefined;
  for (const r of requests) if (r.cardId === cardId && (!found || r.since >= found.since)) found = r;
  return found;
}

/**
 * Requests shown as cards of their own in a column, oldest first: a card being
 * created (no id yet), or one whose card is no longer on the board (gone).
 */
export function placeholdersIn(requests: CardRequest[], status: string, onBoard: (id: string) => boolean): CardRequest[] {
  return requests
    .filter((r) => r.placeholder?.status === status && (r.cardId === null || !onBoard(r.cardId)))
    .sort((a, b) => a.since - b.since);
}

/** The note under a card right now: the host's, or "Waiting for ‹machine›…" once a pending request is a second old. */
export function noteFor(r: CardRequest, machine: string | null, now: number): string | null {
  if (r.note) return r.note;
  if (r.state === 'pending' && now - r.since >= PENDING_NOTE_DELAY_MS) return `Waiting for ${machine ?? 'the machine'}…`;
  return null;
}
