import { autocompletion, completionStatus, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Facet, Prec, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { imageInsert } from './pasteImage.js';

/**
 * Entries of a log card in the board's editor: each top-level list item is one
 * unit, with its description and screenshots indented under it, and entries
 * are separated by a blank line. The text stays plain markdown; in log cards
 * this file helps type it (Enter stays in the entry, `/entry` starts the next,
 * pasted screenshots go into the entry), shows each entry as a block, and
 * offers "→ Card". Ordinary cards keep ordinary markdown lists.
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

/** Top-level entries of a log card, as 0-based line ranges: an item and the indented lines under it. */
export function entryBlocks(doc: string): { first: number; last: number }[] {
  const lines = doc.split('\n');
  const blocks: { first: number; last: number }[] = [];
  let fence: string | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null;
      continue;
    }
    if (fence !== null || !/^[-*+] /.test(line)) continue;
    let last = n;
    // Indented lines belong to it, also an indented empty one (just typed with Enter).
    while (last + 1 < lines.length && (/^\s+\S/.test(lines[last + 1]!) || /^ {2,}$/.test(lines[last + 1]!))) last++;
    blocks.push({ first: n, last });
    n = last;
  }
  return blocks;
}

/** The entry block that line `n` (0-based) is in, if any. */
function blockOf(doc: string, n: number): { first: number; last: number } | null {
  return entryBlocks(doc).find((b) => n >= b.first && n <= b.last) ?? null;
}

/**
 * Text that starts a new entry at the start of line `n`, with a blank line
 * before it and after it where needed: [text before the cursor, text after].
 */
function newEntryText(lines: string[], n: number, entry: string): [string, string] {
  const before = n > 0 && lines[n - 1]!.trim() ? '\n' : '';
  const after = n + 1 < lines.length && lines[n + 1]!.trim() ? '\n' : '';
  return [before + entry, after];
}

/**
 * Where a pasted image goes and what is inserted. In a log card: into the
 * entry the cursor is in (indented), or on an empty line outside entries as a
 * new entry, cursor where its text goes. Elsewhere: under the list item the
 * cursor is in, or on a line of its own.
 */
export function imagePlacement(doc: string, pos: number, link: string, log: boolean): { from: number; to?: number; insert: string; cursor: number } {
  const lines = doc.split('\n');
  const n = doc.slice(0, pos).split('\n').length - 1;
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1;
  const line = lines[n]!;
  const lineEnd = lineStart + line.length;
  const image = `![](${link})`;
  if (log) {
    if (blockOf(doc, n)) {
      // An empty line of the entry (just typed with Enter) becomes the image line.
      if (!line.trim()) return { from: lineStart, to: lineEnd, insert: `  ${image}`, cursor: lineStart + 2 + image.length };
      const insert = `\n  ${image}`;
      return { from: lineEnd, insert, cursor: lineEnd + insert.length };
    }
    if (!line.trim()) {
      const [head, tail] = newEntryText(lines, n, `- [ ] \n  ${image}`);
      return { from: lineStart, insert: head + tail, cursor: lineStart + head.indexOf('- [ ] ') + 6 };
    }
  }
  const indent = line.trim() ? listIndentAt(doc, pos) : null;
  if (indent !== null) {
    const insert = `\n${' '.repeat(indent)}${image}`;
    return { from: lineEnd, insert, cursor: lineEnd + insert.length };
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

/** True in a log card: entries get block display, Enter stays in an entry, `/entry` starts a new one. */
export const logCard = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

/** The `/` menu at the start of a line: entries and sections, typed as plain markdown. */
function slashMenu(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = /^(\s*)\/\w*$/.exec(before);
  if (!m) return null;
  const log = context.state.facet(logCard);
  const today = new Date().toISOString().slice(0, 10);
  const options = [
    { label: '/entry', detail: log ? 'New entry; Enter adds lines to it, a screenshot goes into it' : 'Checkbox item', insert: '- [ ] ', entry: true },
    { label: '/dated', detail: 'Dated entry, for an informational log', insert: `- **${today}**: `, entry: true },
    { label: '/policy', detail: 'Policy: how people and agents should treat this card', insert: '## Policy\n\n', entry: false },
    { label: '/heading', detail: 'Section heading', insert: '## ', entry: false },
  ];
  return {
    from: line.from + m[1]!.length,
    filter: true,
    // In this order (the menu sorts by match, then by boost).
    options: options.map((o, i) => ({
      boost: options.length - i,
      label: o.label,
      detail: o.detail,
      apply: (view: EditorView, _c: unknown, from: number, to: number) => {
        if (log && o.entry) {
          // A new entry of its own: at the start of the line, a blank line before and after it.
          const lines = view.state.doc.toString().split('\n');
          const [head, tail] = newEntryText(lines, line.number - 1, o.insert);
          view.dispatch({ changes: { from: line.from, to, insert: head + tail }, selection: { anchor: line.from + head.length }, userEvent: 'input.complete' });
        } else {
          view.dispatch({ changes: { from, to, insert: o.insert }, selection: { anchor: from + o.insert.length }, userEvent: 'input.complete' });
        }
      },
    })),
  };
}

export const entryMenu = autocompletion({ override: [slashMenu], icons: false });

/**
 * Enter in an entry of a log card: a new line in the same entry (indented).
 * Enter on an empty line of the entry leaves it: a blank line, then a plain
 * line. Highest precedence, since the markdown keymap handles Enter too.
 */
export const entryEnter = Prec.highest(
  keymap.of([
    {
      key: 'Enter',
      run: (view) => {
        const { state } = view;
        if (!state.facet(logCard) || completionStatus(state) === 'active') return false; // an open menu takes Enter
        const range = state.selection.main;
        const line = state.doc.lineAt(range.head);
        const block = blockOf(state.doc.toString(), line.number - 1);
        if (!block) return false;
        const marker = /^[-*+] (\[[ xX]\] )?/.exec(line.text)?.[0].length ?? 0;
        if (line.number - 1 === block.first && range.from < line.from + marker) return false; // before the checkbox: ordinary Enter
        if (line.number - 1 !== block.first && !line.text.trim()) {
          view.dispatch({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, scrollIntoView: true, userEvent: 'input' });
          return true;
        }
        const insert = '\n  ';
        view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, scrollIntoView: true, userEvent: 'input' });
        return true;
      },
    },
  ]),
);

/** Each entry of a log card as a block: a background over its lines, its first line bold as the title. */
function entryDecorations(state: EditorState): DecorationSet {
  if (!state.facet(logCard)) return Decoration.none;
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  for (const b of entryBlocks(doc.toString())) {
    const first = doc.line(b.first + 1);
    const done = /^[-*+] \[[xX]\] /.test(first.text);
    for (let n = b.first; n <= b.last; n++) {
      const cls = ['cm-entry', n === b.first ? 'cm-entry-first' : '', n === b.last ? 'cm-entry-last' : '', done ? 'cm-entry-done' : ''].filter(Boolean).join(' ');
      decos.push(Decoration.line({ class: cls }).range(doc.line(n + 1).from));
    }
    const marker = /^[-*+] (\[[ xX]\] )?/.exec(first.text)![0].length;
    if (first.length > marker) decos.push(Decoration.mark({ class: 'cm-entry-title' }).range(first.from + marker, first.to));
  }
  return Decoration.set(decos, true);
}

export const entryBlocksView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = entryDecorations(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.startState.facet(logCard) !== u.state.facet(logCard)) this.decorations = entryDecorations(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

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
