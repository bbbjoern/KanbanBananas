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
if (res.ok) window.postMessage(await res.json(), '*');
else window.postMessage({ type: 'error', message: 'No dev-board.json. Run the dev-board script first.' }, '*');

export {};
