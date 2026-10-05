#!/usr/bin/env node
// Release KanbanBananas in one go (see PUBLISHING.md):
//
//   npm run release -- 1.3.2 [--skip-integration] [--dry-run]
//
// Checks first, then: version in packages/extension/package.json, "## Unreleased" in the
// changelog renamed to the version, package built and checked, commit, annotated tag, push
// with the tag. Stops before changing anything if something's off.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = join(import.meta.dirname, '..');
const pkgPath = join(root, 'packages/extension/package.json');
const changelogPath = join(root, 'packages/extension/CHANGELOG.md');
const vsixPath = join(root, 'packages/extension/kanban-bananas.vsix');

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const skipIntegration = args.includes('--skip-integration');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
};
const step = (message) => console.log(`\n▸ ${message}`);
const run = (label, cmd, cmdArgs) => {
  step(label);
  if (dryRun) return console.log(`  (dry run) ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) fail(`${label} failed. Nothing was committed.`);
};

// --- Checks before anything changes ---------------------------------------------------

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('usage: npm run release -- <x.y.z> [--skip-integration] [--dry-run]');

const pkgText = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgText);
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, pkg.version)) fail(`${version} isn't newer than the current version ${pkg.version}.`);

const tag = `v${version}`;
if (git('tag', '-l', tag)) fail(`tag ${tag} already exists locally. (Delete it with: git tag -d ${tag})`);
if (git('ls-remote', '--tags', 'origin', tag)) fail(`tag ${tag} already exists on GitHub.`);

const changelog = readFileSync(changelogPath, 'utf8');
const unreleased = /^## Unreleased\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
if (!unreleased) fail('the changelog has no "## Unreleased" section. Add the changes there first.');
if (!unreleased[1].trim()) fail('the "## Unreleased" section in the changelog is empty.');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') console.log(`Note: releasing from branch "${branch}", not main.`);

const dirty = git('status', '--porcelain');
if (dirty) {
  console.log('\nUncommitted changes, which would go into the release commit:\n' + dirty);
  if (!dryRun && !process.stdin.isTTY) {
    fail('there are uncommitted changes and no terminal to ask about them. Commit or stash them, then run again.');
  }
  if (!dryRun) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Include them in the release? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') fail('stopped. Commit or stash the changes, then run again.');
  }
}

console.log(`\nReleasing ${pkg.version} → ${version}${dryRun ? ' (dry run: nothing changes)' : ''}`);
console.log(`Changelog for ${version}:\n${unreleased[1].trim()}`);

run('Typecheck', 'npm', ['run', 'typecheck']);
run('Unit tests', 'npm', ['test']);
if (skipIntegration) console.log('\n▸ Integration tests skipped (--skip-integration)');
else run('Integration tests (opens a VS Code window)', 'npm', ['run', 'test:integration', '-w', 'kanban-bananas']);

// --- Version, changelog, package -------------------------------------------------------

step(`Version ${version} and changelog section`);
const heading = `## ${version}${pkg.preview ? ' (Preview)' : ''}`;
if (dryRun) {
  console.log(`  (dry run) package.json "version": "${version}"; changelog "## Unreleased" → "${heading}"`);
} else {
  writeFileSync(pkgPath, pkgText.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  writeFileSync(changelogPath, changelog.replace(/^## Unreleased\s*$/m, heading));
}
const restore = () => {
  if (dryRun) return;
  writeFileSync(pkgPath, pkgText);
  writeFileSync(changelogPath, changelog);
  console.error('release: put the version and changelog back as they were.');
};

step('Build the package');
if (dryRun) console.log('  (dry run) npm run package -w kanban-bananas');
else {
  const r = spawnSync('npm', ['run', 'package', '-w', 'kanban-bananas'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    restore();
    fail('building the package failed. Nothing was committed.');
  }
  // The package must carry the new version and no keywords (the Marketplace rejects ours: PUBLISHING.md).
  const manifest = JSON.parse(execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], { encoding: 'utf8' }));
  if (manifest.version !== version) {
    restore();
    fail(`the package says version ${manifest.version}, expected ${version}.`);
  }
  if (manifest.keywords) {
    restore();
    fail('the package has "keywords", which the Marketplace rejected before. Remove them (PUBLISHING.md).');
  }
}

// --- Commit, tag, push ------------------------------------------------------------------

run('Commit', 'git', ['add', '-A']);
run(`Commit ${version}`, 'git', ['commit', '-q', '-m', `Release ${version}`]);
run(`Tag ${tag}`, 'git', ['tag', '-a', tag, '-m', `KanbanBananas ${version}`]);
run('Push commit and tag', 'git', ['push', 'origin', branch, '--follow-tags']);

console.log(`\n✓ ${version} is committed, tagged ${tag} and pushed.`);
console.log(`  Upload ${existsSync(vsixPath) ? 'packages/extension/kanban-bananas.vsix' : 'the package'} on the Marketplace manage page (⋯ → Update),`);
console.log('  then reload VS Code after installing it.');
