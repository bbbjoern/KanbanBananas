import type { CardRequest } from '@kanban-bananas/core';
import { describe, expect, it } from 'vitest';
import { iconFor, noteFor, PENDING_NOTE_DELAY_MS, placeholdersIn, requestFor } from './requestState.js';

const req = (over: Partial<CardRequest>): CardRequest => ({ id: 'r', cardId: 'a', state: 'pending', since: 1000, ...over });

describe('requests (hub mode)', () => {
  it('shows the newest request of a card', () => {
    const older = req({ id: 'r1', since: 1000, state: 'applied' });
    const newer = req({ id: 'r2', since: 2000, state: 'stale' });
    expect(requestFor([newer, older], 'a')).toBe(newer);
    expect(requestFor([older, newer], 'a')).toBe(newer);
    expect(requestFor([older], 'b')).toBeUndefined();
  });

  it('places creates and gone cards in their column, oldest first, and never a card that is on the board', () => {
    const onBoard = (id: string) => id === 'here';
    const create = req({ id: 'c', cardId: null, since: 3000, placeholder: { title: 'New', status: 'todo' } });
    const gone = req({ id: 'g', cardId: 'away', state: 'gone', since: 2000, placeholder: { title: 'Old', status: 'todo' } });
    const moved = req({ id: 'm', cardId: 'here', state: 'stale', since: 1000, placeholder: { title: 'Here', status: 'todo' } });
    const elsewhere = req({ id: 'e', cardId: null, since: 500, placeholder: { title: 'Other', status: 'done' } });
    expect(placeholdersIn([create, gone, moved, elsewhere], 'todo', onBoard).map((r) => r.id)).toEqual(['g', 'c']);
    expect(placeholdersIn([create, gone, moved, elsewhere], 'done', onBoard).map((r) => r.id)).toEqual(['e']);
    expect(placeholdersIn([req({})], 'todo', onBoard)).toEqual([]);
  });

  it('says "Waiting for ‹machine›…" a second after a pending request was sent, and the host\'s note otherwise', () => {
    const pending = req({ since: 1000 });
    expect(noteFor(pending, 'MacBook Pro', 1000 + PENDING_NOTE_DELAY_MS - 1)).toBeNull();
    expect(noteFor(pending, 'MacBook Pro', 1000 + PENDING_NOTE_DELAY_MS)).toBe('Waiting for MacBook Pro…');
    expect(noteFor(pending, null, 5000)).toBe('Waiting for the machine…');
    expect(noteFor(req({ state: 'stale', note: 'Not moved.' }), 'MacBook Pro', 5000)).toBe('Not moved.');
    expect(noteFor(req({ state: 'applied' }), 'MacBook Pro', 5000)).toBeNull();
  });

  it("names the requester on someone else's pending change, after the same second", () => {
    const theirs = req({ since: 1000, by: { name: 'Anna', initials: 'AN', color: '#5b6bd6' } });
    expect(noteFor(theirs, 'MacBook Pro', 1000 + PENDING_NOTE_DELAY_MS - 1)).toBeNull();
    expect(noteFor(theirs, 'MacBook Pro', 1000 + PENDING_NOTE_DELAY_MS)).toBe('Anna’s change · waiting for MacBook Pro');
    // Once answered, the host's note stands, whoever asked.
    expect(noteFor(req({ state: 'refused', note: 'Not applied: no such column.', by: theirs.by! }), 'MacBook Pro', 5000)).toBe('Not applied: no such column.');
  });

  it('gives the two refusals their icons: changed since a triangle, the machine said no an octagon', () => {
    expect(iconFor('stale')).toBe('triangle');
    expect(iconFor('refused')).toBe('octagon');
    expect(iconFor('conflict')).toBeNull();
    expect(iconFor('pending')).toBeNull();
    expect(iconFor('gone')).toBeNull();
  });
});
