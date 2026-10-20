import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardDigests, cardHash, cardTexts, verifyCardText } from '../src/node/index.js';
import { FIXTURES, readBoardDir } from './helpers.js';

describe('cardHash', () => {
  it('is the SHA-256 of the UTF-8 bytes, as hex', () => {
    expect(cardHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(cardHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(cardHash(Buffer.from('abc'))).toBe(cardHash('abc'));
    expect(cardHash(new Uint8Array([0x61, 0x62, 0x63]))).toBe(cardHash('abc'));
  });

  it('tells a BOM, CRLF and a missing final newline apart', () => {
    const base = '---\nid: "x"\n---\n# T\n';
    const hashes = new Set([cardHash(base), cardHash(`\uFEFF${base}`), cardHash(base.replace(/\n/g, '\r\n')), cardHash(base.trimEnd())]);
    expect(hashes.size).toBe(4);
  });

  it('matches the hash of the file bytes for every fixture card, valid or broken', () => {
    const files = readBoardDir(FIXTURES);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(cardHash(f.text)).toBe(cardHash(readFileSync(join(FIXTURES, f.path))));
  });
});

describe('cardDigests and cardTexts', () => {
  const files = [
    { path: 'a-2026-01-01.md', text: '---\nid: "a-2026-01-01"\n---\n# A\n' },
    { path: 'done/b-2026-01-02.md', text: '---\nid: "b-2026-01-02"\n---\n# B\n' },
  ];

  it('take the id from the filename and hash the text', () => {
    expect(cardDigests(files)).toEqual([
      { id: 'a-2026-01-01', path: 'a-2026-01-01.md', hash: cardHash(files[0]!.text) },
      { id: 'b-2026-01-02', path: 'done/b-2026-01-02.md', hash: cardHash(files[1]!.text) },
    ]);
    expect(cardTexts(files).map((c) => c.text)).toEqual(files.map((f) => f.text));
  });

  it('verifyCardText catches a text that does not match its hash', () => {
    const [a] = cardTexts(files);
    expect(verifyCardText(a!)).toBe(true);
    expect(verifyCardText({ ...a!, text: `${a!.text}\n` })).toBe(false);
    expect(verifyCardText({ ...a!, hash: 'nope' })).toBe(false);
  });
});
