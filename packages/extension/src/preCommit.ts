import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { log } from './log.js';
import { skillPaths } from './skill.js';

const run = promisify(execFile);
const BEGIN = '# >>> kanban-bananas >>>';
const END = '# <<< kanban-bananas <<<';

/**
 * Pre-commit hook (spec §6/M6): when a commit touches card files, run
 * `kanban check` and block the commit if a card is broken. Our lines live
 * between markers, so an existing hook is extended rather than replaced, and
 * running the command again updates them in place.
 */
export async function installPreCommitHook(folder: vscode.WorkspaceFolder, featuresRoot: vscode.Uri): Promise<void> {
  const cwd = folder.uri.fsPath;
  let top: string;
  let hooksDir: string;
  try {
    top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
    // --git-path honours core.hooksPath and worktrees.
    const hooks = (await run('git', ['rev-parse', '--git-path', 'hooks'], { cwd })).stdout.trim();
    hooksDir = isAbsolute(hooks) ? hooks : join(cwd, hooks);
  } catch {
    void vscode.window.showErrorMessage('KanbanBananas: this project isn\'t a git repository, so there\'s no commit to check.');
    return;
  }

  // Git reports real paths (e.g. /private/var on macOS), so compare real paths.
  top = await realpath(top);
  const launcher = join(await realpath(skillPaths(folder).dir).catch(() => skillPaths(folder).dir), 'scripts', 'kanban');
  const features = relative(top, await realpath(featuresRoot.fsPath)).split('\\').join('/');
  const block = [
    BEGIN,
    '# Checks the kanban cards before a commit that touches them (KanbanBananas).',
    '# Remove this block to turn it off; `git commit --no-verify` skips it once.',
    `if git diff --cached --name-only | grep -q '^${features.replace(/'/g, '')}/'; then`,
    `  "${relative(top, launcher).split('\\').join('/')}" check || {`,
    '    echo "kanban check found broken cards (listed above). Fix them, or commit with --no-verify." >&2',
    '    exit 1',
    '  }',
    'fi',
    END,
  ].join('\n');

  const hookPath = join(hooksDir, 'pre-commit');
  const existing = await readFile(hookPath, 'utf8').catch(() => null);
  let next: string;
  if (existing === null) {
    next = `#!/bin/sh\n${block}\n`;
  } else if (existing.includes(BEGIN) && existing.includes(END)) {
    next = existing.replace(new RegExp(`${escape(BEGIN)}[\\s\\S]*?${escape(END)}`), block);
  } else {
    const ok = await vscode.window.showWarningMessage(
      'A pre-commit hook already exists. Add the kanban check to the end of it? Your existing lines stay as they are.',
      { modal: true, detail: 'If the hook ends with an exit statement, the check will never run; then move the block above it.' },
      'Add to Hook',
    );
    if (ok !== 'Add to Hook') return;
    next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  }

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, next);
  await chmod(hookPath, 0o755);
  log.info(`Pre-commit hook ${existing === null ? 'installed' : 'updated'}: ${hookPath}`);
  void vscode.window.showInformationMessage(
    `KanbanBananas: commits that change cards now run "kanban check" first (${relative(top, hookPath)}).`,
  );
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
