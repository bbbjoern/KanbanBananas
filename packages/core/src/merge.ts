import { diff3Merge } from 'node-diff3';

/**
 * Line-based three-way merge: combine `mine` and `theirs`, both edited from
 * `base`. Returns null when they changed the same lines differently.
 */
export function mergeText(base: string, mine: string, theirs: string): string | null {
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base) return mine;
  const regions = diff3Merge(mine.split('\n'), base.split('\n'), theirs.split('\n'));
  if (regions.some((r) => r.conflict)) return null;
  return regions.flatMap((r) => r.ok ?? []).join('\n');
}
