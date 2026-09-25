import { compareCards } from './order.js';
import { parseCard, type Card, type ParseError } from './parse.js';
import { validateCard, type CardLocation, type Issue, type ValidateOptions } from './validate.js';

export interface BoardFile {
  /** Path relative to the features directory, `/`-separated: `x.md` or `done/x.md`. */
  path: string;
  text: string;
}

export interface BoardCard extends CardLocation {
  path: string;
  card: Card;
  /** Warnings only; a card with an error is in `broken` instead. */
  issues: Issue[];
}

/** A file for the read-only Broken lane: it didn't parse, or failed validation. */
export interface BrokenFile extends CardLocation {
  path: string;
  parseError?: ParseError;
  card?: Card;
  issues: Issue[];
}

export interface Board {
  /** Valid cards, sorted in board order. */
  cards: BoardCard[];
  broken: BrokenFile[];
}

export function loadBoard(files: readonly BoardFile[], opts: ValidateOptions = {}): Board {
  const parsed: { path: string; at: CardLocation; card: Card; issues: Issue[] }[] = [];
  const broken: BrokenFile[] = [];

  for (const file of files) {
    const at = locate(file.path);
    const result = parseCard(file.text);
    if (!result.ok) {
      broken.push({ path: file.path, ...at, parseError: result.error, issues: [] });
      continue;
    }
    parsed.push({ path: file.path, at, card: result.card, issues: validateCard(result.card, at, opts) });
  }

  const byId = new Map<string, typeof parsed>();
  for (const p of parsed) {
    const id = p.card.fields.id;
    if (id === null) continue;
    byId.set(id, [...(byId.get(id) ?? []), p]);
  }
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const p of group) {
      const others = group.filter((o) => o !== p).map((o) => o.path);
      p.issues.push({
        code: 'duplicate-id',
        severity: 'error',
        field: 'id',
        message: `id "${id}" is also used by ${others.join(', ')}.`,
      });
    }
  }

  const cards: BoardCard[] = [];
  for (const p of parsed) {
    if (p.issues.some((i) => i.severity === 'error')) {
      broken.push({ path: p.path, ...p.at, card: p.card, issues: p.issues });
    } else {
      cards.push({ path: p.path, ...p.at, card: p.card, issues: p.issues });
    }
  }
  cards.sort((a, b) => compareCards(a.card.fields, b.card.fields));
  broken.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { cards, broken };
}

function locate(path: string): CardLocation {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', filename: path }
    : { dir: path.slice(0, slash), filename: path.slice(slash + 1) };
}
