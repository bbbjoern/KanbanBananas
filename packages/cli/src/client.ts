import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { CliRequest, CliResponse, SocketRecord } from '@kanban-bananas/core';

/** First wait, then one retry of the same request (same id: applied once) with a longer wait. */
const WAITS_MS = [15_000, 45_000];

class SocketTimeout extends Error {}

/**
 * Send one request to the running extension. Resolves to null when no
 * extension is listening (no record, stale record, nothing at the socket),
 * so the caller falls back to writing the file itself.
 *
 * A slow answer isn't treated as a failure: the request carries an id, the
 * CLI asks again with the same id, and the extension applies it only once.
 */
export async function sendToExtension(
  recordPath: string,
  request: CliRequest,
  onWaiting: (message: string) => void = () => {},
  waits: readonly number[] = WAITS_MS,
): Promise<CliResponse | null> {
  let record: SocketRecord;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8')) as SocketRecord;
  } catch {
    return null;
  }
  const withId: CliRequest = { ...request, requestId: request.requestId ?? randomUUID() };
  for (let attempt = 0; attempt < waits.length; attempt++) {
    try {
      return await once(record.socket, withId, waits[attempt]!);
    } catch (e) {
      if (!(e instanceof SocketTimeout)) throw e;
      if (attempt < waits.length - 1) onWaiting('still waiting for VS Code (it may be busy saving a file)…');
    }
  }
  const total = Math.round(waits.reduce((a, b) => a + b, 0) / 1000);
  throw new Error(
    `VS Code didn't answer within ${total}s. The change may still be applied once VS Code catches up: check with "kanban show" before repeating it.`,
  );
}

function once(socketPath: string, request: CliRequest, timeoutMs: number): Promise<CliResponse | null> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let connected = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SocketTimeout());
    }, timeoutMs);

    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as CliResponse);
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Nothing listening: VS Code isn't running (or crashed). Write directly.
      if (!connected && ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(e.code ?? '')) resolve(null);
      else reject(e);
    });
  });
}
