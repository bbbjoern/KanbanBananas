import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyToMirror,
  HUB_PROTOCOL_VERSION,
  HUB_SESSION_HEADER,
  mirrorDigests,
  reconcile,
  type BoardFile,
  type ClientMessage,
  type HelloMessage,
  type HubIntent,
  type HubMessage,
  type IntentAck,
  type Mirror,
  type RefusedMessage,
} from '../src/index.js';
import { cardDigests, cardHash, HubClient, type HubClientOptions, type HubStatus } from '../src/node/index.js';

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

  send(message: HubMessage): void {
    for (const res of this.streams) res.write(`data: ${JSON.stringify(message)}\n\n`);
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
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : null;
    const session = req.headers[HUB_SESSION_HEADER];
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
      const welcome = { type: 'welcome', protocol: this.welcomeProtocol, session: id, need: reconcile(mirrorDigests(this.mirror), hello.cards).need };
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

describe('HubClient', () => {
  it('connects with a hello, sends what the hub lacks, then only what changes', async () => {
    const h = await hub();
    let files = [file('a', '1'), file('b', '2', 'done/')];
    const { client, statuses } = makeClient(h, () => files);
    open.push(client);
    client.start();
    await waitFor(() => client.status().state === 'connected' && h.streams.size > 0, 'connected');
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected']);
    expect(h.hellos[0]?.cards.map((c) => c.id)).toEqual(['a', 'b']);
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
