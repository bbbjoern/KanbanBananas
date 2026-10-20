import type { BoardFile } from '../board.js';
import {
  HUB_PATHS,
  HUB_PROTOCOL_VERSION,
  HUB_SESSION_HEADER,
  protocolRefusal,
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
import { SentHashes } from '../hubSync.js';
import type { ColumnConfig } from '../view.js';
import { cardTexts } from './cardHash.js';

/**
 * The hub client: keeps a hub's copy of the board current and applies the
 * hub's intents through whatever write path the host gives it. One instance
 * per board; the extension hosts it, and `kanban sync` when VS Code is not open.
 *
 * - Connect = reconcile (hello with every card's hash, send what the hub
 *   lacks) + an event stream for intents. Any failure means offline and a
 *   retry with backoff; a refusal (token, protocol, repo) waits longer and
 *   shows its message.
 * - Changes go up as they happen (`notifyChanged`, diffed by hash against
 *   what the hub holds), with a periodic reconcile as the safety net. There
 *   is no durable queue: a missed event is repaired by the next reconcile.
 * - An intent is applied once per id, acked with the card as written, and
 *   the resulting hash is marked as sent before the watcher sees the write,
 *   so the client's own write is not echoed back.
 * - No files, no settings: the host passes `files()`, `columns()` and `apply()`.
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
  /** For hello and events. */
  requestTimeoutMs: number;
}

export const DEFAULT_HUB_TIMING: HubTiming = {
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  refusedRetryMs: 10 * 60_000,
  reconcileMs: 15 * 60_000,
  debounceMs: 300,
  streamIdleMs: 90_000,
  requestTimeoutMs: 20_000,
};

export type HubState = 'off' | 'connecting' | 'connected' | 'offline' | 'refused';

export interface HubStatus {
  state: HubState;
  /** Why, when offline or refused. */
  message: string | null;
  /** When the hub last held every card (after a reconcile). */
  lastSyncAt: number | null;
  /** Cards on the board at the last reconcile. */
  cards: number;
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
const READ_ONLY = 'This client is read-only; open the project in VS Code to apply changes.';

export class HubClient {
  private readonly t: HubTiming;
  private readonly log: HubLog;
  private readonly fetchFn: typeof fetch;
  private running = false;
  private loop: Promise<void> | undefined;
  private current: HubStatus = { state: 'off', message: null, lastSyncAt: null, cards: 0 };
  private session: string | null = null;
  private readonly sent = new SentHashes();
  private readonly answered = new Map<string, { at: number; ack: Promise<IntentAck> }>();
  /** Hub writes run one after another, so events never overtake a reconcile. */
  private chain: Promise<unknown> = Promise.resolve();
  private streamAbort: AbortController | undefined;
  private streamFailure: unknown;
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

  async stop(): Promise<void> {
    this.running = false;
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
    while (this.running) {
      try {
        this.setStatus('connecting', null);
        await this.enqueue(() => this.reconcile());
        failures = 0;
        this.setStatus('connected', null);
        await this.stream();
        this.session = null;
        if (!this.running) break;
        const why = this.takeStreamFailure();
        this.setStatus('offline', why ? describe(why) : 'The connection to the hub dropped; reconnecting.');
        await this.wait(this.t.retryMinMs);
      } catch (e) {
        this.session = null;
        if (!this.running) break;
        if (e instanceof HubRefusedError) {
          this.setStatus('refused', e.message);
          await this.wait(this.t.refusedRetryMs);
        } else {
          failures++;
          const delay = Math.min(this.t.retryMinMs * 2 ** (failures - 1), this.t.retryMaxMs);
          this.setStatus('offline', describe(e));
          await this.wait(delay);
        }
      }
    }
  }

  /** Hello with every card's hash; send the texts the hub asks for. Afterwards the hub holds the board. */
  private async reconcile(): Promise<void> {
    const texts = cardTexts(await this.o.files());
    const hello: HelloMessage = {
      type: 'hello',
      protocol: HUB_PROTOCOL_VERSION,
      client: this.o.client,
      repo: this.o.repo,
      columns: [...this.o.columns()],
      cards: texts.map(({ id, path, hash }) => ({ id, path, hash })),
    };
    const answer = (await this.post(HUB_PATHS.hello, hello, { session: false })) as WelcomeMessage | RefusedMessage | null;
    if (!answer || answer.type !== 'welcome') throw new HubRequestError('The hub did not answer the hello with a welcome.');
    const mismatch = protocolRefusal(answer.protocol, HUB_PROTOCOL_VERSION, { them: 'the hub', us: `the ${this.o.client.kind}` });
    if (mismatch) throw new HubRefusedError(mismatch);
    this.session = answer.session;
    const byId = new Map(texts.map((c) => [c.id, c]));
    const cards = answer.need.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (cards.length > 0) await this.post(HUB_PATHS.events, { messages: [{ type: 'cards', cards }] });
    this.sent.clear();
    for (const c of texts) this.sent.sent(c.id, c.hash);
    this.current = { ...this.current, lastSyncAt: Date.now(), cards: texts.length };
    this.log.info(`Hub: reconciled ${texts.length} card(s), sent ${cards.length}`);
  }

  /** Send what changed since the hub last saw the board, by hash. Before a session exists the reconcile covers it. */
  private async flush(): Promise<void> {
    if (!this.session) return;
    const texts = cardTexts(await this.o.files());
    const messages: ClientMessage[] = [];
    const live = new Set<string>();
    for (const card of texts) {
      live.add(card.id);
      if (this.sent.shouldSend(card.id, card.hash)) messages.push({ type: this.sent.has(card.id) ? 'changed' : 'created', card });
    }
    for (const id of this.sent.ids()) if (!live.has(id)) messages.push({ type: 'deleted', id });
    if (messages.length === 0) return;
    await this.post(HUB_PATHS.events, { messages });
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
    await this.enqueue(() => this.post(HUB_PATHS.events, { messages: [{ type: 'ack', ack }] })).catch((e) => this.breakStream(e));
  }

  private async applyIntent(intent: HubIntent): Promise<IntentAck> {
    if (!this.o.apply) return { intentId: intent.intentId, ok: false, code: 'error', error: READ_ONLY };
    let ack: IntentAck;
    try {
      ack = await this.o.apply(intent);
    } catch (e) {
      ack = { intentId: intent.intentId, ok: false, code: 'error', error: describe(e) };
    }
    if (ack.ok) {
      // Mark the written version as sent before the watcher reports it, so it is not echoed.
      if (ack.from) this.sent.forget(ack.from);
      this.sent.sent(ack.card.id, ack.card.hash);
    } else if (ack.card) {
      this.sent.sent(ack.card.id, ack.card.hash);
    }
    this.log.info(`Hub: intent ${intent.op} ${intent.intentId}: ${ack.ok ? `${ack.route} ${ack.card.path}` : `${ack.code}: ${ack.error}`}`);
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

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
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
