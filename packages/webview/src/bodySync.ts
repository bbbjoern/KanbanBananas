import { textChanges } from '@kanban-bananas/core';
import { ChangeSet, Text } from '@codemirror/state';

/**
 * Keeps the inline editor's text and the card file in step without ever
 * resetting the editor (spec §7). The editor is uncontrolled: outside changes
 * arrive as small ChangeSets rebased over the user's unsaved typing, so the
 * cursor, selection and undo history stay where they were.
 *
 *   synced   the body the host last confirmed
 *   local    the user's edits since then (synced → editor text)
 *   inFlight a save the host hasn't answered yet (at most one)
 */
export class BodySync {
  private synced: string;
  private local: ChangeSet;
  private inFlight: { sent: string; local: ChangeSet } | null = null;

  constructor(body: string) {
    this.synced = body;
    this.local = ChangeSet.empty(body.length);
  }

  get base(): string {
    return this.synced;
  }

  get dirty(): boolean {
    return !this.local.empty;
  }

  get saving(): boolean {
    return this.inFlight !== null;
  }

  /** The user changed the editor. */
  userEdit(changes: ChangeSet): void {
    this.local = this.local.compose(changes);
  }

  /** Start a save of the editor's text, if there's anything to save and none in flight. */
  startSave(doc: string): { base: string; body: string } | null {
    if (this.local.empty || this.inFlight) return null;
    this.inFlight = { sent: doc, local: this.local };
    return { base: this.synced, body: doc };
  }

  /**
   * The host wrote the save; `result` is the body now in the card (the sent
   * text merged with any outside changes). Returns the changes to apply to the
   * editor, which may hold more typing since the save started.
   */
  saved(result: string): ChangeSet | null {
    const flight = this.inFlight;
    if (!flight) return null;
    this.inFlight = null;
    // Typing since the save started, as changes from the sent text.
    const since = flight.local.invert(Text.of(this.synced.split('\n'))).compose(this.local);
    const outside = diffChange(flight.sent, result);
    this.synced = result;
    this.local = since.map(outside);
    const apply = outside.map(since);
    return apply.empty ? null : apply;
  }

  /** The save wasn't written (a conflict or an error). Keep the user's text as unsaved edits. */
  failed(): void {
    this.inFlight = null;
  }

  /**
   * Someone else changed the body. Returns the changes to apply to the editor,
   * rebased over the user's unsaved edits. While a save is in flight the host
   * merges instead, and sends the combined result with its answer.
   */
  external(body: string): ChangeSet | null {
    if (this.inFlight || body === this.synced) return null;
    const outside = diffChange(this.synced, body);
    this.synced = body;
    const apply = outside.map(this.local);
    this.local = this.local.map(outside, true);
    return apply.empty ? null : apply;
  }

  /** Conflict resolved by keeping the editor's text over `theirs`: it becomes the next save. */
  keepMine(theirs: string, doc: string): void {
    this.inFlight = null;
    this.synced = theirs;
    this.local = diffChange(theirs, doc);
  }

  /** Conflict resolved by taking `theirs`: returns the changes that turn the editor's text into it. */
  takeTheirs(theirs: string, doc: string): ChangeSet {
    this.inFlight = null;
    this.synced = theirs;
    this.local = ChangeSet.empty(theirs.length);
    return diffChange(doc, theirs);
  }
}

/**
 * The changes from `a` to `b` as a ChangeSet over `a`: one change per changed
 * region, so unsaved typing elsewhere keeps its place when rebased over them.
 * (One range from the first difference to the last would swallow that typing
 * and move it to the end of the range.)
 */
export function diffChange(a: string, b: string): ChangeSet {
  return ChangeSet.of(textChanges(a, b), a.length);
}
