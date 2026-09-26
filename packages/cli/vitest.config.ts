import { defineConfig } from 'vitest/config';

// Load @kanban-bananas/core from its TypeScript sources, like the bundler does.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
});
