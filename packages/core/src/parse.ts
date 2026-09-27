import { isMap, parseDocument, type Document } from 'yaml';

/** Frontmatter keys the board knows about. Any other key is kept as-is. */
export const KNOWN_FIELDS = [
  'id',
  'status',
  'priority',
  'assignee',
  'epic',
  'dueDate',
  'created',
  'modified',
  'completedAt',
  'labels',
  'order',
  'lane',
] as const;

export type KnownField = (typeof KNOWN_FIELDS)[number];

export interface CardFields {
  id: string | null;
  status: string | null;
  priority: string | null;
  assignee: string | null;
  epic: string | null;
  dueDate: string | null;
  created: string | null;
  modified: string | null;
  completedAt: string | null;
  labels: string[];
  /** Fractional-index key. A numeric `order: 0` is read as the string "0". */
  order: string | null;
  /** Optional free-text lane, used when the board is grouped by Lane. Absent on most cards. */
  lane: string | null;
}

/**
 * The file split into raw pieces. Concatenating them (with the BOM when
 * `bom` is set) reproduces the original file byte for byte.
 */
export interface CardSource {
  bom: boolean;
  eol: '\n' | '\r\n';
  /** Opening delimiter including its line ending: `---\n` or `---\r\n`. */
  open: string;
  /** Raw YAML between the delimiters, including its final line ending. */
  frontmatter: string;
  /** Closing delimiter line, including its line ending if there is one. */
  close: string;
  /** Everything after the closing delimiter, untouched. */
  body: string;
}

export interface FieldProblem {
  field: KnownField;
  message: string;
}

export interface Card {
  fields: CardFields;
  /** Text of the first `# ` heading outside code fences, or null. */
  title: string | null;
  source: CardSource;
  /** Parsed frontmatter. Keeps key order, quoting, comments and unknown keys. */
  doc: Document;
  /** Known fields whose value had the wrong type. Reported by `validateCard`. */
  fieldProblems: FieldProblem[];
}

export type ParseErrorCode =
  | 'empty-file'
  | 'no-frontmatter'
  | 'unterminated-frontmatter'
  | 'yaml-error'
  | 'frontmatter-not-a-map';

export interface ParseError {
  code: ParseErrorCode;
  message: string;
}

export type ParseResult = { ok: true; card: Card } | { ok: false; error: ParseError };

const BOM = '﻿';

export function parseCard(input: string): ParseResult {
  const bom = input.startsWith(BOM);
  const text = bom ? input.slice(1) : input;

  if (text.trim().length === 0) {
    return fail('empty-file', 'File is empty.');
  }

  const openMatch = /^---(\r?\n)/.exec(text);
  if (!openMatch) {
    return fail('no-frontmatter', 'File does not start with a `---` frontmatter block.');
  }
  const open = openMatch[0];
  const eol = openMatch[1] as '\n' | '\r\n';

  const split = findClosingDelimiter(text, open.length);
  if (!split) {
    return fail('unterminated-frontmatter', 'Frontmatter has no closing `---` line.');
  }
  const frontmatter = text.slice(open.length, split.start);
  const close = text.slice(split.start, split.end);
  const body = text.slice(split.end);

  const doc = parseDocument(frontmatter);
  if (doc.errors.length > 0) {
    return fail('yaml-error', doc.errors.map((e) => e.message).join('\n'));
  }
  if (!isMap(doc.contents)) {
    return fail('frontmatter-not-a-map', 'Frontmatter is not a key/value map.');
  }

  const { fields, problems } = readFields(doc.toJS() as Record<string, unknown>);

  return {
    ok: true,
    card: {
      fields,
      title: findTitle(body),
      source: { bom, eol, open, frontmatter, close, body },
      doc,
      fieldProblems: problems,
    },
  };
}

/** Reassemble a card's file contents from its raw pieces. */
export function serializeCard(card: Card): string {
  const s = card.source;
  return (s.bom ? BOM : '') + s.open + s.frontmatter + s.close + s.body;
}

function fail(code: ParseErrorCode, message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

/** Find the first line that is exactly `---`, starting at `from`. */
function findClosingDelimiter(text: string, from: number): { start: number; end: number } | null {
  let i = from;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl + 1;
    if (text.slice(i, end).replace(/\r?\n$/, '') === '---') {
      return { start: i, end };
    }
    i = end;
  }
  return null;
}

function readFields(raw: Record<string, unknown>): { fields: CardFields; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];

  const str = (field: Exclude<KnownField, 'labels' | 'order'>): string | null => {
    const v = raw[field];
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v;
    problems.push({ field, message: `Expected a string or null, got ${describe(v)}.` });
    return null;
  };

  let labels: string[] = [];
  const rawLabels = raw.labels;
  if (Array.isArray(rawLabels) && rawLabels.every((l) => typeof l === 'string')) {
    labels = rawLabels;
  } else if (rawLabels !== undefined && rawLabels !== null) {
    problems.push({ field: 'labels', message: `Expected a list of strings, got ${describe(rawLabels)}.` });
  }

  let order: string | null = null;
  const rawOrder = raw.order;
  if (typeof rawOrder === 'string') order = rawOrder;
  else if (typeof rawOrder === 'number' && Number.isInteger(rawOrder)) order = String(rawOrder);
  else if (rawOrder !== undefined && rawOrder !== null) {
    problems.push({ field: 'order', message: `Expected a string key or integer, got ${describe(rawOrder)}.` });
  }

  return {
    fields: {
      id: str('id'),
      status: str('status'),
      priority: str('priority'),
      assignee: str('assignee'),
      epic: str('epic'),
      dueDate: str('dueDate'),
      created: str('created'),
      modified: str('modified'),
      completedAt: str('completedAt'),
      labels,
      order,
      lane: str('lane'),
    },
    problems: problems.sort((a, b) => KNOWN_FIELDS.indexOf(a.field) - KNOWN_FIELDS.indexOf(b.field)),
  };
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'object' ? 'a map' : `${typeof v} ${JSON.stringify(v)}`;
}

function findTitle(body: string): string | null {
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^# (.*)$/.exec(line);
    if (heading) return heading[1]!.trim();
  }
  return null;
}
