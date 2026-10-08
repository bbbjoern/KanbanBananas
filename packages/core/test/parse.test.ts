import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCard, serializeCard } from '../src/index.js';
import { FIXTURES, readBoardDir } from './helpers.js';

const read = (p: string) => readFileSync(join(FIXTURES, p), 'utf8');

function parseOk(text: string) {
  const r = parseCard(text);
  if (!r.ok) throw new Error(`parse failed: ${r.error.code}`);
  return r.card;
}

describe('round trip', () => {
  for (const file of readBoardDir(join(FIXTURES, 'valid'))) {
    it(`is byte-identical: ${file.path}`, () => {
      expect(serializeCard(parseOk(file.text))).toBe(file.text);
    });
  }
});

describe('parseCard', () => {
  it('reads all known fields', () => {
    const card = parseOk(read('valid/add-login-page-2026-09-01.md'));
    expect(card.fields).toEqual({
      id: 'add-login-page-2026-09-01',
      status: 'todo',
      priority: 'high',
      assignee: null,
      epic: null,
      dueDate: null,
      created: '2026-09-01T10:00:00.000Z',
      modified: '2026-09-02T08:30:00.000Z',
      completedAt: null,
      labels: ['ui', 'auth'],
      order: 'a1',
      lane: null,
    });
    expect(card.fieldProblems).toEqual([]);
  });

  it('takes the first heading outside code fences as the title', () => {
    expect(parseOk(read('valid/add-login-page-2026-09-01.md')).title).toBe('Add login page');
  });

  it('without a # heading, takes a heading on the first line, but not a later section', () => {
    const card = (body: string) => `---\nid: "t-2026-01-01"\nstatus: "todo"\norder: "a0"\n---\n${body}`;
    expect(parseOk(card('\n## Second level\n\nText.\n')).title).toBe('Second level');
    expect(parseOk(card('## Not this\n\n# This one\n')).title).toBe('This one');
    expect(parseOk(card('Some text first.\n\n## Done — a note\n')).title).toBeNull();
    expect(parseOk(card('#### Fourth\n')).title).toBe('Fourth');
  });

  it('accepts a body that is only a title with no trailing newline', () => {
    const card = parseOk(read('valid/title-only-2026-09-03.md'));
    expect(card.title).toBe('Title only');
    expect(card.source.body).toBe('# Title only');
  });

  it('accepts a BOM and CRLF line endings', () => {
    const card = parseOk(read('valid/crlf-with-bom-2026-09-04.md'));
    expect(card.source.bom).toBe(true);
    expect(card.source.eol).toBe('\r\n');
    expect(card.fields.id).toBe('crlf-with-bom-2026-09-04');
    expect(card.fields.labels).toEqual(['bug']);
    expect(card.title).toBe('CRLF with BOM');
  });

  it('reads numeric order 0 as "0" and keeps unknown keys and comments', () => {
    const card = parseOk(read('valid/numeric-order-2026-09-05.md'));
    expect(card.fields.order).toBe('0');
    expect(card.doc.get('customKey')).toBe('unknown keys are preserved');
    expect(card.source.frontmatter).toContain('# a comment the board must keep');
  });

  it('parses a card whose closing delimiter ends the file', () => {
    const card = parseOk('---\nid: "x"\nstatus: "todo"\n---');
    expect(card.source.close).toBe('---');
    expect(card.source.body).toBe('');
  });

  it('does not treat a `---` inside the body as frontmatter', () => {
    const text = '---\nid: "x"\nstatus: "todo"\n---\n# X\n\n---\n\nafter rule\n';
    const card = parseOk(text);
    expect(card.source.body).toBe('# X\n\n---\n\nafter rule\n');
    expect(serializeCard(card)).toBe(text);
  });

  it('reports wrongly typed fields instead of guessing', () => {
    const card = parseOk('---\nid: "x"\nstatus: 3\nlabels: "bug"\norder: 1.5\n---\n');
    expect(card.fieldProblems.map((p) => p.field)).toEqual(['status', 'labels', 'order']);
    expect(card.fields.status).toBeNull();
  });
});

describe('parseCard rejects', () => {
  const cases: [string, string][] = [
    ['empty-file', ''],
    ['empty-file', '﻿\n\n'],
    ['no-frontmatter', '# Just a body\n'],
    ['unterminated-frontmatter', '---\nid: "x"\n# Title\n'],
    ['yaml-error', '---\nid: "x\nstatus: todo\n---\n'],
    ['yaml-error', '---\nid: "x"\nid: "y"\n---\n'],
    ['frontmatter-not-a-map', '---\n- a\n- b\n---\n'],
    ['frontmatter-not-a-map', '---\n---\n# Title\n'],
  ];
  for (const [code, text] of cases) {
    it(`${code}: ${JSON.stringify(text)}`, () => {
      const r = parseCard(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(code);
    });
  }
});
