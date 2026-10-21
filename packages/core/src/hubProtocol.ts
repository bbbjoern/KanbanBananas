import type { WriteRoute } from './cliProtocol.js';
import type { CreateIntent, MoveIntent, NoteIntent, SaveBodyIntent, SetFieldsIntent } from './ops.js';
import type { KnownField } from './parse.js';
import type { FieldValue } from './patch.js';
import type { ColumnConfig } from './view.js';

/**
 * The hub protocol: how a board client (the extension, or a headless `kanban
 * sync`) talks to a hub that shows the board elsewhere. The client owns the
 * files and stays the only writer; the hub shows the cards and asks for changes.
 *
 * - Up (client → hub): a handshake, then card texts and change events.
 * - Down (hub → client): intents, each carrying the version it was planned against.
 * - A card's version is the hash of its text (`cardHash`), never its mtime,
 *   which means nothing across machines.
 * - Reconcile on every connect: the client sends id + hash of every card, the
 *   hub answers with what it lacks (`reconcile`). Change events in between are
 *   best effort; a missed event costs latency, never correctness.
 * - Messages are plain JSON objects. The transport (POST up, a server-sent
 *   event stream down) and the token are the hosts' business.
 *
 * Both sides compile against this file. `HUB_PROTOCOL_VERSION` goes up on any
 * change a peer built from the old file couldn't handle; `hello` carries it and
 * a mismatch is refused with a message that says which side to update. An
 * optional feature is negotiated instead, so both sides keep working with an
 * older peer: the client asks for it in `hello`, the hub echoes it in
 * `welcome`, and the client uses it only when echoed (`fieldsOnly` is one).
 *
 * Over HTTP (`HUB_PATHS`, relative to the hub URL, bearer token on every request):
 * - `POST hello` with a `HelloMessage` answers `welcome` (200) or `refused`
 *   (4xx with the JSON; a 401/403 without one is a bad token).
 * - `POST events` with `{ messages: ClientMessage[] }`; acks travel here too.
 * - `GET stream` is a server-sent event stream of `HubMessage`s, one JSON
 *   object per `data:` line; comment lines keep the connection alive.
 * `welcome.session` names the connection; `events` and `stream` carry it in
 * the `X-Hub-Session` header so the hub knows which repo they belong to.
 */

export const HUB_PROTOCOL_VERSION = 1;

export const HUB_PATHS = { hello: 'hello', events: 'events', stream: 'stream' } as const;
export const HUB_SESSION_HEADER = 'x-hub-session';

/** Which board this is: the git remote as `normalizeRemote` writes it, and the features directory inside the repo. */
export interface RepoIdentity {
  remote: string;
  /** Relative to the repo root, `/`-separated, e.g. `.devtool/features`. */
  featuresDir: string;
}

/** A card's identity and version: enough to tell whether the other side holds the same text. */
export interface CardDigest {
  /** The card id: its filename without `.md`. Changes when the file is renamed. */
  id: string;
  /** Path relative to the features directory: `x.md` or `done/x.md`. */
  path: string;
  /** `cardHash` of the file's text. */
  hash: string;
}

/**
 * A card's text as on disk. `hash` is `cardHash(text)`; a receiver may check it.
 * With `fieldsOnly`, the client shares titles and fields only: `text` is the
 * frontmatter block and the title line (`fieldsOnlyText`), `hash` stays the
 * whole file's (so reconcile and the echo guard keep working), and a receiver
 * cannot check one against the other. See `HelloMessage.fieldsOnly`.
 */
export interface CardText extends CardDigest {
  text: string;
  fieldsOnly?: boolean;
}

export interface HubClientInfo {
  kind: 'extension' | 'cli';
  /** The extension's or CLI's version, for the hub's "last seen" display and support messages. */
  version: string;
}

export type HelloMessage = {
  type: 'hello';
  protocol: number;
  client: HubClientInfo;
  repo: RepoIdentity;
  columns: ColumnConfig[];
  /** Every card on the board (the valid ones and the broken ones alike: the hub stores text, not a model). */
  cards: CardDigest[];
  /**
   * The client shares titles and fields only: every card text it sends is cut
   * down (`CardText.fieldsOnly`), and the hub may neither show nor edit the
   * text. A hub that takes it echoes `fieldsOnly: true` in its welcome; one
   * that does not (built before the flag) is refused by the client, which
   * never sends cut-down texts to it. Absent or false: whole texts, as always.
   */
  fieldsOnly?: boolean;
};

/** Client → hub. */
export type ClientMessage =
  | HelloMessage
  /** Texts the hub asked for in `welcome.need`, or a full resend at any time. */
  | { type: 'cards'; cards: CardText[] }
  | { type: 'changed'; card: CardText }
  | { type: 'created'; card: CardText }
  /** The id changed: a rename to the filename pattern, or a clash on a move into `done/`. */
  | { type: 'renamed'; from: string; card: CardText }
  | { type: 'deleted'; id: string }
  | { type: 'columns'; columns: ColumnConfig[] }
  /** What became of an intent. The hub takes the card in it as the card's current text. */
  | { type: 'ack'; ack: IntentAck };

export type RefusalCode = 'protocol' | 'repo' | 'token';

export type RefusedMessage = {
  type: 'refused';
  code: RefusalCode;
  /** The hub's protocol version, so the client can say which side is behind. */
  protocol: number;
  message: string;
};

/** Hub → client. `welcome` and `refused` answer a `hello`; the rest arrive on the stream. */
export type WelcomeMessage = {
  type: 'welcome';
  protocol: number;
  /** The hub's handle for this connection, sent back with events and the stream. */
  session: string;
  /** Ids whose text the hub lacks or holds in another version. */
  need: string[];
  /** True when the hello asked for titles and fields only and the hub takes it. */
  fieldsOnly?: boolean;
};

export type HubMessage =
  | WelcomeMessage
  | RefusedMessage
  | { type: 'intent'; intent: HubIntent }
  /** Send `hello` again: the hub lost its state, or it is time for the periodic reconcile. */
  | { type: 'reconcile' };

/**
 * Field values an intent was planned against, by field. The client applies the
 * intent only while every listed field still has that value, so two edits to
 * different fields both land and the second edit to the same field is refused
 * as `stale`. `hubSync.ts` has `expectationFor` and `staleFields`.
 */
export type Expectation = Partial<Record<KnownField, FieldValue>>;

/**
 * A change the hub asks for. `intentId` makes it safe to repeat: the client
 * applies it once and answers every repeat with the first ack. `baseHash` is
 * the version of the card the hub showed when the intent was made (null for
 * `create`); the hub uses it for its bookkeeping, the client decides by
 * `expect`, the three-way merge (`saveBody`) or nothing at all (`note` appends).
 * An ack can be lost with the connection, so the hub sends every intent it has
 * no ack for again on the next stream; the client answers a repeat as before.
 */
export type HubIntent = { intentId: string; baseHash: string | null } & (
  | { op: 'move'; intent: MoveIntent; expect: Expectation }
  | { op: 'set'; intent: SetFieldsIntent; expect: Expectation }
  | { op: 'create'; intent: CreateIntent }
  | { op: 'saveBody'; intent: SaveBodyIntent }
  | { op: 'note'; intent: NoteIntent }
);

export type HubIntentOp = HubIntent['op'];

/**
 * Why an intent wasn't applied:
 * - `stale`: a field it depends on changed since it was planned; `card` is the card now.
 * - `conflict`: a body save overlapped someone else's change to the same lines; `card` holds theirs.
 * - `gone`: no card with that id (deleted, renamed or broken).
 * - `invalid`: the intent itself is wrong (unknown field, no such column, empty title…).
 * - `error`: the write failed for another reason.
 */
export type AckErrorCode = 'stale' | 'conflict' | 'gone' | 'invalid' | 'error';

export type IntentAck = { intentId: string } & (
  | {
      ok: true;
      /** The card as written; its hash is the new version. */
      card: CardText;
      route: WriteRoute;
      /** The id the card had before, when the write renamed it (a clash on a move into `done/`). */
      from?: string;
    }
  | { ok: false; code: AckErrorCode; error: string; /** The card as it is now, when it exists. */ card?: CardText }
);

/**
 * One spelling for a git remote, so two machines agree on which repo they
 * mean: `host/owner/name`, lower-case host, no scheme, no user, no `.git`, no
 * trailing slash. A local path or anything unrecognised is kept as written.
 *
 *   git@github.com:bbbjoern/KanbanBananas.git  → github.com/bbbjoern/KanbanBananas
 *   https://github.com/bbbjoern/KanbanBananas   → github.com/bbbjoern/KanbanBananas
 *   ssh://git@github.com:22/bbbjoern/x.git      → github.com/bbbjoern/x
 */
export function normalizeRemote(remote: string): string {
  const raw = remote.trim();
  if (raw === '') return '';
  let host: string;
  let path: string;
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(raw);
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(raw);
  if (url) [host, path] = [url[1]!, url[2]!];
  else if (scp && !/^[a-z]:[\\/]/i.test(raw)) [host, path] = [scp[1]!, scp[2]!];
  else return raw;
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  return `${host.toLowerCase()}/${path}`;
}

export function sameRepo(a: RepoIdentity, b: RepoIdentity): boolean {
  return normalizeRemote(a.remote) === normalizeRemote(b.remote) && trimDir(a.featuresDir) === trimDir(b.featuresDir);
}

function trimDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

/** A refusal when the two protocol versions differ, naming the side to update; null when they match. */
export function protocolRefusal(theirs: number, ours: number, who: { them: string; us: string }): RefusedMessage | null {
  if (theirs === ours) return null;
  const behind = theirs < ours ? who.them : who.us;
  return {
    type: 'refused',
    code: 'protocol',
    protocol: ours,
    message: `Hub protocol ${theirs} doesn't match ${ours}: update ${behind}.`,
  };
}

/**
 * The hub's checks on a `hello`: the protocol version, and, when the token is
 * bound to a repo, that the client speaks for that repo. Null when it may connect.
 */
export function checkHello(hello: HelloMessage, bound: RepoIdentity | null, ours = HUB_PROTOCOL_VERSION): RefusedMessage | null {
  const mismatch = protocolRefusal(hello.protocol, ours, { them: `the ${hello.client.kind} (${hello.client.version})`, us: 'the hub' });
  if (mismatch) return mismatch;
  if (bound && !sameRepo(hello.repo, bound)) {
    return {
      type: 'refused',
      code: 'repo',
      protocol: ours,
      message: `This token is for ${normalizeRemote(bound.remote)} (${bound.featuresDir}), not ${normalizeRemote(hello.repo.remote)} (${hello.repo.featuresDir}).`,
    };
  }
  return null;
}
