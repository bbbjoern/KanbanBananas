import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { CliRequest, CliResponse, SocketRecord } from '@kanban-bananas/core';

const TIMEOUT_MS = 15_000;

/**
 * Send one request to the running extension. Resolves to null when no
 * extension is listening (no record, stale record, nothing at the socket),
 * so the caller falls back to writing the file itself.
 */
export async function sendToExtension(recordPath: string, request: CliRequest): Promise<CliResponse | null> {
  let record: SocketRecord;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8')) as SocketRecord;
  } catch {
    return null;
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socket);
    let buffer = '';
    let connected = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('VS Code did not answer within 15s. Nothing is known to have been written; check the card.'));
    }, TIMEOUT_MS);

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
