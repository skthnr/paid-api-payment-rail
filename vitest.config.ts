import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    isolate: false,
    projects: [
      {
        test: {
          name: 'sdk',
          root: './packages/sdk',
          include: ['tests/**/*.test.ts'],
        },
      },
      'examples/paywall',
      'mcp',
    ],
  },
});
