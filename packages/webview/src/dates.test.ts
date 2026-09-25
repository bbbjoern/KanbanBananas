import { describe, expect, it } from 'vitest';
import { formatDue } from './dates.js';

const now = new Date(2026, 8, 25, 23, 30); // 25 Sep 2026, late evening local time

describe('formatDue', () => {
  it.each([
    ['2026-09-24', 'Overdue'],
    ['2026-09-25', 'Today'],
    ['2026-09-25T08:00:00.000Z', 'Today'],
    ['2026-09-26', 'Tomorrow'],
    ['2026-09-30', '5d'],
    ['2026-10-25', '30d'],
  ])('%s → %s', (due, text) => {
    expect(formatDue(due, now)?.text).toBe(text);
  });

  it('ignores values that are not dates', () => {
    expect(formatDue('next week', now)).toBeNull();
  });
});
