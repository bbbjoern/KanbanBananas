import { imageRefs } from './assets.js';
import { HUB_ASSET_EXTENSIONS, type AssetDigest, type CardDigest, type CardText, type ClientMessage, type Expectation, type HubIntent } from './hubProtocol.js';
import { parseCard, type CardFields, type KnownField } from './parse.js';
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

/**
 * The images the hub should hold for these cards (`HelloMessage.assets`): the
 * root-relative image links in the texts (`imageRefs`), kept to the images
 * folder, to the types a hub takes (`HUB_ASSET_EXTENSIONS`) and to plain
 * paths (segments of letters, digits, `.`, `_`, `-`, `@`, spaces: what the board
 * and a careful hand name files), each once, in first-seen order. Links
 * elsewhere in the repo, web links and SVGs are not sent: the hub's board
 * shows those as VS Code's preview would without the file.
 */
export function assetRefs(cards: readonly { text: string }[], folder: string): string[] {
  const root = folder.replace(/^\/+|\/+$/g, '');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { text } of cards) {
    for (const ref of imageRefs(text)) {
      if (seen.has(ref) || !assetPathOk(ref, root)) continue;
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

const SEGMENT = /^[\w.@ -]+$/;

/** Is `path` an asset path a hub takes: under the images folder, plain segments, no `..`, an image extension? */
export function assetPathOk(path: string, folder: string): boolean {
  if (path.length > 400 || path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !SEGMENT.test(s))) return false;
  const prefix = folder.split('/').filter(Boolean);
  if (segments.length <= prefix.length || prefix.some((p, i) => segments[i] !== p)) return false;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return path.lastIndexOf('.') > path.lastIndexOf('/') && (HUB_ASSET_EXTENSIONS as readonly string[]).includes(ext);
}

/** The media type of an asset by its extension (the hub verifies the bytes anyway). */
export function assetMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

/**
 * Like `reconcile`, for assets by path: `need` the paths the hub lacks or
 * holds under another hash, in the client's order; `gone` the paths it holds
 * that no card refers to any more.
 */
export function reconcileAssets(held: readonly AssetDigest[], current: readonly AssetDigest[]): { need: string[]; gone: string[] } {
  const have = new Map(held.map((d) => [d.path, d.hash]));
  const need = current.filter((d) => have.get(d.path) !== d.hash).map((d) => d.path);
  const live = new Set(current.map((d) => d.path));
  const gone = held.filter((d) => !live.has(d.path)).map((d) => d.path);
  return { need, gone };
}

/**
 * A card's text cut down to its titles and fields, for a client that shares no
 * text (`CardText.fieldsOnly`): the frontmatter block as written, then the
 * title as a `# ` heading, nothing else. The result parses as the same card
 * with the same fields and title, an empty excerpt and no entries. A file
 * that does not parse keeps its frontmatter block when it has a closed one
 * (the hub then reports the same YAML problem), and is sent empty otherwise.
 */
export function fieldsOnlyText(text: string): string {
  const parsed = parseCard(text);
  if (parsed.ok) {
    const { bom, open, frontmatter, close, eol } = parsed.card.source;
    const title = parsed.card.title;
    return (bom ? '\uFEFF' : '') + open + frontmatter + close + (title === null ? '' : `# ${title}${eol}`);
  }
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const block = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(body);
  return block ? (bom ? '\uFEFF' : '') + block[0] : '';
}

/** The hub's copy of a board: card texts by id. Rebuilt from a `hello` plus the texts it asks for. */
export type Mirror = Map<string, CardText>;

/**
 * Apply one client message to the hub's copy. `hello` drops the cards that are
 * gone (the texts it needs arrive as `cards`); the rest set or delete entries.
 * An ack carries the card as the client wrote it (or as it is now, when it
 * refused), which is newer than anything in the mirror. `columns` changes nothing here.
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
    case 'ack':
      // The card as written (or as it is now, on a refusal) is the latest text the client saw.
      if (message.ack.ok && message.ack.from) mirror.delete(message.ack.from);
      if (message.ack.card) mirror.set(message.ack.card.id, message.ack.card);
      return;
    case 'columns':
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

  /** Does the hub hold any version of this card? */
  has(id: string): boolean {
    return this.hashes.has(id);
  }

  /** Ids the hub holds. */
  ids(): string[] {
    return [...this.hashes.keys()];
  }

  /** Start over, e.g. before a `hello` that resends everything. */
  clear(): void {
    this.hashes.clear();
  }

  get size(): number {
    return this.hashes.size;
  }
}
