import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RepoIdentity } from '../hubProtocol.js';

/**
 * Which repository a board belongs to, for the hub protocol's `RepoIdentity`:
 * the `origin` remote from the repository's git config, read from the files
 * (no git binary needed), and the features directory relative to the root.
 */

/** The nearest directory at or above `start` that holds `.git` (a directory, or a worktree's file). */
export function findGitRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The directory that holds the repository's `config`: `.git`, or the common dir of a worktree. */
function gitDir(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const dir = resolve(root, m[1]!.trim());
    const common = join(dir, 'commondir');
    if (!existsSync(common)) return dir;
    const c = readFileSync(common, 'utf8').trim();
    return isAbsolute(c) ? c : resolve(dir, c);
  } catch {
    return null;
  }
}

/** The URL of the named remote in a git config's text, or null. */
export function parseRemoteUrl(config: string, name = 'origin'): string | null {
  const header = `[remote "${name}"]`;
  let inSection = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inSection = line.replace(/\s+/g, ' ') === header;
      continue;
    }
    if (!inSection) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** The named remote's URL of the repository at `root`, or null when there is none. */
export function readGitRemote(root: string, name = 'origin'): string | null {
  const dir = gitDir(root);
  if (!dir) return null;
  try {
    return parseRemoteUrl(readFileSync(join(dir, 'config'), 'utf8'), name);
  } catch {
    return null;
  }
}

/**
 * The identity of the board whose features directory this is. Without a
 * remote, the repository's root path stands in for it (so a hub can still
 * tell two local boards apart); without a repository, the root is taken to be
 * two levels up (`<root>/.devtool/features`).
 */
export function repoIdentityFor(featuresRoot: string): RepoIdentity {
  const abs = resolve(featuresRoot);
  const gitRoot = findGitRoot(abs);
  const root = gitRoot ?? dirname(dirname(abs));
  const remote = (gitRoot ? readGitRemote(gitRoot) : null) ?? root;
  return { remote, featuresDir: relative(root, abs).split(sep).join('/') };
}
