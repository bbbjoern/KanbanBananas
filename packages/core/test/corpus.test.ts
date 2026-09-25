import { describe, expect, it } from 'vitest';
import { loadBoard, parseCard, serializeCard } from '../src/index.js';
import { CORPUS, readBoardDir } from './helpers.js';

/**
 * M0 exit criterion (spec §8, §9). Runs against a snapshot of the real
 * `.devtool/features` copied into test/corpus/features/ (git-ignored).
 * Skipped when the snapshot is absent. The snapshot was taken after the
 * damaged cards were repaired, so it is all-valid; the damaged cases live in
 * fixtures/broken/.
 */
const files = readBoardDir(CORPUS);

describe.skipIf(files.length === 0)('corpus', () => {
  const board = loadBoard(files, { statuses: ['backlog', 'todo', 'in-progress', 'review', 'done'] });

  it('has the expected file count', () => {
    expect(files).toHaveLength(108);
  });

  it('round-trips every card that parses, byte for byte', () => {
    const mismatched = files.filter((f) => {
      const r = parseCard(f.text);
      return r.ok && serializeCard(r.card) !== f.text;
    });
    expect(mismatched.map((f) => f.path)).toEqual([]);
  });

  it('loads every card as valid, with no warnings', () => {
    expect(board.broken.map((b) => [b.path, b.parseError?.code ?? b.issues.map((i) => i.code)])).toEqual([]);
    expect(board.cards.filter((c) => c.issues.length > 0).map((c) => c.path)).toEqual([]);
    expect(board.cards).toHaveLength(108);
  });
});
