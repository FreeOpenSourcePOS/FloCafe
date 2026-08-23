import { defineConfig, devices } from '@playwright/test';

const e2eKdsPort = process.env.E2E_KDS_PORT || '3002';
const e2eBaseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:3001';

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
    url: `http://127.0.0.1:${e2eKdsPort}/api/health`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: e2eBaseUrl } },
  ],
});
