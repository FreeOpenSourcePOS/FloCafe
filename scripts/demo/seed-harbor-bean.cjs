'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

function now() {
  return new Date().toISOString();
}

function installTaxPack(db, pack) {
  const installedAt = now();
  const versionId = `${pack.id}@${pack.version}`;
  const packJson = JSON.stringify(pack);

  db.prepare(`
    INSERT INTO country_packs (
      id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      publisher = excluded.publisher,
      country = excluded.country,
      jurisdiction = excluded.jurisdiction,
      active_version_id = excluded.active_version_id,
      status = 'active',
      updated_at = excluded.updated_at
  `).run(
    pack.id,
    pack.publisher,
    pack.country,
    pack.jurisdiction,
    versionId,
    installedAt,
    installedAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO country_pack_versions (
      id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
      effective_from, effective_to, min_flo_version, published_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
  `).run(
    versionId,
    pack.id,
    pack.version,
    pack.schemaVersion,
    JSON.stringify({
      id: pack.id,
      publisher: pack.publisher,
      country: pack.country,
      jurisdiction: pack.jurisdiction,
      version: pack.version,
      publishedAt: pack.publishedAt,
    }),
    packJson,
    crypto.createHash('sha256').update(packJson).digest('hex'),
    pack.effectiveFrom,
    pack.effectiveTo || null,
    pack.minFloVersion,
    pack.publishedAt,
    installedAt,
  );

  const insertCategory = db.prepare(`
    INSERT OR REPLACE INTO tax_categories (
      id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const category of pack.categories) {
    insertCategory.run(
      `${versionId}:category:${category.id}`,
      versionId,
      category.id,
      category.label,
      category.defaultBehavior || null,
      JSON.stringify(category),
      installedAt,
    );
  }

  const insertRule = db.prepare(`
    INSERT OR REPLACE INTO tax_rules (
      id, pack_version_id, rule_id, label, calculation_type, rate, amount,
      applies_per, base_rule_ids, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of pack.rules) {
    insertRule.run(
      `${versionId}:rule:${rule.id}`,
      versionId,
      rule.id,
      rule.label,
      rule.type,
      rule.rate || null,
      rule.amount || null,
      rule.appliesPer || null,
      JSON.stringify(rule.baseRuleIds || []),
      JSON.stringify(rule),
      installedAt,
    );
  }
}

function seedHarborBean(db) {
  const createdAt = now();

  // 1. Settings (US, USD, Harbor & Bean Café profile)
  const settings = [
    ['country', 'US'],
    ['currency', 'USD'],
    ['timezone', 'America/New_York'],
    ['billing_type', 'prepaid'],
    ['business_type', 'restaurant'],
    ['tables_required', 'false'],
    ['store_name', 'Harbor & Bean Cafe'],
    ['business_name', 'Harbor & Bean Cafe'],
    ['store_address', '42 Ocean Pier Way, Suite 100'],
    ['store_phone', '+1 555-0100'],
    ['taxes_enabled', 'true'],
    ['kds_enabled', 'true'],
    ['split_checks_enabled', 'true'],
    ['kot_printing_enabled', 'true'],
    ['language', 'en'],
    ['orders_layout', 'split'],
  ];
  for (const [k, v] of settings) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      k,
      v,
      createdAt,
    );
  }

  // 2. Install US Tax Pack
  const usPackPath = path.resolve(__dirname, '../../main/tax-packs/community-united-states.json');
  if (fs.existsSync(usPackPath)) {
    const usPack = JSON.parse(fs.readFileSync(usPackPath, 'utf8'));
    installTaxPack(db, usPack);
  }

  // 3. Staff accounts with deterministic passwords and PINs
  const passwordHash = bcrypt.hashSync('E2ePass123!', 10);
  const users = [
    ['user-owner', 'Elena Vance', 'owner@harborbean.local', 'owner', '1111'],
    ['user-manager', 'Marcus Reed', 'manager@harborbean.local', 'manager', '2222'],
    ['user-cashier', 'Chloe Bennet', 'cashier@harborbean.local', 'cashier', '3333'],
    ['user-chef', 'Leo Hayes', 'chef@harborbean.local', 'chef', '4444'],
    ['user-server', 'Maya Lin', 'server@harborbean.local', 'server', '5555'],
    // Also include e2e fallback accounts for test compatibility
    ['e2e-owner', 'E2E Owner', 'owner@flo.local', 'owner', '1111'],
    ['e2e-manager', 'E2E Manager', 'manager@flo.local', 'manager', '2222'],
    ['e2e-server', 'E2E Server', 'server@flo.local', 'server', '5555'],
  ];

  for (const [id, name, email, role, pin] of users) {
    const pinHash = bcrypt.hashSync(pin, 10);
    db.prepare(`
      INSERT OR REPLACE INTO users (
        id, name, email, password, role, pin_hash, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, email, passwordHash, role, pinHash, createdAt, createdAt);
  }

  // 4. Menu categories
  const categories = [
    ['cat-coffee', 'Hot & Iced Coffee', '#78350F', '☕', 1],
    ['cat-bakery', 'Artisan Bakery', '#D97706', '🥐', 2],
    ['cat-brunch', 'All-Day Brunch', '#EA580C', '🍳', 3],
  ];
  for (const [id, name, color, icon, order] of categories) {
    db.prepare(`
      INSERT OR REPLACE INTO categories (id, name, color, icon, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, color, icon, order, createdAt, createdAt);
  }

  // 5. Addon groups & Addons
  const addonGroups = [
    ['ag-milk', 'Milk Choice', 'Choose your milk', 1, 1, 1, 1],
    ['ag-shots', 'Espresso Shots', 'Extra shots', 0, 0, 2, 2],
  ];
  for (const [id, name, desc, req, min, max, order] of addonGroups) {
    db.prepare(`
      INSERT OR REPLACE INTO addon_groups (
        id, name, description, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, name, desc, req, min, max, order, createdAt, createdAt);
  }

  const addons = [
    ['add-whole', 'ag-milk', 'Whole Milk', 0.0, 1],
    ['add-oat', 'ag-milk', 'Oat Milk', 0.75, 2],
    ['add-almond', 'ag-milk', 'Almond Milk', 0.75, 3],
    ['add-shot-1', 'ag-shots', 'Single Extra Shot', 0.85, 1],
    ['add-decaf', 'ag-shots', 'Decaf Option', 0.0, 2],
  ];
  for (const [id, groupId, name, price, order] of addons) {
    db.prepare(`
      INSERT OR REPLACE INTO addons (
        id, addon_group_id, name, price, tax_behavior, inherit_parent_tax_category, is_active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'country_default', 1, 1, ?, ?, ?)
    `).run(id, groupId, name, price, order, createdAt, createdAt);
  }

  // 6. Products with realistic WebP photography
  const assetsDir = path.resolve(__dirname, 'assets');
  const assetMap = {
    'prod-latte': 'prod-latte.webp',
    'prod-flat-white': 'prod-flat-white.webp',
    'prod-cold-brew': 'prod-cold-brew.webp',
    'prod-croissant': 'prod-croissant.webp',
    'prod-scone': 'prod-scone.webp',
    'prod-toast': 'prod-toast.webp',
  };

  const products = [
    ['prod-latte', 'cat-coffee', 'Vanilla Bean Latte', 4.75, 1],
    ['prod-flat-white', 'cat-coffee', 'Flat White', 4.25, 2],
    ['prod-cold-brew', 'cat-coffee', 'Nitro Cold Brew', 5.0, 3],
    ['prod-croissant', 'cat-bakery', 'Almond Croissant', 4.25, 4],
    ['prod-scone', 'cat-bakery', 'Blueberry Scone', 3.75, 5],
    ['prod-toast', 'cat-brunch', 'Avocado Sourdough Toast', 9.5, 6],
  ];
  for (const [id, catId, name, price, order] of products) {
    let imageUrl = null;
    const assetFile = assetMap[id];
    if (assetFile) {
      const assetPath = path.join(assetsDir, assetFile);
      if (fs.existsSync(assetPath)) {
        const b64 = fs.readFileSync(assetPath).toString('base64');
        imageUrl = `data:image/webp;base64,${b64}`;
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO products (
        id, category_id, name, price, tax_type, tax_category_id, tax_behavior,
        cb_percent, track_inventory, stock_quantity, image_url, is_active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'none', 'standard', 'exclusive', 0, 0, 999, ?, 1, ?, ?, ?)
    `).run(id, catId, name, price, imageUrl, order, createdAt, createdAt);
  }

  // Link addon groups to coffee products
  for (const pId of ['prod-latte', 'prod-flat-white']) {
    for (const gId of ['ag-milk', 'ag-shots']) {
      db.prepare(
        'INSERT OR IGNORE INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)',
      ).run(pId, gId);
    }
  }

  // 7. Printers (Configure virtual receipt printer on 127.0.0.1:9123 so prints succeed without toasts)
  db.prepare(`
    INSERT OR REPLACE INTO printers (
      id, name, connection_type, ip_address, port, is_default, cash_drawer_pulse_enabled, paper_width, created_at, updated_at
    ) VALUES (?, ?, 'network', '127.0.0.1', 9123, 1, 0, '80mm', ?, ?)
  `).run('printer-counter', 'Receipt Printer (Epson TM-T88)', createdAt, createdAt);

  // 8. Supplies & Recipes
  const supplies = [
    ['sup-beans', 'Espresso Beans', 'kg', 5.0, 1.0],
    ['sup-whole-milk', 'Whole Milk', 'l', 20.0, 5.0],
    ['sup-oat-milk', 'Oat Milk', 'l', 12.0, 3.0],
  ];
  for (const [id, name, unit, qty, low] of supplies) {
    db.prepare(`
      INSERT OR REPLACE INTO supplies (
        id, name, base_unit, stock_quantity, low_stock_threshold, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, unit, qty, low, createdAt, createdAt);
  }

  // Seed baseline stock movement history
  const initialMovements = [
    ['sup-beans', 10.0, 'receive', 'kg', 10.0, 'Opening inventory delivery', 'user-manager'],
    ['sup-whole-milk', 30.0, 'receive', 'l', 30.0, 'Fresh dairy delivery', 'user-manager'],
    ['sup-oat-milk', 15.0, 'receive', 'l', 15.0, 'Oat milk stock delivery', 'user-manager'],
  ];
  for (const [sId, qty, type, unit, after, reason, user] of initialMovements) {
    db.prepare(`
      INSERT INTO supply_movements (
        supply_id, quantity_delta, movement_type, unit, stock_after, reason, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'))
    `).run(sId, qty, type, unit, after, reason, user);
  }

  // Recipe for Flat White (0.018 kg beans, 0.25 L milk)
  db.prepare(`
    INSERT OR REPLACE INTO recipes (id, product_id, yield_quantity, is_active, created_at, updated_at)
    VALUES (?, ?, 1, 1, ?, ?)
  `).run('rec-flat-white', 'prod-flat-white', createdAt, createdAt);

  db.prepare(`
    INSERT OR REPLACE INTO recipe_items (id, recipe_id, supply_id, quantity, unit, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('ri-beans', 'rec-flat-white', 'sup-beans', 0.018, 'kg', createdAt);

  db.prepare(`
    INSERT OR REPLACE INTO recipe_items (id, recipe_id, supply_id, quantity, unit, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('ri-milk', 'rec-flat-white', 'sup-whole-milk', 0.25, 'l', createdAt);

  // 8. Tables & Floor Plan (percentage coordinates 0-100 on canvas)
  const tables = [
    ['tab-1', 'T1', 2, 'available', 'Main Dining', 'Center', 25, 35],
    ['tab-2', 'T2', 4, 'occupied', 'Main Dining', 'Window', 65, 35],
    ['tab-3', 'T3', 6, 'available', 'Main Dining', 'Corner', 45, 70],
    ['tab-4', 'T4', 4, 'available', 'Patio', 'Outdoor', 50, 50],
  ];
  for (const [id, num, cap, status, floor, sec, x, y] of tables) {
    db.prepare(`
      INSERT OR REPLACE INTO tables (
        id, number, capacity, status, floor, section, position_x, position_y, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, num, cap, status, floor, sec, x, y, createdAt, createdAt);
  }

  // 9. Customers
  const customers = [
    ['cust-1', 'Sarah Jenkins', '+15550142', '+1'],
    ['cust-2', 'David Chen', '+15550189', '+1'],
    ['cust-3', 'Olivia Taylor', '+15550211', '+1'],
  ];
  for (const [id, name, phone, code] of customers) {
    db.prepare(`
      INSERT OR REPLACE INTO customers (
        id, name, phone, country_code, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, phone, code, createdAt, createdAt);
  }

  console.log('[Showcase Seed] Harbor & Bean Café data initialized successfully.');
}

module.exports = { seedHarborBean };
