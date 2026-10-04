import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendToExtension } from '../src/client.js';

describe('sendToExtension', () => {
  it('a slow answer is waited for: same request id on the retry, and a "still waiting" note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-sock-'));
    const sock = join(dir, 's.sock');
    const seen: string[] = [];
    // Answers only after 250 ms, like an extension busy saving.
    const server = createServer((c) =>
      c.on('data', (d) => {
        const req = JSON.parse(String(d).trim());
        seen.push(req.requestId);
        setTimeout(() => c.write(JSON.stringify({ ok: true, version: 'x' }) + '\n'), 250);
      }),
    );
    await new Promise<void>((r) => server.listen(sock, () => r()));
    const record = join(dir, 'record');
    writeFileSync(record, JSON.stringify({ socket: sock, pid: 1, version: 'x' }));

    const notes: string[] = [];
    const answer = await sendToExtension(record, { op: 'ping' }, (m) => notes.push(m), [100, 2000]);
    server.close();
    expect(answer).toEqual({ ok: true, version: 'x' });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(notes).toEqual([expect.stringMatching(/still waiting/)]);
  });

  it('gives up with a message that says the change may still land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-sock-'));
    const sock = join(dir, 's.sock');
    const server = createServer(() => {}); // never answers
    await new Promise<void>((r) => server.listen(sock, () => r()));
    const record = join(dir, 'record');
    writeFileSync(record, JSON.stringify({ socket: sock, pid: 1, version: 'x' }));
    await expect(sendToExtension(record, { op: 'ping' }, () => {}, [50, 50])).rejects.toThrow(/may still be applied/);
    server.close();
  });
});
