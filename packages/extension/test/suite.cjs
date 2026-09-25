// Runs inside the VS Code extension host.
const assert = require('node:assert/strict');
const vscode = require('vscode');

/** Poll until `fn` returns something truthy, or give up after `ms` and return it anyway. */
async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  let value = fn();
  while (!value && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    value = fn();
  }
  return value;
}

const tests = {
  async 'loads every fixture card, read-only'() {
    const ext = vscode.extensions.getExtension('bbbjoern.kanban-bananas');
    const api = await ext.activate();
    await api.ready;
    const state = api.state();
    assert.equal(state.type, 'state', JSON.stringify(state));
    assert.equal(state.board.cards.length, 5);
    assert.deepEqual(state.board.broken, []);
    assert.deepEqual(
      state.settings.columns.map((c) => c.id),
      ['backlog', 'todo', 'in-progress', 'review', 'done'],
    );
  },

  async 'opens the board panel'() {
    await vscode.commands.executeCommand('kanbanBananas.openBoard');
    const findBoard = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('kanbanBananas.board'));
    const board = await waitFor(findBoard);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(board, `no board tab among: ${tabs.map((t) => t.label).join(', ')}`);
    assert.equal(board.label, 'Kanban');
  },

  async 'picks up a new card from disk'() {
    const api = vscode.extensions.getExtension('bbbjoern.kanban-bananas').exports;
    const [folder] = vscode.workspace.workspaceFolders;
    const uri = vscode.Uri.joinPath(folder.uri, '.devtool/features/new-card-2026-09-25.md');
    const text = '---\nid: "new-card-2026-09-25"\nstatus: "todo"\norder: "a5"\n---\n# New card\n';
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    const found = await waitFor(() => api.state().board.cards.length === 6);
    assert.ok(found, 'watcher did not pick up the new card within 5s');
    assert.ok(api.state().board.cards.some((c) => c.title === 'New card'));
  },
};

exports.run = async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e.message}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
};
