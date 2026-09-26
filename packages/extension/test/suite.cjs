// Runs inside the VS Code extension host, against a copy of core's valid fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'hypertxt.kanban-bananas';
const api = () => vscode.extensions.getExtension(EXT_ID).exports;
const store = () => api().controller.cardStore;
const features = () => path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.devtool/features');
const disk = (rel) => fs.readFileSync(path.join(features(), rel), 'utf8');
const uri = (rel) => vscode.Uri.file(path.join(features(), rel));
const cardIn = (id) => api().state().board.cards.find((c) => c.fields.id === id);

/** Poll until `fn` returns something truthy, or give up after `ms` and return it anyway. */
async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  let value = fn();
  while (!value && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    value = fn();
  }
  return value;
}

/** Lines that differ between two texts with the same number of lines. */
function changedLines(a, b) {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  assert.equal(lb.length, la.length, 'line count changed');
  return la.flatMap((line, i) => (line === lb[i] ? [] : [[line, lb[i]]]));
}

const tests = {
  async 'loads every fixture card'() {
    await vscode.extensions.getExtension(EXT_ID).activate();
    await api().ready;
    const state = api().state();
    assert.equal(state.type, 'state', JSON.stringify(state));
    assert.equal(state.board.cards.length, 5);
    assert.deepEqual(state.board.broken, []);
  },

  async 'opens the board panel'() {
    await vscode.commands.executeCommand('kanbanBananas.openBoard');
    const board = await waitFor(() =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('kanbanBananas.board')),
    );
    assert.ok(board, 'no board tab');
  },

  async 'picks up a new card written by someone else'() {
    const text = '---\nid: "outside-2026-09-25"\nstatus: "todo"\norder: "a5"\n---\n# Outside';
    fs.writeFileSync(path.join(features(), 'outside-2026-09-25.md'), text);
    assert.ok(await waitFor(() => cardIn('outside-2026-09-25')), 'watcher did not pick up the new card');
  },

  async 'closed card: a field edit patches exactly one line on disk'() {
    const before = disk('title-only-2026-09-03.md');
    await store().setFields({ id: 'title-only-2026-09-03', changes: { priority: 'high' } });
    const after = disk('title-only-2026-09-03.md');
    const changed = changedLines(before, after);
    assert.deepEqual(changed.map(([, n]) => n.split(':')[0]).sort(), ['modified', 'priority']);
    assert.ok(after.endsWith('# Title only'), 'body changed');
    assert.equal(cardIn('title-only-2026-09-03').fields.priority, 'high');
  },

  async 'closed card with BOM and CRLF keeps both'() {
    await store().setFields({ id: 'crlf-with-bom-2026-09-04', changes: { labels: ['bug', 'ui'] } });
    const bytes = fs.readFileSync(path.join(features(), 'crlf-with-bom-2026-09-04.md'));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    assert.ok(text.includes('labels: ["bug", "ui"]\r\n'));
    assert.ok(!/[^\r]\n/.test(text), 'a bare LF crept in');
  },

  async 'open card with unsaved edits: move patches the buffer, keeps the edits and undo, disk untouched'() {
    const rel = 'add-login-page-2026-09-01.md';
    const onDisk = disk(rel);
    const doc = await vscode.workspace.openTextDocument(uri(rel));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(doc.positionAt(doc.getText().length), '\nUNSAVED BODY EDIT\n'));
    assert.ok(doc.isDirty);

    await store().move({ id: 'add-login-page-2026-09-01', toStatus: 'review', beforeId: null });

    assert.ok(doc.getText().includes('status: "review"'), 'buffer not patched');
    assert.ok(doc.getText().includes('UNSAVED BODY EDIT'), 'unsaved edit lost');
    assert.ok(doc.isDirty, 'buffer was saved');
    assert.equal(disk(rel), onDisk, 'file on disk changed before save');
    assert.equal((await waitFor(() => cardIn('add-login-page-2026-09-01')?.fields.status === 'review' && 1)), 1);

    await vscode.commands.executeCommand('undo');
    assert.ok(doc.getText().includes('status: "todo"'), 'undo did not revert the board change');
    assert.ok(doc.getText().includes('UNSAVED BODY EDIT'), 'undo removed the user edit too');
    await vscode.commands.executeCommand('redo');
    await doc.save();
    assert.ok(disk(rel).includes('status: "review"') && disk(rel).includes('UNSAVED BODY EDIT'));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },

  async 'open card with no unsaved edits: patch then save'() {
    const rel = 'numeric-order-2026-09-05.md';
    const doc = await vscode.workspace.openTextDocument(uri(rel));
    await vscode.window.showTextDocument(doc);
    await store().setFields({ id: 'numeric-order-2026-09-05', changes: { epic: 'Launch' } });
    assert.ok(!doc.isDirty, 'left unsaved');
    assert.ok(disk(rel).includes('epic: "Launch"'));
    assert.ok(disk(rel).includes('# a comment the board must keep'));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },

  async 'move to done renames into done/ and sets completedAt; moving back clears it'() {
    await store().move({ id: 'title-only-2026-09-03', toStatus: 'done', beforeId: null });
    assert.ok(!fs.existsSync(path.join(features(), 'title-only-2026-09-03.md')));
    const moved = disk('done/title-only-2026-09-03.md');
    assert.match(moved, /status: "done"/);
    assert.match(moved, /completedAt: "\d{4}-/);

    await store().move({ id: 'title-only-2026-09-03', toStatus: 'backlog', beforeId: null });
    assert.match(disk('title-only-2026-09-03.md'), /completedAt: null/);
    assert.ok(!fs.existsSync(path.join(features(), 'done/title-only-2026-09-03.md')));
  },

  async 'move to done with unsaved edits carries the buffer along without saving it'() {
    const rel = 'outside-2026-09-25.md';
    const onDisk = disk(rel);
    const doc = await vscode.workspace.openTextDocument(uri(rel));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(doc.positionAt(doc.getText().length), '\nDRAFT'));
    await store().move({ id: 'outside-2026-09-25', toStatus: 'done', beforeId: null });

    const movedDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri('done/' + rel).fsPath);
    assert.ok(movedDoc, 'no buffer at the new path');
    assert.ok(movedDoc.getText().includes('DRAFT'), 'unsaved edit lost in the move');
    assert.ok(movedDoc.getText().includes('status: "done"'));
    assert.ok(!fs.existsSync(path.join(features(), rel)), 'old file still there');
    assert.ok(!disk('done/' + rel).includes('DRAFT'), 'unsaved edit was written to disk');
    await movedDoc.save();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'a duplicated id is refused rather than guessed'() {
    const clash = '---\nid: "shipped-feature-2026-08-20"\nstatus: "todo"\norder: "a9"\n---\n# Clash';
    fs.writeFileSync(path.join(features(), 'shipped-feature-2026-08-20.md'), clash);
    // Both files share an id now, so the board marks them broken; the store must refuse to guess.
    await waitFor(() => api().state().board.broken.length === 2);
    await assert.rejects(store().move({ id: 'shipped-feature-2026-08-20', toStatus: 'done', beforeId: null }), /broken/);
    fs.unlinkSync(path.join(features(), 'shipped-feature-2026-08-20.md'));
    await waitFor(() => api().state().board.broken.length === 0);
  },

  async 'a filename already taken in done/ gets a suffix, and the id follows'() {
    fs.writeFileSync(path.join(features(), 'zed-2026-01-01.md'), '---\nid: "zed-2026-01-01"\nstatus: "todo"\norder: "a8"\n---\n# Zed');
    // Some other file already has that name in done/ (broken: its id doesn't match).
    fs.writeFileSync(path.join(features(), 'done/zed-2026-01-01.md'), '---\nid: "C"\nstatus: "done"\n---\n# Other');
    await waitFor(() => cardIn('zed-2026-01-01'));
    await store().move({ id: 'zed-2026-01-01', toStatus: 'done', beforeId: null });
    assert.equal(disk('done/zed-2026-01-01.md'), '---\nid: "C"\nstatus: "done"\n---\n# Other', 'overwrote the other file');
    assert.match(disk('done/zed-2026-01-01-2.md'), /^---\nid: "zed-2026-01-01-2"\nstatus: "done"/);
    fs.unlinkSync(path.join(features(), 'done/zed-2026-01-01.md'));
  },

  async 'create writes a new card in the old format and never overwrites'() {
    const a = await store().create({ title: 'Fresh idea', status: 'todo' });
    const b = await store().create({ title: 'Fresh idea', status: 'todo' });
    assert.notEqual(a, b);
    assert.match(b, /-2\.md$/);
    const text = disk(a);
    assert.match(text, /^---\nid: "fresh-idea-\d{4}-\d{2}-\d{2}"\nstatus: "todo"\npriority: "medium"\nassignee: null\n/);
    assert.ok(text.endsWith('---\n# Fresh idea'));
  },

  async 'concurrent writers to one card: no update is lost'() {
    const id = 'crlf-with-bom-2026-09-04';
    await Promise.all([
      store().setFields({ id, changes: { priority: 'critical' } }),
      store().setFields({ id, changes: { assignee: 'sam' } }),
      store().move({ id, toStatus: 'todo', beforeId: null }),
      store().setFields({ id, changes: { labels: ['x'] } }),
    ]);
    const text = disk('crlf-with-bom-2026-09-04.md');
    for (const line of ['priority: "critical"', 'assignee: "sam"', 'status: "todo"', 'labels: ["x"]']) {
      assert.ok(text.includes(line + '\r\n'), `missing ${line}`);
    }
  },

  async 'refuses to write a card whose file no longer parses'() {
    const rel = 'numeric-order-2026-09-05.md';
    const good = disk(rel);
    fs.writeFileSync(path.join(features(), rel), '');
    await waitFor(() => api().state().board.broken.length === 1);
    await assert.rejects(store().setFields({ id: 'numeric-order-2026-09-05', changes: { priority: 'low' } }));
    assert.equal(disk(rel), '', 'wrote to a broken file');
    fs.writeFileSync(path.join(features(), rel), good);
  },
};

exports.run = async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e.stack?.split('\n').slice(0, 3).join('\n    ')}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
};
