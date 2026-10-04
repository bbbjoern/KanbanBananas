import { IntentError, PatchError, SOCKET_RECORD, type CliRequest, type CliResponse, type CliResult, type SocketRecord } from '@kanban-bananas/core';
import { ConflictError } from '@kanban-bananas/core/node';
import { createHash } from 'node:crypto';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { CardStore } from './cardStore.js';
import { log } from './log.js';
import type { Settings } from './settings.js';

/**
 * Local socket for the `kanban` CLI (spec §12). While VS Code runs, CLI
 * changes arrive here and go through the same CardStore as the board, so an
 * agent's note can't be overwritten by an unsaved editor buffer.
 *
 * The socket lives in the temp directory (socket paths are short-limited);
 * `.devtool/.kanban.sock` records where it is. Only the owner can connect.
 */
export class CliServer implements vscode.Disposable {
  private server: Server | undefined;
  private readonly socketPath: string;
  private readonly recordPath: string;

  constructor(
    featuresRoot: string,
    private readonly store: CardStore,
    private readonly settings: () => Settings,
    private readonly version: string,
    private readonly memory: (body: string) => Promise<CliResult>,
  ) {
    const hash = createHash('sha256').update(featuresRoot).digest('hex').slice(0, 12);
    this.socketPath = join(tmpdir(), `kanban-bananas-${hash}-${process.pid}.sock`);
    this.recordPath = join(dirname(featuresRoot), SOCKET_RECORD);
  }

  get recordLocation(): string {
    return this.recordPath;
  }

  async start(): Promise<void> {
    await unlink(this.socketPath).catch(() => {});
    const server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => resolve());
    });
    await chmod(this.socketPath, 0o600);
    this.server = server;
    const record: SocketRecord = { socket: this.socketPath, pid: process.pid, version: this.version };
    await writeFile(this.recordPath, JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  private handle(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        void this.respond(line).then((r) => socket.write(JSON.stringify(r) + '\n'));
      }
    });
    socket.on('error', () => socket.destroy());
  }

  /** Answers by request id, so a repeated request is applied once (kept a few minutes). */
  private readonly answers = new Map<string, { at: number; answer: Promise<CliResponse> }>();

  private async respond(line: string): Promise<CliResponse> {
    let request: CliRequest;
    try {
      request = JSON.parse(line) as CliRequest;
    } catch {
      return { ok: false, code: 'invalid', error: 'Request is not JSON.' };
    }
    const now = Date.now();
    for (const [id, a] of this.answers) if (now - a.at > 5 * 60_000) this.answers.delete(id);
    const id = request.requestId;
    const known = id ? this.answers.get(id) : undefined;
    if (known) {
      log.info(`CLI ${request.op} ${id}: repeated request, answering with the first one's result`);
      return known.answer;
    }
    const started = Date.now();
    const answer = this.handleRequest(request).then((r) => {
      const ms = Date.now() - started;
      const result = r.ok ? (r.result ? `${r.result.route} ${r.result.path}` : 'ok') : `${r.code}: ${r.error}`;
      (ms > 5000 ? log.warn : log.info).call(log, `CLI ${request.op}${id ? ` ${id.slice(0, 8)}` : ''}: ${result} (${ms} ms)`);
      return r;
    });
    if (id) this.answers.set(id, { at: now, answer });
    return answer;
  }

  private async handleRequest(request: CliRequest): Promise<CliResponse> {
    try {
      const store = this.store;
      switch (request.op) {
        case 'ping':
          return { ok: true, version: this.version };
        case 'move':
          return { ok: true, version: this.version, result: await store.move(request.intent) };
        case 'set':
          return { ok: true, version: this.version, result: await store.setFields(request.intent) };
        case 'note':
          return { ok: true, version: this.version, result: await store.note(request.intent) };
        case 'edit':
          return { ok: true, version: this.version, result: await store.editBody(request.intent) };
        case 'memory':
          return { ok: true, version: this.version, result: await this.memory(request.body) };
        case 'create': {
          const s = this.settings();
          const intent = {
            top: s.view.addNewCardsToTop,
            ...request.intent,
            priority: request.intent.priority ?? s.defaultPriority,
          };
          return { ok: true, version: this.version, result: await store.create(intent) };
        }
        default:
          return { ok: false, code: 'invalid', error: `Unknown op "${(request as { op: string }).op}".` };
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof ConflictError) return { ok: false, code: 'conflict', error };
      if (e instanceof IntentError || e instanceof PatchError) return { ok: false, code: 'invalid', error };
      return { ok: false, code: 'error', error };
    }
  }

  dispose(): void {
    this.server?.close();
    void unlink(this.socketPath).catch(() => {});
    // Remove the record only if it still points at this window's socket.
    void readFile(this.recordPath, 'utf8')
      .then((text) => ((JSON.parse(text) as SocketRecord).socket === this.socketPath ? unlink(this.recordPath) : undefined))
      .catch(() => {});
  }
}
