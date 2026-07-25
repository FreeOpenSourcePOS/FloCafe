import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: process.env.CI ? 1 : undefined, // Force 1 worker in CI for stability
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: 'on-first-retry', // Upload traces for debugging CI flakes
  },
  webServer: {
    command: 'cd .. && node tests/run-electron-node-test.cjs tests/e2e-server.cjs',
    url: 'http://127.0.0.1:3002/api/health',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
