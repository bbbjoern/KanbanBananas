// Runs inside the VS Code extension host, against a copy of core's valid fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { execFileSync } = require('node:child_process');

const EXT_ID = 'hypertxtorg.kanban-bananas';
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

  async 'board writes answer with their error, so the board can say so'() {
    const controller = api().controller;
    assert.equal(await controller.setFields({ id: 'title-only-2026-09-03', changes: { priority: 'low' } }), null);
    const error = await controller.setFields({ id: 'no-such-card', changes: { priority: 'low' } });
    assert.equal(typeof error, 'string', 'a failed write reported success');
  },

  async 'a new heading in the board editor becomes the card title'() {
    const controller = api().controller;
    const id = 'title-only-2026-09-03';
    const base = controller.cardBody(id).body;
    await controller.saveBody({ id, base, body: base.replace(/^# .*$/m, '# A new headline') });
    assert.ok(await waitFor(() => cardIn(id)?.title === 'A new headline'), `title is ${cardIn(id)?.title}`);
    // Open in VS Code's editor too (buffer-aware writes), then change it again.
    await vscode.window.showTextDocument(uri(cardIn(id).path));
    const base2 = controller.cardBody(id).body;
    await controller.saveBody({ id, base: base2, body: base2.replace(/^# .*$/m, '# Another headline') });
    assert.ok(await waitFor(() => cardIn(id)?.title === 'Another headline'), `title is ${cardIn(id)?.title}`);
    const base3 = controller.cardBody(id).body;
    await controller.saveBody({ id, base: base3, body: base3.replace(/^# .*$/m, '# Title only') });
    await vscode.commands.executeCommand('workbench.action.files.save');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.ok(await waitFor(() => cardIn(id)?.title === 'Title only'));
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
    // Without node on the PATH, the launcher falls back to the runtime recorded at install time.
    const noNode = execFileSync(path.join(dir, 'scripts/kanban'), ['check'], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
    });
    assert.match(noNode, /cards OK, 0 error/);
    assert.ok(!fs.readFileSync(path.join(dir, 'scripts/kanban'), 'utf8').includes('vscode-server'), 'launcher still scans folders');
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
    await kanban(['note', id, '--heading', 'Agent was here', '--body', 'Agent text.']);
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

  async 'search finds cards by body text, and labels can be renamed and deleted across cards'() {
    const controller = api().controller;
    assert.deepEqual(controller.search('Windows line endings'), ['crlf-with-bom-2026-09-04']);
    assert.deepEqual(controller.search('no such words anywhere'), []);

    // Two cards share a label; rename it, merging into an existing one on one card.
    await store().setFields({ id: 'title-only-2026-09-03', changes: { labels: ['legacy', 'ui'] } });
    await store().setFields({ id: 'numeric-order-2026-09-05', changes: { labels: ['legacy'] } });
    const renamed = await controller.relabelAll('legacy', 'ui');
    assert.deepEqual(renamed, { changed: 2, failed: [] });
    assert.deepEqual(cardIn('title-only-2026-09-03').fields.labels, ['ui']);
    assert.deepEqual(cardIn('numeric-order-2026-09-05').fields.labels, ['ui']);
    assert.ok(!controller.labels().some((l) => l.label === 'legacy'));

    const deleted = await controller.relabelAll('ui', null);
    assert.ok(deleted.changed >= 2);
    assert.ok(!controller.labels().some((l) => l.label === 'ui'));
    assert.match(disk(cardIn('title-only-2026-09-03').path), /labels: \[\]/);
  },

  async 'archive takes a card off the board, restore brings it back, ids are not reused'() {
    const controller = api().controller;
    const id = 'title-only-2026-09-03';
    const status = cardIn(id).fields.status;
    await store().archive(id);
    assert.ok(!cardIn(id), 'still on the board');
    assert.ok(fs.existsSync(path.join(features(), 'archived', `${id}.md`)), 'not in archived/');
    assert.deepEqual((await controller.archivedCards()).map((c) => c.id), [id]);
    await store().restore(id);
    assert.equal(cardIn(id)?.fields.status, status);
    assert.deepEqual(await controller.archivedCards(), []);
  },

  async 'bulk: move a whole column, then archive it'() {
    const controller = api().controller;
    await store().create({ title: 'Bulk one', status: 'backlog' });
    await store().create({ title: 'Bulk two', status: 'backlog' });
    const backlog = controller.columnIds('backlog');
    const moved = await controller.moveAll('backlog', 'review');
    assert.deepEqual(moved.failed, []);
    assert.deepEqual(controller.columnIds('backlog'), []);
    const review = controller.columnIds('review');
    assert.deepEqual(review.filter((id) => backlog.includes(id)), backlog, 'order not kept');
    const archived = await controller.archiveAll('review');
    assert.deepEqual(archived.failed, []);
    assert.deepEqual(controller.columnIds('review'), []);
    assert.ok((await controller.archivedCards()).length >= backlog.length);
  },

  async 'lanes: set a lane on cards, rename it across cards, configure and delete it'() {
    const controller = api().controller;
    const [a, b] = api().state().board.cards.map((c) => c.fields.id);
    await kanban(['set', a, 'lane=Now']);
    await store().setFields({ id: b, changes: { lane: 'Now' } });
    assert.equal(cardIn(a).fields.lane, 'Now');
    await controller.updateLanes('lane', (l) => [...l, { name: 'Now' }, { name: 'Later' }]);
    await waitFor(() => controller.settingsNow.view.lanes.lane.length === 2);
    assert.deepEqual(controller.settingsNow.view.lanes.lane.map((l) => l.name), ['Now', 'Later']);
    const r = await controller.setFieldAll('lane', 'Now', 'Next');
    assert.deepEqual(r, { changed: 2, failed: [] });
    assert.equal(cardIn(b).fields.lane, 'Next');
    await controller.setFieldAll('lane', 'Next', null);
    assert.equal(cardIn(a).fields.lane, null);
    await controller.updateLanes('lane', () => []);
  },

  async 'rename card files to a new filename pattern; ids follow'() {
    const controller = api().controller;
    const config = vscode.workspace.getConfiguration('kanbanBananas');
    await config.update('filenamePattern', '{date}-{slug}', vscode.ConfigurationTarget.Workspace);
    await waitFor(() => controller.settingsNow.filenamePattern === '{date}-{slug}');
    const renames = controller.pendingRenames();
    assert.ok(renames.length > 0);
    const r = await controller.renameAll(renames);
    assert.deepEqual(r.failed, []);
    const state = api().state();
    assert.deepEqual(state.board.broken, []);
    assert.ok(state.board.cards.every((c) => /^\d{4}-\d{2}-\d{2}-/.test(c.filename)), state.board.cards.map((c) => c.filename).join(', '));
    assert.deepEqual(controller.pendingRenames(), []);
    await config.update('filenamePattern', undefined, vscode.ConfigurationTarget.Workspace);
  },

  async 'delete a card (to the trash)'() {
    const controller = api().controller;
    const created = await store().create({ title: 'Throwaway', status: 'todo' });
    const id = created.path.replace(/\.md$/, '');
    await controller.deleteCard(id, false);
    assert.ok(!cardIn(id));
    assert.ok(!fs.existsSync(path.join(features(), created.path)));
  },

  async 'skill auto-update: current, outdated, edited by hand, newer'() {
    const dir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.claude/skills/kanban');
    await vscode.commands.executeCommand('kanbanBananas.installSkill');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.deepEqual(await api().skillState(), { kind: 'current' });

    // An older install, untouched since: VERSION and manifest agree on an older version.
    const manifestPath = path.join(dir, '.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sha = (t) => require('node:crypto').createHash('sha256').update(t).digest('hex');
    fs.writeFileSync(path.join(dir, 'VERSION'), '0.1.0\n');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.1.0', files: { ...manifest.files, VERSION: sha('0.1.0\n') } }));
    assert.equal((await api().skillState()).kind, 'outdated');

    // Someone edited SKILL.md by hand.
    fs.appendFileSync(path.join(dir, 'SKILL.md'), '\nMy own note.\n');
    assert.equal((await api().skillState()).kind, 'edited');

    // A newer extension installed it (e.g. a teammate's).
    fs.writeFileSync(path.join(dir, 'VERSION'), '99.0.0\n');
    assert.equal((await api().skillState()).kind, 'newer');

    await vscode.commands.executeCommand('kanbanBananas.installSkill');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.deepEqual(await api().skillState(), { kind: 'current' });
  },

  async 'lane commands from the board: add, rename (typed on the board), reorder'() {
    const controller = api().controller;
    const names = () => controller.settingsNow.view.lanes.epic.map((l) => l.name);
    await vscode.commands.executeCommand('kanbanBananas.lane.new', { field: 'epic', to: 'Alpha' });
    await vscode.commands.executeCommand('kanbanBananas.lane.new', { field: 'epic', to: 'Beta' });
    assert.ok(await waitFor(() => names().join() === 'Alpha,Beta'), names().join());

    const id = api().state().board.cards[0].fields.id;
    await store().setFields({ id, changes: { epic: 'Alpha' } });
    await vscode.commands.executeCommand('kanbanBananas.lane.rename', { field: 'epic', value: 'Alpha', to: 'Gamma' });
    assert.ok(await waitFor(() => names().join() === 'Gamma,Beta'), names().join());
    assert.equal(cardIn(id).fields.epic, 'Gamma');

    await vscode.commands.executeCommand('kanbanBananas.lane.moveDown', { field: 'epic', value: 'Gamma', order: ['Gamma', 'Beta'] });
    assert.ok(await waitFor(() => names().join() === 'Beta,Gamma'), names().join());
    await store().setFields({ id, changes: { epic: null } });
    await controller.updateLanes('epic', () => []);
  },

  async 'columns: add, rename, reorder, delete (moving its cards); agents learn the new columns'() {
    const controller = api().controller;
    const ids = () => controller.settingsNow.view.columns.map((c) => c.id);
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    await vscode.commands.executeCommand('kanbanBananas.installSkill');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await vscode.commands.executeCommand('kanbanBananas.column.new', { to: 'Blocked' });
    assert.ok(await waitFor(() => ids().join() === 'backlog,todo,in-progress,review,blocked,done'), ids().join());

    // The skill and the CLI accept the new status.
    const policy = () => JSON.parse(fs.readFileSync(path.join(root, '.claude/skills/kanban/policy.json'), 'utf8'));
    assert.ok(await waitFor(() => policy().statuses?.includes('blocked')), JSON.stringify(policy()));
    assert.match(fs.readFileSync(path.join(root, '.claude/skills/kanban/SKILL.md'), 'utf8'), /`blocked`/);
    const card = api().state().board.cards.find((c) => c.fields.status === 'todo').fields.id;
    const r = await kanbanResult(['move', card, 'blocked'], undefined, path.join(root, '.claude/skills/kanban/scripts/kanban'));
    assert.equal(r.code, 0, r.err);
    assert.ok(await waitFor(() => cardIn(card)?.fields.status === 'blocked'));

    await vscode.commands.executeCommand('kanbanBananas.column.rename', { status: 'blocked', to: 'Waiting', changeStatus: false });
    assert.ok(await waitFor(() => controller.settingsNow.view.columns.find((c) => c.id === 'blocked')?.name === 'Waiting'));
    assert.equal(cardIn(card).fields.status, 'blocked', 'rename must not touch cards');

    // The CLI takes the name too, once the skill knows it.
    assert.ok(await waitFor(() => policy().columnNames?.blocked === 'Waiting'), JSON.stringify(policy()));
    const byName = await kanbanResult(['move', card, 'todo'], undefined, path.join(root, '.claude/skills/kanban/scripts/kanban'));
    assert.equal(byName.code, 0, byName.err);
    const back = await kanbanResult(['move', card, 'Waiting'], undefined, path.join(root, '.claude/skills/kanban/scripts/kanban'));
    assert.equal(back.code, 0, back.err);
    assert.ok(await waitFor(() => cardIn(card)?.fields.status === 'blocked'));

    // Renaming again (same name) with the status too: blocked → waiting, the card follows, the column keeps its place.
    await vscode.commands.executeCommand('kanbanBananas.column.rename', { status: 'blocked', to: 'Waiting', changeStatus: true });
    assert.ok(await waitFor(() => ids().join() === 'backlog,todo,in-progress,review,waiting,done'), ids().join());
    assert.ok(await waitFor(() => cardIn(card)?.fields.status === 'waiting'), cardIn(card)?.fields.status);
    assert.equal(controller.settingsNow.view.columns.find((c) => c.id === 'waiting').name, 'Waiting');
    assert.deepEqual(api().state().board.broken, []);
    await vscode.commands.executeCommand('kanbanBananas.column.rename', { status: 'waiting', to: 'Blocked', changeStatus: true });
    assert.ok(await waitFor(() => cardIn(card)?.fields.status === 'blocked'), cardIn(card)?.fields.status);

    await controller.updateColumns((cols) => [cols.find((c) => c.id === 'blocked'), ...cols.filter((c) => c.id !== 'blocked')]);
    assert.ok(await waitFor(() => ids()[0] === 'blocked'), ids().join());

    await vscode.commands.executeCommand('kanbanBananas.column.delete', { status: 'blocked', moveTo: 'todo' });
    assert.ok(await waitFor(() => !ids().includes('blocked')), ids().join());
    assert.equal(cardIn(card).fields.status, 'todo');
    assert.deepEqual(api().state().board.broken, []);

    // Done can't be deleted.
    await vscode.commands.executeCommand('kanbanBananas.column.delete', { status: 'done', moveTo: 'todo' });
    assert.ok(ids().includes('done'));
    await vscode.workspace.getConfiguration('kanbanBananas').update('columns', undefined, vscode.ConfigurationTarget.Workspace);
  },

  async 'pre-commit hook blocks a commit with a broken card, and allows it once fixed'() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const git = (...args) => require('node:child_process').spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    assert.equal(git('commit', '-q', '-m', 'cards').status, 0, 'baseline commit failed');

    await vscode.commands.executeCommand('kanbanBananas.installPreCommitHook');
    const hook = fs.readFileSync(path.join(root, '.git/hooks/pre-commit'), 'utf8');
    assert.match(hook, /# >>> kanban-bananas >>>/);
    // Running it again updates the block instead of adding a second one.
    await vscode.commands.executeCommand('kanbanBananas.installPreCommitHook');
    assert.equal(fs.readFileSync(path.join(root, '.git/hooks/pre-commit'), 'utf8').split('>>> kanban-bananas >>>').length, 2);

    const bad = path.join(features(), 'broken-2026-09-27.md');
    fs.writeFileSync(bad, '# no frontmatter\n');
    git('add', '-A');
    const blocked = git('commit', '-q', '-m', 'broken card');
    assert.notEqual(blocked.status, 0, 'commit with a broken card went through');
    assert.match(blocked.stdout + blocked.stderr, /broken-2026-09-27\.md/);

    fs.unlinkSync(bad);
    git('add', '-A');
    const ok = git('commit', '-q', '-m', 'fixed', '--allow-empty');
    assert.equal(ok.status, 0, ok.stderr);
  },

  async 'images: saved per card, deleted with their card unless another card uses them, unused ones found'() {
    const controller = api().controller;
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const a = (await store().create({ title: 'Has screenshots', status: 'todo' })).path.replace(/\.md$/, '');
    const b = (await store().create({ title: 'Shares one', status: 'todo' })).path.replace(/\.md$/, '');

    const own = await controller.images.save(a, png, 'png');
    const shared = await controller.images.save(a, png, 'png');
    assert.match(own, new RegExp(`^/\\.devtool/assets/${a}/\\d{4}-\\d{2}-\\d{2}-\\d{6}\\.png$`));
    assert.notEqual(own, shared, 'second image in the same second must not overwrite the first');
    assert.ok(fs.existsSync(path.join(root, own)));
    await expectRejects(controller.images.save(a, png, 'exe'), /Not an image/);

    const bodyA = controller.cardBody(a).body;
    await controller.saveBody({ id: a, base: bodyA, body: `${bodyA}\n![](${own})\n![](${shared})\n` });
    const bodyB = controller.cardBody(b).body;
    await controller.saveBody({ id: b, base: bodyB, body: `${bodyB}\n![](${shared})\n` });

    const images = await controller.images.ofCard(a);
    assert.deepEqual(images, { own: [own.slice(1)], shared: [shared.slice(1)] });
    await controller.deleteCard(a, false);
    await controller.images.delete(images.own, false);
    assert.ok(!fs.existsSync(path.join(root, own)), 'own image not deleted');
    assert.ok(fs.existsSync(path.join(root, shared)), 'shared image deleted');

    // An image no card links to shows up as unused.
    const orphan = await controller.images.save(b, png, 'png');
    assert.deepEqual(await controller.images.unused(), [orphan.slice(1)]);
  },

  async 'first run: no board folder offers setup, and Create Board makes one'() {
    const controller = api().controller;
    const config = vscode.workspace.getConfiguration('kanbanBananas');
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    await config.update('featuresDirectory', 'fresh/cards', vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => api().state().type === 'noBoard'), JSON.stringify(api().state()));
    assert.equal(api().state().featuresDirectory, 'fresh/cards');
    assert.ok(!fs.existsSync(path.join(root, 'fresh')), 'created a folder without being asked');

    await vscode.commands.executeCommand('kanbanBananas.createBoard', 'create');
    assert.ok(fs.existsSync(path.join(root, 'fresh/cards/done')), 'board folder not created');
    assert.ok(await waitFor(() => api().state().type === 'state'));
    assert.equal(api().state().board.cards.length, 0);
    await store().create({ title: 'First card', status: 'backlog' });
    assert.ok(fs.readdirSync(path.join(root, 'fresh/cards')).some((f) => f.startsWith('first-card')));

    await config.update('featuresDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => api().state().type === 'state' && api().state().board.cards.length > 1));
  },

  async 'session memory: setting on, agents save through the CLI, board shows it, skill and /session-memory follow'() {
    const controller = api().controller;
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const config = vscode.workspace.getConfiguration('kanbanBananas');
    const skillDir = path.join(root, '.claude/skills/kanban');
    const commandFile = path.join(root, '.claude/commands/session-memory.md');
    await vscode.commands.executeCommand('kanbanBananas.installSkill');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // Off: the CLI refuses, no command file, no summary.
    const off = await kanbanResult(['memory', '--body', 'x'], undefined, path.join(skillDir, 'scripts/kanban'));
    assert.equal(off.code, 2, off.err);
    assert.ok(!fs.existsSync(commandFile));

    await config.update('sessionMemory.enabled', true, vscode.ConfigurationTarget.Workspace);
    await config.update('sessionMemory.keep', 2, vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => fs.existsSync(commandFile)), '/session-memory command not installed');
    assert.ok(await waitFor(() => JSON.parse(fs.readFileSync(path.join(skillDir, 'policy.json'), 'utf8')).sessionMemory?.keep === 2));
    assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /## Session memory/);
    assert.match(fs.readFileSync(commandFile, 'utf8'), /memory --body -/);

    const launcher = path.join(skillDir, 'scripts/kanban');
    for (const next of ['one', 'two', 'three']) {
      const r = await kanbanResult(['memory', '--body', '-', '--json'], `**Working on:** x\n**Next:** step ${next}`, launcher);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).handledBy, 'vscode');
    }
    const file = fs.readFileSync(path.join(root, '.devtool/session-memory.md'), 'utf8');
    assert.ok(file.includes('step three') && file.includes('step two') && !file.includes('step one'), file);
    assert.ok(await waitFor(() => api().state().memory?.next === 'step three'), JSON.stringify(api().state().memory));
    assert.match((await kanbanResult(['memory'], undefined, launcher)).out, /step three/);

    // Opens in the board's split view like a card, without errors.
    await vscode.commands.executeCommand('kanbanBananas.card.showOnBoard', { cardId: '#session-memory' });
    assert.ok(await waitFor(() => controller.shownInEditor.includes('#session-memory') || controller.clientErrors.length > 0, 10000));
    assert.deepEqual(controller.clientErrors, []);
    assert.ok(controller.shownInEditor.includes('#session-memory'), 'memory not shown in the split view');

    // Editing it there merges with an entry an agent adds meanwhile.
    const base = controller.editorDoc('#session-memory').body;
    assert.match(base, /step three/);
    await kanbanResult(['memory', '--body', '-'], '**Next:** step four', launcher);
    await waitFor(() => controller.editorDoc('#session-memory').body.includes('step four'));
    const saved = await controller.saveEditorDoc({ id: '#session-memory', base, body: base.replace('# Session memory', '# Session memory (edited)') });
    assert.ok(saved.includes('(edited)') && saved.includes('step four'), saved);
    assert.match(fs.readFileSync(path.join(root, '.devtool/session-memory.md'), 'utf8'), /\(edited\)[\s\S]*step four/);

    // Hand-written text in the file is shown and carried, also through the extension.
    fs.writeFileSync(path.join(root, '.devtool/session-memory.md'), 'Hand-written status: halfway through the parser.\n');
    assert.match((await kanbanResult(['memory'], undefined, launcher)).out, /written by hand[\s\S]*halfway through the parser/);
    const carried = await kanbanResult(['memory', '--body', '-', '--json'], '**Next:** finish the parser', launcher);
    assert.equal(JSON.parse(carried.out).handledBy, 'vscode');
    const after = fs.readFileSync(path.join(root, '.devtool/session-memory.md'), 'utf8');
    assert.ok(after.includes('halfway through the parser') && after.includes('finish the parser'), after);

    // Personal: listed in .git/info/exclude (this clone only), and taken out again.
    const exclude = path.join(root, '.git/info/exclude');
    await config.update('sessionMemory.personal', true, vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => fs.existsSync(exclude) && fs.readFileSync(exclude, 'utf8').includes('/.devtool/session-memory.md')));
    await config.update('sessionMemory.personal', undefined, vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => !fs.readFileSync(exclude, 'utf8').includes('/.devtool/session-memory.md')));

    // Off again: the command and the skill section go away.
    await config.update('sessionMemory.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('sessionMemory.keep', undefined, vscode.ConfigurationTarget.Workspace);
    assert.ok(await waitFor(() => !fs.existsSync(commandFile)), 'command not removed');
    assert.ok(await waitFor(() => !fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8').includes('## Session memory')));
    assert.equal(api().state().memory, undefined);
  },

  async 'copy a card path for an agent: @mention by default, plain by setting'() {
    const card = api().state().board.cards[0];
    await vscode.commands.executeCommand('kanbanBananas.card.copyPath', { cardId: card.fields.id });
    assert.equal(await vscode.env.clipboard.readText(), `@.devtool/features/${card.path}`);
    const config = vscode.workspace.getConfiguration('kanbanBananas');
    await config.update('copyPathFormat', 'path', vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('kanbanBananas.card.copyPath', { cardId: card.fields.id });
    assert.equal(await vscode.env.clipboard.readText(), `.devtool/features/${card.path}`);
    await config.update('copyPathFormat', undefined, vscode.ConfigurationTarget.Workspace);
  },

  async 'CLI requests with the same id are applied once (safe retries after a slow answer)'() {
    const id = api().state().board.cards[0].fields.id;
    const record = JSON.parse(fs.readFileSync(path.join(features(), '../.kanban.sock'), 'utf8'));
    const send = (req) =>
      new Promise((resolve, reject) => {
        const c = require('node:net').createConnection(record.socket);
        let buf = '';
        c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
        c.on('data', (d) => {
          buf += d;
          if (buf.includes('\n')) {
            c.end();
            resolve(JSON.parse(buf));
          }
        });
        c.on('error', reject);
      });
    const req = { op: 'note', requestId: 'retry-test-1', intent: { id, heading: 'Applied once' } };
    const [a, b] = await Promise.all([send(req), send(req)]);
    const again = await send(req);
    assert.ok(a.ok && b.ok && again.ok, JSON.stringify([a, b, again]));
    const text = disk(cardIn(id).path);
    assert.equal(text.split('## Applied once').length - 1, 1, 'note applied more than once');
  },
};

async function expectRejects(promise, pattern) {
  try {
    await promise;
  } catch (e) {
    assert.match(e.message, pattern);
    return;
  }
  assert.fail('expected a rejection');
}

/**
 * Run the bundled CLI from the workspace root with a real Node, like an agent would.
 * Asynchronously: the extension host has to keep serving the socket while the CLI waits.
 */
function kanbanResult(args, stdin, launcher) {
  const { spawn } = require('node:child_process');
  const cli = path.join(vscode.extensions.getExtension(EXT_ID).extensionPath, 'dist/skill/kanban.mjs');
  return new Promise((resolve) => {
    const child = launcher
      ? spawn(launcher, args, { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath })
      : spawn('node', [cli, ...args], { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath });
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
