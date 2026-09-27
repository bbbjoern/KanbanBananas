import type { CardView, GroupField, LaneDef } from '@kanban-bananas/core';
import { daysUntil } from './dates.js';

/** Board filters (spec §5). Null means "any". */
export interface Filters {
  query: string;
  priority: string | null;
  assignee: string | null;
  /** A label, or UNLABELLED for cards without any. */
  label: string | null;
  due: 'overdue' | 'today' | 'week' | 'none' | null;
}

export const UNLABELLED = '\u0000unlabelled';
export const NO_FILTERS: Filters = { query: '', priority: null, assignee: null, label: null, due: null };

export function filtersActive(f: Filters): boolean {
  return f.query.trim() !== '' || f.priority !== null || f.assignee !== null || f.label !== null || f.due !== null;
}

/**
 * Whether a card passes the filters. `searchIds` holds the host's full-text
 * matches for the current query (null while none has arrived yet: then the
 * query doesn't filter, rather than flashing an empty board).
 */
export function passes(card: CardView, f: Filters, now: Date, searchIds: ReadonlySet<string> | null): boolean {
  const fields = card.fields;
  if (f.query.trim() && searchIds && !searchIds.has(fields.id!)) return false;
  if (f.priority !== null && fields.priority !== f.priority) return false;
  if (f.assignee !== null && fields.assignee !== f.assignee) return false;
  if (f.label === UNLABELLED ? fields.labels.length > 0 : f.label !== null && !fields.labels.includes(f.label)) return false;
  if (f.due !== null) {
    const days = fields.dueDate ? daysUntil(fields.dueDate, now) : null;
    if (f.due === 'none') return days === null;
    if (days === null) return false;
    if (f.due === 'overdue' && days >= 0) return false;
    if (f.due === 'today' && days !== 0) return false;
    if (f.due === 'week' && (days < 0 || days > 6)) return false;
  }
  return true;
}

/** Distinct values of a field across cards, sorted, for the filter menus. */
export function distinct(cards: readonly CardView[], pick: (c: CardView) => (string | null)[]): string[] {
  return [...new Set(cards.flatMap(pick).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
}

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];
const PRIORITY_COLORS: Record<string, string> = { critical: '#e5484d', high: '#e8833a', medium: '#c9a227', low: '#4aa46a' };

/**
 * The lanes for a grouping: configured ones first, in their order (shown even
 * when empty), then values used on cards (priorities in priority order, others
 * alphabetically), then null for cards without a value.
 */
export function laneValues(cards: readonly CardView[], field: GroupField, configured: readonly LaneDef[]): (string | null)[] {
  const listed = configured.filter((l) => !l.none).map((l) => l.name);
  const used = [...new Set(cards.map((c) => c.fields[field]).filter((v): v is string => !!v))].filter((v) => !listed.includes(v));
  used.sort((a, b) =>
    field === 'priority' ? rank(a) - rank(b) || a.localeCompare(b) : a.localeCompare(b),
  );
  // The "none" lane sits where its marker is, else last. Unlisted values follow the last listed lane.
  const order: (string | null)[] = configured.some((l) => l.none) ? configured.map((l) => (l.none ? null : l.name)) : [...listed, null];
  let lastNamed = -1;
  order.forEach((v, i) => {
    if (v !== null) lastNamed = i;
  });
  order.splice(lastNamed + 1, 0, ...used);
  return order;
}

function rank(p: string): number {
  const i = PRIORITY_ORDER.indexOf(p);
  return i === -1 ? PRIORITY_ORDER.length : i;
}

/** A lane's colour: configured, else epic colours / priority colours / the palette. */
export function laneColor(field: GroupField, value: string, configured: readonly LaneDef[], epicColors: Record<string, string> | undefined): string {
  const set = configured.find((l) => l.name === value)?.color;
  if (set) return set;
  if (field === 'priority' && PRIORITY_COLORS[value]) return PRIORITY_COLORS[value]!;
  return epicColor(value, field === 'epic' ? epicColors : undefined);
}

/**
 * New lane order after dropping `dragged` on `target` (null is the "none"
 * lane, which moves like any other): dragging down places it after the
 * target, dragging up before it.
 */
export function reorderLanes<T extends string | null>(lanes: readonly T[], dragged: T, target: T): T[] {
  if (dragged === target) return [...lanes];
  const order = lanes.filter((v) => v !== dragged);
  const at = order.indexOf(target);
  const downward = lanes.indexOf(target) > lanes.indexOf(dragged);
  order.splice(downward ? at + 1 : at, 0, dragged);
  return order;
}

export const NONE_LANE_NAME: Record<GroupField, string> = { epic: 'No epic', assignee: 'Unassigned', priority: 'No priority', lane: 'No lane' };

const EPIC_PALETTE = ['#e0823d', '#3fa3a0', '#8b6fd6', '#d65f8b', '#5b8ee6', '#9aa33b', '#c9a227', '#6b9e6b'];

/** An epic's colour: from settings if set, else a stable pick from the palette by name. */
export function epicColor(epic: string, configured: Record<string, string> | undefined): string {
  const set = configured?.[epic];
  if (set) return set;
  let h = 0;
  for (const ch of epic) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EPIC_PALETTE[h % EPIC_PALETTE.length]!;
}
