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
  // A fake host for the inline editor: serves bodies and accepts saves.
  (window as { __kanbanDevHost?: (m: { type: string; id?: string; body?: string }) => void }).__kanbanDevHost = (m) => {
    if (m.type === 'openEditor' && m.id) {
      window.postMessage({ type: 'editorBody', id: m.id, path: `${m.id}.md`, body: bodies[m.id] ?? '' }, '*');
    } else if (m.type === 'saveBody' && m.id && m.body !== undefined) {
      bodies[m.id] = m.body;
      window.postMessage({ type: 'bodySaved', id: m.id, body: m.body }, '*');
    }
  };
  window.postMessage({ type: data.type, board: data.board, settings: data.settings }, '*');
} else window.postMessage({ type: 'error', message: 'No dev-board.json. Run the dev-board script first.' }, '*');

export {};
