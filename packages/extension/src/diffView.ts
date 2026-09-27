import * as vscode from 'vscode';

/** Read-only documents holding two versions of a card body, for "show diff" on a conflict. */
const SCHEME = 'kanban-bananas-mine';
const contents = new Map<string, string>();
const changed = new vscode.EventEmitter<vscode.Uri>();

export function registerDiffProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? '',
  });
}

/** Open a read-only diff of two versions of a card's body: the card now (left) and the editor's (right). */
export async function showDiff(theirs: string, mine: string, name: string): Promise<void> {
  const stamp = String(Date.now());
  const left = vscode.Uri.from({ scheme: SCHEME, path: `/card/${name}`, query: stamp });
  const right = vscode.Uri.from({ scheme: SCHEME, path: `/yours/${name}`, query: stamp });
  contents.set(left.toString(), theirs);
  contents.set(right.toString(), mine);
  changed.fire(left);
  changed.fire(right);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${name}: card now ↔ your edits`);
}
