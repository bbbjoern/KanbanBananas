// Vite dev server only: feed the board a snapshot so the UI can be worked on in a browser.
// Generate it with `npm run dev-board -w kanban-bananas`. Add ?theme=light to imitate a light VS Code theme.
if (new URLSearchParams(location.search).get('theme') === 'light') {
  const light: Record<string, string> = {
    '--vscode-sideBar-background': '#f7f8fa',
    '--vscode-editor-background': '#ffffff',
    '--vscode-foreground': '#1f2328',
    '--vscode-descriptionForeground': '#6c707e',
    '--vscode-focusBorder': '#3574f0',
    '--vscode-errorForeground': '#d1242f',
    '--vscode-editorWarning-foreground': '#9a6700',
  };
  for (const [k, v] of Object.entries(light)) document.documentElement.style.setProperty(k, v);
}

const res = await fetch('/dev-board.json');
if (res.ok) {
  const data = await res.json();
  const bodies: Record<string, string> = data.bodies ?? {};
  // ?demoEpics: give some cards made-up epics, to see epic lanes (your real board has none yet).
  if (new URLSearchParams(location.search).has('demoEpics')) {
    const epics = ['Compose', 'Parser', 'Platform'];
    data.board.cards.forEach((c: { fields: { epic: string | null } }, i: number) => {
      if (i % 4 !== 3) c.fields.epic = epics[i % 3]!;
    });
  }
  // A fake host for the inline editor: serves bodies and accepts saves.
  (window as { __kanbanDevHost?: (m: { type: string; id?: string; body?: string }) => void }).__kanbanDevHost = (m) => {
    if (m.type === 'openEditor' && m.id) {
      window.postMessage({ type: 'editorBody', id: m.id, path: `${m.id}.md`, body: bodies[m.id] ?? '' }, '*');
    } else if (m.type === 'search') {
      const words = String((m as { query?: string }).query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const ids = data.board.cards
        .filter((c: { fields: { id: string }; title: string | null }) =>
          words.every((w) => `${c.fields.id}\n${c.title}\n${bodies[c.fields.id] ?? ''}`.toLowerCase().includes(w)),
        )
        .map((c: { fields: { id: string } }) => c.fields.id);
      window.postMessage({ type: 'searchResults', query: (m as { query?: string }).query?.trim(), ids }, '*');
    } else if (m.type === 'saveBody' && m.id && m.body !== undefined) {
      bodies[m.id] = m.body;
      window.postMessage({ type: 'bodySaved', id: m.id, body: m.body }, '*');
    }
  };
  const layout = new URLSearchParams(location.search).get('layout');
  if (layout === 'vertical') data.settings.layout = 'vertical';
  window.postMessage({ type: data.type, board: data.board, settings: data.settings }, '*');
} else window.postMessage({ type: 'error', message: 'No dev-board.json. Run the dev-board script first.' }, '*');

export {};
