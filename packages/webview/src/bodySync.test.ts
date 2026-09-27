import { EditorSelection, EditorState, type ChangeSpec } from '@codemirror/state';
import { mergeText } from '@kanban-bananas/core';
import { describe, expect, it } from 'vitest';
import { BodySync } from './bodySync.js';

/** A stand-in for the editor: CodeMirror state plus a BodySync, with a cursor to watch. */
class Editor {
  state: EditorState;
  sync: BodySync;

  constructor(body: string, cursor: number) {
    this.state = EditorState.create({ doc: body, selection: EditorSelection.cursor(cursor) });
    this.sync = new BodySync(body);
  }

  get text() {
    return this.state.doc.toString();
  }

  get cursor() {
    return this.state.selection.main.head;
  }

  type(insert: string) {
    const tr = this.state.update({ changes: { from: this.cursor, insert } as ChangeSpec, selection: { anchor: this.cursor + insert.length } });
    this.sync.userEdit(tr.changes);
    this.state = tr.state;
  }

  apply(changes: ReturnType<BodySync['external']>) {
    if (changes) this.state = this.state.update({ changes }).state;
  }

  /** Text around the cursor, to check it stays on the same words. */
  around(n = 6) {
    return this.text.slice(this.cursor - n, this.cursor) + '|' + this.text.slice(this.cursor, this.cursor + n);
  }
}

/** What the host does with a save: merge against the current body (the real code is core's applyCardEdit). */
function hostSave(current: string, save: { base: string; body: string }): string {
  const merged = mergeText(save.base, save.body, current);
  if (merged === null) throw new Error('conflict');
  return merged;
}

const BODY = '# Title\n\nFirst paragraph here.\n\nSecond paragraph.\n';

describe('BodySync', () => {
  it('an outside change above the cursor leaves the cursor on the same text', () => {
    const ed = new Editor(BODY, BODY.indexOf('paragraph here') + 'paragraph'.length);
    ed.type(' typed');
    const before = ed.around();
    ed.apply(ed.sync.external(BODY.replace('# Title', '# A much longer title')));
    expect(ed.around()).toBe(before);
    expect(ed.text).toBe('# A much longer title\n\nFirst paragraph typed here.\n\nSecond paragraph.\n');
  });

  it('an agent note appended while typing keeps both, cursor unmoved', () => {
    const ed = new Editor(BODY, BODY.indexOf('Second'));
    ed.type('New ');
    const before = ed.around();
    const withNote = BODY + '\n## Done — agent\n\nNote.\n';
    ed.apply(ed.sync.external(withNote));
    expect(ed.around()).toBe(before);
    expect(ed.text).toBe('# Title\n\nFirst paragraph here.\n\nNew Second paragraph.\n\n## Done — agent\n\nNote.\n');
    // And the next save sends exactly that, based on the note version.
    const save = ed.sync.startSave(ed.text)!;
    expect(save.base).toBe(withNote);
  });

  it('typing during a save, while the host merged in an outside change', () => {
    const ed = new Editor(BODY, BODY.indexOf('here'));
    ed.type('A');
    const save = ed.sync.startSave(ed.text)!;
    ed.type('B'); // still typing while the save is in flight
    const onDisk = BODY + '\nAgent line.\n'; // someone appended meanwhile
    const result = hostSave(onDisk, save);
    const before = ed.around();
    ed.apply(ed.sync.saved(result));
    expect(ed.around()).toBe(before);
    expect(ed.text).toBe('# Title\n\nFirst paragraph ABhere.\n\nSecond paragraph.\n\nAgent line.\n');
    // The next save carries only the typing after the first one.
    const next = ed.sync.startSave(ed.text)!;
    expect(next.base).toBe(result);
    expect(next.body).toBe(ed.text);
  });

  it('ignores outside changes while a save is in flight (the host merges them)', () => {
    const ed = new Editor(BODY, 0);
    ed.type('x');
    ed.sync.startSave(ed.text);
    expect(ed.sync.external(BODY + 'later\n')).toBeNull();
  });

  it('a save with nothing new does nothing', () => {
    const ed = new Editor(BODY, 0);
    expect(ed.sync.startSave(ed.text)).toBeNull();
  });

  it('many interleavings end in the same text on both sides', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let rnd = seed;
      const next = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
      let disk = BODY;
      const ed = new Editor(BODY, Math.floor(next() * BODY.length));
      let pending: { base: string; body: string } | null = null;
      for (let step = 0; step < 12; step++) {
        const r = next();
        if (r < 0.4) ed.type(String.fromCharCode(97 + Math.floor(next() * 26)));
        else if (r < 0.55) {
          // Someone appends a line on disk; the host pushes it unless a save is in flight.
          disk += `ext${step}\n`;
          if (!ed.sync.saving) ed.apply(ed.sync.external(disk));
        } else if (r < 0.75 && !pending) {
          pending = ed.sync.startSave(ed.text);
        } else if (pending) {
          disk = hostSave(disk, pending);
          ed.apply(ed.sync.saved(disk));
          pending = null;
        }
      }
      if (pending) {
        disk = hostSave(disk, pending);
        ed.apply(ed.sync.saved(disk));
      }
      ed.apply(ed.sync.external(disk));
      const last = ed.sync.startSave(ed.text);
      if (last) disk = hostSave(disk, last);
      if (last) ed.apply(ed.sync.saved(disk));
      expect(ed.text, `seed ${seed}`).toBe(disk);
    }
  });

  it('conflict: keep mine makes the editor text the next save, based on theirs', () => {
    const ed = new Editor(BODY, 0);
    ed.type('mine ');
    const save = ed.sync.startSave(ed.text)!;
    ed.sync.failed();
    const theirs = 'theirs ' + BODY;
    ed.sync.keepMine(theirs, ed.text);
    const next = ed.sync.startSave(ed.text)!;
    expect(next).toEqual({ base: theirs, body: save.body });
  });

  it('conflict: take theirs replaces the editor text', () => {
    const ed = new Editor(BODY, 0);
    ed.type('mine ');
    ed.sync.startSave(ed.text);
    ed.sync.failed();
    ed.apply(ed.sync.takeTheirs('theirs\n', ed.text));
    expect(ed.text).toBe('theirs\n');
    expect(ed.sync.dirty).toBe(false);
  });
});
