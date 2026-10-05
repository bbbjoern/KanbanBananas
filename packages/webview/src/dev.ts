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
  // `__kanbanDevOffline = true` (or ?offline) plays a lost connection: nothing is answered.
  const devWindow = window as { __kanbanDevOffline?: boolean };
  devWindow.__kanbanDevOffline = new URLSearchParams(location.search).has('offline');
  (window as { __kanbanDevHost?: (m: { type: string; id?: string; body?: string; requestId?: string }) => void }).__kanbanDevHost = (m) => {
    if (devWindow.__kanbanDevOffline) return;
    // Changes aren't stored here; acknowledge them like the extension does.
    if (m.requestId && m.type !== 'saveImage') window.postMessage({ type: 'ack', requestId: m.requestId, ok: true }, '*');
    if (m.type === 'openEditor' && m.id === '#session-memory') {
      const body = '# Session memory\n\n## 2026-09-30T10:00:00.000Z\n\n**Working on:** offline-mode-for-the-mobile-app-2026-09-20: queue storage done, replay in progress\n**Done since last time:** queue storage and replay order\n**Next:** Wire the offline queue into the sync service, then test on a flaky connection.\n**Open questions:** none\n**Decisions:** replay oldest first, stop at the first conflict, because later writes may depend on earlier ones.\n';
      window.postMessage({ type: 'editorBody', id: m.id, path: '.devtool/session-memory.md', body }, '*');
    } else if (m.type === 'openEditor' && m.id) {
      window.postMessage({ type: 'editorBody', id: m.id, path: `${m.id}.md`, body: bodies[m.id] ?? '' }, '*');
    } else if (m.type === 'saveImage') {
      // Pretend to store it; report what arrived, for the paste test below.
      const img = m as unknown as { requestId: string; id: string; ext: string; data: string };
      (window as { __lastImage?: unknown }).__lastImage = { ext: img.ext, bytes: Math.round((img.data.length * 3) / 4) };
      // The dev server has no project files, so hand back the image inline, to see it in the preview.
      const mime = img.ext === 'svg' ? 'image/svg+xml' : `image/${img.ext === 'jpg' ? 'jpeg' : img.ext}`;
      const link = new URLSearchParams(location.search).has('inlineImages') ? `data:${mime};base64,${img.data}` : `/.devtool/assets/${img.id}/test.${img.ext}`;
      window.postMessage({ type: 'imageSaved', requestId: img.requestId, link }, '*');
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
  // ?noBoard: show the first-run welcome instead of the board.
  if (new URLSearchParams(location.search).has('noBoard')) {
    window.postMessage({ type: 'noBoard', featuresDirectory: '.devtool/features', folderOpen: true }, '*');
  } else {
    // ?memory: show a sample session memory in the top-left corner.
    const memory = new URLSearchParams(location.search).has('memory')
      ? {
          file: '.devtool/session-memory.md',
          updated: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
          next: 'Wire the offline queue into the sync service, then test on a flaky connection.',
          latest: '**Working on:** offline-mode-for-the-mobile-app-2026-09-20\n**Done since last time:** queue storage and replay order\n**Next:** Wire the offline queue into the sync service, then test on a flaky connection.\n**Open questions:** none\n**Decisions:** replay oldest first, stop at the first conflict',
        }
      : undefined;
    window.postMessage({ type: data.type, board: data.board, settings: data.settings, assetBase: location.origin, memory }, '*');
  }

  // ?pasteTest: paste a generated screenshot into the open card's editor and report the result.
  if (new URLSearchParams(location.search).has('pasteTest')) {
    setTimeout(async () => {
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 300;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 900, 300);
      g.fillStyle = '#123';
      g.font = '20px sans-serif';
      g.fillText('A pasted screenshot', 20, 40);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      const target = document.querySelector('.cm-content')!;
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      setTimeout(() => {
        const out = document.createElement('pre');
        out.id = 'paste-result';
        const text = [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
        out.textContent = JSON.stringify({
          pngBytes: blob.size,
          sent: (window as { __lastImage?: unknown }).__lastImage,
          linkInText: /!\[\]\((\/\.devtool\/assets\/[^)]+|data:[^;]+)/.exec(text)?.[0] ?? null,
          imgShown: document.querySelectorAll('.cm-lp-image img').length,
        });
        document.body.appendChild(out);
      }, 1500);
    }, 1500);
  }
} else window.postMessage({ type: 'error', message: 'No dev-board.json. Run the dev-board script first.' }, '*');

export {};
