import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
