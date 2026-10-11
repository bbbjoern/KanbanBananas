import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Facet, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { imageInsert } from './pasteImage.js';

/**
 * Entries in the board's editor: a list item is one unit, with its
 * description and screenshots indented under it. The text stays plain
 * markdown; this file only helps type it (a `/` menu, where pasted images go)
 * and offers "→ Card" on an entry of a log card.
 */

const ITEM = /^(\s*)([-*+]|\d+[.)]) /;
const ENTRY = /^[-*+] \[[ xX]\] /;

/**
 * The indent that keeps a new line inside the list item at `pos` (e.g. 2 for
 * `- [ ] text`), or null when `pos` isn't in a list item.
 */
export function listIndentAt(doc: string, pos: number): number | null {
  const lines = doc.split('\n');
  let n = doc.slice(0, pos).split('\n').length - 1;
  for (; n >= 0; n--) {
    const line = lines[n]!;
    const item = ITEM.exec(line);
    if (item) return item[0].length;
    if (!/^\s+\S/.test(line)) return null; // not indented: not part of an item
  }
  return null;
}

/**
 * Where a pasted image goes and what is inserted: under the list item the
 * cursor is in (indented, so it belongs to that entry); in a log card on an
 * empty line, as a new entry with the cursor where its text goes; else on a
 * line of its own.
 */
export function imagePlacement(doc: string, pos: number, link: string, log: boolean): { from: number; insert: string; cursor: number } {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = doc.indexOf('\n', pos) === -1 ? doc.length : doc.indexOf('\n', pos);
  const line = doc.slice(lineStart, lineEnd);
  const indent = line.trim() ? listIndentAt(doc, pos) : null;
  if (indent !== null) {
    const insert = `\n${' '.repeat(indent)}![](${link})`;
    return { from: lineEnd, insert, cursor: lineEnd + insert.length };
  }
  if (log && !line.trim()) {
    return { from: lineStart, insert: `- [ ] \n  ![](${link})`, cursor: lineStart + 6 };
  }
  const insert = imageInsert(doc, pos, link);
  return { from: pos, insert, cursor: pos + insert.length };
}

/** The top-level entry (`- [ ] …` plus its indented lines) at `pos`, as a range of `doc`. */
export function entryAt(doc: string, pos: number): { from: number; to: number; text: string } | null {
  const lines = doc.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  let n = doc.slice(0, pos).split('\n').length - 1;
  while (n > 0 && /^\s+\S/.test(lines[n]!)) n--;
  if (!ENTRY.test(lines[n]!)) return null;
  let last = n;
  while (last + 1 < lines.length && /^\s+\S/.test(lines[last + 1]!)) last++;
  const from = starts[n]!;
  const to = starts[last]! + lines[last]!.length;
  return { from, to, text: doc.slice(from, to) };
}

/** A card made from an entry: title from its first line (`**Title**: text` or `Title: text`), the rest as body. */
export function cardFromEntry(entry: string): { title: string; body: string } {
  const [first = '', ...rest] = entry.split('\n');
  const line = first.replace(ENTRY, '').trim();
  let title = line;
  let text = '';
  const bold = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(line);
  const colon = /^([^:]{1,80}):\s+(.*)$/.exec(line);
  if (bold) [title, text] = [bold[1]!, bold[2]!];
  else if (colon) [title, text] = [colon[1]!, colon[2]!];
  else if (line.length > 80) [title, text] = [`${line.slice(0, 77).trimEnd()}…`, line];
  const more = rest.map((l) => l.replace(/^ {1,4}/, ''));
  const body = [text, ...more].join('\n').trim();
  return { title: title.trim() || 'Entry from a log', body };
}

/** The `/` menu at the start of a line: entries and sections, typed as plain markdown. */
function slashMenu(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /^(\s*)\/\w*$/.exec(before);
  if (!m) return null;
  const today = new Date().toISOString().slice(0, 10);
  const options = [
    { label: '/entry', detail: 'Entry: a checkbox item; paste a screenshot to add it under it', insert: '- [ ] ' },
    { label: '/dated', detail: 'Dated entry, for an informational log', insert: `- **${today}**: ` },
    { label: '/policy', detail: 'Policy: how people and agents should treat this card', insert: '## Policy\n\n' },
    { label: '/heading', detail: 'Section heading', insert: '## ' },
  ];
  return {
    from: line.from + m[1]!.length,
    filter: true,
    // In this order (the menu sorts by match, then by boost).
    options: options.map((o, i) => ({
      boost: options.length - i,
      label: o.label,
      detail: o.detail,
      apply: (view: EditorView, _c: unknown, from: number, to: number) =>
        view.dispatch({ changes: { from, to, insert: o.insert }, selection: { anchor: from + o.insert.length }, userEvent: 'input.complete' }),
    })),
  };
}

export const entryMenu = autocompletion({ override: [slashMenu], icons: false });

/** Set for log cards: "→ Card" on the entry the cursor is in calls it with that entry. */
export const promoteEntry = Facet.define<(entry: { from: number; to: number; text: string }) => void, ((entry: { from: number; to: number; text: string }) => void) | null>({
  combine: (v) => v[0] ?? null,
});

class PromoteWidget extends WidgetType {
  constructor(readonly from: number) {
    super();
  }

  override eq(other: PromoteWidget): boolean {
    return other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-entry-promote';
    button.textContent = '→ Card';
    button.title = 'Make this entry its own card (it stays here, ticked, with a pointer to the card)';
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const entry = entryAt(view.state.doc.toString(), this.from);
      const promote = view.state.facet(promoteEntry);
      if (entry && promote) promote(entry);
    });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function promoteButton(state: EditorState): DecorationSet {
  if (!state.facet(promoteEntry)) return Decoration.none;
  const doc = state.doc.toString();
  const entry = entryAt(doc, state.selection.main.head);
  if (!entry || !/^[-*+] \[ \] /.test(entry.text)) return Decoration.none; // open entries only
  const end = state.doc.lineAt(entry.from).to;
  const decos: Range<Decoration>[] = [Decoration.widget({ widget: new PromoteWidget(entry.from), side: 1 }).range(end)];
  return Decoration.set(decos);
}

export const promoteEntryButton = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = promoteButton(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.startState.facet(promoteEntry) !== u.state.facet(promoteEntry)) {
        this.decorations = promoteButton(u.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
