import { createHash } from 'node:crypto';
import type { BoardFile } from '../board.js';
import {
  HUB_PATHS,
  HUB_PROTOCOL_VERSION,
  HUB_SESSION_HEADER,
  protocolRefusal,
  type AssetDigest,
  type CardText,
  type ClientMessage,
  type HelloMessage,
  type HubClientInfo,
  type HubIntent,
  type HubMessage,
  type IntentAck,
  type RefusedMessage,
  type RepoIdentity,
  type WelcomeMessage,
} from '../hubProtocol.js';

/** The `saveImage` intent as the host sees it. */
export type SaveImageHubIntent = Extract<HubIntent, { op: 'saveImage' }>;
import { assetMediaType, assetRefs, fieldsOnlyText, SentHashes } from '../hubSync.js';
import type { ColumnConfig } from '../view.js';
import type { HubAssetSource } from './assetSource.js';
import { cardTexts } from './cardHash.js';

/**
 * The hub client: keeps a hub's copy of the board current and applies the
 * hub's intents through whatever write path the host gives it. One instance
 * per board; the extension hosts it, and `kanban sync` when VS Code is not open.
 *
 * - Connect = reconcile (hello with every card's hash, send what the hub
 *   lacks) + an event stream for intents. Any failure means offline and a
 *   retry with backoff; a refusal (token, protocol, repo) waits longer and
 *   shows its message. A stream that ends soon after it opened counts as a
 *   failure too, so a hub that keeps closing it is not asked every second.
 * - One stream per repo on the hub: when another client (a second window, a
 *   leftover extension host, another machine) connects, the hub sends this
 *   one `replaced`. It then waits, without a hello or a retry, until the
 *   host calls `resume()` (the window got focus, the user asked): two
 *   clients that reconnected on their own would replace each other forever,
 *   and one of them may hold an older copy of the board.
 * - Changes go up as they happen (`notifyChanged`, diffed by hash against
 *   what the hub holds), with a periodic reconcile as the safety net. There
 *   is no durable queue: a missed event is repaired by the next reconcile.
 * - An intent is applied once per id, acked with the card as written, and
 *   the resulting hash is marked as sent before the watcher sees the write,
 *   so the client's own write is not echoed back.
 * - Images (the screenshots cards refer to) go up as files of their own,
 *   one `PUT` each, when the hub says it takes them: the ones it lacks after
 *   a hello, and the ones a changed card newly refers to, before the card.
 *   Never with `fieldsOnly`. A hub that refuses one (too large, not an image)
 *   is not asked again until the file changes.
 * - An image pasted on the hub's board comes down as a `saveImage` intent:
 *   the client fetches the bytes (`GET uploads/<id>`), checks them against
 *   the intent, and the host writes the file and names the link in the ack.
 *   Only when the host passes `saveImage`; the hello says so (`uploads`).
 * - No files, no settings: the host passes `files()`, `columns()`, `apply()`
 *   and, for images, `assets` and `saveImage`.
 */

export interface HubEndpoint {
  /** The hub's base URL, e.g. `https://projects.example.org/api/hub`. */
  url: string;
  token: string;
}

export interface HubLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HubTiming {
  /** Backoff after a failure: doubles from the minimum up to the maximum. */
  retryMinMs: number;
  retryMaxMs: number;
  /** After the hub refused the handshake (wrong token, protocol, repo). */
  refusedRetryMs: number;
  /** Periodic reconcile while connected. */
  reconcileMs: number;
  /** Changes reported within this window go up together. */
  debounceMs: number;
  /** A stream without any bytes for this long is reconnected. */
  streamIdleMs: number;
  /** A stream that ends sooner than this after it opened backs the retry off like a failure. */
  quickDropMs: number;
  /** For hello and events. */
  requestTimeoutMs: number;
  /** For one image upload. */
  uploadTimeoutMs: number;
}

export const DEFAULT_HUB_TIMING: HubTiming = {
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  refusedRetryMs: 10 * 60_000,
  reconcileMs: 15 * 60_000,
  debounceMs: 300,
  streamIdleMs: 90_000,
  quickDropMs: 10_000,
  requestTimeoutMs: 20_000,
  uploadTimeoutMs: 60_000,
};

export type HubState = 'off' | 'connecting' | 'connected' | 'offline' | 'refused' | 'replaced';

export interface HubStatus {
  state: HubState;
  /** Why, when offline or refused. */
  message: string | null;
  /** When the hub last held every card (after a reconcile). */
  lastSyncAt: number | null;
  /** Cards on the board at the last reconcile. */
  cards: number;
  /** Images the hub holds for them, after the last reconcile (0 when the hub takes none). */
  assets: number;
}

export interface HubClientOptions {
  hub: HubEndpoint;
  repo: RepoIdentity;
  client: HubClientInfo;
  columns: () => readonly ColumnConfig[];
  /** Every card file as the board sees it (an open buffer's text counts). */
  files: () => Promise<readonly BoardFile[]> | readonly BoardFile[];
  /** Apply an intent and answer with the card as written. Without it every intent is refused as read-only. */
  apply?: (intent: HubIntent) => Promise<IntentAck>;
  /**
   * Write an image pasted on the hub's board (a `saveImage` intent, with its
   * bytes already fetched and checked) and answer with the card and the
   * `link` it should get. Without it, pastes on the hub's board are refused
   * and the hello does not offer them.
   */
  saveImage?: (intent: SaveImageHubIntent, bytes: Uint8Array) => Promise<IntentAck>;
  /**
   * Share titles and fields only: every card text that goes up (the texts
   * after a hello, changes, the cards in acks) is cut down to its frontmatter
   * and title line, with the whole file's hash as its version. A hub that
   * cannot take that (its welcome does not say so) is refused, so no text
   * leaves the machine by mistake. Off by default.
   */
  fieldsOnly?: boolean;
  /**
   * Where the images the cards refer to are read (`fsAssetSource`). With it
   * the hello lists them and the hub, when it takes images, is sent the ones
   * it lacks. Without it, or with `fieldsOnly`, no image leaves the machine.
   */
  assets?: HubAssetSource;
  log?: Partial<HubLog>;
  onStatus?: (status: HubStatus) => void;
  fetch?: typeof fetch;
  timing?: Partial<HubTiming>;
}

export class HubRefusedError extends Error {
  override name = 'HubRefusedError';
  constructor(readonly refusal: RefusedMessage) {
    super(refusal.message);
  }
}

export class HubRequestError extends Error {
  override name = 'HubRequestError';
}

/** How long an intent's answer is kept, so a repeat gets the same one. */
const ANSWER_TTL_MS = 5 * 60_000;
/** Card texts go up in requests of about this many bytes, so a big board fits a hub's body limit. */
export const HUB_BATCH_BYTES = 512 * 1024;
const REPLACED = 'Another window or machine syncs this board with the hub now.';
const READ_ONLY = 'This client is read-only; open the project in VS Code to apply changes.';
const FIELDS_ONLY_UNSUPPORTED = 'This hub takes whole card texts only. Update the hub, or share the text (the setting "Share text", kanbanBananas.hub.shareText).';

export class HubClient {
  private readonly t: HubTiming;
  private readonly log: HubLog;
  private readonly fetchFn: typeof fetch;
  private running = false;
  private loop: Promise<void> | undefined;
  private current: HubStatus = { state: 'off', message: null, lastSyncAt: null, cards: 0, assets: 0 };
  private session: string | null = null;
  private readonly sent = new SentHashes();
  /** The hub takes images (said so in the last welcome). */
  private takesAssets = false;
  /** Images the hub holds, by path → hash; and the ones it refused, so they are not sent again unchanged. */
  private readonly assetsHeld = new Map<string, string>();
  private readonly assetsRefused = new Map<string, string>();
  /** Hashes by path, reused while a file's size and mtime stand. */
  private readonly assetHashes = new Map<string, { key: string; hash: string }>();
  private readonly answered = new Map<string, { at: number; ack: Promise<IntentAck> }>();
  /** Hub writes run one after another, so events never overtake a reconcile. */
  private chain: Promise<unknown> = Promise.resolve();
  private streamAbort: AbortController | undefined;
  private streamFailure: unknown;
  /** The hub said another client took over; the loop waits for `resume()`. */
  private replaced = false;
  private wake: (() => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: HubClientOptions) {
    this.t = { ...DEFAULT_HUB_TIMING, ...o.timing };
    this.log = { info: o.log?.info ?? (() => {}), warn: o.log?.warn ?? (() => {}), error: o.log?.error ?? (() => {}) };
    const f = o.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new Error('fetch is not available in this runtime.');
    this.fetchFn = f;
  }

  status(): HubStatus {
    return this.current;
  }

  /** Connect and keep connected until `stop`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** After `replaced`: connect again now, taking the hub back from the other client. Otherwise nothing. */
  resume(): void {
    if (this.replaced) this.wake?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.replaced = false;
    clearTimeout(this.debounceTimer);
    this.streamAbort?.abort();
    this.wake?.();
    await this.loop;
    this.loop = undefined;
    this.session = null;
    this.setStatus('off', null);
  }

  /** One reconcile without a stream: hello, send what the hub lacks, done. Throws on failure. */
  syncOnce(): Promise<void> {
    return this.enqueue(() => this.reconcile());
  }

  /** The board changed: send what differs from the hub's copy, shortly. */
  notifyChanged(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.enqueue(() => this.flush()).catch((e) => this.breakStream(e));
    }, this.t.debounceMs);
  }

  /** The column set changed. */
  notifyColumns(): void {
    void this.enqueue(async () => {
      if (!this.session) return;
      await this.post(HUB_PATHS.events, { messages: [{ type: 'columns', columns: [...this.o.columns()] }] });
    }).catch((e) => this.breakStream(e));
  }

  private async run(): Promise<void> {
    let failures = 0;
    let quickDrops = 0;
    while (this.running) {
      try {
        this.setStatus('connecting', null);
        await this.enqueue(() => this.reconcile());
        failures = 0;
        this.setStatus('connected', null);
        const opened = Date.now();
        await this.stream();
        this.session = null;
        if (!this.running) break;
        const why = this.takeStreamFailure();
        if (this.replaced) {
          quickDrops = 0;
          this.setStatus('replaced', REPLACED);
          await this.wait(null);
          this.replaced = false;
          continue;
        }
        quickDrops = Date.now() - opened < this.t.quickDropMs ? quickDrops + 1 : 0;
        this.setStatus('offline', why ? describe(why) : 'The connection to the hub dropped; reconnecting.');
        await this.wait(quickDrops ? this.backoff(quickDrops) : this.t.retryMinMs);
      } catch (e) {
        this.session = null;
        if (!this.running) break;
        if (e instanceof HubRefusedError) {
          this.setStatus('refused', e.message);
          await this.wait(this.t.refusedRetryMs);
        } else {
          failures++;
          this.setStatus('offline', describe(e));
          await this.wait(this.backoff(failures));
        }
      }
    }
  }

  /** Hello with every card's hash; send the texts the hub asks for. Afterwards the hub holds the board. */
  private async reconcile(): Promise<void> {
    const whole = cardTexts(await this.o.files());
    const texts = this.outgoing(whole);
    const assets = await this.digests(whole);
    const hello: HelloMessage = {
      type: 'hello',
      protocol: HUB_PROTOCOL_VERSION,
      client: this.o.client,
      repo: this.o.repo,
      columns: [...this.o.columns()],
      cards: texts.map(({ id, path, hash }) => ({ id, path, hash })),
      ...(this.o.fieldsOnly ? { fieldsOnly: true } : {}),
      ...(assets && this.o.assets ? { assets, images: this.o.assets.images } : {}),
      ...(this.o.saveImage ? { uploads: true } : {}),
    };
    const answer = (await this.post(HUB_PATHS.hello, hello, { session: false })) as WelcomeMessage | RefusedMessage | null;
    if (!answer || answer.type !== 'welcome') throw new HubRequestError('The hub did not answer the hello with a welcome.');
    const mismatch = protocolRefusal(answer.protocol, HUB_PROTOCOL_VERSION, { them: 'the hub', us: `the ${this.o.client.kind}` });
    if (mismatch) throw new HubRefusedError(mismatch);
    if (this.o.fieldsOnly && answer.fieldsOnly !== true) {
      throw new HubRefusedError({ type: 'refused', code: 'protocol', protocol: answer.protocol, message: FIELDS_ONLY_UNSUPPORTED });
    }
    this.session = answer.session;
    const byId = new Map(texts.map((c) => [c.id, c]));
    const cards = answer.need.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
    for (const batch of batches(cards, (c) => c.text.length)) await this.post(HUB_PATHS.events, { messages: [{ type: 'cards', cards: batch }] });
    this.sent.clear();
    for (const c of texts) this.sent.sent(c.id, c.hash);
    const uploaded = await this.reconcileAssets(assets, answer);
    this.current = { ...this.current, lastSyncAt: Date.now(), cards: texts.length, assets: this.assetsHeld.size };
    const images = assets ? (this.takesAssets ? `, ${this.assetsHeld.size} image(s), uploaded ${uploaded}` : ', images not taken by this hub') : '';
    this.log.info(`Hub: reconciled ${texts.length} card(s), sent ${cards.length}${images}${this.o.fieldsOnly ? ', titles and fields only' : ''}`);
  }

  /**
   * The digests of the images the cards refer to, for the hello; null when
   * none are to be sent (no source, or titles and fields only). A missing
   * file is left out: the hub's board shows it broken, as VS Code would.
   */
  private async digests(cards: readonly CardText[]): Promise<AssetDigest[] | null> {
    const src = this.o.assets;
    if (!src || this.o.fieldsOnly) return null;
    const out: AssetDigest[] = [];
    for (const path of assetRefs(cards, src.images.folder)) {
      const s = await src.stat(path);
      if (!s) continue;
      const key = `${s.size}:${s.mtimeMs}`;
      let known = this.assetHashes.get(path);
      if (!known || known.key !== key) {
        known = { key, hash: createHash('sha256').update(await src.read(path)).digest('hex') };
        this.assetHashes.set(path, known);
      }
      out.push({ path, hash: known.hash, size: s.size });
    }
    return out;
  }

  /** After a welcome: note whether the hub takes images, and send the ones it asked for. Returns how many went up. */
  private async reconcileAssets(assets: AssetDigest[] | null, welcome: WelcomeMessage): Promise<number> {
    this.takesAssets = assets !== null && welcome.assets === true;
    this.assetsHeld.clear();
    if (!assets || !this.takesAssets) return 0;
    const byPath = new Map(assets.map((a) => [a.path, a]));
    const need = new Set(welcome.needAssets ?? []);
    let uploaded = 0;
    for (const a of assets) {
      if (!need.has(a.path)) {
        this.assetsHeld.set(a.path, a.hash);
        continue;
      }
      if (this.assetsRefused.get(a.path) === a.hash) continue;
      if (await this.upload(byPath.get(a.path)!)) uploaded++;
    }
    return uploaded;
  }

  /** The images these cards refer to that the hub does not hold yet, sent one by one. */
  private async uploadNew(cards: readonly CardText[]): Promise<void> {
    if (!this.takesAssets) return;
    const digests = await this.digests(cards);
    for (const a of digests ?? []) {
      if (this.assetsHeld.get(a.path) === a.hash || this.assetsRefused.get(a.path) === a.hash) continue;
      await this.upload(a);
    }
  }

  /** One image to the hub. False when the hub refused it (logged, not retried unchanged); throws when the request failed. */
  private async upload(a: AssetDigest): Promise<boolean> {
    const src = this.o.assets!;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.t.uploadTimeoutMs);
    try {
      const bytes = await src.read(a.path);
      const path = `${HUB_PATHS.assets}/${a.path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await this.fetchFn(this.url(path), {
        method: 'PUT',
        headers: this.headers({ 'content-type': assetMediaType(a.path), 'content-length': String(bytes.byteLength) }),
        body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
        signal: abort.signal,
      });
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 409) {
        const text = await res.text().catch(() => '');
        this.log.warn(`Hub: image ${a.path} not taken (HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''})`);
        this.assetsRefused.set(a.path, a.hash);
        return false;
      }
      if (!res.ok) await this.failed(path, res);
      await res.text().catch(() => '');
      this.assetsHeld.set(a.path, a.hash);
      this.assetsRefused.delete(a.path);
      this.log.info(`Hub: uploaded ${a.path} (${Math.round(a.size / 1024)} KB)`);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log.warn(`Hub: image ${a.path} is gone; not sent`);
        return false;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The cards as they go up: whole, or cut down to titles and fields when the client shares no text. */
  private outgoing(cards: CardText[]): CardText[] {
    if (!this.o.fieldsOnly) return cards;
    return cards.map((c) => ({ ...c, text: fieldsOnlyText(c.text), fieldsOnly: true }));
  }

  /** Send what changed since the hub last saw the board, by hash. Before a session exists the reconcile covers it. */
  private async flush(): Promise<void> {
    if (!this.session) return;
    const whole = cardTexts(await this.o.files());
    const texts = this.outgoing(whole);
    const messages: ClientMessage[] = [];
    const live = new Set<string>();
    const changed: CardText[] = [];
    for (const [i, card] of texts.entries()) {
      live.add(card.id);
      if (this.sent.shouldSend(card.id, card.hash)) {
        messages.push({ type: this.sent.has(card.id) ? 'changed' : 'created', card });
        changed.push(whole[i]!);
      }
    }
    for (const id of this.sent.ids()) if (!live.has(id)) messages.push({ type: 'deleted', id });
    if (messages.length === 0) return;
    // The images a changed card newly refers to go first, so nobody sees the card with a broken image.
    await this.uploadNew(changed);
    for (const batch of batches(messages, (m) => ('card' in m ? m.card.text.length : 0))) await this.post(HUB_PATHS.events, { messages: batch });
    for (const m of messages) {
      if (m.type === 'deleted') this.sent.forget(m.id);
      else if (m.type === 'changed' || m.type === 'created') this.sent.sent(m.card.id, m.card.hash);
    }
    this.log.info(`Hub: sent ${messages.map((m) => m.type).join(', ')}`);
  }

  /** Read the event stream until it ends or is broken; throws for a refusal or a failed reconcile. */
  private async stream(): Promise<void> {
    const abort = new AbortController();
    this.streamAbort = abort;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => this.breakStream(new HubRequestError('No data from the hub for a while.')), this.t.streamIdleMs);
    };
    const periodic = setInterval(() => void this.enqueue(() => this.reconcile()).catch((e) => this.breakStream(e)), this.t.reconcileMs);
    try {
      const res = await this.fetchFn(this.url(HUB_PATHS.stream), { headers: this.headers({ accept: 'text/event-stream' }), signal: abort.signal });
      if (!res.ok || !res.body) await this.failed(HUB_PATHS.stream, res);
      resetIdle();
      for await (const data of sseData(res.body!, resetIdle)) {
        let message: HubMessage;
        try {
          message = JSON.parse(data) as HubMessage;
        } catch {
          this.log.warn(`Hub: ignoring a stream message that is not JSON`);
          continue;
        }
        await this.handle(message);
      }
    } catch (e) {
      if (!abort.signal.aborted) throw e;
      // Aborted by us: stopped, idle, or a failed write; the loop reads the reason.
    } finally {
      clearTimeout(idle);
      clearInterval(periodic);
      this.streamAbort = undefined;
    }
  }

  private async handle(message: HubMessage): Promise<void> {
    switch (message.type) {
      case 'intent':
        // Not awaited: the stream goes on while the write runs; acks are serialised with the other writes.
        void this.answer(message.intent);
        return;
      case 'reconcile':
        await this.enqueue(() => this.reconcile());
        return;
      case 'refused':
        throw new HubRefusedError(message);
      case 'replaced':
        // Ends the stream; the loop waits for resume().
        this.replaced = true;
        this.breakStream(null);
        return;
      case 'welcome':
        return;
    }
  }

  /** Apply an intent once per id and ack it; a repeat gets the first answer. */
  private async answer(intent: HubIntent): Promise<void> {
    const now = Date.now();
    for (const [id, a] of this.answered) if (now - a.at > ANSWER_TTL_MS) this.answered.delete(id);
    let known = this.answered.get(intent.intentId);
    if (!known) {
      known = { at: now, ack: this.applyIntent(intent) };
      this.answered.set(intent.intentId, known);
    } else {
      this.log.info(`Hub: intent ${intent.intentId} repeated, answering as before`);
    }
    const ack = await known.ack;
    await this.enqueue(async () => {
      if (ack.ok) await this.uploadNew([ack.card]).catch((e) => this.log.warn(`Hub: images for ${ack.card.path} not sent: ${describe(e)}`));
      await this.post(HUB_PATHS.events, { messages: [{ type: 'ack', ack }] });
    }).catch((e) => this.breakStream(e));
  }

  private async applyIntent(intent: HubIntent): Promise<IntentAck> {
    if (intent.op === 'saveImage') return this.applySaveImage(intent);
    if (!this.o.apply) return { intentId: intent.intentId, ok: false, code: 'error', error: READ_ONLY };
    let ack: IntentAck;
    try {
      ack = await this.o.apply(intent);
    } catch (e) {
      ack = { intentId: intent.intentId, ok: false, code: 'error', error: describe(e) };
    }
    return this.noteAck(intent, ack);
  }

  /** Fetch the pasted image the intent names, check it against the intent, and have the host write it. */
  private async applySaveImage(intent: SaveImageHubIntent): Promise<IntentAck> {
    const fail = (code: 'invalid' | 'error', error: string): IntentAck => ({ intentId: intent.intentId, ok: false, code, error });
    if (!this.o.saveImage) return this.noteAck(intent, fail('error', READ_ONLY));
    let ack: IntentAck;
    try {
      const bytes = await this.download(intent.intent.upload);
      if (!bytes) {
        ack = fail('error', 'The hub no longer holds the image.');
      } else if (bytes.byteLength !== intent.intent.size || createHash('sha256').update(bytes).digest('hex') !== intent.intent.hash) {
        ack = fail('invalid', 'The image the hub sent does not match the request.');
      } else {
        ack = await this.o.saveImage(intent, bytes);
      }
    } catch (e) {
      ack = fail('error', describe(e));
    }
    // The hub moves the bytes under the link, so the card's body save that follows has nothing to upload.
    if (ack.ok && ack.link && this.takesAssets) this.assetsHeld.set(ack.link.replace(/^\/+/, ''), intent.intent.hash);
    return this.noteAck(intent, ack);
  }

  /** The bytes of an upload the hub holds, or null when it is gone (404); throws when the request failed. */
  private async download(id: string): Promise<Uint8Array | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.t.uploadTimeoutMs);
    try {
      const path = `${HUB_PATHS.uploads}/${encodeURIComponent(id)}`;
      const res = await this.fetchFn(this.url(path), { headers: this.headers({}), signal: abort.signal });
      if (res.status === 404) {
        await res.text().catch(() => '');
        return null;
      }
      if (!res.ok) await this.failed(path, res);
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bookkeeping for an answered intent: cut the card down when sharing fields only, mark the written version as sent, log. */
  private noteAck(intent: HubIntent, ack: IntentAck): IntentAck {
    if (ack.card) ack = ack.ok ? { ...ack, card: this.outgoing([ack.card])[0]! } : { ...ack, card: this.outgoing([ack.card])[0]! };
    if (ack.ok) {
      // Mark the written version as sent before the watcher reports it, so it is not echoed.
      if (ack.from) this.sent.forget(ack.from);
      this.sent.sent(ack.card.id, ack.card.hash);
    } else if (ack.card) {
      this.sent.sent(ack.card.id, ack.card.hash);
    }
    this.log.info(`Hub: intent ${intent.op} ${intent.intentId}: ${ack.ok ? `${ack.route} ${ack.link ?? ack.card.path}` : `${ack.code}: ${ack.error}`}`);
    return ack;
  }

  /** End the stream because something failed; the loop reconnects and reconciles. */
  private breakStream(reason: unknown): void {
    if (!this.streamAbort) return;
    this.streamFailure = reason;
    this.streamAbort.abort();
  }

  private takeStreamFailure(): unknown {
    const f = this.streamFailure;
    this.streamFailure = undefined;
    return f;
  }

  private async post(path: string, body: unknown, opts: { session?: boolean } = {}): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.t.requestTimeoutMs);
    try {
      const res = await this.fetchFn(this.url(path), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }, opts.session !== false),
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) await this.failed(path, res);
      if (res.status === 204) return null;
      const text = await res.text();
      const json = text ? (JSON.parse(text) as { type?: string }) : null;
      if (json && json.type === 'refused') throw new HubRefusedError(json as RefusedMessage);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turn a failed response into the right error: a refusal when the hub said so, else a request error. */
  private async failed(path: string, res: Response): Promise<never> {
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text) as { type?: string };
      if (json.type === 'refused') throw new HubRefusedError(json as RefusedMessage);
    } catch (e) {
      if (e instanceof HubRefusedError) throw e;
    }
    if (res.status === 401 || res.status === 403) {
      throw new HubRefusedError({ type: 'refused', code: 'token', protocol: HUB_PROTOCOL_VERSION, message: 'The hub rejected the token.' });
    }
    throw new HubRequestError(`${path}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
  }

  private headers(extra: Record<string, string>, withSession = true): Record<string, string> {
    return {
      authorization: `Bearer ${this.o.hub.token}`,
      ...(withSession && this.session ? { [HUB_SESSION_HEADER]: this.session } : {}),
      ...extra,
    };
  }

  private url(path: string): string {
    return `${this.o.hub.url.replace(/\/+$/, '')}/${path}`;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The n-th retry's delay: doubles from the minimum up to the maximum. */
  private backoff(n: number): number {
    return Math.min(this.t.retryMinMs * 2 ** (n - 1), this.t.retryMaxMs);
  }

  /** Until the delay passes or `wake` (stop, resume) is called; `null` waits for `wake` only. */
  private wait(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? undefined : setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private setStatus(state: HubState, message: string | null): void {
    const changed = state !== this.current.state || message !== this.current.message;
    this.current = { ...this.current, state, message };
    if (!changed) return;
    (state === 'offline' || state === 'refused' ? this.log.warn : this.log.info)(`Hub: ${state}${message ? ` (${message})` : ''}`);
    this.o.onStatus?.(this.current);
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Split items into runs of at most `HUB_BATCH_BYTES` by `size`; an item larger than that goes alone. */
export function batches<T>(items: readonly T[], size: (item: T) => number, limit = HUB_BATCH_BYTES): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length > 0 && bytes + n > limit) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** The `data` of each server-sent event, as the stream delivers them. `onChunk` runs for every chunk read. */
async function* sseData(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    onChunk();
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (data.length > 0) {
          yield data.join('\n');
          data = [];
        }
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
    }
  }
}
