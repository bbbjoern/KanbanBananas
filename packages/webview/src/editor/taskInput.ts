import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

/**
 * Markdown only makes `[ ]` a checkbox inside a list item (`- [ ] task`).
 * So typing `[ ]` or `[]` at the start of a line, followed by a space, turns
 * it into `- [ ] `, and `- []` into `- [ ] `. One undo puts back what was typed.
 */

/** What a line start becomes when a space is typed after it, or null to leave it. */
export function taskLineStart(before: string): string | null {
  const plain = /^(\s*)\[ ?\]$/.exec(before);
  if (plain) return `${plain[1]}- [ ] `;
  const listed = /^(\s*(?:[-*+]|\d+[.)])) \[\]$/.exec(before);
  if (listed) return `${listed[1]} [ ] `;
  return null;
}

export const taskInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const replacement = taskLineStart(line.text.slice(0, from - line.from));
  if (replacement === null) return false;
  // Not inside code, where brackets are just text.
  for (let node = syntaxTree(view.state).resolveInner(from, -1); ; node = node.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText)$/.test(node.name)) return false;
    if (!node.parent) break;
  }
  view.dispatch({
    changes: { from: line.from, to: from, insert: replacement },
    selection: { anchor: line.from + replacement.length },
    userEvent: 'input.type',
  });
  return true;
});
