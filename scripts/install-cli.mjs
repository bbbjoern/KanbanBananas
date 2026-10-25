#!/usr/bin/env node
// Put the `kanban` command on your PATH, for repositories you don't open in VS Code
// (where the extension's skill installer doesn't run), e.g. Xcode projects:
//
//   npm run install-cli [-- --to <dir>] [--link]
//
// Builds the CLI bundle (packages/cli/dist/kanban.mjs, self-contained) and copies it to
// <dir>/kanban. Default <dir>: /usr/local/bin or /opt/homebrew/bin, the first you can write
// to, else ~/.local/bin.
// --link makes a symlink instead, so every later build is picked up without reinstalling
// (but the command breaks while the repo is moved or mid-build). Run it again after pulling.
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const bundle = join(root, 'packages/cli/dist/kanban.mjs');

const args = process.argv.slice(2);
const link = args.includes('--link');
const toIndex = args.indexOf('--to');
if (toIndex !== -1 && !args[toIndex + 1]) fail('--to needs a directory.');
const unknown = args.filter((a, i) => a !== '--link' && a !== '--to' && (toIndex === -1 || i !== toIndex + 1));
if (unknown.length) fail(`unknown argument ${unknown[0]}. Usage: npm run install-cli [-- --to <dir>] [--link]`);

function fail(message) {
  console.error(`install-cli: ${message}`);
  process.exit(1);
}

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const dir = toIndex !== -1 ? resolve(args[toIndex + 1]) : (['/usr/local/bin', '/opt/homebrew/bin'].find(writable) ?? join(homedir(), '.local/bin'));

console.log('▸ Building the CLI');
const build = spawnSync('npm', ['run', 'build', '-w', '@kanban-bananas/cli'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) fail('the build failed; nothing was installed.');
if (!existsSync(bundle)) fail(`no bundle at ${bundle} after the build.`);

try {
  mkdirSync(dir, { recursive: true });
} catch (e) {
  fail(`can't create ${dir} (${e.code ?? e.message}). Pick another directory with --to <dir>.`);
}
if (!writable(dir)) fail(`can't write to ${dir}. Pick another directory with --to <dir>.`);
const target = join(dir, 'kanban');
let present = false;
try {
  present = Boolean(lstatSync(target));
} catch {}
if (present) rmSync(target);
if (link) symlinkSync(bundle, target);
else copyFileSync(bundle, target);
chmodSync(bundle, 0o755);
if (!link) chmodSync(target, 0o755);
console.log(`▸ ${link ? 'Linked' : 'Installed'} ${target}${link ? ` → ${bundle}` : ''}`);

const version = spawnSync(process.execPath, [target, 'version'], { encoding: 'utf8' });
if (version.status !== 0) fail(`${target} doesn't run: ${version.stderr.trim()}`);
console.log(`  kanban ${version.stdout.trim()}`);

const onPath = (process.env.PATH ?? '').split(delimiter).some((p) => p && resolve(p) === dir);
if (!onPath) {
  console.log(`\n${dir} is not on your PATH. Add it, e.g. in ~/.zshrc:\n  export PATH="${dir}:$PATH"`);
}
// launchd has no shell PATH: the plist template needs both paths spelled out.
console.log(`\nFor scripts/launchd/kanban-sync.plist:\n  node:   ${process.execPath}\n  kanban: ${target}`);
