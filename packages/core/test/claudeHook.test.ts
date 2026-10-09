import { describe, expect, it } from 'vitest';
import { sessionStartCommand, sessionStartEntry, withSessionStartHook } from '../src/claudeHook.js';

const cmd = sessionStartCommand('.claude/skills/kanban/scripts/kanban');

describe('session start hook in Claude Code settings', () => {
  it('adds the hook to a missing or empty file', () => {
    expect(JSON.parse(withSessionStartHook(null, cmd)!)).toEqual({ hooks: { SessionStart: [sessionStartEntry(cmd)] } });
    expect(sessionStartEntry(cmd)).toMatchObject({ matcher: 'startup|clear|compact', hooks: [{ timeout: 10 }] });
    expect(withSessionStartHook('', cmd)).not.toBeNull();
  });

  it('keeps everything else, and changes nothing when the hook is already there', () => {
    const own = { permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [] } };
    const added = withSessionStartHook(JSON.stringify(own), cmd)!;
    const parsed = JSON.parse(added);
    expect(parsed.permissions).toEqual(own.permissions);
    expect(parsed.hooks.Stop).toEqual([]);
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(withSessionStartHook(added, cmd)).toBeNull();
  });

  it('replaces an older command of ours instead of adding a second', () => {
    const old = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'old/path/kanban memory --session-start' }] }] } });
    expect(JSON.parse(withSessionStartHook(old, cmd)!).hooks.SessionStart).toEqual([sessionStartEntry(cmd)]);
  });

  it('removes only our hook, and the keys it leaves empty', () => {
    const both = withSessionStartHook(JSON.stringify({ model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }), cmd)!;
    expect(JSON.parse(withSessionStartHook(both, null)!)).toEqual({ model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
    const alone = withSessionStartHook('{"model":"x"}', cmd)!;
    expect(JSON.parse(withSessionStartHook(alone, null)!)).toEqual({ model: 'x' });
    expect(withSessionStartHook('{"model":"x"}', null)).toBeNull();
  });

  it('refuses a file it cannot read as settings', () => {
    expect(() => withSessionStartHook('{ "a": 1, // comment\n}', cmd)).toThrow();
    expect(() => withSessionStartHook('[]', cmd)).toThrow();
  });
});
