// Runs inside the VS Code extension host, against a copy of core's valid fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');

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

  async 'split view: opening a card in the board renders without errors'() {
    const controller = api().controller;
    const id = cardIn('add-login-page-2026-09-01') ? 'add-login-page-2026-09-01' : api().state().board.cards[0].fields.id;
    await vscode.commands.executeCommand('kanbanBananas.card.showOnBoard', { cardId: id });
    const shown = await waitFor(() => controller.shownInEditor.includes(id) || controller.clientErrors.length > 0, 10000);
    assert.deepEqual(controller.clientErrors, [], 'webview errors');
    assert.ok(shown && controller.shownInEditor.includes(id), 'split view never rendered the card');
    // Give the editor a moment to load the body, then check again.
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(controller.clientErrors, [], 'webview errors after loading the body');
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
    const a = (await store().create({ title: 'Fresh idea', status: 'todo' })).path;
    const b = (await store().create({ title: 'Fresh idea', status: 'todo' })).path;
    assert.notEqual(a, b);
    assert.match(b, /-2\.md$/);
    const text = disk(a);
    assert.match(text, /^---\nid: "fresh-idea-\d{4}-\d{2}-\d{2}"\nstatus: "todo"\npriority: "medium"\nassignee: null\n/);
    assert.ok(text.endsWith('---\n# Fresh idea\n'));
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

  async 'CLI: the running extension records its socket'() {
    const record = JSON.parse(fs.readFileSync(path.join(features(), '../.kanban.sock'), 'utf8'));
    assert.ok(fs.existsSync(record.socket), 'socket missing');
    assert.equal(record.pid, process.pid);
  },

  async 'CLI: a note on a card open with unsaved edits goes into the buffer, not over it'() {
    const id = 'add-login-page-2026-09-01';
    const rel = cardIn(id).path;
    const onDisk = disk(rel);
    const doc = await vscode.workspace.openTextDocument(uri(rel));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(doc.positionAt(doc.getText().length), '\nUSER TYPING'));

    const out = await kanban(['note', id, '--heading', 'Done — from an agent', '--body', '-', '--json'], 'Agent text.\n');
    const result = JSON.parse(out);
    assert.equal(result.handledBy, 'vscode');
    assert.equal(result.route, 'editor-unsaved');
    assert.equal(result.unsaved, true);

    const text = doc.getText();
    assert.ok(text.includes('USER TYPING'), 'user edit lost');
    assert.ok(text.includes('## Done — from an agent\n\nAgent text.'), 'note missing from buffer');
    assert.equal(disk(rel), onDisk, 'disk changed before save');
    await doc.save();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'CLI: move through the extension renames into done/'() {
    const out = JSON.parse(await kanban(['move', 'add-login-page-2026-09-01', 'done', '--json']));
    assert.equal(out.handledBy, 'vscode');
    // The card may still be loaded (clean) in VS Code from the previous test; either way it's saved.
    assert.ok(['disk', 'editor-saved'].includes(out.route), out.route);
    assert.ok(out.path.endsWith('done/add-login-page-2026-09-01.md'));
    assert.match(disk('done/add-login-page-2026-09-01.md'), /status: "done"/);
  },

  async 'CLI: edit with a stale mtime is refused through the extension too'() {
    const shown = JSON.parse(await kanban(['show', 'numeric-order-2026-09-05', '--json']));
    const before = disk('numeric-order-2026-09-05.md');
    const r = await kanbanResult(['edit', shown.id, '--body', '# X', '--expect-mtime', String(shown.mtimeMs - 1000)]);
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /conflict/);
    assert.equal(disk('numeric-order-2026-09-05.md'), before);
  },

  async 'installs the agent skill, and its launcher runs the CLI'() {
    await vscode.commands.executeCommand('kanbanBananas.installSkill');
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const dir = path.join(root, '.claude/skills/kanban');
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.ok(!skill.includes('{{'), 'placeholders left in SKILL.md');
    assert.ok(skill.includes('.claude/skills/kanban/scripts/kanban find'), 'command path not filled in');
    assert.match(skill, /^---\nname: kanban\n/);
    const version = vscode.extensions.getExtension(EXT_ID).packageJSON.version;
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), version);
    assert.ok(fs.statSync(path.join(dir, 'scripts/kanban')).mode & 0o100, 'launcher not executable');
    const out = execFileSync(path.join(dir, 'scripts/kanban'), ['check'], { cwd: root, encoding: 'utf8' });
    assert.match(out, /cards OK, 0 error/);
  },

  async 'the skill follows the agentsMayMoveCards setting, and the CLI enforces it'() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const dir = path.join(root, '.claude/skills/kanban');
    const config = vscode.workspace.getConfiguration('kanbanBananas');

    let skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('Never move a card to `done`'), 'default policy text missing');
    assert.ok(!skill.includes('{{'), 'placeholders left');

    await config.update('agentsMayMoveCards', 'never', vscode.ConfigurationTarget.Workspace);
    const updated = await waitFor(() => fs.readFileSync(path.join(dir, 'policy.json'), 'utf8').includes('"never"'));
    assert.ok(updated, 'policy.json not rewritten');
    skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes("Don't move cards between columns"), 'SKILL.md not rewritten for "never"');
    assert.ok(!skill.includes('move <id> in-progress'), 'still tells agents to move cards');

    const launcher = path.join(dir, 'scripts/kanban');
    const r = await new Promise((resolve) => {
      const child = require('node:child_process').spawn(launcher, ['move', 'numeric-order-2026-09-05', 'review'], { cwd: root });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
    });
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /moves cards between columns themselves/);

    await config.update('agentsMayMoveCards', undefined, vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => fs.readFileSync(path.join(dir, 'policy.json'), 'utf8').includes('"notToDone"')));
  },

  async 'native editor: cursor stays put while the board, an agent and a save change the card'() {
    const id = 'crlf-with-bom-2026-09-04';
    const rel = cardIn(id).path;
    const doc = await vscode.workspace.openTextDocument(uri(rel));
    const editor = await vscode.window.showTextDocument(doc);
    // Put the cursor in the middle of the title line and type.
    const at = doc.getText().indexOf('with BOM');
    editor.selection = new vscode.Selection(doc.positionAt(at), doc.positionAt(at));
    await vscode.commands.executeCommand('type', { text: 'typed ' });
    const around = () => {
      const off = doc.offsetAt(editor.selection.active);
      const t = doc.getText();
      return t.slice(off - 12, off) + '|' + t.slice(off, off + 8);
    };
    const expected = around();
    assert.ok(expected.endsWith('CRLF typed |with BOM'), `after typing: ${JSON.stringify(expected)}`);

    await store().setFields({ id, changes: { priority: 'low', labels: ['a', 'b', 'c'] } });
    assert.equal(around(), expected, `moved after a board field edit: ${JSON.stringify(around())}`);
    await kanban(['note', id, '--heading', 'Agent note', '--body', 'From the CLI.']);
    assert.equal(around(), expected, `moved after an agent note: ${JSON.stringify(around())}`);
    await store().move({ id, toStatus: 'in-progress', beforeId: null });
    assert.equal(around(), expected, `moved after a board move: ${JSON.stringify(around())}`);
    await doc.save();
    assert.equal(around(), expected, `moved after saving: ${JSON.stringify(around())}`);

    // Keystrokes after all that still land where the cursor is.
    await vscode.commands.executeCommand('type', { text: 'more ' });
    assert.ok(doc.getText().includes('CRLF typed more with BOM'), 'typing went elsewhere');
    assert.ok(doc.getText().includes('## Agent note'), 'agent note missing');
    await doc.save();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'native editor: the CodeLens header is one fixed row of card fields'() {
    const id = 'crlf-with-bom-2026-09-04';
    const target = uri(cardIn(id).path);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', target);
    const titles = lenses.map((l) => l.command?.title ?? '');
    assert.equal(titles.length, 7, titles.join(' | '));
    assert.ok(lenses.every((l) => l.range.start.line === 0), 'lenses not all on the first line');
    assert.ok(titles.includes('Priority: Low'), titles.join(' | '));
    assert.ok(titles.includes('Labels: a, b, c'), titles.join(' | '));
    assert.ok(titles.includes('Due: none'));
    // Not on files outside the board.
    const other = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'README.md'));
    fs.writeFileSync(other.fsPath, '# Not a card\n');
    await vscode.workspace.openTextDocument(other);
    assert.equal((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', other)).length, 0);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  },

  async 'inline editor saves merge with outside changes, and report real conflicts'() {
    const id = 'numeric-order-2026-09-05';
    const controller = api().controller;
    const base = controller.cardBody(id).body;
    await kanban(['note', id, '--heading', 'Agent was here']);
    // Save based on the version before the note: merged, nothing lost.
    const merged = await controller.saveBody({ id, base, body: base.replace('# Numeric order', '# Numeric order, edited') });
    assert.ok(merged.includes('# Numeric order, edited'), 'edit lost');
    assert.ok(merged.includes('## Agent was here'), 'agent note lost');
    // Two different edits to the same line: refused, file unchanged.
    const before = disk(cardIn(id).path);
    await assert.rejects(
      controller.saveBody({ id, base: merged, body: merged.replace('edited', 'mine') }).then(() =>
        controller.saveBody({ id, base: merged, body: merged.replace('edited', 'theirs') }),
      ),
      (e) => e.name === 'BodyConflictError',
    );
    assert.ok(disk(cardIn(id).path).includes('Numeric order, mine'), disk(cardIn(id).path));
    assert.notEqual(disk(cardIn(id).path), before);
  },
};

/**
 * Run the bundled CLI from the workspace root with a real Node, like an agent would.
 * Asynchronously: the extension host has to keep serving the socket while the CLI waits.
 */
function kanbanResult(args, stdin) {
  const { spawn } = require('node:child_process');
  const cli = path.join(vscode.extensions.getExtension(EXT_ID).extensionPath, 'dist/skill/kanban.mjs');
  return new Promise((resolve) => {
    const child = spawn('node', [cli, ...args], { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(stdin ?? '');
  });
}

async function kanban(args, stdin) {
  const r = await kanbanResult(args, stdin);
  if (r.code !== 0) throw new Error(`kanban ${args[0]} exited ${r.code}: ${r.err}`);
  return r.out;
}

exports.run = async function run() {
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${String(e.message).split('\n').join('\n    ')}\n    ${e.stack?.split('\n').find((l) => l.includes('suite.cjs')) ?? ''}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed`);
};
