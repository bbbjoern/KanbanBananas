import { describe, expect, it } from 'vitest';
import { taskLineStart } from './taskInput.js';

describe('typing a checkbox', () => {
  it('turns [ ] or [] at the start of a line into a task list item', () => {
    expect(taskLineStart('[ ]')).toBe('- [ ] ');
    expect(taskLineStart('[]')).toBe('- [ ] ');
    expect(taskLineStart('  [ ]')).toBe('  - [ ] ');
  });

  it('fills in an empty box in a list item', () => {
    expect(taskLineStart('- []')).toBe('- [ ] ');
    expect(taskLineStart('* []')).toBe('* [ ] ');
    expect(taskLineStart('1. []')).toBe('1. [ ] ');
  });

  it('leaves everything else alone', () => {
    expect(taskLineStart('- [ ]')).toBeNull(); // already a task: the space is just typed
    expect(taskLineStart('text [ ]')).toBeNull();
    expect(taskLineStart('[x]')).toBeNull();
    expect(taskLineStart('[link]')).toBeNull();
  });
});
