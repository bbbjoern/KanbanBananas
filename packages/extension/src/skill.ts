import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_AGENT_MOVE_POLICY,
  isAgentMovePolicy,
  SKILL_POLICY_FILE,
  skillPolicyText,
  type AgentMovePolicy,
  type SkillPolicy,
} from '@kanban-bananas/core';
import * as vscode from 'vscode';
import { log } from './log.js';
import { readSettings, SECTION } from './settings.js';

/** The previous extension's agent skill, which writes card files by hand (spec §10). */
const LEGACY_SKILL = '.agents/skills/kanban-markdown';
const SKILL_NAME = 'kanban';

interface SkillPaths {
  folder: vscode.WorkspaceFolder;
  /** Absolute path of the installed skill folder. */
  dir: string;
  /** How agents run the CLI, relative to the project root. */
  command: string;
}

export function skillPaths(folder: vscode.WorkspaceFolder): SkillPaths {
  const base = vscode.workspace.getConfiguration(SECTION).get<string>('skillDirectory') || '.claude/skills';
  const rel = `${base.replace(/\/+$/, '')}/${SKILL_NAME}`;
  return { folder, dir: join(folder.uri.fsPath, ...rel.split('/')), command: `${rel}/scripts/kanban` };
}

export function agentMovePolicy(): AgentMovePolicy {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>('agentsMayMoveCards');
  return isAgentMovePolicy(value) ? value : DEFAULT_AGENT_MOVE_POLICY;
}

/** Whether the skill is installed in this folder (it has a VERSION stamp). */
export function skillInstalled(folder: vscode.WorkspaceFolder): boolean {
  return existsSync(join(skillPaths(folder).dir, 'VERSION'));
}

/** Files of the installed skill, by path inside the skill folder. */
type SkillFiles = Map<string, Buffer>;
const MANIFEST = '.manifest.json';
/** The launcher must stay executable. */
const EXECUTABLE = 'scripts/kanban';

interface Manifest {
  version: string;
  /** sha256 of each file as written, to tell hand edits from our own installs. */
  files: Record<string, string>;
}

/** Everything the skill folder should contain for this extension version and the current settings. */
async function renderSkill(extensionUri: vscode.Uri, folder: vscode.WorkspaceFolder, version: string): Promise<SkillFiles> {
  const paths = skillPaths(folder);
  const policy = agentMovePolicy();
  const from = (name: string) => join(extensionUri.fsPath, 'dist', 'skill', name);
  const statuses = readSettings().view.columns.map((c) => c.id);
  let skill = (await readFile(from('SKILL.md'), 'utf8'))
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{STATUSES}}', statuses.map((s) => `\`${s}\``).join(', '));
  for (const [key, text] of Object.entries(skillPolicyText(policy, '{{KANBAN}}'))) skill = skill.replaceAll(`{{${key}}}`, text);
  skill = skill.replaceAll('{{KANBAN}}', paths.command);
  return new Map([
    ['SKILL.md', Buffer.from(skill)],
    [SKILL_POLICY_FILE, Buffer.from(JSON.stringify({ agentsMayMoveCards: policy, statuses } satisfies SkillPolicy, null, 2) + '\n')],
    ['scripts/kanban.mjs', await readFile(from('kanban.mjs'))],
    [EXECUTABLE, Buffer.from(launcher(process.execPath))],
    ['VERSION', Buffer.from(version + '\n')],
  ]);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * The skill's launcher script, written at install time (the package ships no
 * shell script). It runs `node` from the PATH, else the JavaScript runtime this
 * extension itself runs on: on a remote, the Node that VS Code's server ships
 * with; locally, VS Code's runtime in Node mode. That path changes when VS Code
 * updates; the skill check then rewrites the launcher.
 */
function launcher(runtime: string): string {
  const quoted = `'${runtime.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# Runs the KanbanBananas CLI. Written by the extension when it installs the skill.',
    'DIR=$(cd "$(dirname "$0")" && pwd)',
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$DIR/kanban.mjs" "$@"',
    'fi',
    `RUNTIME=${quoted}`,
    'if [ -x "$RUNTIME" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME" "$DIR/kanban.mjs" "$@"',
    'fi',
    'echo "kanban: Node.js not found. Install Node 18 or newer, or open this project in VS Code so the extension can update this launcher." >&2',
    'exit 127',
    '',
  ].join('\n');
}

/**
 * Write (or overwrite) the skill folder: SKILL.md written for the current
 * agentsMayMoveCards setting, policy.json for the CLI to enforce it, the
 * bundled CLI, its launcher, a VERSION stamp and a manifest of what was
 * written. `quiet` is for automatic updates: no editor tab, no old-skill question.
 */
export async function installSkill(
  extensionUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  version: string,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<void> {
  const paths = skillPaths(folder);
  log.info(`Installing agent skill v${version} into ${paths.dir} (agentsMayMoveCards: ${agentMovePolicy()})`);
  const files = await renderSkill(extensionUri, folder, version);
  const manifest: Manifest = { version, files: {} };
  for (const [rel, content] of files) {
    const target = join(paths.dir, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    manifest.files[rel] = sha(content);
  }
  await chmod(join(paths.dir, ...EXECUTABLE.split('/')), 0o755);
  await writeFile(join(paths.dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  log.info(`Installed agent skill in ${paths.dir}`);
  if (quiet) return;

  // Visible confirmation that doesn't depend on notifications being shown.
  await vscode.window.showTextDocument(vscode.Uri.file(join(paths.dir, 'SKILL.md')), { preview: true });
  void vscode.window.showInformationMessage(
    `KanbanBananas: installed the agent skill in ${vscode.workspace.asRelativePath(paths.dir)} (v${version}). Agents run it as ${paths.command}.`,
  );
  await offerLegacyRemoval(folder);
}

export type SkillState =
  | { kind: 'missing' }
  | { kind: 'current' }
  /** Installed by an older (or the same) extension version and untouched since: safe to replace. */
  | { kind: 'outdated'; installed: string }
  /** Someone changed the files since they were installed (or there's no manifest to tell). */
  | { kind: 'edited'; installed: string }
  /** Installed by a newer extension version, e.g. a teammate's: leave it. */
  | { kind: 'newer'; installed: string };

/** Compare the installed skill with what this extension would write now. */
export async function skillState(extensionUri: vscode.Uri, folder: vscode.WorkspaceFolder, version: string): Promise<SkillState> {
  const dir = skillPaths(folder).dir;
  const installed = await readFile(join(dir, 'VERSION'), 'utf8').then((v) => v.trim(), () => null);
  if (installed === null) return { kind: 'missing' };

  const expected = await renderSkill(extensionUri, folder, version);
  const actual = new Map<string, Buffer | null>();
  for (const rel of expected.keys()) actual.set(rel, await readFile(join(dir, ...rel.split('/'))).catch(() => null));
  if ([...expected].every(([rel, content]) => actual.get(rel)?.equals(content))) return { kind: 'current' };

  if (compareVersions(installed, version) > 0) return { kind: 'newer', installed };
  const manifest = await readFile(join(dir, MANIFEST), 'utf8').then((t) => JSON.parse(t) as Manifest, () => null);
  // Installs from before the manifest existed (≤ 0.4.0) were only ever written by the
  // extension; treat them as untouched once, and the manifest takes over from then on.
  if (manifest === null) return compareVersions(installed, version) < 0 ? { kind: 'outdated', installed } : { kind: 'edited', installed };
  const untouched =
    Object.entries(manifest.files).every(([rel, hash]) => {
      const content = actual.get(rel) ?? null;
      return content !== null && sha(content) === hash;
    });
  return untouched ? { kind: 'outdated', installed } : { kind: 'edited', installed };
}

/** Compare dotted versions numerically: negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** After install, offer to delete the old skill so agents stop writing cards by hand. Always asks. */
async function offerLegacyRemoval(folder: vscode.WorkspaceFolder): Promise<void> {
  const legacy = join(folder.uri.fsPath, ...LEGACY_SKILL.split('/'));
  if (!existsSync(legacy)) return;
  log.info(`Old skill found at ${legacy}; asking whether to delete it`);
  const choice = await vscode.window.showWarningMessage(
    `Delete the old ${LEGACY_SKILL} skill? It teaches agents to edit card files by hand, next to the new kanban skill.`,
    { modal: true },
    'Delete',
  );
  if (choice !== 'Delete') {
    log.info('Kept the old skill');
    return;
  }
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(legacy), { recursive: true, useTrash: true });
  } catch {
    // No trash on this machine (common on remotes); the user already confirmed deleting it.
    await rm(legacy, { recursive: true });
  }
  log.info(`Deleted ${legacy}`);
  void vscode.window.showInformationMessage(`KanbanBananas: deleted ${LEGACY_SKILL}.`);
}

const DISMISSED_KEY = 'kanbanBananas.skillPromptDismissed';

/**
 * On activation: offer to install the skill if it isn't there. If it is:
 * update it automatically when it's older and untouched (upgrade only), ask
 * when it was edited by hand, and leave a newer one alone.
 */
export async function checkSkill(
  extensionUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  version: string,
  state: vscode.Memento,
): Promise<void> {
  const paths = skillPaths(folder);
  const current = await skillState(extensionUri, folder, version);
  const legacy = existsSync(join(folder.uri.fsPath, ...LEGACY_SKILL.split('/')));
  const dismissed = state.get<boolean>(DISMISSED_KEY) === true;
  const auto = vscode.workspace.getConfiguration(SECTION).get<boolean>('autoUpdateSkill', true);
  log.info(`Skill check in ${paths.dir}: ${JSON.stringify(current)} (extension v${version}), old skill=${legacy ? 'yes' : 'no'}, auto-update=${auto}`);

  switch (current.kind) {
    case 'current':
    case 'newer':
      return;
    case 'outdated': {
      if (auto) {
        await installSkill(extensionUri, folder, version, { quiet: true });
        void vscode.window.showInformationMessage(`KanbanBananas: updated the agent skill to v${version} (was v${current.installed}).`);
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `KanbanBananas: the kanban agent skill (v${current.installed}) is out of date. Update it to v${version}?`,
        'Update',
      );
      if (choice === 'Update') await installSkill(extensionUri, folder, version);
      return;
    }
    case 'edited': {
      const choice = await vscode.window.showWarningMessage(
        `KanbanBananas: the agent skill in ${vscode.workspace.asRelativePath(paths.dir)} was changed by hand, so it wasn't updated automatically. Updating replaces those changes with v${version}.`,
        'Update Anyway',
        'Show Files',
      );
      if (choice === 'Update Anyway') await installSkill(extensionUri, folder, version);
      if (choice === 'Show Files') await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(paths.dir));
      return;
    }
    case 'missing':
      break;
  }

  if (dismissed) return;
  const message = legacy
    ? `KanbanBananas: agents still use the old ${LEGACY_SKILL} skill, which edits card files by hand. Install the new kanban skill so they change cards safely?`
    : `KanbanBananas: add the kanban skill to this project, so AI agents like Claude Code can read and update cards safely? It goes in ${vscode.workspace.asRelativePath(paths.dir)}.`;
  const buttons = ['Install', 'Not Now', "Don't Ask Again"] as const;
  const choice = legacy
    ? await vscode.window.showWarningMessage(message, ...buttons)
    : await vscode.window.showInformationMessage(message, ...buttons);
  log.info(`Skill prompt answered: ${choice ?? 'dismissed'}`);
  if (choice === 'Install') await installSkill(extensionUri, folder, version);
  else if (choice === "Don't Ask Again") {
    await state.update(DISMISSED_KEY, true);
    void vscode.window.showInformationMessage(
      'KanbanBananas: you can add it any time with "KanbanBananas: Install / Update Agent Skill".',
    );
  }
}
