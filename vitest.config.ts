import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite creates many real Git repositories/worktrees and SQLite
    // databases. On high-core hosts, Vitest's CPU-derived default can launch
    // enough files at once to starve otherwise-correct 5s lifecycle tests.
    minWorkers: 1,
    maxWorkers: 4,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/_archive/**',
      '**/.brainctl-dev/**',
      '**/*.integration.test.ts',
    ],
    deps: {
      optimizer: {
        ssr: {
          include: ['node:sqlite'],
          exclude: [],
        },
      },
    },
  },
});
