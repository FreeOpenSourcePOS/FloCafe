import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

interface LocalBackupEntry {
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'auto' | 'manual';
  schemaVersion: number;
}

interface RemoteBackupEntry {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  created_at: string;
  kind: 'automatic' | 'manual';
  schema_version: number;
  app_version: string;
  destination_folder_id: string;
  compatible: boolean;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    createdAt: string;
    id: string;
  };
}

function buildLocalBackups(): LocalBackupEntry[] {
  return Array.from({ length: 16 }, (_, idx) => {
    const seq = 16 - idx;
    const padded = String(seq).padStart(2, '0');
    const fileName = `flo-backup-${seq % 2 === 0 ? 'manual' : 'auto'}-2026-03-${padded}T12-00-00-000Z.db`;
    return {
      fileName,
      path: `/tmp/backups/${fileName}`,
      sizeBytes: 1024 * 128 + seq * 10240,
      createdAt: `2026-03-${padded}T12:00:00.000Z`,
      kind: seq % 2 === 0 ? 'manual' : 'auto',
      schemaVersion: 85,
    };
  });
}

function buildRemoteBackups(): RemoteBackupEntry[] {
  return Array.from({ length: 16 }, (_, idx) => {
    const seq = 16 - idx;
    const padded = String(seq).padStart(2, '0');
    return {
      id: `drive-file-${padded}`,
      name: `flo-backup-drive-${padded}.db`,
      bytes: 1024 * 256 + seq * 10240,
      sha256: 'a'.repeat(64),
      created_at: `2026-03-${padded}T12:00:00.000Z`,
      kind: seq % 2 === 0 ? 'manual' : 'automatic',
      schema_version: 85,
      app_version: '3.13.0',
      destination_folder_id: 'folder-a',
      compatible: true,
    };
  });
}

async function setupMockedSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'backup-pagination-e2e-token');
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'e2e-owner',
            name: 'E2E Owner',
            email: 'owner@flo.local',
            role: 'owner',
            category_ids: [],
          },
          tenants: [
            {
              id: 1,
              business_name: 'E2E Cafe',
              role: 'owner',
              plan: 'free',
              status: 'active',
              business_type: 'restaurant',
              language: 'en',
            },
          ],
        }),
      });
      return;
    }
    if (pathname === '/api/db-tools/master-pin/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true, isSet: true, schemaVersion: 85 }),
      });
      return;
    }
    if (pathname === '/api/settings/google-drive') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: true,
          auth_state: 'connected',
          secure_storage_available: true,
          connected: true,
          account_email: 'owner@flo.local',
          destination_folder_id: 'folder-a',
          destination_folder_name: 'FloCafe Backups',
          frequency: 'daily',
          retention_count: 7,
          last_backup_at: '2026-03-01T12:00:16.000Z',
          last_backup_status: 'success',
          last_error: null,
          warning_acknowledged: true,
          warning_required: false,
        }),
      });
      return;
    }
    if (pathname === '/api/settings/google-drive/destinations') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          destinations: [{ id: 'folder-a', name: 'FloCafe Backups', current: true }],
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('Settings -> Database paginates local and Google Drive backup history independently with recoverable error state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setupMockedSession(page);

  const allLocalBackups = buildLocalBackups();
  const allRemoteBackups = buildRemoteBackups();
  const localRequests: string[] = [];
  const remoteRequests: string[] = [];
  let failNextRemoteLoadMore = false;

  await page.route('**/api/db-tools/backups*', async (route) => {
    const url = new URL(route.request().url());
    localRequests.push(`${url.pathname}${url.search}`);
    const limitParam = url.searchParams.get('limit');
    const cursorParam = url.searchParams.get('cursor');

    let candidates = [...allLocalBackups];
    if (cursorParam) {
      const cursor = decodeCursor(cursorParam);
      candidates = candidates.filter(
        (entry) =>
          entry.createdAt < cursor.createdAt ||
          (entry.createdAt === cursor.createdAt && entry.fileName < cursor.id),
      );
    }

    if (!limitParam) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ backups: candidates, nextCursor: null, hasMore: false }),
      });
      return;
    }

    const limit = Number(limitParam);
    const slice = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const last = slice[slice.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.fileName) : null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ backups: slice, nextCursor, hasMore }),
    });
  });

  await page.route('**/api/settings/google-drive/backups*', async (route) => {
    const url = new URL(route.request().url());
    remoteRequests.push(`${url.pathname}${url.search}`);
    const limitParam = url.searchParams.get('limit');
    const cursorParam = url.searchParams.get('cursor');

    if (cursorParam && failNextRemoteLoadMore) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Could not load remote Drive backups', code: 'offline' }),
      });
      return;
    }

    let candidates = [...allRemoteBackups];
    if (cursorParam) {
      const cursor = decodeCursor(cursorParam);
      candidates = candidates.filter(
        (entry) =>
          entry.created_at < cursor.createdAt ||
          (entry.created_at === cursor.createdAt && entry.id < cursor.id),
      );
    }

    if (!limitParam) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ backups: candidates, nextCursor: null, hasMore: false }),
      });
      return;
    }

    const limit = Number(limitParam);
    const slice = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const last = slice[slice.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ backups: slice, nextCursor, hasMore }),
    });
  });

  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20000 });
  await page.goto(`${BASE}/settings?tab=data`);
  await expect(page.getByRole('heading', { name: 'Backup & Data', exact: true })).toBeVisible();

  await expect.poll(() => localRequests).toEqual(['/api/db-tools/backups?limit=5']);
  await expect.poll(() => remoteRequests).toEqual(['/api/settings/google-drive/backups?limit=5']);

  const localRows = page.getByTestId('local-backup-row');
  const remoteRows = page.getByTestId('remote-backup-row');
  await expect(localRows).toHaveCount(5);
  await expect(localRows.nth(0)).toHaveAttribute(
    'data-backup-filename',
    allLocalBackups[0].fileName,
  );
  await expect(localRows.nth(4)).toHaveAttribute(
    'data-backup-filename',
    allLocalBackups[4].fileName,
  );

  await expect(remoteRows).toHaveCount(5);
  await expect(page.getByText(allRemoteBackups[0].name, { exact: true })).toBeVisible();
  await expect(page.getByText(allRemoteBackups[4].name, { exact: true })).toBeVisible();
  await expect(page.getByText(allRemoteBackups[5].name, { exact: true })).toHaveCount(0);

  const localLoadMoreButton = page.getByTestId('local-backups-load-more');
  const remoteLoadMoreButton = page.getByTestId('remote-backups-load-more');
  await expect(localLoadMoreButton).toBeVisible();
  await expect(remoteLoadMoreButton).toBeVisible();

  const screenshotDir = process.env.BACKUP_PAGINATION_SCREENSHOT_DIR;
  if (screenshotDir && fs.existsSync(screenshotDir)) {
    await localLoadMoreButton.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, '01-initial-5-rows.png'),
      fullPage: true,
    });
  }

  await localLoadMoreButton.click();
  await expect.poll(() => localRequests.length).toBe(2);
  expect(localRequests[1]).toContain('/api/db-tools/backups?limit=10&cursor=');
  expect(remoteRequests).toEqual(['/api/settings/google-drive/backups?limit=5']);

  await expect(localRows).toHaveCount(15);
  await expect(localRows.nth(5)).toHaveAttribute(
    'data-backup-filename',
    allLocalBackups[5].fileName,
  );
  await expect(localRows.nth(14)).toHaveAttribute(
    'data-backup-filename',
    allLocalBackups[14].fileName,
  );
  await expect(localLoadMoreButton).toBeVisible();

  if (screenshotDir && fs.existsSync(screenshotDir)) {
    await localLoadMoreButton.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(screenshotDir, '02-local-loaded-more-15-rows.png'),
      fullPage: true,
    });
  }

  await localLoadMoreButton.click();
  await expect.poll(() => localRequests.length).toBe(3);
  await expect(localRows).toHaveCount(16);
  await expect(localRows.nth(15)).toHaveAttribute(
    'data-backup-filename',
    allLocalBackups[15].fileName,
  );
  await expect(localLoadMoreButton).toHaveCount(0);

  failNextRemoteLoadMore = true;
  await remoteLoadMoreButton.click();
  await expect.poll(() => remoteRequests.length).toBe(2);
  expect(remoteRequests[1]).toContain('/api/settings/google-drive/backups?limit=10&cursor=');

  await expect(remoteRows).toHaveCount(5);
  await expect(page.getByText(allRemoteBackups[0].name, { exact: true })).toBeVisible();
  await expect(page.getByText(allRemoteBackups[4].name, { exact: true })).toBeVisible();
  await expect(page.getByText(allRemoteBackups[5].name, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('remote-backups-load-more-error')).toBeVisible();
  await expect(remoteLoadMoreButton).toBeVisible();
  await expect(remoteLoadMoreButton).toBeEnabled();

  if (screenshotDir && fs.existsSync(screenshotDir)) {
    await page.screenshot({
      path: path.join(screenshotDir, '03-drive-load-more-error-preserved-rows.png'),
      fullPage: true,
    });
  }

  failNextRemoteLoadMore = false;
  await remoteLoadMoreButton.click();
  await expect.poll(() => remoteRequests.length).toBe(3);
  expect(remoteRequests[2]).toBe(remoteRequests[1]);
  await expect(page.getByTestId('remote-backups-load-more-error')).toHaveCount(0);
  await expect(remoteRows).toHaveCount(15);
  await expect(page.getByText(allRemoteBackups[5].name, { exact: true })).toBeVisible();
  await expect(page.getByText(allRemoteBackups[14].name, { exact: true })).toBeVisible();
  await expect(page.getByText(allRemoteBackups[15].name, { exact: true })).toHaveCount(0);

  await remoteLoadMoreButton.click();
  await expect.poll(() => remoteRequests.length).toBe(4);
  await expect(remoteRows).toHaveCount(16);
  await expect(page.getByText(allRemoteBackups[15].name, { exact: true })).toBeVisible();
  await expect(remoteLoadMoreButton).toHaveCount(0);

  if (screenshotDir && fs.existsSync(screenshotDir)) {
    await page.screenshot({
      path: path.join(screenshotDir, '04-drive-retry-success-all-loaded.png'),
      fullPage: true,
    });
  }
});
