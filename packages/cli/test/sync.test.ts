import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyToMirror, mirrorDigests, reconcile, type ClientMessage, type HelloMessage, type HubIntent, type IntentAck, type Mirror } from '@kanban-bananas/core';
import { EXIT, run } from '../src/cli.js';
import { boardColumns } from '../src/sync.js';

const FIXTURES = join(import.meta.dirname, '../../core/test/fixtures/valid');

/** The hub's three endpoints, just enough for `kanban sync`. */
class FakeHub {
  server: Server;
  url = '';
  mirror: Mirror = new Map();
  hellos: HelloMessage[] = [];
  received: ClientMessage[] = [];
  streams = new Set<ServerResponse>();
  constructor() {
    this.server = createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer tok') return res.writeHead(401).end();
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      if (req.url === '/hello') {
        this.hellos.push(body);
        applyToMirror(this.mirror, body);
        const need = reconcile(mirrorDigests(this.mirror), (body as HelloMessage).cards).need;
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'welcome', protocol: 1, session: 's', need }));
      }
      if (req.url === '/events') {
        for (const m of (body as { messages: ClientMessage[] }).messages) {
          applyToMirror(this.mirror, m);
          this.received.push(m);
        }
        return res.writeHead(204).end();
      }
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': hi\n\n');
        this.streams.add(res);
        res.on('close', () => this.streams.delete(res));
        return;
      }
      res.writeHead(404).end();
    });
  }
  /** Send an intent down every open stream. */
  push(intent: HubIntent) {
    for (const s of this.streams) s.write(`data: ${JSON.stringify({ type: 'intent', intent })}\n\n`);
  }
  ack(intentId: string): IntentAck | undefined {
    for (const m of this.received) if (m.type === 'ack' && m.ack.intentId === intentId) return m.ack;
    return undefined;
  }
  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async close() {
    for (const s of this.streams) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

async function waitFor<T>(fn: () => T, what: string, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let project: string;
let features: string;
let hub: FakeHub;
beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'kb-sync-'));
  features = join(project, '.devtool/features');
  cpSync(FIXTURES, features, { recursive: true });
  hub = await new FakeHub().listen();
});
afterEach(() => hub.close());

function kanban(args: string[], env: Record<string, string> = {}, signal?: AbortSignal) {
  let stdout = '';
  let stderr = '';
  const done = run(args, {
    cwd: project,
    env,
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    readStdin: async () => '',
    ...(signal ? { signal } : {}),
  });
  return { done, out: () => stdout, err: () => stderr };
}

describe('kanban sync', () => {
  it('refuses to run without a URL or a token, and never takes the token as an argument', async () => {
    const noUrl = kanban(['sync', '--once']);
    expect(await noUrl.done).toBe(EXIT.usage);
    expect(noUrl.err()).toMatch(/needs the hub URL/);
    const noToken = kanban(['sync', '--once', '--hub', hub.url]);
    expect(await noToken.done).toBe(EXIT.usage);
    expect(noToken.err()).toMatch(/needs a token/);
    const asArgument = kanban(['sync', '--once', '--hub', hub.url, '--token', 'tok']);
    expect(await asArgument.done).toBe(EXIT.usage);
    expect(asArgument.err()).toMatch(/no option --token/);
    expect(hub.hellos).toHaveLength(0);
  });

  it('--once sends the board and exits; the token may come from a file', async () => {
    const tokenFile = join(project, 'token');
    writeFileSync(tokenFile, 'tok\n');
    const r = kanban(['sync', '--once'], { KANBAN_HUB_URL: hub.url, KANBAN_HUB_TOKEN_FILE: tokenFile });
    expect(await r.done).toBe(EXIT.ok);
    expect(hub.hellos).toHaveLength(1);
    expect(hub.hellos[0]?.client.kind).toBe('cli');
    expect(hub.hellos[0]?.repo.featuresDir).toBe('.devtool/features');
    expect(hub.hellos[0]?.columns.map((c) => c.id)).toEqual(['backlog', 'todo', 'in-progress', 'review', 'done']);
    expect(hub.hellos[0]?.columns.map((c) => c.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'Review', 'Done']);
    expect(hub.hellos[0]?.columns[2]?.color).toBe('#f59e0b');
    expect(mirrorDigests(hub.mirror)).toHaveLength(5);
    expect(r.out()).toMatch(/the hub holds 5 card\(s\)/);
    expect(hub.streams.size).toBe(0);

    // A hub that is down is a problem, not a usage error.
    await hub.close();
    const down = kanban(['sync', '--once', '--hub', hub.url], { KANBAN_HUB_TOKEN: 'tok' });
    expect(await down.done).toBe(EXIT.problems);
    hub = await new FakeHub().listen();
  });

  it('runs until stopped, sends file changes, and waits while VS Code is open in the project', async () => {
    const record = join(project, '.devtool/.kanban.sock');
    writeFileSync(record, JSON.stringify({ socket: '/nowhere', pid: process.pid, version: 'x' }));
    const stop = new AbortController();
    const r = kanban(['sync', '--hub', hub.url], { KANBAN_HUB_TOKEN: 'tok', KANBAN_SYNC_POLL_MS: '50' }, stop.signal);
    await waitFor(() => /VS Code is open/.test(r.out()), 'the waiting note');
    await new Promise((res) => setTimeout(res, 100));
    expect(hub.hellos).toHaveLength(0);

    rmSync(record);
    await waitFor(() => hub.streams.size === 1, 'a stream after VS Code went away');
    expect(hub.hellos).toHaveLength(1);
    writeFileSync(join(features, 'fresh-2026-10-20.md'), '---\nid: "fresh-2026-10-20"\nstatus: "todo"\n---\n# Fresh\n');
    await waitFor(() => hub.received.some((m) => m.type === 'created'), 'the created event');
    expect(hub.mirror.has('fresh-2026-10-20')).toBe(true);

    stop.abort();
    expect(await r.done).toBe(EXIT.ok);
    expect(r.out()).toMatch(/sync: stopped/);
  });
});

describe('kanban sync --write', () => {
  const NOW = '2026-10-25T12:00:00.000Z';
  const LOGIN = 'add-login-page-2026-09-01';
  const read = (path: string) => readFileSync(join(features, path), 'utf8');
  const bodyOf = (text: string) => text.slice(text.indexOf('\n---\n', 4) + 5);
  let stop: AbortController;
  let r: ReturnType<typeof kanban>;

  async function start(flags: string[] = ['--write']) {
    stop = new AbortController();
    r = kanban(['sync', '--hub', hub.url, ...flags], { KANBAN_HUB_TOKEN: 'tok', KANBAN_NOW: NOW, KANBAN_SYNC_POLL_MS: '50' }, stop.signal);
    await waitFor(() => hub.streams.size === 1, 'the stream');
  }
  afterEach(async () => {
    stop.abort();
    await r.done;
  });

  async function send(intent: HubIntent): Promise<IntentAck> {
    hub.push(intent);
    return waitFor(() => hub.ack(intent.intentId), `the ack for ${intent.intentId}`);
  }

  it('says which mode it runs in', async () => {
    await start();
    expect(r.out()).toMatch(/\(applies changes\)/);
  });

  it('applies a move, a set and a note to the files and acks with the card as written', async () => {
    await start();
    const move = await send({ intentId: 'i1', baseHash: null, op: 'move', intent: { id: LOGIN, toStatus: 'review', beforeId: null }, expect: { status: 'todo' } });
    expect(move).toMatchObject({ ok: true, route: 'disk', card: { id: LOGIN, path: `${LOGIN}.md` } });
    const moved = read(`${LOGIN}.md`);
    expect(moved).toMatch(/^status: "review"$/m);
    expect(moved).toMatch(new RegExp(`^modified: "${NOW}"$`, 'm'));
    expect(move.ok && move.card.text).toBe(moved);

    const set = await send({ intentId: 'i2', baseHash: null, op: 'set', intent: { id: LOGIN, changes: { priority: 'low', labels: ['ui'] } }, expect: { priority: 'high' } });
    expect(set.ok).toBe(true);
    expect(read(`${LOGIN}.md`)).toMatch(/^priority: "low"$/m);
    expect(read(`${LOGIN}.md`)).toMatch(/^labels: \["ui"\]$/m);

    const note = await send({ intentId: 'i3', baseHash: null, op: 'note', intent: { id: LOGIN, heading: 'From SuperTask', body: 'Looks good.' } });
    expect(note.ok).toBe(true);
    expect(read(`${LOGIN}.md`)).toMatch(/From SuperTask[\s\S]*Looks good\./);
    // Everything else stays byte for byte: the body text before the note is untouched.
    expect(read(`${LOGIN}.md`)).toContain('Some body text with **formatting** that must survive.');
  });

  it('moves a card into done/ and creates new cards', async () => {
    await start();
    const done = await send({ intentId: 'd1', baseHash: null, op: 'move', intent: { id: LOGIN, toStatus: 'done', beforeId: null }, expect: {} });
    expect(done).toMatchObject({ ok: true, card: { path: `done/${LOGIN}.md` } });
    expect(existsSync(join(features, `${LOGIN}.md`))).toBe(false);
    expect(read(`done/${LOGIN}.md`)).toMatch(new RegExp(`^completedAt: "${NOW}"$`, 'm'));

    const created = await send({ intentId: 'c1', baseHash: null, op: 'create', intent: { title: 'From the hub', status: 'todo' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.card.path).toBe('from-the-hub-2026-10-25.md');
    expect(read(created.card.path)).toMatch(/^priority: "medium"$/m);
    expect(read(created.card.path)).toMatch(/# From the hub/);
  });

  it('refuses stale, gone, invalid and conflicting intents without writing', async () => {
    await start();
    const before = read(`${LOGIN}.md`);
    const stale = await send({ intentId: 's1', baseHash: null, op: 'set', intent: { id: LOGIN, changes: { priority: 'low' } }, expect: { priority: 'critical' } });
    expect(stale).toMatchObject({ ok: false, code: 'stale', card: { id: LOGIN, text: before } });
    const gone = await send({ intentId: 's2', baseHash: null, op: 'move', intent: { id: 'nope', toStatus: 'todo', beforeId: null }, expect: {} });
    expect(gone).toMatchObject({ ok: false, code: 'gone' });
    const invalid = await send({ intentId: 's3', baseHash: null, op: 'move', intent: { id: LOGIN, toStatus: 'nowhere', beforeId: null }, expect: {} });
    expect(invalid).toMatchObject({ ok: false, code: 'invalid' });
    const badCreate = await send({ intentId: 's4', baseHash: null, op: 'create', intent: { title: 'X', status: 'nowhere' } });
    expect(badCreate).toMatchObject({ ok: false, code: 'invalid' });
    expect(read(`${LOGIN}.md`)).toBe(before);

    // Someone changed the same line on disk since the hub's edit was based on it.
    const base = bodyOf(before);
    writeFileSync(join(features, `${LOGIN}.md`), before.replace('must survive.', 'must survive, on disk.'));
    const onDisk = read(`${LOGIN}.md`);
    const conflict = await send({ intentId: 's5', baseHash: null, op: 'saveBody', intent: { id: LOGIN, base, body: base.replace('must survive.', 'must survive, in the hub.') } });
    expect(conflict).toMatchObject({ ok: false, code: 'conflict', card: { text: onDisk } });
    expect(read(`${LOGIN}.md`)).toBe(onDisk);
  });

  it('merges a body save with a change elsewhere in the card', async () => {
    await start();
    const before = read(`${LOGIN}.md`);
    const base = bodyOf(before);
    writeFileSync(join(features, `${LOGIN}.md`), before.replace('# Add login page', '# Add the login page'));
    const ack = await send({ intentId: 'b1', baseHash: null, op: 'saveBody', intent: { id: LOGIN, base, body: base.replace('must survive.', 'must survive, in the hub.') } });
    expect(ack.ok).toBe(true);
    const after = read(`${LOGIN}.md`);
    expect(after).toContain('# Add the login page');
    expect(after).toContain('must survive, in the hub.');
  });

  it('does not echo its own write back as a change', async () => {
    await start();
    await send({ intentId: 'e1', baseHash: null, op: 'set', intent: { id: LOGIN, changes: { priority: 'low' } }, expect: {} });
    await new Promise((res) => setTimeout(res, 400));
    expect(hub.received.filter((m) => m.type === 'changed')).toHaveLength(0);
  });

  it('refuses the write when VS Code has opened the project meanwhile', async () => {
    await start();
    const before = read(`${LOGIN}.md`);
    writeFileSync(join(project, '.devtool/.kanban.sock'), JSON.stringify({ socket: '/nowhere', pid: process.pid, version: 'x' }));
    const ack = await send({ intentId: 'v1', baseHash: null, op: 'set', intent: { id: LOGIN, changes: { priority: 'low' } }, expect: {} });
    expect(ack).toMatchObject({ ok: false, code: 'error' });
    expect(!ack.ok && ack.error).toMatch(/VS Code just opened/);
    expect(read(`${LOGIN}.md`)).toBe(before);
  });

  it('without --write stays read-only', async () => {
    await start([]);
    expect(r.out()).toMatch(/\(read-only\)/);
    const before = read(`${LOGIN}.md`);
    const ack = await send({ intentId: 'r1', baseHash: null, op: 'set', intent: { id: LOGIN, changes: { priority: 'low' } }, expect: {} });
    expect(ack).toMatchObject({ ok: false, code: 'error' });
    expect(!ack.ok && ack.error).toMatch(/read-only/);
    expect(read(`${LOGIN}.md`)).toBe(before);
  });
});

describe('boardColumns', () => {
  it('takes the names the extension gave, else the standard ones, else the id spelled as a name', () => {
    expect(boardColumns({ statuses: ['todo', 'qa-check', 'done'], columnNames: { done: 'Shipped' } })).toEqual([
      { id: 'todo', name: 'To Do', color: '#3b82f6' },
      { id: 'qa-check', name: 'Qa check', color: '#6b7280' },
      { id: 'done', name: 'Shipped', color: '#22c55e' },
    ]);
  });
});
