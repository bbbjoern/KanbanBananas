export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

const DAY = 86_400_000;

/** Whole days from today (local calendar) to the due date: negative when overdue. Null if not a date. */
export function daysUntil(dueDate: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
  if (!m) return null;
  const due = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / DAY);
}

/**
 * Relative due date: "Overdue", "Today", "Tomorrow", or "5d". Only the
 * YYYY-MM-DD part is used, read as a local calendar date.
 */
export function formatDue(dueDate: string, now: Date): { text: string; tone: DueTone } | null {
  const days = daysUntil(dueDate, now);
  if (days === null) return null;
  if (days < 0) return { text: 'Overdue', tone: 'overdue' };
  if (days === 0) return { text: 'Today', tone: 'today' };
  if (days === 1) return { text: 'Tomorrow', tone: 'soon' };
  return { text: `${days}d`, tone: days <= 7 ? 'soon' : 'later' };
}
