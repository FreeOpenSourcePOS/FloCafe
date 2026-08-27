const Module = require('node:module');
const bcrypt = require('bcryptjs');

const userDataDir = process.env.FLO_E2E_USER_DATA_DIR;
const ownerEmail = process.env.FLO_E2E_OWNER_EMAIL;
const ownerPassword = process.env.FLO_E2E_OWNER_PASSWORD;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: (name) => name === 'userData' ? userDataDir : userDataDir,
        getVersion: () => 'e2e',
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../dist/main/db');

try {
  if (!userDataDir || !process.env.FLO_E2E_DB_PATH || !ownerEmail || !ownerPassword) {
    throw new Error('Native E2E fixture requires isolated profile, database, and owner credentials');
  }

  initDatabase();
  const db = getDatabase();
  const createdAt = now();
  const settings = [
    ['business_name', 'Native E2E Cafe'],
    ['country', 'CA'],
    ['currency', 'CAD'],
    ['timezone', 'America/Toronto'],
    ['language', 'en'],
    ['business_type', 'restaurant'],
    ['service_model', 'qsr'],
    ['billing_type', 'prepaid'],
    ['tables_required', 'false'],
    ['kds_enabled', 'true'],
    ['whatsapp_enabled', 'false'],
    ['taxes_enabled', 'false'],
    ['cloud_sync_enabled', '0'],
    ['cloud_orders_enabled', '0'],
    ['cloud_reports_enabled', '0'],
    ['cloud_command_polling_enabled', '0'],
    ['cloud_services_disabled_by_user', 'true'],
    ['telemetry_enabled', 'false'],
    ['anonymous_data_consent', 'false'],
    ['diagnostics_consent', 'false'],
  ];
  const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [key, value] of settings) setting.run(key, value, createdAt);

  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, terms_accepted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    'native-e2e-owner',
    'Native E2E Owner',
    ownerEmail,
    bcrypt.hashSync(ownerPassword, 10),
    'owner',
    createdAt,
    createdAt,
    createdAt,
  );

  console.log('[Native E2E] Isolated database seeded');
} finally {
  try { closeDatabase(); } finally { Module._load = originalLoad; }
}
