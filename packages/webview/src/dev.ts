// Vite dev server only: feed the board a snapshot so the UI can be worked on in a browser.
// Generate it with `npm run dev-board -w kanban-bananas`.
const res = await fetch('/dev-board.json');
if (res.ok) window.postMessage(await res.json(), '*');
else window.postMessage({ type: 'error', message: 'No dev-board.json. Run the dev-board script first.' }, '*');
export {};
