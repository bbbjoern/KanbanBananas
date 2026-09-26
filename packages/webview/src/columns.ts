/** Card ids per column, in board order. The webview's working copy while dragging. */
export type Columns = Record<string, string[]>;

export function findColumn(columns: Columns, id: string): string | undefined {
  return Object.keys(columns).find((status) => columns[status]!.includes(id));
}

/** Move a card to `index` in column `to` (index counted without the card itself). */
export function moveCard(columns: Columns, id: string, to: string, index: number): Columns {
  const next: Columns = {};
  for (const [status, ids] of Object.entries(columns)) next[status] = ids.filter((x) => x !== id);
  const target = next[to] ?? [];
  const clamped = Math.max(0, Math.min(index, target.length));
  next[to] = [...target.slice(0, clamped), id, ...target.slice(clamped)];
  return next;
}

/** The move intent that reproduces the card's position in `columns`, or null if it didn't move. */
export function moveIntent(
  before: Columns,
  after: Columns,
  id: string,
): { toStatus: string; beforeId: string | null } | null {
  const from = findColumn(before, id);
  const to = findColumn(after, id);
  if (!to) return null;
  if (from === to && before[from]!.join('\n') === after[to]!.join('\n')) return null;
  const ids = after[to]!;
  return { toStatus: to, beforeId: ids[ids.indexOf(id) + 1] ?? null };
}
