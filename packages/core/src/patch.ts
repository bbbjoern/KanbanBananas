import { isMap, isScalar, isSeq, parseDocument, Scalar, type Node } from 'yaml';
import { parseCard, serializeCard } from './parse.js';

export type FieldValue = string | null | string[];

export class PatchError extends Error {
  override name = 'PatchError';
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Set frontmatter fields by editing only their values in the source text.
 * Everything else (other lines, key order, quoting, comments, unknown keys,
 * the body) stays byte-for-byte identical. A key that doesn't exist yet is
 * added as a new line at the end of the frontmatter.
 *
 * Throws PatchError if the file doesn't parse, or if the result doesn't
 * re-parse to exactly the intended fields (spec §2.8).
 */
export function patchFields(text: string, changes: Readonly<Record<string, FieldValue>>): string {
  const before = parseCard(text);
  if (!before.ok) throw new PatchError(`Refusing to patch a file that doesn't parse: ${before.error.message}`);
  const { source } = before.card;
  const fm = source.frontmatter;

  // Parse again so node ranges are offsets into `fm`.
  const doc = parseDocument(fm);
  const map = doc.contents;
  if (!isMap(map)) throw new PatchError('Frontmatter is not a map.');

  const edits: Edit[] = [];
  let appended = '';
  for (const [key, value] of Object.entries(changes)) {
    const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key);
    if (!pair) {
      appended += `${key}: ${formatValue(value, null)}${source.eol}`;
      continue;
    }
    const keyNode = pair.key as Scalar;
    const valueNode = (pair.value ?? null) as Node | null;
    const formatted = formatValue(value, valueNode);
    const hasSource = valueNode?.range && valueNode.range[1] > valueNode.range[0];
    if (valueNode && hasSource && (isScalar(valueNode) || (isSeq(valueNode) && valueNode.flow))) {
      edits.push({ start: valueNode.range![0], end: valueNode.range![1], text: formatted });
    } else {
      // No value (`key:`) or a block collection: replace everything after the colon.
      const colon = fm.indexOf(':', keyNode.range![1]);
      let end = hasSource ? valueNode!.range![1] : colon + 1;
      while (end > colon + 1 && /\s/.test(fm[end - 1]!)) end--;
      edits.push({ start: colon + 1, end, text: ` ${formatted}` });
    }
  }

  let newFm = fm;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    newFm = newFm.slice(0, e.start) + e.text + newFm.slice(e.end);
  }
  newFm += appended;

  const result = serializeCard({ ...before.card, source: { ...source, frontmatter: newFm } });
  verify(text, result, changes);
  return result;
}

/** Re-parse the result and check it says exactly what was intended, and nothing else changed. */
function verify(original: string, result: string, changes: Readonly<Record<string, FieldValue>>): void {
  const before = parseCard(original);
  const after = parseCard(result);
  if (!before.ok || !after.ok) throw new PatchError('Patched file does not parse.');
  if (after.card.source.body !== before.card.source.body) throw new PatchError('Patch changed the body.');

  const oldData = before.card.doc.toJS() as Record<string, unknown>;
  const newData = after.card.doc.toJS() as Record<string, unknown>;
  const expected: Record<string, unknown> = { ...oldData, ...changes };
  const keys = new Set([...Object.keys(expected), ...Object.keys(newData)]);
  for (const key of keys) {
    if (JSON.stringify(newData[key]) !== JSON.stringify(expected[key])) {
      throw new PatchError(`Patched field "${key}" is ${JSON.stringify(newData[key])}, expected ${JSON.stringify(expected[key])}.`);
    }
  }
}

/** Format a value the way the old board wrote it, keeping an existing value's quote style where possible. */
export function formatValue(value: FieldValue, existing: Node | null): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => doubleQuoted(v)).join(', ')}]`;
  // Only a string value's quoting is a style choice; a null or number is written fresh.
  const style = isScalar(existing) && typeof existing.value === 'string' ? existing.type : undefined;
  if (style === Scalar.QUOTE_SINGLE && !/[\r\n]/.test(value)) return `'${value.replace(/'/g, "''")}'`;
  if (style === Scalar.PLAIN && isSafePlain(value)) return value;
  return doubleQuoted(value);
}

/** JSON string escapes are all valid YAML double-quoted escapes. */
function doubleQuoted(value: string): string {
  return JSON.stringify(value);
}

function isSafePlain(value: string): boolean {
  if (value === '' || /[\r\n]/.test(value) || value !== value.trim()) return false;
  const doc = parseDocument(`k: ${value}`);
  return doc.errors.length === 0 && (doc.toJS() as { k: unknown }).k === value;
}
