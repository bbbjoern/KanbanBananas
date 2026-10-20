import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyToMirror, mirrorDigests, reconcile, type ClientMessage, type HelloMessage, type Mirror } from '@kanban-bananas/core';
import { EXIT, run } from '../src/cli.js';

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
