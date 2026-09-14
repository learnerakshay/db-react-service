import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Starts (or connects to) the test PostgreSQL and applies migrations.
    globalSetup: ['./tests/global-setup.ts'],
    // Database tests share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
