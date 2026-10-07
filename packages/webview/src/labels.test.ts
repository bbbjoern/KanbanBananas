import { describe, expect, it } from 'vitest';
import { addLabels, labelToAdd, suggestLabels } from './labels.js';

const known = ['auth', 'backend', 'bug', 'UI', 'ui-kit'];

describe('labels', () => {
  it('uses an existing label’s spelling and refuses duplicates', () => {
    expect(labelToAdd('ui', [], known)).toBe('UI');
    expect(labelToAdd(' Bug ', ['auth'], known)).toBe('bug');
    expect(labelToAdd('BUG', ['bug'], known)).toBeNull();
    expect(labelToAdd('  ', [], known)).toBeNull();
    expect(labelToAdd('new  label', [], known)).toBe('new label');
  });

  it('adds several at once without duplicates', () => {
    expect(addLabels(['bug', 'Bug', 'perf', 'PERF'], ['auth'], known)).toEqual(['auth', 'bug', 'perf']);
  });

  it('suggests matches not on the card, prefix matches first', () => {
    expect(suggestLabels('u', ['auth'], known)).toEqual(['UI', 'ui-kit', 'bug']);
    expect(suggestLabels('ui', ['UI'], known)).toEqual(['ui-kit']);
    expect(suggestLabels('', ['auth', 'bug'], known)).toEqual(['backend', 'UI', 'ui-kit']);
  });
});
