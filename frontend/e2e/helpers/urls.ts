const e2eKdsPort = process.env.E2E_KDS_PORT || '3002';
const e2eServerAppPort = process.env.E2E_SERVER_APP_PORT || '3003';

export const E2E_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';
export const E2E_KDS_BASE_URL = process.env.E2E_KDS_BASE_URL
  || (process.env.E2E_KDS_PORT ? `http://localhost:${e2eKdsPort}` : process.env.KDS_BASE_URL)
  || 'http://localhost:3002';
export const E2E_SERVER_APP_BASE_URL = process.env.E2E_SERVER_APP_BASE_URL
  || `http://localhost:${e2eServerAppPort}`;
