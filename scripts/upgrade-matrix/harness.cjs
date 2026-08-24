/**
 * Shared driver for the runtime upgrade test matrix (#468).
 *
 * Drives a real installed FloCafe build through an in-app N -> N+1 upgrade:
 *
 *   install N -> seed identifiable data via the local Express API ->
 *   opt into the update channel -> wait for `ready-to-install` ->
 *   restart-and-install (Master-PIN gated IPC, exactly what the UI calls) ->
 *   verify version, data persistence, and updater logs after relaunch.
 *
 * The renderer is driven over the Chrome DevTools Protocol using the app's
 * own preload bridge (`window.electronAPI`), so every action goes through
 * the same IPC surface a user touches — no product code paths are special-
 * cased for tests.
 *
 * Dependency-free on purpose: Node 22 globals (fetch, WebSocket) only, so
 * the same script runs locally and inside GitHub-hosted runners.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const API_PORT = Number(process.env.FLO_API_PORT || 3001);

class HarnessError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(name, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new HarnessError(`Timed out after ${timeoutMs}ms waiting for ${name}` +
    (lastError ? `; last error: ${lastError.message}` : ''));
}

function apiRequest(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: pathname,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // non-JSON body — surface the raw text in the error below
          }
          if (res.statusCode >= 400) {
            reject(new HarnessError(`${method} ${pathname} -> ${res.statusCode}: ${text.slice(0, 300)}`));
          } else {
            resolve(json);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new HarnessError(`${method} ${pathname} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── CDP helpers ───────────────────────────────────────────────────────────────

let cdpMessageId = 0;

async function cdpEval(port, expression, timeoutMs = 20000) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  // Prefer the main POS window page; fall back to any page target.
  const pages = targets.filter((t) => t.type === 'page');
  if (pages.length === 0) throw new HarnessError(`No page targets on :${port}: ${JSON.stringify(targets)}`);
  const target = pages.find((t) => !/kds/i.test(t.title || t.url || '')) ?? pages[0];

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new HarnessError(`CDP websocket to ${target.webSocketDebuggerUrl} failed`)), { once: true });
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HarnessError(`CDP eval timed out: ${expression.slice(0, 80)}`)), timeoutMs);
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === undefined) return;
        clearTimeout(timer);
        if (msg.error) reject(new HarnessError(`CDP error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }, { once: true });
      ws.send(JSON.stringify({
        id: ++cdpMessageId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text || 'unknown exception';
      throw new HarnessError(`Renderer exception evaluating "${expression.slice(0, 80)}": ${detail}`);
    }
    return result.result?.value;
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

// ── App lifecycle helpers ─────────────────────────────────────────────────────

async function waitForApi(timeoutMs = 120000) {
  return waitFor(`Express API on :${API_PORT}`, timeoutMs, async () => {
    const status = await apiRequest('GET', '/api/health').catch(() =>
      apiRequest('GET', '/api/pos-info').catch(() => null));
    return status !== null ? status : undefined;
  });
}

/**
 * First-run setup plus the identifiable data seeds the matrix requires:
 * one order, one settings change, one printer config record. Idempotent per
 * fresh install (setup only works while zero users exist).
 */
async function setupAndSeed({ email, password, masterPin }) {
  const setupStatus = await apiRequest('GET', '/api/auth/setup/status');
  if (!setupStatus?.needsSetup) {
    throw new HarnessError('App reports setup already complete on a fresh install; refusing to run against unknown state');
  }
  await apiRequest('POST', '/api/auth/setup/initialize', {
    body: {
      name: 'Upgrade Matrix Bot',
      email,
      password,
      business_name: 'Matrix Test Store',
      store_name: 'Matrix Test Store',
      terms_accepted: true,
      master_pin: masterPin,
      country: 'IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    },
  });
  const login = await apiRequest('POST', '/api/auth/login', { body: { email, password } });
  const token = login.access_token;

  // POST responses are envelope-wrapped: {product}, {order}, {printer}.
  const productBody = await apiRequest('POST', '/api/products', {
    token,
    body: { name: `Persistence Probe ${Date.now()}`, price: 42, track_inventory: false },
  });
  const product = productBody.product ?? productBody;
  const orderBody = await apiRequest('POST', '/api/orders', {
    token,
    body: {
      type: 'takeaway',
      items: [{ product_id: product.id, quantity: 2 }],
      special_instructions: 'survives the 468 upgrade',
    },
  });
  const order = orderBody.order ?? orderBody;
  const printerBody = await apiRequest('POST', '/api/printers', {
    token,
    body: {
      name: 'Matrix Probe Printer',
      connection_type: 'network',
      ip_address: '192.0.2.10',
      port: 9100,
      paper_width: 'cols-48',
    },
  });
  const printer = printerBody.printer ?? printerBody;
  return { token, productId: product.id, orderId: order.id, printerId: printer.id };
}

/** Verify the seeded records survived the upgrade. Throws on any loss. */
async function verifySeeds(seeds, expectedVersion, { skipBetaPreference = false } = {}) {
  const problems = [];
  const appInfo = await cdpEval(DEBUG_PORT(), 'window.electronAPI.getAppInfo()');
  if (appInfo?.version !== expectedVersion) {
    problems.push(`running version is ${appInfo?.version}, expected ${expectedVersion}`);
  }

  const orderBody = await apiRequest('GET', `/api/orders/${seeds.orderId}`, { token: seeds.token }).catch((e) => {
    problems.push(`seeded order unreadable after upgrade: ${e.message}`);
    return null;
  });
  const order = orderBody?.order ?? orderBody;
  if (order && order.special_instructions !== 'survives the 468 upgrade') {
    problems.push(`seeded order lost its marker note: ${JSON.stringify(order.special_instructions)}`);
  }
  const printers = await apiRequest('GET', '/api/printers', { token: seeds.token }).catch(() => null);
  const printerList = Array.isArray(printers) ? printers : printers?.printers;
  if (!printerList?.some((p) => p.id === seeds.printerId)) {
    problems.push('seeded printer config missing after upgrade');
  }
  let betaCheck = skipBetaPreference
    ? 'SKIP (pre-toggle fixture; N predates beta preference)'
    : 'SKIP (build predates the beta-channel IPC)';
  if (!skipBetaPreference) {
    try {
      const betaEnabled = await cdpEval(DEBUG_PORT(), 'window.electronAPI.getBetaChannel()');
      if (betaEnabled !== true) {
        problems.push(`beta-channel preference did not persist across the upgrade (got ${JSON.stringify(betaEnabled)})`);
      } else {
        betaCheck = 'PASS';
      }
    } catch (error) {
      if (!/getBetaChannel is not a function/.test(error.message)) throw error;
    }
  }
  if (problems.length > 0) throw new HarnessError(`Post-upgrade verification failed:\n- ${problems.join('\n- ')}`);
  return { version: appInfo.version, betaCheck };
}

// Remote-debugging port; overridable so parallel rows never collide.
const debugPortOverride = process.env.FLO_DEBUG_PORT ? Number(process.env.FLO_DEBUG_PORT) : null;
function DEBUG_PORT() {
  return debugPortOverride ?? 9222;
}

/** Poll the renderer's update status until the staged update is ready. */
async function waitReadyToInstall({ expectedVersion, timeoutMs }) {
  const statuses = [];
  return waitFor(`ready-to-install (${expectedVersion ?? 'any'})`, timeoutMs, async () => {
    const status = await cdpEval(DEBUG_PORT(), 'window.electronAPI.getUpdateStatus()');
    statuses.push(`${new Date().toISOString()} ${status.status}${status.percent != null ? ` ${Number(status.percent).toFixed(1)}%` : ''}${status.version ? ` v${status.version}` : ''}${status.error ? ` error=${status.error}` : ''}`);
    if (process.env.FLO_STATUS_LOG) {
      fs.appendFileSync(process.env.FLO_STATUS_LOG, `${statuses.at(-1)}\n`);
    }
    if (status.status === 'ready-to-install') {
      if (expectedVersion && status.version && status.version !== expectedVersion) {
        throw new HarnessError(`Updater staged version ${status.version} but expected ${expectedVersion}`);
      }
      return status;
    }
    if (status.status === 'check-failed' && /manifest-missing/.test(status.reason || '')) {
      // Keep waiting — a transient feed race can still recover on a later poll.
      console.error(`[harness] manifest-missing so far: ${status.error}`);
    }
    return false;
  });
}

module.exports = {
  HarnessError,
  DEBUG_PORT,
  apiRequest,
  cdpEval,
  sleep,
  waitFor,
  waitForApi,
  setupAndSeed,
  verifySeeds,
  waitReadyToInstall,
};
