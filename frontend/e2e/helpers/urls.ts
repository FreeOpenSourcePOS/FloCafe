const e2eKdsPort = process.env.E2E_KDS_PORT || '3002';
const e2eServerAppPort = process.env.E2E_SERVER_APP_PORT || '3003';

export const E2E_BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3001';
export const E2E_KDS_BASE_URL = process.env.E2E_KDS_BASE_URL
  || (process.env.E2E_KDS_PORT ? `http://127.0.0.1:${e2eKdsPort}` : process.env.KDS_BASE_URL)
  || 'http://127.0.0.1:3002';
export const E2E_SERVER_APP_BASE_URL = process.env.E2E_SERVER_APP_BASE_URL
  || `http://127.0.0.1:${e2eServerAppPort}`;
