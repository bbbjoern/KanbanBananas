import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Builds straight into the extension, with fixed filenames the host can reference.
const { version } = JSON.parse(readFileSync(new URL('../extension/package.json', import.meta.url), 'utf8'));

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Lets the page report which build it is, so the log shows whether VS Code runs the current one.
  define: { __BOARD_BUILD__: JSON.stringify(`${version} (${new Date().toISOString()})`) },
  // public/ only holds the dev-server board snapshot; it must never reach a build.
  publicDir: command === 'serve' ? 'public' : false,
  resolve: { conditions: ['source'] },
  // Vitest runs in Node (SSR): load core from source there too.
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  build: {
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'index.js',
        assetFileNames: 'index[extname]',
      },
    },
  },
}));
