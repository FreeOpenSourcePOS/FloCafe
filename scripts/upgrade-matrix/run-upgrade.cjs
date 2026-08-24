#!/usr/bin/env node
/**
 * Phase driver for one row of the runtime upgrade matrix (#468).
 *
 * Two phases, invoked separately so platform-specific install/launch/process
 * handling stays in the caller (workflow steps or a local shell):
 *
 *   seed    — while release N is running: complete first-run setup, create
 *             identifiable data (order / settings / printer config), opt into
 *             the update channel, wait for the staged update, then invoke the
 *             exact IPC the UI's "Restart Now" button uses (restart-and-install,
 *             Master-PIN gated). Exits once the app begins quitting to install.
 *
 *   verify  — after the upgraded build has been launched again: assert the
 *             running version, that every seeded record survived, and that the
 *             persisted beta-channel preference survived. Prints an evidence
 *             JSON document on success.
 *
 * Dependency-free (Node 22 globals only). See harness.cjs for the shared
 * helpers.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  HarnessError,
  DEBUG_PORT,
  apiRequest,
  cdpEval,
  sleep,
  waitForApi,
  setupAndSeed,
  verifySeeds,
  waitReadyToInstall,
} = require('./harness.cjs');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      args._.push(key);
      continue;
    }
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i++;
    }
  }
  return args;
}

async function phaseSeed(args) {
  const seedsPath = path.resolve(args['seed-file']);
  const email = args.email || 'matrix-bot@flocafe.invalid';
  const password = args.password;
  const masterPin = args.pin;
  const channel = args.channel || 'beta';
  // Old-cohort rows upgrade through whatever feed their build follows; only
  // require an explicit version assertion when one is provided.
  const expectedVersion = args['expected-version'] || null;

  await waitForApi(Number(args['api-timeout'] || 180000));
  console.error('[seed] API is up; completing setup + seeding identifiable data');
  const seeds = await setupAndSeed({ email, password, masterPin });
  fs.writeFileSync(seedsPath, JSON.stringify({ ...seeds, email, password, masterPin }, null, 2));
  console.error(`[seed] seeded order=${seeds.orderId} product=${seeds.productId} printer=${seeds.printerId}`);

  if (channel === 'beta') {
    if (args['pre-toggle-fixture']) {
      // Pre-#507 builds (e.g. released 3.3.0) have no beta toggle IPC; the
      // opt-in is simulated in the installed fixture's updater setup, so
      // this phase only needs to trigger the check.
      await cdpEval(DEBUG_PORT(), 'window.electronAPI.checkForUpdates()');
      console.error('[seed] pre-toggle fixture: triggered update check against the patched beta feed');
    } else {
      const result = await cdpEval(DEBUG_PORT(), 'window.electronAPI.setBetaChannel(true)');
      if (!result?.success) {
        throw new HarnessError(`set-beta-channel failed: ${JSON.stringify(result)}`);
      }
      console.error('[seed] opted into the beta channel; updater re-checking against the beta feed now');
    }
  } else {
    await cdpEval(DEBUG_PORT(), 'window.electronAPI.checkForUpdates()');
    console.error('[seed] triggered a manual update check against the stable feed');
  }

  const readyTimeoutMs = Number(args['ready-timeout'] || 900000);
  const status = await waitReadyToInstall({ expectedVersion, timeoutMs: readyTimeoutMs });
  console.error(`[seed] staged ${status.version}; invoking restart-and-install`);

  const pinArg = masterPin ? `'${masterPin}'` : '';
  // Current builds answer {success:true}; legacy cohorts (2.9.x) return
  // undefined on success — treat an explicit failure object as the only error.
  const installResult = await cdpEval(
    DEBUG_PORT(),
    `window.electronAPI.restartAndInstall(${pinArg}).then(r => r).catch(e => ({ success: false, error: String(e) }))`
  );
  if (installResult && installResult.success === false) {
    throw new HarnessError(`restart-and-install failed: ${JSON.stringify(installResult)}`);
  }
  console.error('[seed] restart-and-install accepted; app is quitting to apply the update');
}

async function phaseVerify(args) {
  const seedsPath = path.resolve(args['seed-file']);
  const seeds = JSON.parse(fs.readFileSync(seedsPath, 'utf8'));
  const expectedVersion = args['expected-version'];
  if (!expectedVersion) throw new HarnessError('--expected-version is required for the verify phase');

  await waitForApi(Number(args['api-timeout'] || 300000));
  // Give the renderer a moment to expose its preload bridge after boot.
  await sleep(5000);
  const skipBetaPreference = Boolean(args['pre-toggle-fixture'] || args['skip-beta-preference']);
  const { version: runningVersion, betaCheck } = await verifySeeds(seeds, expectedVersion, {
    skipBetaPreference,
    skipBetaPreferenceReason: args['pre-toggle-fixture']
      ? 'pre-toggle fixture; N predates beta preference'
      : 'stable-channel row; beta preference not in scope',
  });

  const evidence = {
    row: args.row || 'unspecified',
    from_version: seeds.from_version || 'unknown',
    to_version: runningVersion,
    verified_at: new Date().toISOString(),
    seeds: {
      order_id: seeds.orderId,
      product_id: seeds.productId,
      printer_id: seeds.printerId,
    },
    checks: {
      version_after_relaunch: 'PASS',
      order_persisted: 'PASS',
      printer_config_persisted: 'PASS',
      settings_persisted: betaCheck,
    },
  };
  console.log(JSON.stringify(evidence, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args._[0];
  try {
    if (phase === 'seed') await phaseSeed(args);
    else if (phase === 'verify') await phaseVerify(args);
    else throw new HarnessError('usage: run-upgrade.cjs <seed|verify> [options]');
  } catch (error) {
    console.error(`[run-upgrade:${phase}] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
