import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken } from './helpers/test-auth';

const DEFAULT_LOCAL_EVIDENCE =
  '/Users/gurkiratkhaira/.no-mistakes/evidence/01M71NAA3AJKJCX81VZ1YA2HZ7';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  (fs.existsSync(path.dirname(DEFAULT_LOCAL_EVIDENCE))
    ? DEFAULT_LOCAL_EVIDENCE
    : path.join(os.tmpdir(), 'no-mistakes-evidence', '01M71NAA3AJKJCX81VZ1YA2HZ7'));

if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function ownerHeaders() {
  return {
    Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  };
}

async function loginViaUi(page: Page, email: string, password: string, baseUrl = E2E_BASE_URL) {
  await page.goto(`${baseUrl}/auth/login`);
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
    localStorage.removeItem('pos-settings');
  });
  await page.goto(`${baseUrl}/auth/login`);

  const passwordTab = page.getByRole('tab', { name: /password/i });
  try {
    await passwordTab.waitFor({ state: 'visible', timeout: 3000 });
    await passwordTab.click();
  } catch {}

  await expect(page.locator('#email')).toBeVisible();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15_000 });
}

test.describe
  .serial('Self-Service Password & PIN Change + Staff Credential Reset Live Scenarios', () => {
  test('Scenario 1: Self-service password change with current password across roles preserves active session', async ({
    page,
    request,
  }) => {
    // 1. Create a dedicated operational staff member (cashier)
    const cashierEmail = `cashier-live-${Date.now()}@flo.local`;
    const initialPassword = 'InitialPass123!';
    const updatedPassword = 'UpdatedPass456!';

    const createRes = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Live Cashier',
        email: cashierEmail,
        password: initialPassword,
        role: 'cashier',
      },
    });
    expect(createRes.status()).toBe(201);

    // 2. Sign in as cashier through the UI
    await loginViaUi(page, cashierEmail, initialPassword);

    // 3. Open user dropdown in sidebar and click "Change Password & PIN"
    const userMenuButton = page.locator('button:has(svg.lucide-user-circle)');
    await expect(userMenuButton).toBeVisible();
    await userMenuButton.click();

    const changeCredentialsButton = page.getByTestId('sidebar-change-credentials-button');
    await expect(changeCredentialsButton).toBeVisible();
    await changeCredentialsButton.click();

    // 4. Assert dialog opens
    const dialog = page.getByTestId('account-credentials-dialog');
    await expect(dialog).toBeVisible();

    // 5. Fill out password change form
    await page.getByTestId('self-current-password').fill(initialPassword);
    await page.getByTestId('self-new-password').fill(updatedPassword);
    await page.getByTestId('self-confirm-password').fill(updatedPassword);

    // Capture visual evidence of filled form
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-1-password-change-modal.png'),
    });

    // 6. Submit
    await page.getByTestId('self-password-submit').click();

    // Dialog closes upon success
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // 7. Verify session remains fully authenticated without re-login
    await page.goto(`${E2E_BASE_URL}/orders`);
    expect(page.url()).toContain('/orders');

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-1-authenticated-session-preserved.png'),
    });

    // 8. Verify old password rejected and new password accepted via API
    const oldLogin = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
      data: { email: cashierEmail, password: initialPassword },
    });
    expect(oldLogin.status()).toBe(401);

    const newLogin = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
      data: { email: cashierEmail, password: updatedPassword },
    });
    expect(newLogin.status()).toBe(200);
    const newBody = await newLogin.json();
    expect(newBody.access_token).toBeTruthy();
  });

  test('Scenario 2: Self-service PIN change and initial PIN setup across roles enable quick switch', async ({
    page,
    request,
  }) => {
    // 1. Create a dedicated operational waiter without a PIN
    const waiterEmail = `waiter-live-${Date.now()}@flo.local`;
    const waiterPassword = 'WaiterPassword1!';
    const initialPin = '1234';
    const rotatedPin = '987654';

    const createRes = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Live Waiter',
        email: waiterEmail,
        password: waiterPassword,
        role: 'server',
      },
    });
    expect(createRes.status()).toBe(201);
    const createdUser = (await createRes.json()).staff;

    // 2. Sign in through UI
    await loginViaUi(page, waiterEmail, waiterPassword);

    // 3. Open credentials modal
    const userMenuButton = page.locator('button:has(svg.lucide-user-circle)');
    await expect(userMenuButton).toBeVisible();
    await userMenuButton.click();
    await page.getByTestId('sidebar-change-credentials-button').click();

    const dialog = page.getByTestId('account-credentials-dialog');
    await expect(dialog).toBeVisible();

    // 4. Click PIN tab
    await page.getByTestId('credentials-tab-pin').click();

    // User has no PIN yet -> First time notice should be visible, asking for current password
    await expect(page.getByTestId('first-time-pin-notice')).toBeVisible();
    await expect(page.getByTestId('self-pin-current-password')).toBeVisible();
    await expect(page.getByTestId('self-current-pin')).toBeHidden();

    // Fill initial PIN setup
    await page.getByTestId('self-pin-current-password').fill(waiterPassword);
    await page.getByTestId('self-new-pin').fill(initialPin);
    await page.getByTestId('self-confirm-pin').fill(initialPin);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-2-first-time-pin-setup.png'),
    });

    await page.getByTestId('self-pin-submit').click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // 5. Re-open credentials modal to rotate PIN
    await userMenuButton.click();
    await page.getByTestId('sidebar-change-credentials-button').click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('credentials-tab-pin').click();

    // Now user has PIN -> should request current PIN, NOT current password!
    await expect(page.getByTestId('first-time-pin-notice')).toBeHidden();
    await expect(page.getByTestId('self-current-pin')).toBeVisible();
    await expect(page.getByTestId('self-pin-current-password')).toBeHidden();

    // Rotate to 6-digit PIN
    await page.getByTestId('self-current-pin').fill(initialPin);
    await page.getByTestId('self-new-pin').fill(rotatedPin);
    await page.getByTestId('self-confirm-pin').fill(rotatedPin);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-2-pin-change-modal.png'),
    });

    await page.getByTestId('self-pin-submit').click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // 6. Verify PIN login: old PIN rejected, rotated 6-digit PIN accepted!
    const oldPinRes = await request.post(`${E2E_BASE_URL}/api/auth/pin-login`, {
      data: { user_id: createdUser.id, pin: initialPin },
    });
    expect(oldPinRes.status()).toBe(401);

    const newPinRes = await request.post(`${E2E_BASE_URL}/api/auth/pin-login`, {
      data: { user_id: createdUser.id, pin: rotatedPin },
    });
    expect(newPinRes.status()).toBe(200);
    const pinBody = await newPinRes.json();
    expect(pinBody.user.has_pin).toBe(true);
  });

  test('Scenario 3: Adversarial credential validation and 5-attempt rate-limit lockout', async ({
    page,
    request,
  }) => {
    // 1. Create a dedicated staff user with a known PIN
    const attackerEmail = `locked-staff-${Date.now()}@flo.local`;
    const attackerPassword = 'SecurePassword123!';
    const currentPin = '5555';

    const createRes = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Rate Limited User',
        email: attackerEmail,
        password: attackerPassword,
        role: 'cashier',
        pin: currentPin,
      },
    });
    expect(createRes.status()).toBe(201);

    // 2. Sign in as the user
    await loginViaUi(page, attackerEmail, attackerPassword);

    // 3. Open credentials modal
    const userMenuButton = page.locator('button:has(svg.lucide-user-circle)');
    await expect(userMenuButton).toBeVisible();
    await userMenuButton.click();
    await page.getByTestId('sidebar-change-credentials-button').click();
    const dialog = page.getByTestId('account-credentials-dialog');
    await expect(dialog).toBeVisible();

    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
    page.on('response', (res) => {
      if (res.status() >= 400) {
        console.log(`[HTTP ${res.status()}] ${res.url()}`);
      }
    });

    // 4. Test password adversarial cases:
    // a) Wrong current password
    await page.getByTestId('self-current-password').fill('CompletelyWrongPass1!');
    await page.getByTestId('self-new-password').fill('NewValidPass123!');
    await page.getByTestId('self-confirm-password').fill('NewValidPass123!');
    await page.getByTestId('self-password-submit').click();
    await expect(page.getByTestId('self-password-error')).toBeVisible();
    await expect(dialog).toBeVisible();

    // Verify error text mentions incorrect password
    const errorText = await page.getByTestId('self-password-error').textContent();
    console.log('STEP A ERROR TEXT:', errorText);

    // b) Weak new password (< 4 characters)
    await page.getByTestId('self-current-password').fill(attackerPassword);
    await page.getByTestId('self-new-password').fill('123');
    await page.getByTestId('self-confirm-password').fill('123');
    await page.getByTestId('self-password-submit').click();
    await expect(page.getByTestId('self-password-error')).toBeVisible();

    // c) Mismatched confirmation password
    await page.getByTestId('self-new-password').fill('ValidPass123!');
    await page.getByTestId('self-confirm-password').fill('DifferentPass456!');
    await page.getByTestId('self-password-submit').click();
    await expect(page.getByTestId('self-password-error')).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-3-credential-validation-errors.png'),
    });

    // 5. Test PIN adversarial cases:
    await page.getByTestId('credentials-tab-pin').click();

    // Try wrong PIN repeatedly to exercise per-user rate limit countdown and lockout
    for (let i = 1; i <= 5; i++) {
      await page.getByTestId('self-current-pin').fill(`000${i}`);
      await page.getByTestId('self-new-pin').fill('9999');
      await page.getByTestId('self-confirm-pin').fill('9999');
      await page.getByTestId('self-pin-submit').click();
      await expect(page.getByTestId('self-pin-error')).toBeVisible();
    }

    // 6th attempt should display lockout message
    await page.getByTestId('self-current-pin').fill(currentPin); // even with correct PIN!
    await page.getByTestId('self-new-pin').fill('9999');
    await page.getByTestId('self-confirm-pin').fill('9999');
    await page.getByTestId('self-pin-submit').click();
    await expect(page.getByTestId('self-pin-error')).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-3-lockout-rate-limit.png'),
    });

    // 6. Verify other users on the terminal are unaffected
    const otherUserLogin = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
      data: { email: 'manager@flo.local', password: E2E_PASSWORD },
    });
    expect(otherUserLogin.status()).toBe(200);
  });

  test('Scenario 4: Self-service credential management on Standalone KDS (:3102) and Server App (:3103)', async ({
    page,
    request,
  }) => {
    // 1. Create a dedicated chef and server
    const chefEmail = `chef-kds-${Date.now()}@flo.local`;
    const chefPassword = 'ChefPassword123!';
    const createChef = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: { name: 'KDS Chef', email: chefEmail, password: chefPassword, role: 'chef' },
    });
    expect(createChef.status()).toBe(201);

    const waiterEmail = `waiter-sa-${Date.now()}@flo.local`;
    const waiterPassword = 'WaiterPassword123!';
    const createWaiter = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Server App Waiter',
        email: waiterEmail,
        password: waiterPassword,
        role: 'server',
      },
    });
    expect(createWaiter.status()).toBe(201);

    // 2. Drive Standalone KDS (:3102)
    await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
    await page.getByTestId('kds-login-email').fill(chefEmail);
    await page.getByTestId('kds-login-password').fill(chefPassword);
    await page.getByTestId('kds-login-submit').click();
    await expect(page.getByTestId('kds-workspace')).toBeVisible();

    // Locate KeyRound button on KDS top header
    const kdsCredButton = page.getByTestId('kds-change-credentials-button');
    await expect(kdsCredButton).toBeVisible();
    await kdsCredButton.click();

    const kdsDialog = page.getByTestId('account-credentials-dialog');
    await expect(kdsDialog).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-4-kds-credentials-dialog.png'),
    });

    // Chef sets initial PIN on KDS
    await page.getByTestId('credentials-tab-pin').click();
    await page.getByTestId('self-pin-current-password').fill(chefPassword);
    await page.getByTestId('self-new-pin').fill('7788');
    await page.getByTestId('self-confirm-pin').fill('7788');
    await page.getByTestId('self-pin-submit').click();
    await expect(kdsDialog).toBeHidden({ timeout: 10_000 });

    // KDS workspace remains fully active
    await expect(page.getByTestId('kds-workspace')).toBeVisible();

    // 3. Drive Standalone Server App (:3103)
    await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
    // Sign in on server app
    const saLoginRes = await request.post(`${E2E_SERVER_APP_BASE_URL}/api/auth/login`, {
      data: { email: waiterEmail, password: waiterPassword },
    });
    expect(saLoginRes.status()).toBe(200);
    const saToken = (await saLoginRes.json()).access_token;

    await page.evaluate(
      ([tok]) => {
        localStorage.setItem('flocafe:server-app-token', tok);
        localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'en' } }));
      },
      [saToken],
    );
    await page.reload();

    const saCredButton = page.getByTestId('server-app-change-credentials-button');
    await expect(saCredButton).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-4-server-app-header.png'),
    });

    await saCredButton.click();
    const saDialog = page.getByTestId('account-credentials-dialog');
    await expect(saDialog).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-4-server-app-credentials-dialog.png'),
    });

    // Waiter changes password on Server App
    const updatedWaiterPassword = 'UpdatedWaiterPass1!';
    await page.getByTestId('self-current-password').fill(waiterPassword);
    await page.getByTestId('self-new-password').fill(updatedWaiterPassword);
    await page.getByTestId('self-confirm-password').fill(updatedWaiterPassword);
    await page.getByTestId('self-password-submit').click();
    await expect(saDialog).toBeHidden({ timeout: 10_000 });

    // Verify localStorage has fresh token
    const storedToken = await page.evaluate(() => localStorage.getItem('flocafe:server-app-token'));
    expect(storedToken).toBeTruthy();
    expect(storedToken).not.toBe(saToken);
  });

  test('Scenario 5: Owner administrator resets forgotten password and PIN for any role without current credentials', async ({
    page,
    request,
  }) => {
    // 1. Create a staff member with existing credentials
    const targetEmail = `forgotten-staff-${Date.now()}@flo.local`;
    const createRes = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Forgotten Staff',
        email: targetEmail,
        password: 'OriginalPassword1!',
        role: 'server',
        pin: '1122',
      },
    });
    expect(createRes.status()).toBe(201);
    const targetStaff = (await createRes.json()).staff;

    // 2. Owner logs in and goes to /staff
    await loginViaUi(page, 'owner@flo.local', E2E_PASSWORD);
    await page.goto(`${E2E_BASE_URL}/staff`);
    await expect(page.getByText('Forgotten Staff')).toBeVisible();

    // 3. Locate target staff and click Reset PW
    const staffCard = page.locator('.bg-card').filter({ hasText: targetEmail });
    await expect(staffCard).toBeVisible();
    const resetPwButton = staffCard.getByRole('button', { name: 'Reset PW' });
    await expect(resetPwButton).toBeVisible();
    await resetPwButton.click();

    // Assert Reset Password modal is open
    const resetPwModal = page.locator('#reset-password-modal-title').locator('..').locator('..');
    await expect(page.locator('#reset-password-modal-title')).toBeVisible();
    const ownerResetPassword = 'OwnerResetPassword123!';
    await resetPwModal.locator('input').first().fill(ownerResetPassword);
    await resetPwModal.locator('input').nth(1).fill(ownerResetPassword);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-5-owner-reset-password-modal.png'),
    });

    await resetPwModal.getByRole('button', { name: 'Reset Password' }).click();
    await expect(page.locator('#reset-password-modal-title')).toBeHidden({ timeout: 10_000 });

    // 4. Click Reset PIN
    const resetPinButton = staffCard.getByRole('button', { name: 'Reset PIN' });
    await expect(resetPinButton).toBeVisible();
    await resetPinButton.click();

    const resetPinModal = page.locator('#reset-pin-modal-title').locator('..').locator('..');
    await expect(page.locator('#reset-pin-modal-title')).toBeVisible();
    const ownerResetPin = '9900';
    await resetPinModal.locator('input').first().fill(ownerResetPin);
    await resetPinModal.locator('input').nth(1).fill(ownerResetPin);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-5-owner-reset-pin-modal.png'),
    });

    await resetPinModal.getByRole('button', { name: 'Reset PIN' }).click();
    await expect(page.locator('#reset-pin-modal-title')).toBeHidden({ timeout: 10_000 });

    // 5. Verify target staff member can log in with owner-assigned credentials immediately
    const loginWithNewPw = await request.post(`${E2E_BASE_URL}/api/auth/login`, {
      data: { email: targetEmail, password: ownerResetPassword },
    });
    expect(loginWithNewPw.status()).toBe(200);

    const loginWithNewPin = await request.post(`${E2E_BASE_URL}/api/auth/pin-login`, {
      data: { user_id: targetStaff.id, pin: ownerResetPin },
    });
    expect(loginWithNewPin.status()).toBe(200);
  });

  test('Scenario 6: Manager credential reset restriction by default and permission-gated access', async ({
    page,
    request,
  }) => {
    // 1. Create an operational staff member
    const opEmail = `op-staff-${Date.now()}@flo.local`;
    const createRes = await request.post(`${E2E_BASE_URL}/api/staff`, {
      headers: ownerHeaders(),
      data: {
        name: 'Operational Chef',
        email: opEmail,
        password: 'InitialChefPass1!',
        role: 'chef',
        pin: '3456',
      },
    });
    expect(createRes.status()).toBe(201);
    const opStaff = (await createRes.json()).staff;

    // 2. Manager logs in and navigates to /staff
    await loginViaUi(page, 'manager@flo.local', E2E_PASSWORD);
    await page.goto(`${E2E_BASE_URL}/staff`);
    await expect(page.getByText('Operational Chef')).toBeVisible();

    const opStaffCard = page.locator('.bg-card').filter({ hasText: opEmail });

    // In default state, canResetCredentials is false for manager -> Reset buttons must NOT be present
    const resetPwButtons = opStaffCard.getByRole('button', { name: 'Reset PW' });
    expect(await resetPwButtons.count()).toBe(0);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-6-manager-default-no-credential-reset.png'),
    });

    // Manager API attempt to reset credentials returns 403 staff.credentials.reset
    const mgrToken = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
    const directResetRes = await request.put(`${E2E_BASE_URL}/api/staff/${opStaff.id}`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
      data: { password: 'IllegalManagerPassword1!' },
    });
    expect(directResetRes.status()).toBe(403);
    const errBody = await directResetRes.json();
    expect(errBody.permission).toBe('staff.credentials.reset');

    // 3. Owner grants staff.credentials.reset to manager role
    const getRoles = await request.get(`${E2E_BASE_URL}/api/authorization/roles`, {
      headers: ownerHeaders(),
    });
    const rolesData = await getRoles.json();
    const mgrRevision = rolesData.roles.find(
      (r: { role: string; revision?: string }) => r.role === 'manager',
    )?.revision;

    const grantRes = await request.put(`${E2E_BASE_URL}/api/authorization/roles/manager`, {
      headers: ownerHeaders(),
      data: {
        revision: mgrRevision,
        overrides: [{ permission_id: 'staff.credentials.reset', effect: 'allow' }],
      },
    });
    expect(grantRes.status()).toBe(200);

    // 4. Manager reloads /staff: Reset buttons ARE now visible!
    await page.reload();
    await expect(page.getByText('Operational Chef')).toBeVisible();

    const updatedCard = page.locator('.bg-card').filter({ hasText: opEmail });
    const enabledResetPw = updatedCard.getByRole('button', { name: 'Reset PW' });
    await expect(enabledResetPw).toBeVisible();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, 'scenario-6-manager-permission-granted-reset.png'),
    });

    // 5. Manager resets operational staff credentials -> SUT accepts it
    const mgrResetRes = await request.put(`${E2E_BASE_URL}/api/staff/${opStaff.id}`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
      data: { password: 'ManagerGrantedPass1!', pin: '7799' },
    });
    expect(mgrResetRes.status()).toBe(200);

    // 6. Adversarial check: Manager can NEVER reset Owner credentials, even with staff.credentials.reset!
    const mgrHackOwner = await request.put(`${E2E_BASE_URL}/api/staff/e2e-owner`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
      data: { password: 'CompromisedOwnerPass1!' },
    });
    expect(mgrHackOwner.status()).toBe(403);
  });
});
