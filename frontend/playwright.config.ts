import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './e2e/helpers/urls';
import path from 'node:path';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  testIgnore: /.*\.electron\.spec\.ts/,
  workers: 1, // Single shared backend server requires serial execution to prevent DB state races
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: 'on-first-retry', // Upload traces for debugging CI flakes
  },
  webServer: {
    command: 'node tests/e2e-server.cjs',
    // The server app starts last, so its health endpoint is the browser
    // harness's all-services-ready barrier.
    url: `${E2E_SERVER_APP_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      E2E_TASK_LOCAL_PORTS: '1',
      E2E_BASE_URL,
      E2E_KDS_BASE_URL,
      E2E_SERVER_APP_BASE_URL,
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: E2E_BASE_URL } },
  ],
});
