import { describe, expect, it } from 'vitest';
import { labelCounts, loadBoard, relabel, searchCards } from '../src/index.js';

const card = (id: string, extra: string, body: string) => ({
  path: `${id}.md`,
  text: `---\nid: "${id}"\nstatus: "todo"\norder: "a${id.length}"\n${extra}---\n${body}`,
});

const board = loadBoard([
  card('parser-fix', 'labels: ["parser", "bug"]\nassignee: "Sam"\n', '# Parser fix\n\nWhitespace in glossary terms is lost.\n'),
  card('subtitles', 'labels: ["ui"]\nepic: "Media"\n', '# Subtitles module\n\nImport SRT files.\n'),
  card('login', 'labels: []\n', '# Login page\n'),
]);

describe('searchCards', () => {
  it('matches body, title, id, assignee, labels and epic, case-insensitively', () => {
    expect(searchCards(board, 'WHITESPACE')).toEqual(['parser-fix']);
    expect(searchCards(board, 'subtitles')).toEqual(['subtitles']);
    expect(searchCards(board, 'sam')).toEqual(['parser-fix']);
    expect(searchCards(board, 'bug')).toEqual(['parser-fix']);
    expect(searchCards(board, 'media')).toEqual(['subtitles']);
  });

  it('needs every word to match', () => {
    expect(searchCards(board, 'glossary parser')).toEqual(['parser-fix']);
    expect(searchCards(board, 'glossary login')).toEqual([]);
  });

  it('returns everything for an empty query', () => {
    expect(searchCards(board, '  ')).toHaveLength(3);
  });
});

describe('labels', () => {
  it('relabel renames, removes and never duplicates', () => {
    expect(relabel(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'x', 'c']);
    expect(relabel(['a', 'b'], 'b', 'a')).toEqual(['a']);
    expect(relabel(['a', 'b'], 'a', null)).toEqual(['b']);
    expect(relabel(['a'], 'zzz', 'y')).toEqual(['a']);
  });

  it('counts labels, most used first', () => {
    expect(labelCounts(board)).toEqual([
      { label: 'bug', count: 1 },
      { label: 'parser', count: 1 },
      { label: 'ui', count: 1 },
    ]);
  });
});
