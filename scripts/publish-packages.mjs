#!/usr/bin/env node
// Publish KanbanBananas packages to GitHub Packages, for apps that host the
// board or speak the hub protocol (SuperTask is the first):
//
//   NODE_AUTH_TOKEN=<token with write:packages> node scripts/publish-packages.mjs core [webview] --version 1.7.0 [--dry-run]
//
// The workspace packages stay private under their internal names; what is
// published is a staged copy under the repository owner's scope, as GitHub
// Packages requires: @kanban-bananas/core → @bbbjoern/kanban-bananas-core,
// @kanban-bananas/webview → @bbbjoern/kanban-bananas-webview. A consumer
// aliases it back: "@kanban-bananas/core": "npm:@bbbjoern/kanban-bananas-core@1.7.0".
// The release script publishes the release version; between releases use a
// prerelease such as 1.7.0-dev.1 (consumers pin exact versions).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const SCOPE = '@bbbjoern';
const REGISTRY = 'https://npm.pkg.github.com';
const REPO = 'https://github.com/bbbjoern/KanbanBananas.git';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const versionAt = args.indexOf('--version');
const packages = args.filter((a, i) => !a.startsWith('--') && i !== versionAt + 1);
const extensionVersion = JSON.parse(readFileSync(join(root, 'packages/extension/package.json'), 'utf8')).version;
const version = versionAt === -1 ? extensionVersion : args[versionAt + 1];

const fail = (message) => {
  console.error(`\npublish: ${message}`);
  process.exit(1);
};
if (packages.length === 0 || packages.some((p) => !['core', 'webview'].includes(p))) fail('usage: publish-packages.mjs core [webview] [--version x.y.z] [--dry-run]');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`"${version}" is not a version.`);
if (!process.env.NODE_AUTH_TOKEN && !dryRun) fail('NODE_AUTH_TOKEN is not set (a GitHub token with write:packages).');

const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });

/** What each package publishes: its build, and the package.json fields the staged copy gets. */
const SPECS = {
  core: {
    dir: 'packages/core',
    build: () => run('npm', ['run', 'build', '-w', '@kanban-bananas/core']),
    name: `${SCOPE}/kanban-bananas-core`,
    description: 'KanbanBananas core: card parsing and patching, the board model, the CLI and hub protocols. No vscode import.',
    copy: ['dist', 'src'],
    manifest: (pkg) => ({
      main: pkg.main,
      types: pkg.types,
      exports: pkg.exports,
      dependencies: pkg.dependencies,
      files: ['dist', 'src'],
    }),
  },
  webview: {
    dir: 'packages/webview',
    // The webview builds into the extension; the staged copy takes the bundle from there.
    build: () => run('npm', ['run', 'build', '-w', '@kanban-bananas/webview']),
    name: `${SCOPE}/kanban-bananas-webview`,
    description: 'KanbanBananas board: the built bundle (index.js, index.css) for hosts that show the board outside VS Code.',
    copy: [],
    copyFrom: [['packages/extension/dist/webview', 'dist']],
    manifest: () => ({ files: ['dist'] }),
  },
};

for (const key of packages) {
  const spec = SPECS[key];
  const pkgDir = join(root, spec.dir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  console.log(`\n▸ ${spec.name}@${version}${dryRun ? ' (dry run)' : ''}`);
  spec.build();

  const stage = join(pkgDir, '.publish');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const d of spec.copy) cpSync(join(pkgDir, d), join(stage, d), { recursive: true });
  for (const [from, to] of spec.copyFrom ?? []) {
    if (!existsSync(join(root, from))) fail(`${from} is missing; the build did not produce it.`);
    cpSync(join(root, from), join(stage, to), { recursive: true });
  }
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  const manifest = {
    name: spec.name,
    version,
    description: spec.description,
    license: pkg.license ?? 'MIT',
    repository: { type: 'git', url: REPO, directory: spec.dir },
    type: 'module',
    ...spec.manifest(pkg),
    publishConfig: { registry: REGISTRY, access: 'restricted' },
  };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(stage, 'README.md'), `# ${spec.name}\n\n${spec.description}\n\nPublished from ${REPO} (${spec.dir}); the changelog is the extension's.\n`);
  // The token reaches npm through the environment, never through a file in the repo.
  writeFileSync(join(stage, '.npmrc'), `//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`);

  // A prerelease (1.7.0-dev.1) goes under the `dev` tag, so `latest` stays the last release.
  const tag = version.includes('-') ? 'dev' : 'latest';
  run('npm', ['publish', '--tag', tag, ...(dryRun ? ['--dry-run'] : [])], stage);
  rmSync(stage, { recursive: true, force: true });
  console.log(`✓ ${spec.name}@${version}${dryRun ? ' would be published' : ' published'}`);
}
