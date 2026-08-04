/** Issue #214 demo credential migration and inactive-session regression coverage. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-214-auth-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret, authRoutes, seedSetupProfile } = require('../main/routes/auth');

async function request(baseUrl: string, pathName: string, options: Record<string, any> = {}) {
  const { headers: optionHeaders, ...requestOptions } = options;
  const response = await fetch(baseUrl + pathName, {
    ...requestOptions,
    headers: { 'Content-Type': 'application/json', ...(optionHeaders || {}) },
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function main() {
  console.log('Issue #214: demo credential migration and inactive sessions');
  initDatabase();
  const db = getDatabase();

  try {
    seedSetupProfile(db, 'demo', 'qsr', 'en', 'IN');
    const managerPassword = bcrypt.hashSync('demo12345', 10);
    const changedPassword = bcrypt.hashSync('ChangedPass123!', 10);
    db.prepare('UPDATE users SET password = ?, is_active = 1, tokens_valid_after = NULL WHERE id = ?')
      .run(managerPassword, 'user-demo-manager');
    db.prepare('UPDATE users SET password = ?, is_active = 1, tokens_valid_after = NULL WHERE id = ?')
      .run(changedPassword, 'user-demo-cashier');
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run('unrelated-demo-password', 'Unrelated', 'unrelated@test.local', managerPassword, 'cashier', now(), now());

    const legacyToken = jwt.sign(
      { userId: 'user-demo-manager', email: 'manager@flo.local', role: 'manager' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );

    // Simulate a v47 database being opened by the v48 binary.
    db.pragma('user_version = 47');
    closeDatabase();
    initDatabase();
    const upgraded = getDatabase();

    const manager = upgraded.prepare('SELECT is_active, tokens_valid_after FROM users WHERE id = ?').get('user-demo-manager') as any;
    const cashier = upgraded.prepare('SELECT is_active FROM users WHERE id = ?').get('user-demo-cashier') as any;
    const unrelated = upgraded.prepare('SELECT is_active FROM users WHERE id = ?').get('unrelated-demo-password') as any;
    if (manager.is_active !== 0 || !manager.tokens_valid_after) throw new Error('legacy demo manager was not deactivated and invalidated');
    if (cashier.is_active !== 1) throw new Error('changed-password demo cashier was incorrectly deactivated');
    if (unrelated.is_active !== 1) throw new Error('unrelated user was incorrectly deactivated');
    console.log('  ✓ migration disables only the unchanged bundled demo credential');

    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    const server = await new Promise<any>((resolve) => {
      const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
      const authHeader = { Authorization: `Bearer ${legacyToken}` };
      for (const [pathName, options] of [
        ['/me', { headers: authHeader }],
        ['/refresh', { method: 'POST', headers: authHeader }],
        ['/password/change', {
          method: 'POST',
          headers: authHeader,
          body: JSON.stringify({ current_password: 'demo12345', password: 'NewPass123!' }),
        }],
      ] as const) {
        const response = await request(baseUrl, pathName, options);
        if (response.status !== 401) throw new Error(`${pathName} accepted a deactivated session (${response.status})`);
      }
      console.log('  ✓ existing manager sessions are rejected by me, refresh, and password change');

      const disabledLogin = await request(baseUrl, '/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'manager@flo.local', password: 'demo12345' }),
      });
      if (disabledLogin.status !== 401) throw new Error(`disabled demo login returned ${disabledLogin.status}`);

      const changedLogin = await request(baseUrl, '/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'cashier@flo.local', password: 'ChangedPass123!' }),
      });
      if (changedLogin.status !== 200) throw new Error(`changed demo password login returned ${changedLogin.status}`);
      const malformedPasswordChange = await request(baseUrl, '/password/change', {
        method: 'POST',
        headers: { Authorization: `Bearer ${changedLogin.data.access_token}` },
        body: JSON.stringify({ current_password: null, password: null }),
      });
      if (malformedPasswordChange.status !== 400) {
        throw new Error(`malformed password-change body returned ${malformedPasswordChange.status}`);
      }
      console.log('  ✓ disabled demo credentials cannot log in while changed credentials remain usable');
      console.log('  ✓ malformed password-change bodies return 400');
    } finally {
      server.close();
    }
  } finally {
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  console.log('6/6 passed');
}

main().catch((error: any) => {
  try { closeDatabase(); } catch {}
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
