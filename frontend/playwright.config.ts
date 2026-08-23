import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL } from './e2e/helpers/urls';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1, // Single shared backend server requires serial execution to prevent DB state races
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: 'on-first-retry', // Upload traces for debugging CI flakes
  },
  webServer: {
    command: 'cd .. && node tests/run-electron-node-test.cjs tests/e2e-server.cjs',
    url: `${E2E_KDS_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: E2E_BASE_URL } },
  ],
});
