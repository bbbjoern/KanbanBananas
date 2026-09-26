import { parseCard, serializeCard } from './parse.js';
import { patchFields, PatchError, type FieldValue } from './patch.js';

/** A change to one card: frontmatter fields, plus optionally its body. */
export interface CardEdit {
  fields: Readonly<Record<string, FieldValue>>;
  /** Text to add at the end of the body, after a blank line. */
  append?: string;
  /** New body (everything after the frontmatter), replacing the old one. */
  body?: string;
}

/**
 * Apply an edit to a card's current text. Frontmatter goes through
 * patchFields (only the changed lines move); the body is either kept
 * byte-for-byte, extended at the end, or replaced as a whole.
 * Line endings in new body text follow the file's.
 */
export function applyCardEdit(text: string, edit: CardEdit): string {
  const patched = Object.keys(edit.fields).length > 0 ? patchFields(text, edit.fields) : text;
  if (edit.append === undefined && edit.body === undefined) return patched;

  const parsed = parseCard(patched);
  if (!parsed.ok) throw new PatchError(`Refusing to edit a file that doesn't parse: ${parsed.error.message}`);
  const { source } = parsed.card;
  let body = edit.body !== undefined ? withEol(edit.body, source.eol) : source.body;
  if (edit.append !== undefined) body = appendBlock(body, withEol(edit.append, source.eol), source.eol);

  const result = serializeCard({ ...parsed.card, source: { ...source, body } });
  const check = parseCard(result);
  if (!check.ok || JSON.stringify(check.card.fields) !== JSON.stringify(parsed.card.fields)) {
    throw new PatchError('Body edit changed the frontmatter.');
  }
  return result;
}

/** A `## heading` section, with an optional body, for `kanban note`. */
export function noteSection(heading: string, body?: string): string {
  const h = heading.replace(/\s+/g, ' ').trim();
  if (!h) throw new PatchError('A note needs a heading.');
  const text = body?.replace(/\s+$/, '');
  return text ? `## ${h}\n\n${text}\n` : `## ${h}\n`;
}

/** Add `block` after the body with one blank line between, whatever the body ends with. */
function appendBlock(body: string, block: string, eol: string): string {
  const trimmed = body.replace(/(\r?\n)+$/, '');
  return trimmed === '' ? block : trimmed + eol + eol + block;
}

function withEol(text: string, eol: string): string {
  return text.replace(/\r?\n/g, eol);
}

/**
 * Apply a planned edit to a card's current text, first checking the text is
 * still that card: it parses and its id is `id`. Nothing is guessed.
 */
export function editCard(text: string, id: string, edit: CardEdit): string {
  const parsed = parseCard(text);
  if (!parsed.ok) throw new PatchError(`The card no longer parses (${parsed.error.message}). Nothing was written.`);
  if (parsed.card.fields.id !== id) {
    throw new PatchError(`The file now holds card "${parsed.card.fields.id}", not "${id}". Nothing was written.`);
  }
  return applyCardEdit(text, edit);
}
