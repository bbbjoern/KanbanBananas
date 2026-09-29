// Writes packages/webview/public/dev-board.json from invented demo cards, for
// Marketplace screenshots (never real project data). Run: node scripts/demo-board.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COLUMNS, loadBoard, toBoardView } from '@kanban-bananas/core';

const cards = [
  ['backlog', 'Dark mode for the settings page', 'low', ['ui'], 'Web', 'Match the editor theme; respect the OS setting by default.'],
  ['backlog', 'Export a board as CSV', 'medium', ['export'], 'Platform', 'One row per card with status, labels and dates.'],
  ['backlog', 'Keyboard shortcuts cheat sheet', 'low', ['docs'], 'Web', 'A small overlay on "?" listing every shortcut.'],
  ['todo', 'Rate-limit the public API', 'high', ['api', 'security'], 'Platform', 'Token bucket per key; 429 with Retry-After.'],
  ['todo', 'Onboarding checklist', 'medium', ['ui'], 'Web', 'Three steps for new users, dismissible, remembered per account.'],
  ['todo', 'Search: highlight matches', 'medium', ['search'], 'Web', 'Mark matching words in titles and excerpts.'],
  ['todo', 'Upgrade the build to Node 22', 'medium', ['infra'], 'Platform', 'Bump CI images and check native modules.'],
  ['in-progress', 'Offline mode for the mobile app', 'high', ['mobile', 'sync'], 'Mobile', 'Queue writes while offline; replay in order and resolve conflicts.'],
  ['in-progress', 'Invoice PDFs with company logo', 'medium', ['billing'], 'Platform', 'Logo upload in settings; embed as SVG where possible.'],
  ['review', 'Fix: session expires during upload', 'critical', ['bug', 'auth'], 'Platform', 'Refresh the token before long uploads instead of failing at the end.'],
  ['review', 'Push notifications opt-in screen', 'medium', ['mobile'], 'Mobile', 'Explain the value first, then ask for permission.'],
  ['done', 'Password reset via email', 'high', ['auth'], 'Platform', 'Single-use links, valid for 30 minutes.'],
  ['done', 'Team invitations', 'medium', ['teams'], 'Web', 'Invite by email; pending invites can be revoked.'],
  ['done', 'App icon and splash screen', 'low', ['design'], 'Mobile', 'Adaptive icon for Android; launch storyboard for iOS.'],
];
const due = { 'Rate-limit the public API': '2026-10-02', 'Fix: session expires during upload': '2026-09-26' };

const files = cards.map(([status, title, priority, labels, epic, body], i) => {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-2026-09-20';
  return {
    path: status === 'done' ? `done/${id}.md` : `${id}.md`,
    text: [
      '---',
      `id: "${id}"`,
      `status: "${status}"`,
      `priority: "${priority}"`,
      'assignee: null',
      `epic: "${epic}"`,
      `dueDate: ${due[title] ? `"${due[title]}"` : 'null'}`,
      `created: "2026-09-${String(10 + i).padStart(2, '0')}T09:00:00.000Z"`,
      'modified: "2026-09-27T09:00:00.000Z"',
      'completedAt: null',
      `labels: [${labels.map((l) => `"${l}"`).join(', ')}]`,
      `order: "a${i.toString(36)}"`,
      '---',
      `# ${title}`,
      '',
      body,
      '',
      '## Plan',
      '',
      '- [x] Agree on the approach',
      '- [ ] Build it',
      '- [ ] Test on staging',
      '',
    ].join('\n'),
  };
});

const columns = [...DEFAULT_COLUMNS];
const board = loadBoard(files, { statuses: columns.map((c) => c.id) });
const message = {
  type: 'state',
  board: toBoardView(board),
  bodies: Object.fromEntries(board.cards.map((c) => [c.card.fields.id, c.card.source.body])),
  settings: {
    columns,
    compactMode: false,
    addNewCardsToTop: false,
    epicColors: {},
    lanes: { epic: [], assignee: [], priority: [], lane: [] },
    layout: 'horizontal',
    hideScrollbars: false,
    defaultStatus: 'backlog',
    images: { format: 'webp', maxWidth: 0 },
    show: { priority: true, assignee: true, dueDate: true, labels: true, epic: true, filename: false },
  },
};
const out = join(import.meta.dirname, '../../webview/public');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'dev-board.json'), JSON.stringify(message));
console.log(`${files.length} demo cards → ${join(out, 'dev-board.json')}`);
