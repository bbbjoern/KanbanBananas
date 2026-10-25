import type { ContextMenuTarget, GroupField, MenuCommand } from '@kanban-bananas/core';

/**
 * Context menus drawn by a host (BoardHostOptions.menus, hub mode). The board
 * already marks its card, column head and lane head with VS Code's
 * `data-vscode-context`; here a right-click on one of them (⇧F10 and the menu
 * key fire the same event, a touch press of 500 ms too) becomes a
 * `contextMenu` message for the host, and the host's `menuCommand`s become
 * changes to the board's own view state (the pane, folds).
 */

/** How long a touch press opens the menu, and how far it may move first. */
export const LONG_PRESS_MS = 500;
const SLOP = 8;

/** The key a lane is folded under in the board's `collapsed` list. */
export const laneKey = (field: GroupField, value: string | null): string => `#lane:${field}:${value ?? ''}`;

/** The menu target an element's `data-vscode-context` describes, or null (not a card, column or lane head). */
export function targetOf(context: string | undefined, collapsed: readonly string[]): ContextMenuTarget | null {
  if (!context) return null;
  let c: { webviewSection?: string; cardId?: string; status?: string; field?: GroupField; value?: string | null };
  try {
    c = JSON.parse(context) as typeof c;
  } catch {
    return null;
  }
  if (c.webviewSection === 'card' && typeof c.cardId === 'string') return { section: 'card', cardId: c.cardId };
  if (c.webviewSection === 'column' && typeof c.status === 'string') return { section: 'column', status: c.status, folded: collapsed.includes(c.status) };
  if ((c.webviewSection === 'lane' || c.webviewSection === 'laneNone') && c.field) {
    const value = c.value ?? null;
    return { section: 'lane', field: c.field, value, folded: collapsed.includes(laneKey(c.field, value)) };
  }
  return null;
}

/** Shift, a text field, the editor or a link keep the browser's menu (cut, copy, paste, spelling, open link). */
export function browserMenu(target: Element, shiftKey: boolean): boolean {
  return shiftKey || !!target.closest('input, textarea, select, [contenteditable="true"], a[href], .cm-editor');
}

/** The folds after a fold command; `lanes` are the current grouping's lane keys. */
export function foldsAfter(collapsed: readonly string[], command: MenuCommand, lanes: readonly string[]): string[] {
  const toggle = (key: string) => (collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
  switch (command.action) {
    case 'foldColumn':
      return toggle(command.status);
    case 'foldLane':
      return toggle(laneKey(command.field, command.value));
    case 'foldAllLanes':
      return [...collapsed, ...lanes.filter((k) => !collapsed.includes(k))];
    case 'expandAllLanes':
      return collapsed.filter((k) => !k.startsWith('#lane:'));
    default:
      return [...collapsed];
  }
}

/**
 * Listens on the document: a right-click on a marked element (or a long touch
 * press) calls `open` with the target and where to open, and keeps the
 * browser's menu away. Returns the cleanup.
 */
export function listenForMenus(collapsed: () => readonly string[], open: (target: ContextMenuTarget, x: number, y: number) => void): () => void {
  const targetAt = (el: EventTarget | null) => {
    const marked = el instanceof Element ? el.closest<HTMLElement>('[data-vscode-context]') : null;
    const target = marked ? targetOf(marked.dataset.vscodeContext, collapsed()) : null;
    return marked && target ? { marked, target } : null;
  };
  const onMenu = (e: MouseEvent) => {
    if (!(e.target instanceof Element) || browserMenu(e.target, e.shiftKey)) return;
    const hit = targetAt(e.target);
    if (!hit) return;
    e.preventDefault();
    // From the keyboard (⇧F10, the menu key) there is no pointer: the element's top-right corner.
    const keyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
    const r = hit.marked.getBoundingClientRect();
    open(hit.target, keyboard ? r.right - 8 : e.clientX, keyboard ? r.top + 8 : e.clientY);
  };
  let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let fired = false;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const onDown = (e: PointerEvent) => {
    fired = false;
    if (e.pointerType !== 'touch' || !(e.target instanceof Element) || browserMenu(e.target, false)) return;
    const hit = targetAt(e.target);
    if (!hit) return;
    cancel();
    const { clientX: x, clientY: y } = e;
    press = {
      x,
      y,
      timer: setTimeout(() => {
        press = null;
        fired = true;
        open(hit.target, x, y);
      }, LONG_PRESS_MS),
    };
  };
  const onMove = (e: PointerEvent) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel();
  };
  // The click that ends a press that opened the menu does not also open the card.
  const onClick = (e: MouseEvent) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener('contextmenu', onMenu);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('click', onClick, true);
  return () => {
    cancel();
    document.removeEventListener('contextmenu', onMenu);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', cancel, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('click', onClick, true);
  };
}
