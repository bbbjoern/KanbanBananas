/**
 * The Claude Code SessionStart hook that hands an agent the session memory
 * when a session starts (installed by the extension while session memory and
 * its "load at session start" setting are on). Only our own hook is ever
 * added or removed; everything else in the settings file stays as it was.
 */

/** Part of our hook's command, to recognise it again (also in older versions of the command). */
export const SESSION_START_MARKER = 'memory --session-start';

/** The hook command: the skill's CLI, from the project root; never fails the session. */
export function sessionStartCommand(cliPath: string): string {
  return `"$CLAUDE_PROJECT_DIR"/${cliPath} ${SESSION_START_MARKER} 2>/dev/null || true`;
}

/**
 * When it runs: a new session, after /clear, and after compaction (the
 * conversation is gone or summarised); not on resume, where it's still there.
 * A timeout well below the default 10 minutes, so it can never hold up a session.
 */
export function sessionStartEntry(command: string): HookEntry {
  return { matcher: 'startup|clear|compact', hooks: [{ type: 'command', command, timeout: 10 }] };
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
  [key: string]: unknown;
}

/**
 * The settings file's new text with our hook added (`command`) or removed
 * (null), or null when nothing changes. Throws if the file isn't a JSON object,
 * so a file we can't read safely is never rewritten.
 */
export function withSessionStartHook(text: string | null, command: string | null): string | null {
  const settings: Record<string, unknown> = text?.trim() ? JSON.parse(text) : {};
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error('not a JSON object');
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('"hooks" is not an object');
  const current = (Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []) as HookEntry[];
  const ours = (h: { command?: string }) => typeof h.command === 'string' && h.command.includes(SESSION_START_MARKER);

  // Every entry without our hook in it; entries left empty by that go.
  const others = current
    .map((e) => (Array.isArray(e.hooks) && e.hooks.some(ours) ? { ...e, hooks: e.hooks.filter((h) => !ours(h)) } : e))
    .filter((e) => !Array.isArray(e.hooks) || e.hooks.length > 0);
  const next = command ? [...others, sessionStartEntry(command)] : others;

  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  if (next.length) hooks.SessionStart = next;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  return JSON.stringify(settings, null, 2) + '\n';
}
