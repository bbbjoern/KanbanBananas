import type { CardFields } from './parse.js';

/**
 * Board order: `order` key, then `created`, then `id`. Keys compare by code
 * unit, which matches the base-62 digit order of `fractional-indexing`.
 * Missing values sort last.
 */
export function compareCards(a: CardFields, b: CardFields): number {
  return (
    compareNullable(a.order, b.order) ||
    compareNullable(a.created, b.created) ||
    compareNullable(a.id, b.id)
  );
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
