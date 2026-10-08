import { diffIndices } from 'node-diff3';

/** One replaced range of the old text, in characters: `[from, to)` becomes `insert`. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The changes from `a` to `b`, one per changed region, in order and not
 * overlapping. Lines are compared first; each changed run of lines is then
 * trimmed to the characters that differ. Separate regions stay separate, so
 * an editor can rebase unsaved typing over them without moving it.
 */
export function textChanges(a: string, b: string): TextChange[] {
  if (a === b) return [];
  // Every line keeps its "\n"; the extra "\n" at the end is a sentinel, so the last line has one too.
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const offsetsA = lineOffsets(linesA);
  const offsetsB = lineOffsets(linesB);
  const A = a + '\n';
  const B = b + '\n';
  const out: TextChange[] = [];
  for (const hunk of diffIndices(linesA, linesB)) {
    const [startA, lengthA] = hunk.buffer1;
    const [startB, lengthB] = hunk.buffer2;
    let from = offsetsA[startA]!;
    let to = offsetsA[startA + lengthA]!;
    let fromB = offsetsB[startB]!;
    let toB = offsetsB[startB + lengthB]!;
    while (from < to && fromB < toB && A[from] === B[fromB]) {
      from++;
      fromB++;
    }
    while (to > from && toB > fromB && A[to - 1] === B[toB - 1]) {
      to--;
      toB--;
    }
    let insert = B.slice(fromB, toB);
    // Still touching the sentinel: whole lines added or removed at the end. The same
    // change one character earlier stays inside `a` (the character before is a "\n" too).
    if (to > a.length) {
      insert = insert ? '\n' + insert.slice(0, -1) : '';
      from--;
      to--;
    }
    if (from !== to || insert) out.push({ from, to, insert });
  }
  return out;
}

/** Start offset of each line, plus one past the end (with every line counted with its "\n"). */
function lineOffsets(lines: string[]): number[] {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  return offsets;
}
