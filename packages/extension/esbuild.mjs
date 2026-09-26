import * as esbuild from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';

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

// The agent skill ships inside the extension: SKILL.md template, bundled CLI, launcher.
function copySkill() {
  mkdirSync('dist/skill', { recursive: true });
  copyFileSync('../cli/skill/SKILL.md', 'dist/skill/SKILL.md');
  copyFileSync('../cli/skill/kanban', 'dist/skill/kanban');
  chmodSync('dist/skill/kanban', 0o755);
  copyFileSync('../cli/dist/kanban.mjs', 'dist/skill/kanban.mjs');
}

if (process.argv.includes('--watch')) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
  copySkill();
}
