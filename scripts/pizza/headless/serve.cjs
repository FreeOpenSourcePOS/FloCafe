#!/usr/bin/env node
// What the service unit runs: takes the data folder's lock, shared, before anything opens the
// database, then loads the server into this same process, so the lock lasts as long as it does.
const path = require('node:path');
const { repoRoot, config, dataLock } = require('./common.cjs');

// What decides where the database and the app's own backup folders are, and the ports. Each stays
// as the unit set it; FLO_E2E_DB_PATH stays unset (common.cjs clears it).
const PINNED = [
  'FLO_DEV_USER_DATA',
  'FLO_E2E_DB_PATH',
  'HOME',
  'PORT',
  'KDS_PORT',
  'SERVER_APP_PORT',
];

try {
  const dataDir = path.resolve(config('FLO_DEV_USER_DATA').FLO_DEV_USER_DATA);
  process.env.FLO_DEV_USER_DATA = dataDir;
  dataLock(dataDir, 'shared');
} catch (error) {
  console.error(`ERROR: ${error?.message ?? error}`);
  process.exit(1);
}
// dev-server.js loads a .env from the repository folder over the environment. The unit's
// settings stay as they are, so the server opens the database in the folder locked above.
const ignored = (name) => console.warn(`[headless] ignored a change to ${name}`);
process.env = new Proxy(process.env, {
  set(env, name, value) {
    if (!PINNED.includes(name)) return Reflect.set(env, name, value);
    if (env[name] !== String(value)) ignored(name);
    return true;
  },
  defineProperty(env, name, descriptor) {
    if (!PINNED.includes(name)) return Reflect.defineProperty(env, name, descriptor);
    ignored(name);
    return true;
  },
  deleteProperty(env, name) {
    if (!PINNED.includes(name)) return Reflect.deleteProperty(env, name);
    ignored(name);
    return true;
  },
});
require(path.join(repoRoot, 'dev-server.js'));
