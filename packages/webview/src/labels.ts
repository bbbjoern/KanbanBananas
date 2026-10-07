/** Labels typed into a card: matched to the board's existing labels, so "UI" and "ui" don't both appear. */

const key = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The label to add for what was typed: an existing label's spelling when one
 * matches (ignoring case and extra spaces), else the typed text, tidied.
 * Null when it's empty or already on the card.
 */
export function labelToAdd(typed: string, current: readonly string[], known: readonly string[]): string | null {
  const k = key(typed);
  if (!k || current.some((c) => key(c) === k)) return null;
  return known.find((l) => key(l) === k) ?? typed.trim().replace(/\s+/g, ' ');
}

/** Add each label in turn, skipping duplicates. */
export function addLabels(typed: readonly string[], current: readonly string[], known: readonly string[]): string[] {
  const out = [...current];
  for (const t of typed) {
    const l = labelToAdd(t, out, known);
    if (l) out.push(l);
  }
  return out;
}

/** Existing labels matching what's typed, not already on the card: those starting with it first. */
export function suggestLabels(typed: string, current: readonly string[], known: readonly string[], max = 8): string[] {
  const k = key(typed);
  const on = new Set(current.map(key));
  const free = known.filter((l) => !on.has(key(l)));
  if (!k) return free.slice(0, max);
  const starts = free.filter((l) => key(l).startsWith(k));
  const contains = free.filter((l) => !key(l).startsWith(k) && key(l).includes(k));
  return [...starts, ...contains].slice(0, max);
}
