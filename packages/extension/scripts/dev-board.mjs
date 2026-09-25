// Writes packages/webview/public/dev-board.json from a features folder, for
// working on the UI in the Vite dev server. The output is git-ignored.
//   npm run dev-board -w kanban-bananas -- [featuresDir]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COLUMNS, loadBoard, toBoardView } from '@kanban-bananas/core';

const here = import.meta.dirname;
const root = process.argv[2] ?? join(here, '../../core/test/corpus/features');
const files = ['', 'done'].flatMap((dir) => {
  let names = [];
  try {
    names = readdirSync(join(root, dir)).filter((n) => n.endsWith('.md'));
  } catch {}
  return names.map((n) => ({ path: dir ? `${dir}/${n}` : n, text: readFileSync(join(root, dir, n), 'utf8') }));
});
const columns = [...DEFAULT_COLUMNS];
const message = {
  type: 'state',
  board: toBoardView(loadBoard(files, { statuses: columns.map((c) => c.id) })),
  settings: {
    columns,
    compactMode: process.argv.includes('--compact'),
    show: { priority: true, assignee: true, dueDate: true, labels: true, epic: true, filename: false },
  },
};
const out = join(here, '../../webview/public');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'dev-board.json'), JSON.stringify(message));
console.log(`${files.length} files → ${join(out, 'dev-board.json')}`);
