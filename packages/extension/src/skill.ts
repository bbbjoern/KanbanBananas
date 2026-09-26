import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { SECTION } from './settings.js';

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

function skillPaths(folder: vscode.WorkspaceFolder): SkillPaths {
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

/**
 * Write (or overwrite) the skill folder: SKILL.md written for the current
 * agentsMayMoveCards setting, policy.json for the CLI to enforce it, the
 * bundled CLI, its launcher and a VERSION stamp. `quiet` is for automatic
 * updates: no editor tab, no old-skill question.
 */
export async function installSkill(
  extensionUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  version: string,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<void> {
  const paths = skillPaths(folder);
  const policy = agentMovePolicy();
  log.info(`Installing agent skill v${version} into ${paths.dir} (agentsMayMoveCards: ${policy})`);
  const from = (name: string) => join(extensionUri.fsPath, 'dist', 'skill', name);
  const template = await readFile(from('SKILL.md'), 'utf8');

  let skill = template.replaceAll('{{VERSION}}', version);
  for (const [key, text] of Object.entries(skillPolicyText(policy, '{{KANBAN}}'))) skill = skill.replaceAll(`{{${key}}}`, text);
  skill = skill.replaceAll('{{KANBAN}}', paths.command);

  await mkdir(join(paths.dir, 'scripts'), { recursive: true });
  await writeFile(join(paths.dir, 'SKILL.md'), skill);
  await writeFile(join(paths.dir, SKILL_POLICY_FILE), JSON.stringify({ agentsMayMoveCards: policy } satisfies SkillPolicy, null, 2) + '\n');
  await writeFile(join(paths.dir, 'scripts', 'kanban.mjs'), await readFile(from('kanban.mjs')));
  await writeFile(join(paths.dir, 'scripts', 'kanban'), await readFile(from('kanban')));
  await chmod(join(paths.dir, 'scripts', 'kanban'), 0o755);
  await writeFile(join(paths.dir, 'VERSION'), version + '\n');
  log.info(`Installed agent skill in ${paths.dir}`);
  if (quiet) return;

  // Visible confirmation that doesn't depend on notifications being shown.
  await vscode.window.showTextDocument(vscode.Uri.file(join(paths.dir, 'SKILL.md')), { preview: true });
  void vscode.window.showInformationMessage(
    `KanbanBananas: installed the agent skill in ${vscode.workspace.asRelativePath(paths.dir)} (v${version}). Agents run it as ${paths.command}.`,
  );
  await offerLegacyRemoval(folder);
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
 * On activation: offer to install the skill if it isn't there, and to update
 * it if it's older than the extension. "Don't Ask Again" is remembered per
 * workspace and only silences the install offer; updates are always offered.
 */
export async function checkSkill(
  extensionUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  version: string,
  state: vscode.Memento,
): Promise<void> {
  const paths = skillPaths(folder);
  const installed = await readFile(join(paths.dir, 'VERSION'), 'utf8').then((v) => v.trim(), () => null);
  const legacy = existsSync(join(folder.uri.fsPath, ...LEGACY_SKILL.split('/')));
  const dismissed = state.get<boolean>(DISMISSED_KEY) === true;
  log.info(
    `Skill check: installed=${installed ?? 'no'} (extension v${version}), old skill=${legacy ? 'yes' : 'no'}, don't-ask-again=${dismissed ? 'yes' : 'no'}, looked in ${paths.dir}`,
  );

  if (installed !== null) {
    if (installed === version) return;
    const choice = await vscode.window.showWarningMessage(
      `KanbanBananas: the kanban agent skill is v${installed}; the extension is v${version}. Update it so agents use the current CLI.`,
      'Update',
    );
    if (choice === 'Update') await installSkill(extensionUri, folder, version);
    return;
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
