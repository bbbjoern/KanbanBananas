import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds straight into the extension, with fixed filenames the host can reference.
export default defineConfig(({ command }) => ({
  plugins: [react()],
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
