import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  conditions: ['source'],
  sourcemap: true,
  logLevel: 'info',
});

// The agent skill ships inside the extension: SKILL.md template and the bundled CLI.
// The launcher script is written at install time (see skill.ts), so the package holds no shell script.
function copySkill() {
  mkdirSync('dist/skill', { recursive: true });
  rmSync('dist/skill/kanban', { force: true });
  copyFileSync('../cli/skill/SKILL.md', 'dist/skill/SKILL.md');
  copyFileSync('../cli/dist/kanban.mjs', 'dist/skill/kanban.mjs');
}

if (process.argv.includes('--watch')) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
  copySkill();
}
