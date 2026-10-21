import { describe, expect, it } from 'vitest';
import { parseCard } from '../src/parse.js';
import {
  applyToMirror,
  expectationFor,
  fieldsOnlyText,
  mirrorDigests,
  reconcile,
  SentHashes,
  staleFields,
  type CardDigest,
  type CardFields,
  type CardText,
  type ClientMessage,
  type Mirror,
} from '../src/index.js';

/** A stand-in for cardHash: these helpers never hash, they only compare. */
const h = (text: string) => `h:${text}`;
const card = (id: string, text: string, dir = ''): CardText => ({ id, path: `${dir}${id}.md`, hash: h(text), text });
const digest = ({ id, path, hash }: CardText): CardDigest => ({ id, path, hash });

describe('reconcile', () => {
  it('needs everything from an empty mirror and nothing from an equal one', () => {
    const current = [digest(card('a', '1')), digest(card('b', '2', 'done/'))];
    expect(reconcile([], current)).toEqual({ need: ['a', 'b'], gone: [] });
    expect(reconcile(current, current)).toEqual({ need: [], gone: [] });
  });

  it('needs a card whose text or path changed, in the client order, and lists what is gone', () => {
    const mirror = [digest(card('a', '1')), digest(card('b', '2')), digest(card('c', '3')), digest(card('old', '0'))];
    const current = [digest(card('c', '3')), digest(card('b', '2', 'done/')), digest(card('a', '1 edited')), digest(card('new', 'n'))];
    expect(reconcile(mirror, current)).toEqual({ need: ['b', 'a', 'new'], gone: ['old'] });
  });
});

describe('applyToMirror', () => {
  it('sets, renames and deletes cards and ignores messages without text', () => {
    const mirror: Mirror = new Map();
    applyToMirror(mirror, { type: 'created', card: card('a', '1') });
    applyToMirror(mirror, { type: 'cards', cards: [card('b', '2'), card('c', '3')] });
    applyToMirror(mirror, { type: 'changed', card: card('a', '1 edited') });
    applyToMirror(mirror, { type: 'renamed', from: 'b', card: card('b-2', '2', 'done/') });
    applyToMirror(mirror, { type: 'deleted', id: 'c' });
    applyToMirror(mirror, { type: 'columns', columns: [] });
    applyToMirror(mirror, { type: 'ack', ack: { intentId: 'i', ok: false, code: 'gone', error: 'x' } });
    expect(mirrorDigests(mirror)).toEqual([digest(card('a', '1 edited')), digest(card('b-2', '2', 'done/'))]);
  });

  it('takes the card in an ack as its latest text, and drops the old id of a renaming write', () => {
    const mirror: Mirror = new Map([['a', card('a', '1')], ['b', card('b', '2')]]);
    applyToMirror(mirror, { type: 'ack', ack: { intentId: 'i', ok: true, route: 'disk', card: card('a-2', '1 moved', 'done/'), from: 'a' } });
    applyToMirror(mirror, { type: 'ack', ack: { intentId: 'j', ok: false, code: 'stale', error: 'x', card: card('b', '2 by someone else') } });
    applyToMirror(mirror, { type: 'ack', ack: { intentId: 'k', ok: false, code: 'gone', error: 'x' } });
    expect(mirrorDigests(mirror)).toEqual([digest(card('b', '2 by someone else')), digest(card('a-2', '1 moved', 'done/'))]);
  });

  it('drops what a hello no longer lists and keeps the rest until their texts arrive', () => {
    const mirror: Mirror = new Map([['a', card('a', '1')], ['b', card('b', '2')]]);
    applyToMirror(mirror, hello([digest(card('b', '2 changed')), digest(card('c', '3'))]));
    expect([...mirror.keys()]).toEqual(['b']);
    expect(mirror.get('b')?.text).toBe('2');
  });

  it('sorts digests by path, done/ after the top level', () => {
    const mirror: Mirror = new Map([['z', card('z', '1')], ['a', card('a', '2', 'done/')], ['m', card('m', '3')]]);
    expect(mirrorDigests(mirror).map((d) => d.path)).toEqual(['done/a.md', 'm.md', 'z.md']);
  });
});

describe('a client with dropped events still ends in the same state after a reconcile', () => {
  // Deterministic pseudo-random sequences, so a failure can be replayed.
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const rnd = prng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const files = new Map<string, CardText>();
      const mirror: Mirror = new Map();
      let n = 0;
      let dropped = 0;
      const send = (m: ClientMessage) => {
        if (rnd() < 0.2 && m.type !== 'hello' && m.type !== 'cards') dropped++;
        else applyToMirror(mirror, m);
      };
      for (let step = 0; step < 60; step++) {
        const ids = [...files.keys()];
        const op = ids.length === 0 ? 'create' : pick(['create', 'change', 'change', 'rename', 'delete', 'move']);
        if (op === 'create') {
          const c = card(`c${n++}`, `text ${n}`);
          files.set(c.id, c);
          send({ type: 'created', card: c });
        } else if (op === 'change') {
          const old = files.get(pick(ids))!;
          const c = { ...old, text: `${old.text}+`, hash: h(`${old.text}+`) };
          files.set(c.id, c);
          send({ type: 'changed', card: c });
        } else if (op === 'move') {
          const old = files.get(pick(ids))!;
          const dir = old.path.startsWith('done/') ? '' : 'done/';
          const c = card(old.id, `${old.text} moved`, dir);
          files.set(c.id, c);
          send({ type: 'changed', card: c });
        } else if (op === 'rename') {
          const old = files.get(pick(ids))!;
          const c = card(`${old.id}-r`, old.text);
          files.delete(old.id);
          files.set(c.id, c);
          send({ type: 'renamed', from: old.id, card: c });
        } else {
          const id = pick(ids);
          files.delete(id);
          send({ type: 'deleted', id });
        }
      }
      const current = [...files.values()].map(digest);
      send(hello(current));
      const { need } = reconcile(mirrorDigests(mirror), current);
      send({ type: 'cards', cards: need.map((id) => files.get(id)!) });
      expect(mirrorDigests(mirror)).toEqual(
        [...files.values()].map(digest).sort((a, b) => (a.path < b.path ? -1 : 1)),
      );
      expect(reconcile(mirrorDigests(mirror), current)).toEqual({ need: [], gone: [] });
      expect(dropped).toBeGreaterThan(0);
    });
  }
});

function hello(cards: CardDigest[]): ClientMessage {
  return { type: 'hello', protocol: 1, client: { kind: 'cli', version: '0' }, repo: { remote: 'r', featuresDir: 'f' }, columns: [], cards };
}

const FIELDS: CardFields = {
  id: 'a',
  status: 'todo',
  priority: 'medium',
  assignee: null,
  epic: null,
  dueDate: null,
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  labels: ['ui', 'auth'],
  order: 'a1',
  lane: null,
  type: null,
};

describe('expectationFor and staleFields', () => {
  it('a move depends on the card status and order', () => {
    const expect_ = expectationFor(FIELDS, { op: 'move' });
    expect(expect_).toEqual({ status: 'todo', order: 'a1' });
    expect(staleFields(FIELDS, expect_)).toEqual([]);
    expect(staleFields({ ...FIELDS, status: 'review' }, expect_)).toEqual(['status']);
    expect(staleFields({ ...FIELDS, status: 'review', order: 'a2' }, expect_)).toEqual(['status', 'order']);
  });

  it('a set depends only on the fields it changes, so edits to different fields both land', () => {
    const expect_ = expectationFor(FIELDS, { op: 'set', intent: { id: 'a', changes: { priority: 'high' } } });
    expect(expect_).toEqual({ priority: 'medium' });
    expect(staleFields({ ...FIELDS, labels: ['bug'], status: 'done', modified: 'later' }, expect_)).toEqual([]);
    expect(staleFields({ ...FIELDS, priority: 'low' }, expect_)).toEqual(['priority']);
  });

  it('compares lists by content and treats an absent field as null', () => {
    const expect_ = expectationFor(FIELDS, { op: 'set', intent: { id: 'a', changes: { labels: [], lane: 'x' } } });
    expect(expect_).toEqual({ labels: ['ui', 'auth'], lane: null });
    expect(staleFields({ ...FIELDS, labels: ['ui', 'auth'] }, expect_)).toEqual([]);
    expect(staleFields({ ...FIELDS, labels: ['auth', 'ui'] }, expect_)).toEqual(['labels']);
    expect(staleFields({ ...FIELDS, lane: 'y' }, expect_)).toEqual(['lane']);
    expect(staleFields({ ...FIELDS, labels: null as unknown as string[] }, { labels: ['ui'] })).toEqual(['labels']);
  });

  it('create, saveBody and note expect nothing', () => {
    expect(expectationFor(FIELDS, { op: 'create' })).toEqual({});
    expect(expectationFor(FIELDS, { op: 'saveBody' })).toEqual({});
    expect(expectationFor(FIELDS, { op: 'note' })).toEqual({});
    expect(staleFields({ ...FIELDS, status: 'done' }, {})).toEqual([]);
  });
});

describe('SentHashes', () => {
  it('skips a version the hub already holds, including the client\'s own write coming back', () => {
    const sent = new SentHashes();
    expect(sent.shouldSend('a', 'h1')).toBe(true);
    sent.sent('a', 'h1');
    expect(sent.shouldSend('a', 'h1')).toBe(false);
    expect(sent.shouldSend('a', 'h2')).toBe(true);
    expect(sent.shouldSend('b', 'h1')).toBe(true);
    sent.forget('a');
    expect(sent.has('a')).toBe(false);
    expect(sent.shouldSend('a', 'h1')).toBe(true);
    sent.sent('a', 'h1');
    sent.sent('b', 'h1');
    expect(sent.size).toBe(2);
    expect(sent.ids().sort()).toEqual(['a', 'b']);
    expect(sent.has('b')).toBe(true);
    sent.clear();
    expect(sent.size).toBe(0);
    expect(sent.shouldSend('a', 'h1')).toBe(true);
  });
});

describe('fieldsOnlyText', () => {
  it('keeps the frontmatter and the title line, drops the rest, and parses as the same card', () => {
    const text = '---\nid: "a"\nstatus: "todo"\nlabels: [x, y]\n---\n# The title\n\nA secret body.\n\n## Notes\n- [ ] more\n';
    const cut = fieldsOnlyText(text);
    expect(cut).toBe('---\nid: "a"\nstatus: "todo"\nlabels: [x, y]\n---\n# The title\n');
    const parsed = parseCard(cut);
    expect(parsed.ok && parsed.card.title).toBe('The title');
    expect(parsed.ok && parsed.card.fields.labels).toEqual(['x', 'y']);
    expect(cut).not.toContain('secret');
    expect(fieldsOnlyText(cut)).toBe(cut);
  });

  it('keeps CRLF and a BOM, a title from a level-two first line, and sends no heading without a title', () => {
    expect(fieldsOnlyText('\uFEFF---\r\nid: "a"\r\n---\r\n## Second level\r\n\r\nbody\r\n')).toBe('\uFEFF---\r\nid: "a"\r\n---\r\n# Second level\r\n');
    expect(fieldsOnlyText('---\nid: "a"\n---\nno heading here\n\n## later section\n')).toBe('---\nid: "a"\n---\n');
  });

  it('sends a broken card as its closed frontmatter block, or empty', () => {
    expect(fieldsOnlyText('---\nid: [\n---\n# Title\n\nbody\n')).toBe('---\nid: [\n---\n');
    expect(fieldsOnlyText('---\nid: "a"\n# never closed\n\nbody\n')).toBe('');
    expect(fieldsOnlyText('# No frontmatter\n\nbody\n')).toBe('');
    expect(fieldsOnlyText('')).toBe('');
  });
});
