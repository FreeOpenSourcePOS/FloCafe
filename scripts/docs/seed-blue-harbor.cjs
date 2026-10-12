/**
 * Deterministic Blue Harbor Café Fixture Seeder
 * Populates an isolated SQLite database for FloCafe Help Center documentation & screenshots.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDatabase, now } = require('../../dist/main/db');
const { createSupply } = require('../../dist/main/services/supplies');
const { saveRecipe } = require('../../dist/main/services/recipes');

function installTaxPack(db, pack) {
  const installedAt = now();
  const versionId = `${pack.id}@${pack.version}`;
  const packJson = JSON.stringify(pack);
  const digest = crypto.createHash('sha256').update(packJson).digest('hex');

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
    digest,
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

function seedBlueHarborCafe() {
  const db = getDatabase();
  const createdAt = now();
  const passwordHash = bcrypt.hashSync('DemoPassword123!', 10);

  console.log('[Seed] Seeding Blue Harbor Café settings...');
  const settings = [
    ['business_name', 'Blue Harbor Café'],
    ['store_name', 'Blue Harbor Café'],
    ['country', 'CA'],
    ['currency', 'CAD'],
    ['currency_symbol', '$'],
    ['timezone', 'America/Toronto'],
    ['language', 'en'],
    ['business_type', 'restaurant'],
    ['billing_type', 'prepaid'],
    ['tables_required', 'false'],
    ['loyalty_enabled', 'true'],
    ['loyalty_rate', '10'],
    ['taxes_enabled', 'true'],
    ['require_open_shift', 'false'],
    ['store_address', '142 Harborview Street, Toronto, ON M5V 2H1'],
    ['store_phone', '+14165550198'],
    ['store_email', 'contact@blueharborcafe.ca'],
    [
      'receipt_header',
      'Blue Harbor Café\nArtisan Coffee & Fresh Bakery\n142 Harborview Street, Toronto',
    ],
    ['receipt_footer', 'Thank you for supporting local!\nVisit us online at blueharborcafe.ca'],
    ['first_run_completed', 'true'],
    ['kds_enabled', 'true'],
  ];

  for (const [key, value] of settings) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      key,
      value,
      createdAt,
    );
  }

  console.log('[Seed] Seeding Canadian HST tax pack (13%)...');
  const caTaxPack = {
    schemaVersion: 1,
    id: 'official-ca-pack',
    publisher: 'FreeOpenSourcePOS',
    version: '1.0.0',
    country: 'CA',
    jurisdiction: 'ON',
    currency: 'CAD',
    effectiveFrom: '2026-01-01',
    publishedAt: '2026-01-01',
    minFloVersion: '2.4.0',
    taxPoint: 'finalized_at',
    inclusivePricingDefault: false,
    registrationNumberLabel: 'HST #',
    categories: [
      { id: 'standard', label: 'Standard (HST)', ruleIds: ['hst'] },
      { id: 'packaging', label: 'Packaging', ruleIds: ['hst'] },
      { id: 'delivery', label: 'Delivery', ruleIds: ['hst'] },
      { id: 'service_charge', label: 'Service charge', ruleIds: ['hst'] },
      { id: 'addon', label: 'Add-on', ruleIds: ['hst'] },
      { id: 'unclassified', label: 'Unclassified', ruleIds: ['hst'] },
    ],
    defaultCategories: {
      product: 'standard',
      packaging: 'packaging',
      delivery: 'delivery',
      service_charge: 'service_charge',
      addon: 'addon',
    },
    unclassifiedCategoryId: 'unclassified',
    rules: [
      {
        id: 'hst',
        label: 'HST (13%)',
        type: 'percent',
        categoryIds: [
          'standard',
          'packaging',
          'delivery',
          'service_charge',
          'addon',
          'unclassified',
        ],
        rate: '13',
      },
    ],
    taxRounding: {
      scope: 'line',
      method: 'half_up',
      decimalPlaces: 2,
      remainderAllocation: 'largest_remainder',
    },
    payableRounding: {
      increment: '0.01',
      method: 'half_up',
    },
  };
  installTaxPack(db, caTaxPack);

  console.log('[Seed] Seeding users with roles & PINs...');
  const users = [
    {
      id: 'usr-owner',
      name: 'Elena Rostova (Owner)',
      email: 'owner@blueharbor.local',
      role: 'owner',
      pin: '1234',
    },
    {
      id: 'usr-manager',
      name: 'Marcus Vance (Manager)',
      email: 'manager@blueharbor.local',
      role: 'manager',
      pin: '2345',
    },
    {
      id: 'usr-cashier',
      name: 'Chloe Martin (Cashier)',
      email: 'cashier@blueharbor.local',
      role: 'cashier',
      pin: '3456',
    },
    {
      id: 'usr-server',
      name: 'Sam Rivera (Server)',
      email: 'server@blueharbor.local',
      role: 'server',
      pin: '4567',
    },
    {
      id: 'usr-chef',
      name: 'Chef Kenji Sato (Kitchen)',
      email: 'chef@blueharbor.local',
      role: 'chef',
      pin: '5678',
    },
  ];

  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users (id, name, email, password, role, pin, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  for (const u of users) {
    const pinHash = bcrypt.hashSync(u.pin, 10);
    insertUser.run(
      u.id,
      u.name,
      u.email,
      passwordHash,
      u.role,
      u.pin,
      pinHash,
      createdAt,
      createdAt,
    );
  }

  console.log('[Seed] Seeding printers and kitchen stations...');
  db.prepare(`
    INSERT OR REPLACE INTO printers (id, name, connection_type, ip_address, port, is_default, cash_drawer_pulse_enabled, paper_width, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'prn-counter',
    'Counter Receipt Printer',
    'usb',
    null,
    9100,
    1,
    1,
    '80mm',
    createdAt,
    createdAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO printers (id, name, connection_type, ip_address, port, is_default, cash_drawer_pulse_enabled, paper_width, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'prn-barista',
    'Barista Ticket Printer',
    'network',
    '192.168.1.150',
    9100,
    0,
    0,
    '80mm',
    createdAt,
    createdAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO kitchen_stations (id, name, description, printer_id, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    'stn-barista',
    'Barista Station',
    'Coffee & Cold Drink Prep',
    'prn-barista',
    1,
    createdAt,
    createdAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO kitchen_stations (id, name, description, printer_id, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    'stn-kitchen',
    'Kitchen & Bakery',
    'Hot Sandwiches & Baked Goods',
    null,
    2,
    createdAt,
    createdAt,
  );

  console.log('[Seed] Seeding menu categories...');
  const categories = [
    { id: 'cat-coffee', name: 'Coffee', sort: 1 },
    { id: 'cat-tea', name: 'Tea & Cold Drinks', sort: 2 },
    { id: 'cat-bakery', name: 'Fresh Bakery', sort: 3 },
    { id: 'cat-food', name: 'Artisan Food', sort: 4 },
  ];
  for (const c of categories) {
    db.prepare(
      'INSERT OR REPLACE INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(c.id, c.name, c.sort, createdAt, createdAt);
  }

  console.log('[Seed] Seeding add-on groups and modifiers...');
  const addonGroups = [
    { id: 'ag-milk', name: 'Milk Choice', min: 1, max: 1, req: 1, multi: 0, sort: 1 },
    { id: 'ag-syrup', name: 'Syrup Flavor', min: 0, max: 3, req: 0, multi: 1, sort: 2 },
    { id: 'ag-shot', name: 'Espresso Boost', min: 0, max: 2, req: 0, multi: 1, sort: 3 },
  ];
  for (const ag of addonGroups) {
    db.prepare(`
      INSERT OR REPLACE INTO addon_groups (id, name, is_required, min_selection, max_selection, allow_multiple_quantities, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(ag.id, ag.name, ag.req, ag.min, ag.max, ag.multi, ag.sort, createdAt, createdAt);
  }

  const addons = [
    { id: 'ad-whole', group: 'ag-milk', name: 'Whole Milk', price: 0.0, sort: 1 },
    { id: 'ad-oat', group: 'ag-milk', name: 'Oat Milk', price: 0.8, sort: 2 },
    { id: 'ad-almond', group: 'ag-milk', name: 'Almond Milk', price: 0.8, sort: 3 },
    { id: 'ad-vanilla', group: 'ag-syrup', name: 'Madagascar Vanilla', price: 0.5, sort: 1 },
    { id: 'ad-caramel', group: 'ag-syrup', name: 'Salted Caramel', price: 0.5, sort: 2 },
    { id: 'ad-hazelnut', group: 'ag-syrup', name: 'Roasted Hazelnut', price: 0.5, sort: 3 },
    { id: 'ad-shot', group: 'ag-shot', name: 'Extra Espresso Shot', price: 1.0, sort: 1 },
  ];
  for (const ad of addons) {
    db.prepare(`
      INSERT OR REPLACE INTO addons (id, addon_group_id, name, price, tax_category_id, tax_behavior, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'standard', 'exclusive', 1, ?, ?, ?)
    `).run(ad.id, ad.group, ad.name, ad.price, ad.sort, createdAt, createdAt);
  }

  // Link categories to add-on groups
  for (const agId of ['ag-milk', 'ag-syrup', 'ag-shot']) {
    db.prepare(
      'INSERT OR REPLACE INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)',
    ).run('cat-coffee', agId);
  }
  for (const agId of ['ag-milk', 'ag-syrup']) {
    db.prepare(
      'INSERT OR REPLACE INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)',
    ).run('cat-tea', agId);
  }

  console.log('[Seed] Seeding menu products...');
  const products = [
    // Coffee
    { id: 'prod-latte', cat: 'cat-coffee', name: 'Caffè Latte', price: 5.25, sort: 1, stock: 100 },
    {
      id: 'prod-cappuccino',
      cat: 'cat-coffee',
      name: 'Cappuccino',
      price: 4.75,
      sort: 2,
      stock: 100,
    },
    { id: 'prod-espresso', cat: 'cat-coffee', name: 'Espresso', price: 3.5, sort: 3, stock: 100 },
    { id: 'prod-americano', cat: 'cat-coffee', name: 'Americano', price: 4.0, sort: 4, stock: 100 },
    {
      id: 'prod-flat-white',
      cat: 'cat-coffee',
      name: 'Flat White',
      price: 5.0,
      sort: 5,
      stock: 100,
    },
    { id: 'prod-mocha', cat: 'cat-coffee', name: 'Mocha', price: 5.75, sort: 6, stock: 100 },
    // Tea & Cold Drinks
    {
      id: 'prod-chai-latte',
      cat: 'cat-tea',
      name: 'Spiced Chai Latte',
      price: 5.0,
      sort: 1,
      stock: 80,
    },
    {
      id: 'prod-iced-coffee',
      cat: 'cat-tea',
      name: 'Cold Brew Coffee',
      price: 4.5,
      sort: 2,
      stock: 90,
    },
    {
      id: 'prod-matcha-latte',
      cat: 'cat-tea',
      name: 'Iced Matcha Latte',
      price: 5.5,
      sort: 3,
      stock: 75,
    },
    {
      id: 'prod-lemonade',
      cat: 'cat-tea',
      name: 'Sparkling Lemonade',
      price: 4.0,
      sort: 4,
      stock: 60,
    },
    // Bakery
    {
      id: 'prod-croissant',
      cat: 'cat-bakery',
      name: 'Butter Croissant',
      price: 3.75,
      sort: 1,
      stock: 24,
    },
    {
      id: 'prod-muffin',
      cat: 'cat-bakery',
      name: 'Blueberry Streusel Muffin',
      price: 3.5,
      sort: 2,
      stock: 18,
    },
    {
      id: 'prod-cookie',
      cat: 'cat-bakery',
      name: 'Chocolate Chunk Cookie',
      price: 2.75,
      sort: 3,
      stock: 30,
    },
    {
      id: 'prod-banana-bread',
      cat: 'cat-bakery',
      name: 'Banana Walnut Bread',
      price: 4.25,
      sort: 4,
      stock: 12,
    },
    // Food
    {
      id: 'prod-avocado-toast',
      cat: 'cat-food',
      name: 'Sourdough Avocado Toast',
      price: 9.5,
      sort: 1,
      stock: 45,
    },
    {
      id: 'prod-grilled-cheese',
      cat: 'cat-food',
      name: 'Aged Cheddar Grilled Cheese',
      price: 8.5,
      sort: 2,
      stock: 35,
    },
    {
      id: 'prod-veggie-wrap',
      cat: 'cat-food',
      name: 'Mediterranean Veggie Wrap',
      price: 8.0,
      sort: 3,
      stock: 25,
    },
    {
      id: 'prod-breakfast-bagel',
      cat: 'cat-food',
      name: 'Classic Breakfast Bagel',
      price: 7.5,
      sort: 4,
      stock: 30,
    },
  ];

  const insertProduct = db.prepare(`
    INSERT OR REPLACE INTO products (
      id, category_id, name, price, tax_type, tax_category_id, tax_behavior,
      cb_percent, track_inventory, stock_quantity, is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'none', 'standard', 'exclusive', 5, 1, ?, 1, ?, ?, ?)
  `);

  for (const p of products) {
    insertProduct.run(p.id, p.cat, p.name, p.price, p.stock, p.sort, createdAt, createdAt);
  }

  console.log('[Seed] Seeding product variants for Caffè Latte (sizes)...');
  const variants = [
    { id: 'var-latte-s', prod: 'prod-latte', name: 'Small (12oz)', price: 4.75, sort: 1 },
    { id: 'var-latte-m', prod: 'prod-latte', name: 'Regular (16oz)', price: 5.25, sort: 2 },
    { id: 'var-latte-l', prod: 'prod-latte', name: 'Large (20oz)', price: 5.75, sort: 3 },
  ];
  for (const v of variants) {
    db.prepare(`
      INSERT OR REPLACE INTO product_variants (id, product_id, name, price, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(v.id, v.prod, v.name, v.price, v.sort, createdAt, createdAt);
  }

  console.log('[Seed] Seeding tables and floor plan...');
  const tables = [
    {
      id: 'tbl-1',
      number: 'T1',
      cap: 2,
      floor: 'Main Dining',
      x: 120,
      y: 100,
      status: 'available',
    },
    { id: 'tbl-2', number: 'T2', cap: 4, floor: 'Main Dining', x: 280, y: 100, status: 'occupied' },
    {
      id: 'tbl-3',
      number: 'T3',
      cap: 4,
      floor: 'Main Dining',
      x: 120,
      y: 260,
      status: 'available',
    },
    {
      id: 'tbl-4',
      number: 'T4',
      cap: 6,
      floor: 'Main Dining',
      x: 280,
      y: 260,
      status: 'available',
    },
    {
      id: 'tbl-p1',
      number: 'P1',
      cap: 2,
      floor: 'Patio Terrace',
      x: 140,
      y: 120,
      status: 'available',
    },
    {
      id: 'tbl-p2',
      number: 'P2',
      cap: 4,
      floor: 'Patio Terrace',
      x: 300,
      y: 120,
      status: 'available',
    },
  ];
  for (const t of tables) {
    db.prepare(`
      INSERT OR REPLACE INTO tables (id, number, capacity, status, floor, position_x, position_y, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(t.id, t.number, t.cap, t.status, t.floor, t.x, t.y, createdAt, createdAt);
  }

  console.log('[Seed] Seeding customers & loyalty points...');
  const customers = [
    {
      id: 'cust-1',
      name: 'Sarah Jenkins',
      email: 'sarah.j@example.com',
      phone: '+14165551234',
      notes: 'Prefers oat milk latte',
    },
    {
      id: 'cust-2',
      name: 'Liam Patel',
      email: 'liam.p@example.com',
      phone: '+14165555678',
      notes: 'Daily morning espresso',
    },
    {
      id: 'cust-3',
      name: 'Emma Chen',
      email: 'emma.c@example.com',
      phone: '+14165559012',
      notes: 'Loyal patron',
    },
  ];
  for (const c of customers) {
    db.prepare(`
      INSERT OR REPLACE INTO customers (id, name, email, phone, notes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(c.id, c.name, c.email, c.phone, c.notes, createdAt, createdAt);
  }

  db.prepare(`
    INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at)
    VALUES (?, 'credit', ?, 'Opening loyalty bonus', ?, ?)
  `).run('cust-1', 140, createdAt, createdAt);
  db.prepare(`
    INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at)
    VALUES (?, 'credit', ?, 'Opening loyalty bonus', ?, ?)
  `).run('cust-2', 85, createdAt, createdAt);
  db.prepare(`
    INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at)
    VALUES (?, 'credit', ?, 'Opening loyalty bonus', ?, ?)
  `).run('cust-3', 210, createdAt, createdAt);

  console.log('[Seed] Seeding inventory supplies & units...');
  try {
    const beans = createSupply(db, {
      name: 'Espresso Roast Beans',
      baseUnit: 'kg',
      stockQuantity: 14.5,
      lowStockThreshold: 5.0,
      actorUserId: 'usr-owner',
    });
    const milk = createSupply(db, {
      name: 'Organic Whole Milk',
      baseUnit: 'l',
      stockQuantity: 22.0,
      lowStockThreshold: 8.0,
      actorUserId: 'usr-owner',
    });
    createSupply(db, {
      name: 'Barista Oat Milk',
      baseUnit: 'l',
      stockQuantity: 11.5,
      lowStockThreshold: 4.0,
      actorUserId: 'usr-owner',
    });
    const cups = createSupply(db, {
      name: '12oz Paper Cups',
      baseUnit: 'each',
      stockQuantity: 280,
      lowStockThreshold: 50,
      actorUserId: 'usr-owner',
    });
    const sourdough = createSupply(db, {
      name: 'Artisan Sourdough Loaf',
      baseUnit: 'each',
      stockQuantity: 8,
      lowStockThreshold: 3,
      actorUserId: 'usr-owner',
    });
    const cheddar = createSupply(db, {
      name: 'White Aged Cheddar',
      baseUnit: 'kg',
      stockQuantity: 5.2,
      lowStockThreshold: 2.0,
      actorUserId: 'usr-owner',
    });

    // Link recipes
    saveRecipe(db, {
      productId: 'prod-latte',
      items: [
        { supplyId: beans.id, quantity: 0.02, unit: 'kg' },
        { supplyId: milk.id, quantity: 0.25, unit: 'l' },
        { supplyId: cups.id, quantity: 1, unit: 'each' },
      ],
    });
    saveRecipe(db, {
      productId: 'prod-grilled-cheese',
      items: [
        { supplyId: sourdough.id, quantity: 0.1, unit: 'each' },
        { supplyId: cheddar.id, quantity: 0.08, unit: 'kg' },
      ],
    });
  } catch (err) {
    console.warn('[Seed] Supplies/Recipe setup note:', err.message);
  }

  console.log('[Seed] Seeding active cash shift (float: $200.00)...');
  db.prepare(`
    INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status)
    VALUES (?, ?, ?, 20000, 'open')
  `).run('usr-cashier', 'Chloe Martin (Cashier)', createdAt);

  console.log('[Seed] Seeding sample expenses...');
  const todayDate = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT OR REPLACE INTO expense_categories (id, name, name_key, is_active, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'usr-owner', 'usr-owner', ?, ?)
  `).run('exp-cat-dairy', 'Dairy & Fresh Goods', 'dairy_fresh_goods', createdAt, createdAt);

  db.prepare(`
    INSERT OR REPLACE INTO expense_categories (id, name, name_key, is_active, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'usr-owner', 'usr-owner', ?, ?)
  `).run(
    'exp-cat-roastery',
    'Coffee Roastery Supplies',
    'coffee_roastery_supplies',
    createdAt,
    createdAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO expenses (id, category_id, category_name, description, payee, amount_minor, currency_code, incurred_on, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'CAD', ?, 'usr-owner', ?)
  `).run(
    'exp-1',
    'exp-cat-dairy',
    'Dairy & Fresh Goods',
    'Ontario Organic Dairy - Weekly Milk Delivery',
    'Ontario Organic Dairy',
    8450,
    todayDate,
    createdAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO expense_payments (id, expense_id, amount_minor, method, business_date, created_by, created_at)
    VALUES (?, ?, ?, 'bank_transfer', ?, 'usr-owner', ?)
  `).run('exp-pay-1', 'exp-1', 8450, todayDate, createdAt);

  db.prepare(`
    INSERT OR REPLACE INTO expenses (id, category_id, category_name, description, payee, amount_minor, currency_code, incurred_on, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'CAD', ?, 'usr-owner', ?)
  `).run(
    'exp-2',
    'exp-cat-roastery',
    'Coffee Roastery Supplies',
    'Harbor Roast Coffee Beans (15kg)',
    'Harbor Coffee Roasters',
    22000,
    todayDate,
    createdAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO expense_payments (id, expense_id, amount_minor, method, business_date, created_by, created_at)
    VALUES (?, ?, ?, 'card', ?, 'usr-owner', ?)
  `).run('exp-pay-2', 'exp-2', 22000, todayDate, createdAt);

  console.log('[Seed] Seeding sample orders for POS, dine-in, and KDS...');
  // Order 1: Dine-in order at Table T2 (confirmed, preparing in kitchen)
  const order1 = db
    .prepare(`
    INSERT INTO orders (
      order_number, table_id, customer_id, user_id, type, guest_count,
      status, subtotal, tax_amount, total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'dine_in', 2, 'confirmed', 20.00, 2.60, 22.60, ?, ?)
  `)
    .run('ORD-1001', 'tbl-2', 'cust-2', 'usr-server', createdAt, createdAt);

  const order1Id = order1.lastInsertRowid;
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-latte', 'Caffè Latte', 5.25, 2, 10.50, 1.37, 11.87, 'preparing', ?, ?)
  `).run(order1Id, createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-avocado-toast', 'Sourdough Avocado Toast', 9.50, 1, 9.50, 1.23, 10.73, 'preparing', ?, ?)
  `).run(order1Id, createdAt, createdAt);

  // Order 2: Completed takeaway order with bill and payment
  const order2 = db
    .prepare(`
    INSERT INTO orders (
      order_number, customer_id, user_id, type,
      status, subtotal, tax_amount, total, created_at, updated_at
    ) VALUES (?, ?, ?, 'takeaway', 'completed', 8.25, 1.07, 9.32, ?, ?)
  `)
    .run('ORD-1002', 'cust-1', 'usr-cashier', createdAt, createdAt);

  const order2Id = order2.lastInsertRowid;
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-croissant', 'Butter Croissant', 3.75, 1, 3.75, 0.49, 4.24, 'served', ?, ?)
  `).run(order2Id, createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-iced-coffee', 'Cold Brew Coffee', 4.50, 1, 4.50, 0.58, 5.08, 'served', ?, ?)
  `).run(order2Id, createdAt, createdAt);

  const paymentDetails = JSON.stringify([{ method: 'card', amount: 9.32 }]);
  db.prepare(`
    INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES (?, 'BILL-1002', 8.25, 1.07, 9.32, 9.32, 0.00, 'paid', ?, ?, ?, ?)
  `).run(order2Id, paymentDetails, createdAt, createdAt, createdAt);

  // Order 3: Ready KDS order
  const order3 = db
    .prepare(`
    INSERT INTO orders (
      order_number, user_id, type,
      status, subtotal, tax_amount, total, created_at, updated_at
    ) VALUES (?, ?, 'takeaway', 'confirmed', 5.50, 0.72, 6.22, ?, ?)
  `)
    .run('ORD-1003', 'usr-cashier', createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-matcha-latte', 'Iced Matcha Latte', 5.50, 1, 5.50, 0.72, 6.22, 'ready', ?, ?)
  `).run(order3.lastInsertRowid, createdAt, createdAt);

  console.log('[Seed] Blue Harbor Café seeding complete!');
}

module.exports = { seedBlueHarborCafe };
