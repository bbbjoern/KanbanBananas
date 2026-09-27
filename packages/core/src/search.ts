import type { Board } from './board.js';

/**
 * Full-text search (spec §5): every word of the query must appear somewhere
 * in the card's id, title, body, assignee, labels or epic. Case-insensitive.
 * Returns matching card ids in board order.
 */
export function searchCards(board: Board, query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return board.cards.map((c) => c.card.fields.id!);
  return board.cards
    .filter((c) => {
      const f = c.card.fields;
      const haystack = [f.id, c.card.title, c.card.source.body, f.assignee, f.epic, ...f.labels].join('\n').toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .map((c) => c.card.fields.id!);
}

/** A card's labels with `from` renamed to `to`, or removed when `to` is null. Order kept, no duplicates. */
export function relabel(labels: readonly string[], from: string, to: string | null): string[] {
  const out: string[] = [];
  for (const l of labels) {
    const next = l === from ? to : l;
    if (next !== null && !out.includes(next)) out.push(next);
  }
  return out;
}

/** Every label on the board with how many cards carry it, most used first. */
export function labelCounts(board: Board): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of board.cards) for (const l of c.card.fields.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
