// Integration smoke test: runs the built extension in a real VS Code against a
// copy of core's valid fixtures. Uses the installed VS Code when there is one.
//   npm run test:integration -w kanban-bananas
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';

const here = import.meta.dirname;
const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const tmp = mkdtempSync(join(tmpdir(), 'kanban-bananas-'));
const workspace = join(tmp, 'workspace');
cpSync(join(here, '../../core/test/fixtures/valid'), join(workspace, '.devtool/features'), { recursive: true });

try {
  await runTests({
    ...(existsSync(installed) && !process.env.CI ? { vscodeExecutablePath: installed } : {}),
    extensionDevelopmentPath: join(here, '..'),
    extensionTestsPath: join(here, 'suite.cjs'),
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${join(tmp, 'user-data')}`, '--skip-welcome'],
  });
} catch (e) {
  console.error('Integration tests failed', e);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
