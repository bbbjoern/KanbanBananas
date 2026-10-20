import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findGitRoot, parseRemoteUrl, readGitRemote, repoIdentityFor } from '../src/node/index.js';

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/other/thing.git
[remote "origin"]
\turl = git@github.com:bbbjoern/KanbanBananas.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'kb-git-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), CONFIG);
  mkdirSync(join(root, '.devtool', 'features', 'done'), { recursive: true });
  return root;
}

describe('git remote', () => {
  it('reads the named remote from the config text', () => {
    expect(parseRemoteUrl(CONFIG)).toBe('git@github.com:bbbjoern/KanbanBananas.git');
    expect(parseRemoteUrl(CONFIG, 'upstream')).toBe('https://github.com/other/thing.git');
    expect(parseRemoteUrl(CONFIG, 'nope')).toBeNull();
    expect(parseRemoteUrl('[remote  "origin"]\n  url=x\n')).toBe('x');
  });

  it('finds the root from the features directory and builds the identity', () => {
    const root = repo();
    const features = join(root, '.devtool', 'features');
    expect(findGitRoot(features)).toBe(root);
    expect(readGitRemote(root)).toBe('git@github.com:bbbjoern/KanbanBananas.git');
    expect(repoIdentityFor(features)).toEqual({ remote: 'git@github.com:bbbjoern/KanbanBananas.git', featuresDir: '.devtool/features' });
  });

  it('follows a worktree\'s gitdir file to the common config', () => {
    const main = repo();
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = mkdtempSync(join(tmpdir(), 'kb-wt-'));
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    mkdirSync(join(wt, 'docs', 'cards'), { recursive: true });
    expect(repoIdentityFor(join(wt, 'docs', 'cards'))).toEqual({ remote: 'git@github.com:bbbjoern/KanbanBananas.git', featuresDir: 'docs/cards' });
  });

  it('uses the root path when there is no remote, and two levels up when there is no repository', () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'config'), '[core]\n\tbare = false\n');
    expect(readGitRemote(root)).toBeNull();
    expect(repoIdentityFor(join(root, '.devtool', 'features'))).toEqual({ remote: root, featuresDir: '.devtool/features' });

    const plain = mkdtempSync(join(tmpdir(), 'kb-plain-'));
    mkdirSync(join(plain, '.devtool', 'features'), { recursive: true });
    expect(repoIdentityFor(join(plain, '.devtool', 'features'))).toEqual({ remote: plain, featuresDir: '.devtool/features' });
  });
});
