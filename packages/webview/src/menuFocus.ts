/**
 * A field a host's card menu asked for (Labels…, Due date…, Assignee…, Epic…;
 * SuperTask v0.9.8 Board 8f): it scrolls into view and takes the focus, and its
 * row gets `data-menu-focus`, which the stylesheet draws as a tint that fades
 * and the focus ring. Asking again restarts the tint; the mark goes with the
 * focus. Nothing happens for a field the pane doesn't show or can't focus.
 */
export function focusFromMenu(pane: ParentNode, field: string): boolean {
  const row = pane.querySelector<HTMLElement>(`[data-field="${field}"]`);
  const target = row?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled])');
  if (!row || !target) return false;
  row.scrollIntoView({ block: 'nearest' });
  target.focus({ preventScroll: true });
  // A fresh animation each time: off, a layout read, on.
  delete row.dataset.menuFocus;
  void row.offsetWidth;
  row.dataset.menuFocus = '';
  target.addEventListener('blur', () => delete row.dataset.menuFocus, { once: true });
  return true;
}
