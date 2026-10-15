import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Anything importing config/env throws on missing variables; the setup
    // file supplies placeholders so the suite runs without a .env or database.
    setupFiles: ['src/test/setup.ts'],
  },
});
