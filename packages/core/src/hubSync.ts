import type { CardDigest, CardText, ClientMessage, Expectation, HubIntent } from './hubProtocol.js';
import type { CardFields, KnownField } from './parse.js';
import type { FieldValue } from './patch.js';

/**
 * Pure helpers around the hub protocol: what to send after a handshake, the
 * hub's state as a reducer over client messages, the per-field check that
 * decides whether an intent is stale, and the echo guard. No I/O, no hashing
 * (see `node/cardHash.ts` for that), so both hosts and the tests share them.
 */

/**
 * What the hub lacks, given the digests it holds (`mirror`) and the client's
 * (`current`, the truth): `need` is the ids whose text the hub must be sent,
 * in the client's order; `gone` the ids the hub holds that no longer exist.
 */
export function reconcile(mirror: readonly CardDigest[], current: readonly CardDigest[]): { need: string[]; gone: string[] } {
  const have = new Map(mirror.map((d) => [d.id, d]));
  const need: string[] = [];
  for (const d of current) {
    const h = have.get(d.id);
    if (!h || h.hash !== d.hash || h.path !== d.path) need.push(d.id);
  }
  const live = new Set(current.map((d) => d.id));
  const gone = mirror.filter((d) => !live.has(d.id)).map((d) => d.id);
  return { need, gone };
}

/** The hub's copy of a board: card texts by id. Rebuilt from a `hello` plus the texts it asks for. */
export type Mirror = Map<string, CardText>;

/**
 * Apply one client message to the hub's copy. `hello` drops the cards that are
 * gone (the texts it needs arrive as `cards`); the rest set or delete entries.
 * Messages that carry no card text (`columns`, `ack`) change nothing here.
 */
export function applyToMirror(mirror: Mirror, message: ClientMessage): void {
  switch (message.type) {
    case 'hello':
      for (const id of reconcile(mirrorDigests(mirror), message.cards).gone) mirror.delete(id);
      return;
    case 'cards':
      for (const card of message.cards) mirror.set(card.id, card);
      return;
    case 'changed':
    case 'created':
      mirror.set(message.card.id, message.card);
      return;
    case 'renamed':
      mirror.delete(message.from);
      mirror.set(message.card.id, message.card);
      return;
    case 'deleted':
      mirror.delete(message.id);
      return;
    case 'columns':
    case 'ack':
      return;
  }
}

/** The mirror's digests, sorted by path, as `hello.cards` would list them. */
export function mirrorDigests(mirror: Mirror): CardDigest[] {
  return [...mirror.values()]
    .map(({ id, path, hash }) => ({ id, path, hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The fields an intent depends on, with the values it was planned against:
 * a move needs the card's status and order as they were; a set needs the old
 * values of the fields it changes. Other intents have no expectation.
 */
export function expectationFor(fields: CardFields, intent: Pick<HubIntent, 'op'> & Partial<Pick<Extract<HubIntent, { op: 'set' }>, 'intent'>>): Expectation {
  if (intent.op === 'move') return { status: fields.status, order: fields.order };
  if (intent.op === 'set' && intent.intent) {
    const out: Expectation = {};
    for (const key of Object.keys(intent.intent.changes) as KnownField[]) out[key] = fields[key] ?? null;
    return out;
  }
  return {};
}

/** The fields whose current value differs from what the intent expected: empty means the intent may be applied. */
export function staleFields(fields: CardFields, expect: Expectation): KnownField[] {
  const stale: KnownField[] = [];
  for (const [key, expected] of Object.entries(expect) as [KnownField, FieldValue | undefined][]) {
    if (expected === undefined) continue;
    if (!sameValue(fields[key] ?? null, expected)) stale.push(key);
  }
  return stale;
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * The echo guard, kept by the client: what the hub holds for each card. An
 * event whose hash equals that is not worth sending, whether it is the
 * client's own write coming back from the watcher or a save that changed
 * nothing. Updated from every message sent and every ack.
 */
export class SentHashes {
  private readonly hashes = new Map<string, string>();

  /** Should this version of the card go to the hub? */
  shouldSend(id: string, hash: string): boolean {
    return this.hashes.get(id) !== hash;
  }

  /** The hub now holds this version. */
  sent(id: string, hash: string): void {
    this.hashes.set(id, hash);
  }

  /** The hub no longer holds the card (deleted or renamed away). */
  forget(id: string): void {
    this.hashes.delete(id);
  }

  /** Start over, e.g. before a `hello` that resends everything. */
  clear(): void {
    this.hashes.clear();
  }

  get size(): number {
    return this.hashes.size;
  }
}
