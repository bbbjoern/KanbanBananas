import { syntaxTree } from '@codemirror/language';
import { Facet, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/**
 * Live preview (spec §7): the document stays plain markdown text; these
 * decorations only change how it looks. Markup is hidden except on lines
 * with the cursor, headings and emphasis are styled, and task checkboxes can
 * be clicked, which toggles `[ ]` ↔ `[x]` in the text. Nothing else is ever
 * written that the user didn't type.
 */

const hidden = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const markClass = (cls: string) => Decoration.mark({ class: cls });

const HEADINGS: Record<string, string> = {
  ATXHeading1: 'cm-lp-h1',
  ATXHeading2: 'cm-lp-h2',
  ATXHeading3: 'cm-lp-h3',
  ATXHeading4: 'cm-lp-h4',
  ATXHeading5: 'cm-lp-h4',
  ATXHeading6: 'cm-lp-h4',
};

const MARKS: Record<string, string> = {
  StrongEmphasis: 'cm-lp-strong',
  Emphasis: 'cm-lp-em',
  InlineCode: 'cm-lp-code',
  Strikethrough: 'cm-lp-strike',
  Link: 'cm-lp-link',
};

/** Where the page can load project files from (for `/…` image links); empty when unknown. */
export const assetBase = Facet.define<string, string>({ combine: (v) => v[0] ?? '' });

/** Resolve an image link to something the page can load, or null if it can't show it. */
export function imageSrc(url: string, base: string): string | null {
  if (/^(https?:|data:)/i.test(url)) return url;
  if (url.startsWith('/') && base) {
    const path = url.split('/').map((seg) => encodeURIComponent(safeDecode(seg))).join('/');
    return base.replace(/\/+$/, '') + path;
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-lp-image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.title = 'Click the line to edit the link';
    wrap.appendChild(img);
    return wrap;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-lp-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', this.checked ? 'Done task' : 'Open task');
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      // The marker is "[ ]" or "[x]"; change only the character inside.
      const inner = view.state.doc.sliceString(this.pos + 1, this.pos + 2);
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: inner === ' ' ? 'x' : ' ' } });
    });
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Line numbers that have a cursor or selection on them: markup stays visible there. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const decos: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        if (HEADINGS[name]) {
          decos.push(lineClass(HEADINGS[name]!).range(state.doc.lineAt(node.from).from));
        } else if (name === 'HeaderMark' && !isActive(node.from)) {
          // Hide "## " including the space after it.
          const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          decos.push(hidden.range(node.from, end));
        } else if (MARKS[name] && node.to > node.from) {
          decos.push(markClass(MARKS[name]!).range(node.from, node.to));
        } else if (
          (name === 'EmphasisMark' || name === 'StrikethroughMark' || (name === 'CodeMark' && node.node.parent?.name === 'InlineCode')) &&
          !isActive(node.from)
        ) {
          decos.push(hidden.range(node.from, node.to));
        } else if ((name === 'LinkMark' || name === 'URL') && node.node.parent?.name === 'Link' && !isActive(node.from)) {
          decos.push(hidden.range(node.from, node.to));
        } else if (name === 'Image' && !isActive(node.from) && state.doc.lineAt(node.from).number === state.doc.lineAt(node.to).number) {
          const url = node.node.getChild('URL');
          const src = url ? imageSrc(state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, ''), state.facet(assetBase)) : null;
          if (src) {
            const alt = /^!\[([^\]]*)\]/.exec(state.doc.sliceString(node.from, node.to))?.[1] ?? '';
            decos.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
            return false;
          }
        } else if (name === 'TaskMarker') {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
          decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
          if (checked) {
            const line = state.doc.lineAt(node.from);
            if (node.to < line.to) decos.push(markClass('cm-lp-done').range(node.to, line.to));
          }
        } else if (name === 'QuoteMark' && !isActive(node.from)) {
          const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          decos.push(hidden.range(node.from, end));
        } else if (name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            decos.push(lineClass('cm-lp-quote').range(line.from));
            pos = line.to + 1;
          }
        } else if (name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            decos.push(lineClass('cm-lp-codeblock').range(line.from));
            pos = line.to + 1;
          }
          return false;
        }
        return undefined;
      },
    });
  }
  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
