import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, readVersioned, renameNoClobber, writeAtomic } from '../../src/atomicFile.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-atomic-'));
});

const card = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe('writeAtomic', () => {
  it('replaces the file, keeps its permissions and leaves no temp file', async () => {
    const p = card('a.md', 'old');
    chmodSync(p, 0o600);
    const { version } = await readVersioned(p);
    await writeAtomic(p, '﻿new', version);
    expect(readFileSync(p)).toEqual(Buffer.from('﻿new', 'utf8'));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('refuses to write when the file changed since it was read, and leaves it alone', async () => {
    const p = card('a.md', 'old');
    const { version } = await readVersioned(p);
    writeFileSync(p, 'mid'); // same size, so only the mtime tells
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    await expect(writeAtomic(p, 'new', version)).rejects.toThrow(ConflictError);
    expect(readFileSync(p, 'utf8')).toBe('mid');
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('never overwrites an existing file when creating', async () => {
    const p = card('a.md', 'existing');
    await expect(writeAtomic(p, 'new', null)).rejects.toThrow(ConflictError);
    expect(readFileSync(p, 'utf8')).toBe('existing');
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('creates a new file', async () => {
    const p = join(dir, 'b.md');
    await writeAtomic(p, 'fresh', null);
    expect(readFileSync(p, 'utf8')).toBe('fresh');
    expect(readdirSync(dir)).toEqual(['b.md']);
  });

  it('keeps the original intact when the process is killed between temp write and rename', async () => {
    const p = card('a.md', '---\nid: "a"\n---\n# Original');
    const bundle = join(dir, 'atomic.mjs');
    await esbuild.build({
      entryPoints: [join(import.meta.dirname, '../../src/atomicFile.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    const script = `
      import { readVersioned, writeAtomic } from ${JSON.stringify(bundle)};
      const { version } = await readVersioned(${JSON.stringify(p)});
      await writeAtomic(${JSON.stringify(p)}, 'REPLACED', version, {
        beforeCommit: () => process.kill(process.pid, 'SIGKILL'),
      });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
    expect(child.signal).toBe('SIGKILL');
    expect(readFileSync(p, 'utf8')).toBe('---\nid: "a"\n---\n# Original');
    // The orphaned temp file is a dotfile without the .md extension, so the board ignores it.
    const leftovers = readdirSync(dir).filter((n) => n !== 'a.md' && n !== 'atomic.mjs');
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/^\.a\.md\.[0-9a-f]+\.tmp$/);
  });
});

describe('renameNoClobber', () => {
  it('moves a file and refuses to replace one', async () => {
    const a = card('a.md', 'A');
    const b = card('b.md', 'B');
    await expect(renameNoClobber(a, b)).rejects.toThrow(ConflictError);
    expect(readFileSync(b, 'utf8')).toBe('B');
    await renameNoClobber(a, join(dir, 'c.md'));
    expect(readdirSync(dir).sort()).toEqual(['b.md', 'c.md']);
  });
});
