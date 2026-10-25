#!/usr/bin/env node
// Connect a repository you don't open in VS Code (e.g. an Xcode project) to a project hub such
// as SuperTask, and keep it connected with a launchd agent that runs `kanban sync --write`:
//
//   npm run connect-repo -- <repo> --hub <url> [--token-file <file>] [--no-agent]
//   npm run connect-repo -- <repo> --remove
//
// 1. Gives the repo a board (.devtool/features) if it has none.
// 2. Stores the hub's token in ~/.config/kanban/<name>.token (chmod 600), asked for without
//    echo, or piped in (`pbpaste | npm run connect-repo -- …`). --token-file uses a file you have.
// 3. Syncs once to check the URL and token. Stops here if that fails (a new token is saved only after).
// 4. Writes ~/Library/LaunchAgents/org.hypertxt.kanban-sync.<name>.plist and (re)starts it:
//    it runs at login, restarts when it stops, and logs to ~/Library/Logs/kanban-sync-<name>.log.
//    --no-agent skips this and prints the command to run by hand.
// --remove stops and deletes the agent; the board and the token file stay.
// Needs `kanban` on the PATH: `npm run install-cli` first.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const USAGE = 'Usage: npm run connect-repo -- <repo> --hub <url> [--token-file <file>] [--no-agent]\n       npm run connect-repo -- <repo> --remove';
const fail = (message) => {
  console.error(`connect-repo: ${message}`);
  process.exit(1);
};
const step = (message) => console.log(`\n▸ ${message}`);

// npm runs scripts from this repository's root; paths you type are relative to where you were.
const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-agent' || a === '--remove') flags[a.slice(2)] = true;
  else if (a === '--hub' || a === '--token-file') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`${a} needs a value.\n${USAGE}`);
    flags[a.slice(2)] = args[++i];
  } else if (a.startsWith('--')) fail(`unknown option ${a}.\n${USAGE}`);
  else positional.push(a);
}
if (positional.length > 1) fail(`one repository at a time.\n${USAGE}`);
// No default: npm runs this from the KanbanBananas folder, so a forgotten path would connect KanbanBananas itself.
if (positional.length === 0) fail(`which repository? Pass its folder (or drag it from Finder into Terminal).\n${USAGE}`);

const repo = resolve(cwd, positional[0]);
if (!existsSync(repo) || !statSync(repo).isDirectory()) fail(`not a folder: ${repo}`);
const name = basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo';
const label = `org.hypertxt.kanban-sync.${name}`;
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const logPath = join(homedir(), 'Library/Logs', `kanban-sync-${name}.log`);
const domain = `gui/${process.getuid()}`;

if (flags.remove) {
  step(`Removing the agent for ${repo}`);
  stopAgent();
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log(`  Stopped ${label} and deleted ${plistPath}.\n  The board (.devtool) and the token file are untouched.`);
  process.exit(0);
}

const hub = (flags.hub ?? process.env.KANBAN_HUB_URL ?? '').trim();
if (!hub) fail(`--hub <url> is missing: the hub URL SuperTask gave you.\n${USAGE}`);
if (!/^https?:\/\//.test(hub)) fail(`the hub URL should start with https:// (or http://): ${hub}`);

// The installed command, not this repository's own node_modules/.bin/kanban, which `npm run` puts first on the PATH.
const kanban = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((dir) => dir && !dir.split(sep).includes('node_modules'))
  .map((dir) => join(dir, 'kanban'))
  .find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
if (!kanban) fail('`kanban` is not on your PATH. Run `npm run install-cli` first.');

// 1. The board.
if (!existsSync(join(repo, '.git'))) {
  // Xcode often puts the repository one level down (Mirazo/Mirazo/.git): say so before a board lands in the wrong folder.
  const inside = readdirSync(repo, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(repo, e.name, '.git')));
  if (inside.length > 0 && !existsSync(join(repo, '.devtool'))) {
    fail(`${repo} is not a git repository, but ${inside.map((e) => `"${join(repo, e.name)}"`).join(' and ')} is. Pass that folder instead.`);
  }
  console.log(`\n  Note: ${repo} has no .git; the hub will know it by its path, not its git remote.`);
}
const features = join(repo, '.devtool/features');
if (existsSync(join(repo, '.devtool'))) {
  step(`Board: using the existing .devtool in ${repo}`);
} else {
  step(`Board: creating ${features}`);
  mkdirSync(features, { recursive: true });
  console.log('  Empty for now: add cards in SuperTask, or with `kanban new "<title>"` in the repo. Commit .devtool/ with the repo.');
}

// 2. The token: a new one is saved only once the hub has accepted it.
let tokenFile;
let newToken = '';
if (flags['token-file']) {
  tokenFile = resolve(cwd, flags['token-file']);
  if (!existsSync(tokenFile)) fail(`no token file at ${tokenFile}`);
  if (!readFileSync(tokenFile, 'utf8').trim()) fail(`the token file ${tokenFile} is empty`);
  step(`Token: using ${tokenFile}`);
} else {
  tokenFile = join(homedir(), '.config/kanban', `${name}.token`);
  newToken = (await readToken(existsSync(tokenFile))).trim();
  if (!newToken && !existsSync(tokenFile)) fail('no token given.');
  step(newToken ? 'Token: received' : `Token: keeping ${tokenFile}`);
}

// 3. One sync to check the URL and the token.
step(`Checking the connection: kanban sync --once → ${hub}`);
const check = spawnSync(kanban, ['sync', '--once', '--hub', hub], {
  cwd: repo,
  env: { ...process.env, ...(newToken ? { KANBAN_HUB_TOKEN: newToken, KANBAN_HUB_TOKEN_FILE: '' } : { KANBAN_HUB_TOKEN: '', KANBAN_HUB_TOKEN_FILE: tokenFile }) },
  encoding: 'utf8',
  timeout: 60_000,
});
const output = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();
if (output) console.log(output.replace(/^/gm, '  '));
if (check.status !== 0) fail('the hub did not accept the connection (see above). Nothing was saved or installed; fix the URL or token and run this again.');
if (newToken) {
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, newToken + '\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  console.log(`  Token saved in ${tokenFile} (only you can read it)`);
}

// 4. The agent.
if (flags['no-agent']) {
  step('No agent (--no-agent). To sync by hand, in the repo:');
  console.log(`  KANBAN_HUB_TOKEN_FILE=${tokenFile} kanban sync --write --hub ${hub}`);
  process.exit(0);
}
step(`Agent: ${label}`);
mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(plistPath, plist());
const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
if (lint.status !== 0) fail(`the agent file is not valid: ${lint.stdout}${lint.stderr}`);
stopAgent(); // an older version of it, if loaded
// launchd may refuse a bootstrap while the old agent is still shutting down: try again for a few seconds.
let boot;
for (let attempt = 1; attempt <= 5; attempt++) {
  boot = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' });
  if (boot.status === 0) break;
  sleep(1000);
}
if (boot.status !== 0) fail(`launchctl could not start it: ${(boot.stderr || boot.stdout).trim()}`);
let state = '';
try {
  state = /^\s*state = (.+)$/m.exec(execFileSync('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' }))?.[1] ?? '';
} catch {}
console.log(`  Installed ${plistPath}${state ? ` (${state})` : ''}`);
console.log(`  Log:     tail -f ${logPath}`);
console.log(`  Restart: launchctl kickstart -k ${domain}/${label}`);
console.log(`  Remove:  npm run connect-repo -- "${repo}" --remove`);
console.log('\nDone. While VS Code has this repo open, the extension syncs and the agent waits; when VS Code closes, the agent takes over.');
console.log('After `npm run install-cli` (a newer kanban), restart the agent with the kickstart line above.');

/** Stop the agent if it is loaded, and wait (up to 10 s) until launchd has let go of it. */
function stopAgent() {
  spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }).status !== 0) return;
    sleep(250);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function plist() {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const str = (s) => `<string>${x(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by KanbanBananas' scripts/connect-repo.mjs. Remove with: npm run connect-repo -- <repo> --remove -->
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(label)}
  <key>ProgramArguments</key>
  <array>
    ${str(process.execPath)}
    ${str(kanban)}
    <string>sync</string>
    <string>--write</string>
  </array>
  <key>WorkingDirectory</key>
  ${str(repo)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>KANBAN_HUB_URL</key>
    ${str(hub)}
    <key>KANBAN_HUB_TOKEN_FILE</key>
    ${str(tokenFile)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${str(logPath)}
  <key>StandardErrorPath</key>
  ${str(logPath)}
</dict>
</plist>
`;
}

/** The token from a pipe, or typed/pasted without echo. Empty input keeps an existing token file. */
async function readToken(haveOne) {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  }
  const prompt = haveOne ? 'Paste the hub token (Enter keeps the saved one): ' : 'Paste the hub token: ';
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.startsWith(prompt) || s === '\r\n' || s === '\n') process.stdout.write(s);
  };
  const answer = await new Promise((r) => rl.question(prompt, r));
  rl.close();
  process.stdout.write('\n');
  return answer;
}
