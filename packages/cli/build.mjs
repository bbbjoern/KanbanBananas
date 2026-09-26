// Bundles core + cli into one self-contained file for the agent skill (spec §12).
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../extension/package.json', import.meta.url), 'utf8'));

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/kanban.mjs',
  platform: 'node',
  format: 'esm',
  target: 'node18',
  conditions: ['source'],
  // Bundled CommonJS dependencies (yaml) call require() for Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __kbCreateRequire } from 'node:module';\nconst require = __kbCreateRequire(import.meta.url);",
  },
  define: { KANBAN_VERSION: JSON.stringify(version) },
  logLevel: 'info',
});
