import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyToMirror,
  HUB_PROTOCOL_VERSION,
  HUB_SESSION_HEADER,
  mirrorDigests,
  reconcile,
  reconcileAssets,
  type AssetDigest,
  type BoardFile,
  type ClientMessage,
  type HelloMessage,
  type HubIntent,
  type HubMessage,
  type IntentAck,
  type Mirror,
  type RefusedMessage,
} from '../src/index.js';
import { batches, cardDigests, cardHash, cardTexts, fsAssetSource, HubClient, type HubClientOptions, type HubStatus } from '../src/node/index.js';

/** A hub in-process: the three endpoints, a mirror kept with the same helpers SuperTask will use. */
class FakeHub {
  server: Server;
  url = '';
  token = 'secret';
  mirror: Mirror = new Map();
  hellos: HelloMessage[] = [];
  received: ClientMessage[] = [];
  streams = new Set<ServerResponse>();
  streamsOpened = 0;
  sessions: string[] = [];
  refuse: RefusedMessage | 'token' | null = null;
  welcomeProtocol = HUB_PROTOCOL_VERSION;
  /** Whether this hub echoes `fieldsOnly` (a hub built before the flag does not). */
  takesFieldsOnly = true;
  /** Whether this hub stores images; the ones it holds by path, and every upload in order with its status. */
  takesAssets = true;
  assets = new Map<string, AssetDigest>();
  uploads: { path: string; type: string; bytes: number; status: number; session: string | undefined }[] = [];
  /** Answer the next uploads of these paths with this status. */
  refuseAssets = new Map<string, number>();
  /** Images pasted on this hub's board, by id, for `GET uploads/<id>`. */
  pasted = new Map<string, Buffer>();
  /** Every request's method and path, in order. */
  requests: string[] = [];
  /** End every stream cleanly as soon as it opens, as a hub that keeps closing it would. */
  endStreams = false;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hub/`;
    return this;
  }

  async close(): Promise<void> {
    this.dropStreams();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private reconcileAssets(current: AssetDigest[]): string[] {
    const { need, gone } = reconcileAssets([...this.assets.values()], current);
    for (const path of gone) this.assets.delete(path);
    return need;
  }

  send(message: HubMessage): void {
    for (const res of this.streams) res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  /** What the hub does when another client's stream takes over: say so, then end the stream. */
  replaceStreams(): void {
    this.send({ type: 'replaced' });
    for (const res of this.streams) res.end();
    this.streams.clear();
  }

  dropStreams(): void {
    for (const res of this.streams) res.destroy();
    this.streams.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}` || this.refuse === 'token') {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const session = req.headers[HUB_SESSION_HEADER];
    this.requests.push(`${req.method} ${req.url}`);
    if (req.method === 'PUT' && req.url?.startsWith('/hub/assets/')) {
      const path = req.url.slice('/hub/assets/'.length).split('/').map(decodeURIComponent).join('/');
      const bytes = Buffer.concat(chunks);
      const status = typeof session !== 'string' ? 400 : (this.refuseAssets.get(path) ?? 200);
      this.uploads.push({ path, type: String(req.headers['content-type']), bytes: bytes.length, status, session: session as string | undefined });
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no' }));
        return;
      }
      const digest = { path, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      this.assets.set(path, digest);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(digest));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/hub/uploads/')) {
      const bytes = typeof session === 'string' ? this.pasted.get(decodeURIComponent(req.url.slice('/hub/uploads/'.length))) : undefined;
      if (!bytes) res.writeHead(typeof session === 'string' ? 404 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no' }));
      else res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length) }).end(bytes);
      return;
    }
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : null;
    if (req.method === 'POST' && req.url === '/hub/hello') {
      const hello = body as HelloMessage;
      this.hellos.push(hello);
      if (this.refuse) {
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify(this.refuse));
        return;
      }
      applyToMirror(this.mirror, hello);
      const id = `s${this.hellos.length}`;
      this.sessions.push(id);
      const welcome = {
        type: 'welcome',
        protocol: this.welcomeProtocol,
        session: id,
        need: reconcile(mirrorDigests(this.mirror), hello.cards).need,
        ...(hello.fieldsOnly && this.takesFieldsOnly ? { fieldsOnly: true } : {}),
        ...(hello.assets && this.takesAssets ? { assets: true, needAssets: this.reconcileAssets(hello.assets) } : {}),
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(welcome));
    } else if (req.method === 'POST' && req.url === '/hub/events') {
      if (typeof session !== 'string') {
        res.writeHead(400).end('no session');
        return;
      }
      for (const m of (body as { messages: ClientMessage[] }).messages) {
        applyToMirror(this.mirror, m);
        this.received.push(m);
      }
      res.writeHead(204).end();
    } else if (req.method === 'GET' && req.url === '/hub/stream') {
      if (typeof session !== 'string') {
        res.writeHead(400).end('no session');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': hello\n\n');
      this.streams.add(res);
      this.streamsOpened++;
      res.on('close', () => this.streams.delete(res));
      if (this.endStreams) setImmediate(() => res.end());
    } else {
      res.writeHead(404).end();
    }
  }
}

const file = (id: string, body: string, dir = ''): BoardFile => ({ path: `${dir}${id}.md`, text: `---\nid: "${id}"\nstatus: "todo"\n---\n# ${id}\n\n${body}\n` });

async function waitFor<T>(fn: () => T, what: string, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TIMING = { retryMinMs: 30, retryMaxMs: 120, refusedRetryMs: 60_000, reconcileMs: 60_000, debounceMs: 10, streamIdleMs: 5000, requestTimeoutMs: 2000 };

function makeClient(hub: FakeHub, files: () => BoardFile[], extra: Partial<HubClientOptions> = {}) {
  const statuses: HubStatus[] = [];
  const client = new HubClient({
    hub: { url: hub.url, token: hub.token },
    repo: { remote: 'github.com/o/n', featuresDir: '.devtool/features' },
    client: { kind: 'cli', version: 'test' },
    columns: () => [{ id: 'todo', name: 'To Do', color: '#000' }],
    files,
    onStatus: (s) => statuses.push(s),
    timing: TIMING,
    ...extra,
  });
  return { client, statuses };
}

const open: HubClient[] = [];
const hubs: FakeHub[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.stop()));
  await Promise.all(hubs.splice(0).map((h) => h.close()));
});
async function hub(): Promise<FakeHub> {
  const h = await new FakeHub().listen();
  hubs.push(h);
  return h;
}

describe('batches', () => {
  it('splits by size, keeps order, and lets an oversized item travel alone', () => {
    const sizes = [300, 300, 500, 1200, 100, 100];
    expect(batches(sizes, (n) => n, 1000)).toEqual([[300, 300], [500], [1200], [100, 100]]);
    expect(batches([], (n: number) => n, 1000)).toEqual([]);
  });
});

describe('HubClient', () => {
  it('sends a big board in several requests', async () => {
    const h = await hub();
    const files = Array.from({ length: 30 }, (_, i) => file(`big-${i}`, 'x'.repeat(100_000)));
    const { client } = makeClient(h, () => files);
    await client.syncOnce();
    const sends = h.received.filter((m) => m.type === 'cards');
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.flatMap((m) => (m.type === 'cards' ? m.cards.map((c) => c.id) : []))).toEqual(files.map((f) => f.path.replace(/\.md$/, '')));
    expect(mirrorDigests(h.mirror)).toHaveLength(30);
  });

  it('connects with a hello, sends what the hub lacks, then only what changes', async () => {
    const h = await hub();
    let files = [file('a', '1'), file('b', '2', 'done/')];
    const { client, statuses } = makeClient(h, () => files);
    open.push(client);
    client.start();
    await waitFor(() => client.status().state === 'connected' && h.streams.size > 0, 'connected');
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected']);
    expect(h.hellos[0]?.cards.map((c) => c.id)).toEqual(['a', 'b']);
    // No apply: the hello says the client is read-only, so the hub can show the board view only.
    expect(h.hellos[0]?.readOnly).toBe(true);
    expect(h.received).toEqual([{ type: 'cards', cards: expect.arrayContaining([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })]) }]);
    expect(mirrorDigests(h.mirror)).toEqual(cardDigests(files).sort((x, y) => (x.path < y.path ? -1 : 1)));
    expect(client.status().cards).toBe(2);

    // Nothing changed: nothing goes up.
    client.notifyChanged();
    await new Promise((r) => setTimeout(r, 60));
    expect(h.received).toHaveLength(1);

    files = [file('a', '1 edited'), file('c', '3')];
    client.notifyChanged();
    await waitFor(() => h.received.length === 4, 'three events');
    expect(h.received.slice(1).map((m) => m.type).sort()).toEqual(['changed', 'created', 'deleted']);
    expect(mirrorDigests(h.mirror)).toEqual(cardDigests(files));
  });

  it('reconnects when the stream drops and reconciles what it missed', async () => {
    const h = await hub();
    let files = [file('a', '1')];
    const { client } = makeClient(h, () => files);
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'first stream');
    files = [file('a', '1 changed while offline'), file('b', '2')];
    h.dropStreams();
    await waitFor(() => h.hellos.length === 2 && h.streams.size === 1, 'second hello and stream');
    expect(h.hellos[1]?.cards.map((c) => c.id)).toEqual(['a', 'b']);
    const sent = h.received.filter((m) => m.type === 'cards').at(-1);
    expect(sent && sent.type === 'cards' ? sent.cards.map((c) => c.id) : []).toEqual(['a', 'b']);
    expect(mirrorDigests(h.mirror)).toEqual(cardDigests(files));
    expect(client.status().state).toBe('connected');
    expect(h.sessions).toEqual(['s1', 's2']);
  });

  it('waits when the hub says another client took over, and connects again only on resume', async () => {
    const h = await hub();
    let files = [file('a', '1')];
    const { client, statuses } = makeClient(h, () => files);
    open.push(client);
    client.resume(); // not replaced: nothing
    client.start();
    await waitFor(() => h.streams.size === 1, 'first stream');
    h.replaceStreams();
    await waitFor(() => client.status().state === 'replaced', 'replaced');
    expect(client.status().message).toMatch(/Another window or machine/);
    files = [file('a', '1 stale copy')];
    client.notifyChanged();
    // Many retry intervals later: no hello, no stream, nothing sent.
    await new Promise((r) => setTimeout(r, 300));
    expect(h.hellos).toHaveLength(1);
    expect(h.streamsOpened).toBe(1);
    expect(h.received).toHaveLength(1);
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected', 'replaced']);

    client.resume();
    await waitFor(() => client.status().state === 'connected' && h.streams.size === 1, 'connected again');
    expect(h.hellos).toHaveLength(2);
    expect(mirrorDigests(h.mirror)).toEqual(cardDigests(files));
  });

  it('stops while replaced, and starts afresh', async () => {
    const h = await hub();
    const { client } = makeClient(h, () => [file('a', '1')]);
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'first stream');
    h.replaceStreams();
    await waitFor(() => client.status().state === 'replaced', 'replaced');
    await client.stop();
    expect(client.status().state).toBe('off');
    client.start();
    await waitFor(() => client.status().state === 'connected' && h.streams.size === 1, 'connected after a new start');
    expect(h.hellos).toHaveLength(2);
  });

  it('backs off when the hub keeps ending the stream right after it opened', async () => {
    const h = await hub();
    h.endStreams = true;
    const { client } = makeClient(h, () => [file('a', '1')], { timing: { ...TIMING, retryMinMs: 40, retryMaxMs: 10_000 } });
    open.push(client);
    client.start();
    // Retries after 40, 80, 160, 320 ms: about five hellos in 600 ms, not fifteen.
    await new Promise((r) => setTimeout(r, 600));
    expect(h.hellos.length).toBeGreaterThanOrEqual(3);
    expect(h.hellos.length).toBeLessThanOrEqual(6);
    expect(client.status().state).not.toBe('replaced');
  });

  it('retries at the minimum after a stream that lived', async () => {
    const h = await hub();
    h.endStreams = true;
    const { client } = makeClient(h, () => [file('a', '1')], { timing: { ...TIMING, retryMinMs: 40, retryMaxMs: 10_000, quickDropMs: 0 } });
    open.push(client);
    client.start();
    await new Promise((r) => setTimeout(r, 600));
    expect(h.hellos.length).toBeGreaterThanOrEqual(8);
  });

  it('is offline with retries while the hub is unreachable, and refused with the message when the hub says so', async () => {
    const h = await hub();
    const port = h.url;
    await h.close();
    hubs.pop();
    const down = makeClient({ url: port, token: 'x' } as FakeHub, () => []);
    open.push(down.client);
    down.client.start();
    await waitFor(() => down.statuses.filter((s) => s.state === 'offline').length >= 2, 'two offline rounds');
    expect(down.client.status().message).toMatch(/ECONNREFUSED|fetch failed/);
    await down.client.stop();
    expect(down.client.status().state).toBe('off');

    const h2 = await hub();
    h2.refuse = { type: 'refused', code: 'repo', protocol: HUB_PROTOCOL_VERSION, message: 'This token is for another repo.' };
    const refused = makeClient(h2, () => [file('a', '1')]);
    open.push(refused.client);
    refused.client.start();
    await waitFor(() => refused.client.status().state === 'refused', 'refused');
    expect(refused.client.status().message).toBe('This token is for another repo.');
    expect(h2.hellos).toHaveLength(1);

    const h3 = await hub();
    h3.refuse = 'token';
    const badToken = makeClient(h3, () => []);
    open.push(badToken.client);
    badToken.client.start();
    await waitFor(() => badToken.client.status().state === 'refused', 'token refused');
    expect(badToken.client.status().message).toBe('The hub rejected the token.');

    const h4 = await hub();
    h4.welcomeProtocol = HUB_PROTOCOL_VERSION + 1;
    const old = makeClient(h4, () => []);
    open.push(old.client);
    old.client.start();
    await waitFor(() => old.client.status().state === 'refused', 'protocol refused');
    expect(old.client.status().message).toContain('update the cli');
  });

  it('applies an intent once, acks with the written card, and does not echo its own write', async () => {
    const h = await hub();
    let files = [file('a', '1')];
    const applied: HubIntent[] = [];
    const apply = async (intent: HubIntent): Promise<IntentAck> => {
      applied.push(intent);
      if (intent.op !== 'set') throw new Error('unexpected op');
      files = [file('a', 'set by the hub')];
      const f = files[0]!;
      return { intentId: intent.intentId, ok: true, route: 'disk', card: { id: 'a', path: f.path, hash: cardHash(f.text), text: f.text } };
    };
    const { client } = makeClient(h, () => files, { apply });
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'stream');
    expect(h.hellos[0]?.readOnly).toBe(false);
    const intent: HubIntent = { intentId: 'i1', baseHash: cardHash(file('a', '1').text), op: 'set', intent: { id: 'a', changes: { priority: 'high' } }, expect: { priority: null } };
    h.send({ type: 'intent', intent });
    await waitFor(() => h.received.some((m) => m.type === 'ack'), 'ack');
    const ack = h.received.find((m) => m.type === 'ack');
    expect(ack).toEqual({ type: 'ack', ack: { intentId: 'i1', ok: true, route: 'disk', card: expect.objectContaining({ id: 'a', hash: cardHash(files[0]!.text) }) } });
    expect(h.mirror.get('a')?.text).toBe(files[0]!.text);

    // The watcher reports the write: nothing more goes up.
    const before = h.received.length;
    client.notifyChanged();
    await new Promise((r) => setTimeout(r, 60));
    expect(h.received).toHaveLength(before);

    // The hub repeats the intent (e.g. after its own restart): applied once, same ack.
    h.send({ type: 'intent', intent });
    await waitFor(() => h.received.filter((m) => m.type === 'ack').length === 2, 'second ack');
    expect(applied).toHaveLength(1);
    expect(h.received.filter((m) => m.type === 'ack')[1]).toEqual(ack);
  });

  it('refuses intents as read-only without an apply function, and reports an apply that throws', async () => {
    const h = await hub();
    const { client } = makeClient(h, () => [file('a', '1')]);
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'stream');
    h.send({ type: 'intent', intent: { intentId: 'i2', baseHash: null, op: 'create', intent: { title: 'New', status: 'todo' } } });
    await waitFor(() => h.received.some((m) => m.type === 'ack'), 'ack');
    expect(h.received.find((m) => m.type === 'ack')).toEqual({ type: 'ack', ack: { intentId: 'i2', ok: false, code: 'error', error: expect.stringMatching(/read-only/) } });

    const h2 = await hub();
    const throwing = makeClient(h2, () => [], { apply: async () => { throw new Error('disk full'); } });
    open.push(throwing.client);
    throwing.client.start();
    await waitFor(() => h2.streams.size === 1, 'stream 2');
    h2.send({ type: 'intent', intent: { intentId: 'i3', baseHash: null, op: 'create', intent: { title: 'New', status: 'todo' } } });
    await waitFor(() => h2.received.some((m) => m.type === 'ack'), 'ack 2');
    expect(h2.received.find((m) => m.type === 'ack')).toEqual({ type: 'ack', ack: { intentId: 'i3', ok: false, code: 'error', error: 'disk full' } });
  });

  it('reconciles again when the hub asks, sends columns, and syncOnce works without a stream', async () => {
    const h = await hub();
    let columns = [{ id: 'todo', name: 'To Do', color: '#000' }];
    const { client } = makeClient(h, () => [file('a', '1')], { columns: () => columns });
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'stream');
    h.send({ type: 'reconcile' });
    await waitFor(() => h.hellos.length === 2, 'second hello');
    expect(h.streamsOpened).toBe(1);
    columns = [...columns, { id: 'done', name: 'Done', color: '#0f0' }];
    client.notifyColumns();
    await waitFor(() => h.received.some((m) => m.type === 'columns'), 'columns');
    expect(h.received.find((m) => m.type === 'columns')).toEqual({ type: 'columns', columns });
    await client.stop();

    const h2 = await hub();
    const once = makeClient(h2, () => [file('x', '1')]);
    await once.client.syncOnce();
    expect(h2.hellos).toHaveLength(1);
    expect(h2.streamsOpened).toBe(0);
    expect(mirrorDigests(h2.mirror).map((d) => d.id)).toEqual(['x']);
    expect(once.client.status().lastSyncAt).not.toBeNull();
  });
});

describe('HubClient sharing titles and fields only', () => {
  it('asks for it in the hello, sends cut-down texts with the whole file\'s hash, and cuts the card in every ack', async () => {
    const h = await hub();
    let files = [file('a', 'a secret body'), file('b', 'another secret', 'done/')];
    const acks: IntentAck[] = [];
    const { client } = makeClient(h, () => files, {
      fieldsOnly: true,
      apply: async (intent) => {
        files = [file('a', 'a secret body, edited by the machine'), files[1]!];
        const ack: IntentAck = { intentId: intent.intentId, ok: true, card: { ...cardTexts([files[0]!])[0]! }, route: 'disk' };
        acks.push(ack);
        return ack;
      },
    });
    open.push(client);
    client.start();
    await waitFor(() => client.status().state === 'connected' && h.streams.size > 0, 'connected');
    expect(h.hellos[0]?.fieldsOnly).toBe(true);
    expect(h.hellos[0]?.cards.map((c) => c.hash)).toEqual(cardDigests(files).map((c) => c.hash));
    const sent = h.received.flatMap((m) => (m.type === 'cards' ? m.cards : []));
    expect(sent.map((c) => c.text)).toEqual(['---\nid: "a"\nstatus: "todo"\n---\n# a\n', '---\nid: "b"\nstatus: "todo"\n---\n# b\n']);
    expect(sent.every((c) => c.fieldsOnly === true && c.hash === cardHash(files.find((f) => f.path === c.path)!.text))).toBe(true);
    expect(JSON.stringify(h.received)).not.toContain('secret');

    h.send({ type: 'intent', intent: { intentId: 'i1', baseHash: sent[0]!.hash, op: 'note', intent: { id: 'a', heading: 'x' } } });
    await waitFor(() => h.received.some((m) => m.type === 'ack'), 'the ack');
    const ack = h.received.find((m) => m.type === 'ack');
    expect(ack?.type === 'ack' && ack.ack.ok && ack.ack.card).toEqual({ ...acks[0]!.ok && acks[0].card, text: '---\nid: "a"\nstatus: "todo"\n---\n# a\n', fieldsOnly: true });
    expect(JSON.stringify(h.received)).not.toContain('secret');

    // The machine's own write is not echoed, since the whole file's hash is what was marked as sent.
    client.notifyChanged();
    await new Promise((r) => setTimeout(r, 60));
    expect(h.received.filter((m) => m.type === 'changed')).toHaveLength(0);
  });

  it('is refused by a hub that does not say it takes titles and fields only, and sends it no text', async () => {
    const h = await hub();
    h.takesFieldsOnly = false;
    const { client, statuses } = makeClient(h, () => [file('a', 'a secret body')], { fieldsOnly: true });
    open.push(client);
    client.start();
    await waitFor(() => client.status().state === 'refused', 'refused');
    expect(statuses.at(-1)?.message).toContain('whole card texts only');
    expect(h.received).toEqual([]);
    expect(h.streams.size).toBe(0);
  });

  it('sends whole texts and no flag when off', async () => {
    const h = await hub();
    const files = [file('a', 'the body')];
    const { client } = makeClient(h, () => files);
    await client.syncOnce();
    expect(h.hellos[0]?.fieldsOnly).toBeUndefined();
    const sent = h.received.flatMap((m) => (m.type === 'cards' ? m.cards : []));
    expect(sent[0]?.fieldsOnly).toBeUndefined();
    expect(sent[0]?.text).toContain('the body');
  });
});

describe('HubClient with images', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });
  async function repo(): Promise<{ root: string; files: BoardFile[] }> {
    root = await mkdtemp(join(tmpdir(), 'kb-assets-'));
    await mkdir(join(root, '.devtool', 'assets', 'a'), { recursive: true });
    await mkdir(join(root, '.devtool', 'assets', 'b'), { recursive: true });
    await writeFile(join(root, '.devtool', 'assets', 'a', 'one.png'), PNG);
    await writeFile(join(root, '.devtool', 'assets', 'a', 'unused.png'), PNG);
    await writeFile(join(root, '.devtool', 'assets', 'b', 'two.webp'), Buffer.concat([PNG, Buffer.from('2')]));
    const files = [file('a', 'see ![](/.devtool/assets/a/one.png) and ![](/.devtool/assets/a/missing.png) and ![](/.devtool/assets/a/v.svg)'), file('b', '![](/.devtool/assets/b/two.webp)')];
    return { root, files };
  }
  const source = (root: string) => fsAssetSource(root, { folder: '.devtool/assets', format: 'webp', maxWidth: 1600 });

  it('lists the referenced images that exist in the hello, uploads the ones the hub lacks, and a new reference before its card', async () => {
    const h = await hub();
    const { root, files } = await repo();
    const { client } = makeClient(h, () => files, { assets: source(root) });
    open.push(client);
    client.start();
    await waitFor(() => client.status().state === 'connected', 'connected');
    const hello = h.hellos[0]!;
    expect(hello.assets).toEqual([
      { path: '.devtool/assets/a/one.png', hash: sha(PNG), size: PNG.length },
      { path: '.devtool/assets/b/two.webp', hash: sha(Buffer.concat([PNG, Buffer.from('2')])), size: PNG.length + 1 },
    ]);
    expect(hello.images).toEqual({ folder: '.devtool/assets', format: 'webp', maxWidth: 1600 });
    expect(h.uploads.map((u) => [u.path, u.type, u.bytes, u.status, u.session])).toEqual([
      ['.devtool/assets/a/one.png', 'image/png', PNG.length, 200, 's1'],
      ['.devtool/assets/b/two.webp', 'image/webp', PNG.length + 1, 200, 's1'],
    ]);
    expect(client.status()).toMatchObject({ cards: 2, assets: 2 });

    // A card now refers to a new file: it goes up first, then the card; a reference the hub holds is not sent again.
    await writeFile(join(root, '.devtool', 'assets', 'b', 'three.gif'), Buffer.from('GIF89a'));
    files[1] = file('b', '![](/.devtool/assets/b/two.webp) ![](/.devtool/assets/b/three.gif)');
    h.requests.length = 0;
    client.notifyChanged();
    await waitFor(() => h.received.some((m) => m.type === 'changed'), 'the change');
    expect(h.requests).toEqual(['PUT /hub/assets/.devtool/assets/b/three.gif', 'POST /hub/events']);
    expect(h.uploads.at(-1)).toMatchObject({ path: '.devtool/assets/b/three.gif', type: 'image/gif', bytes: 6, status: 200 });

    // The next reconcile: the hub holds everything, nothing is uploaded; the hash cache is reused.
    h.requests.length = 0;
    await client.syncOnce();
    expect(h.requests).toEqual(['POST /hub/hello']);
    expect(h.hellos.at(-1)!.assets!.map((a) => a.path)).toEqual(['.devtool/assets/a/one.png', '.devtool/assets/b/two.webp', '.devtool/assets/b/three.gif']);
  });

  it('does not retry an image the hub refused until the file changes, and goes on with the rest', async () => {
    const h = await hub();
    const { root, files } = await repo();
    h.refuseAssets.set('.devtool/assets/a/one.png', 413);
    const { client } = makeClient(h, () => files, { assets: source(root) });
    open.push(client);
    client.start();
    await waitFor(() => client.status().state === 'connected', 'connected');
    expect(h.uploads.map((u) => [u.path, u.status])).toEqual([
      ['.devtool/assets/a/one.png', 413],
      ['.devtool/assets/b/two.webp', 200],
    ]);
    expect(client.status().assets).toBe(1);
    client.notifyChanged();
    await new Promise((r) => setTimeout(r, 60));
    expect(h.uploads.length).toBe(2);
    // The file changed: it is offered again.
    h.refuseAssets.clear();
    await writeFile(join(root, '.devtool', 'assets', 'a', 'one.png'), Buffer.concat([PNG, Buffer.from('new')]));
    await client.syncOnce();
    expect(h.uploads.at(-1)).toMatchObject({ path: '.devtool/assets/a/one.png', status: 200, bytes: PNG.length + 3 });
  });

  it('sends no images to a hub that does not say it takes them, nor with titles and fields only, nor without a source', async () => {
    const h = await hub();
    const { root, files } = await repo();
    h.takesAssets = false;
    const a = makeClient(h, () => files, { assets: source(root) });
    open.push(a.client);
    await a.client.syncOnce();
    expect(h.hellos.at(-1)!.assets).toHaveLength(2);
    expect(h.uploads).toEqual([]);
    expect(a.client.status().assets).toBe(0);

    h.takesAssets = true;
    const b = makeClient(h, () => files, { assets: source(root), fieldsOnly: true });
    open.push(b.client);
    await b.client.syncOnce();
    expect(h.hellos.at(-1)!.assets).toBeUndefined();
    expect(h.hellos.at(-1)!.images).toBeUndefined();
    expect(h.uploads).toEqual([]);

    const c = makeClient(h, () => files);
    open.push(c.client);
    await c.client.syncOnce();
    expect(h.hellos.at(-1)!.assets).toBeUndefined();
    expect(h.uploads).toEqual([]);
  });

  it('writes an image pasted on the hub\'s board through the host, acks the link, and does not upload it again with the card', async () => {
    const h = await hub();
    const { root, files } = await repo();
    const pasted = Buffer.concat([PNG, Buffer.from('pasted')]);
    h.pasted.set('u1', pasted);
    const saved: { id: string; ext: string; bytes: Buffer }[] = [];
    const saveImage: HubClientOptions['saveImage'] = async (intent, bytes) => {
      saved.push({ id: intent.intent.id, ext: intent.intent.ext, bytes: Buffer.from(bytes) });
      await writeFile(join(root, '.devtool', 'assets', 'a', 'new.png'), bytes);
      const f = files[0]!;
      return { intentId: intent.intentId, ok: true, route: 'disk', card: { id: 'a', path: f.path, hash: cardHash(f.text), text: f.text }, link: '/.devtool/assets/a/new.png' };
    };
    const { client } = makeClient(h, () => files, { assets: source(root), saveImage });
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'stream');
    expect(h.hellos[0]!.uploads).toBe(true);
    h.requests.length = 0;
    const intent: HubIntent = { intentId: 'p1', baseHash: cardHash(files[0]!.text), op: 'saveImage', intent: { id: 'a', ext: 'png', hash: sha(pasted), size: pasted.length, upload: 'u1' } };
    h.send({ type: 'intent', intent });
    await waitFor(() => h.received.some((m) => m.type === 'ack'), 'ack');
    expect(saved).toEqual([{ id: 'a', ext: 'png', bytes: pasted }]);
    expect(h.received.find((m) => m.type === 'ack')).toEqual({ type: 'ack', ack: { intentId: 'p1', ok: true, route: 'disk', card: expect.objectContaining({ id: 'a' }), link: '/.devtool/assets/a/new.png' } });
    expect(h.requests).toEqual(['GET /hub/uploads/u1', 'POST /hub/events']);

    // The editor inserts the link and saves the body: the hub holds the bytes already, so only the card goes up.
    files[0] = file('a', 'see ![](/.devtool/assets/a/one.png) and ![](/.devtool/assets/a/new.png)');
    h.requests.length = 0;
    client.notifyChanged();
    await waitFor(() => h.received.some((m) => m.type === 'changed'), 'the change');
    expect(h.requests).toEqual(['POST /hub/events']);
  });

  it('refuses a paste whose bytes do not match, one the hub no longer holds, and every paste without a host that writes images', async () => {
    const h = await hub();
    const { files } = await repo();
    const pasted = Buffer.concat([PNG, Buffer.from('pasted')]);
    h.pasted.set('u1', pasted);
    let calls = 0;
    const saveImage: HubClientOptions['saveImage'] = async (intent) => {
      calls++;
      return { intentId: intent.intentId, ok: false, code: 'error', error: 'unexpected' };
    };
    const { client } = makeClient(h, () => files, { saveImage });
    open.push(client);
    client.start();
    await waitFor(() => h.streams.size === 1, 'stream');
    const base = { baseHash: cardHash(files[0]!.text), op: 'saveImage' as const };
    const acks = () => h.received.filter((m): m is Extract<ClientMessage, { type: 'ack' }> => m.type === 'ack').map((m) => m.ack);
    h.send({ type: 'intent', intent: { intentId: 'p1', ...base, intent: { id: 'a', ext: 'png', hash: sha(PNG), size: pasted.length, upload: 'u1' } } });
    await waitFor(() => acks().length === 1, 'first ack');
    expect(acks()[0]).toMatchObject({ intentId: 'p1', ok: false, code: 'invalid', error: /does not match/ });
    h.send({ type: 'intent', intent: { intentId: 'p2', ...base, intent: { id: 'a', ext: 'png', hash: sha(pasted), size: pasted.length, upload: 'gone' } } });
    await waitFor(() => acks().length === 2, 'second ack');
    expect(acks()[1]).toMatchObject({ intentId: 'p2', ok: false, code: 'error', error: /no longer holds/ });
    expect(calls).toBe(0);

    // A read-only client (kanban sync) offers no uploads and refuses a paste without fetching it.
    const ro = makeClient(h, () => files);
    open.push(ro.client);
    ro.client.start();
    await waitFor(() => h.streams.size === 2, 'second stream');
    expect(h.hellos.at(-1)!.uploads).toBeUndefined();
    h.requests.length = 0;
    h.send({ type: 'intent', intent: { intentId: 'p3', ...base, intent: { id: 'a', ext: 'png', hash: sha(pasted), size: pasted.length, upload: 'u1' } } });
    await waitFor(() => acks().filter((a) => a.intentId === 'p3').length === 2, 'both answers');
    expect(acks().filter((a) => a.intentId === 'p3').every((a) => !a.ok && a.code === 'error')).toBe(true);
    expect(h.requests.filter((r) => r.startsWith('GET /hub/uploads'))).toEqual(['GET /hub/uploads/u1']);
  });

  it('fsAssetSource reads under the folder only', async () => {
    const { root } = await repo();
    const src = source(root);
    expect(await src.stat('.devtool/assets/a/one.png')).toMatchObject({ size: PNG.length });
    expect(await src.stat('.devtool/assets/a/nope.png')).toBeNull();
    expect(await src.stat('.devtool/assets/a')).toBeNull();
    await expect(src.read('../etc/passwd.png')).rejects.toThrow(/Not an asset path/);
    await expect(src.read('.devtool/assets/../x.png')).rejects.toThrow(/Not an asset path/);
    expect(Buffer.from(await src.read('.devtool/assets/a/one.png'))).toEqual(PNG);
  });
});
