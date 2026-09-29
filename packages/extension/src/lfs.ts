import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { log } from './log.js';

const run = promisify(execFile);

/**
 * Opt-in: store the images folder with Git LFS. A deliberate one-time step,
 * not a setting: it changes the shared .gitattributes, every clone needs
 * git-lfs, hosting quotas apply, and it doesn't move images already committed.
 */
export async function storeImagesWithLfs(folder: vscode.WorkspaceFolder, imagesFolder: string): Promise<void> {
  const cwd = folder.uri.fsPath;
  let top: string;
  try {
    top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim();
  } catch {
    void vscode.window.showErrorMessage('KanbanBananas: this project isn\'t a git repository.');
    return;
  }
  try {
    await run('git', ['lfs', 'version'], { cwd });
  } catch {
    void vscode.window.showErrorMessage('KanbanBananas: git-lfs isn\'t installed on this machine. Install it first (https://git-lfs.com), then run this again.');
    return;
  }
  const pattern = `${imagesFolder}/** filter=lfs diff=lfs merge=lfs -text`;
  const attributes = join(top, '.gitattributes');
  const current = await readFile(attributes, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(pattern)) {
    void vscode.window.showInformationMessage(`KanbanBananas: ${imagesFolder} is already stored with Git LFS.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Store ${imagesFolder} with Git LFS?`,
    {
      modal: true,
      detail: [
        'This adds one line to .gitattributes, which you then commit. From then on:',
        '• every machine that clones the project needs git-lfs installed, or it gets placeholder files instead of images;',
        '• your git host\'s LFS quota applies (GitHub: 1 GB free storage and bandwidth);',
        '• images committed before this stay in normal git history (moving them needs "git lfs migrate", which rewrites history).',
      ].join('\n'),
    },
    'Use Git LFS',
  );
  if (ok !== 'Use Git LFS') return;
  await writeFile(attributes, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  log.info(`Added to .gitattributes: ${pattern}`);
  void vscode.window.showInformationMessage('KanbanBananas: added the images folder to .gitattributes. Commit it; new images are stored with Git LFS from now on.');
}
