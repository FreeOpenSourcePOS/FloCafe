/**
 * Deterministic Blue Harbor Café Fixture Seeder
 * Populates an isolated SQLite database for FloCafe Help Center documentation & screenshots.
 */
const fs = require('fs');
const path = require('path');
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
    ['tables_required', 'true'],
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
    ['bill_footer_message', 'Thank you for supporting local! Visit us online at blueharborcafe.ca'],
    ['first_run_completed', 'true'],
    ['kds_enabled', 'true'],
    ['kds_default_view', 'kanban'],
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

  const demoAssetsDir = path.resolve(__dirname, '../demo/assets');
  const fallbackImages = {
    'prod-cold-brew.webp':
      'data:image/webp;base64,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',
    'prod-croissant.webp':
      'data:image/webp;base64,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',
    'prod-flat-white.webp':
      'data:image/webp;base64,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',
    'prod-latte.webp':
      'data:image/webp;base64,UklGRjoRAABXRUJQVlA4WAoAAAAgAAAAnwAAnwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggTA8AAJBOAJ0BKqAAoAA+lUSbSqWjoiGntguosBKJYwC+QEfZVK45ZposEl0lybOUeMHppEpOR7LPcfNjBdibuaX8I37nvuC2EyDZJnw+9jg4Pa9k9NT+7SOGWyosZhsf222Ve7KKMt2z/IUiniU60aCXVZujKsInCSCA0e+IeY0ovtJduTNFP7W17Fcxdd4BLQvttN4t6NcmM4tzT8G8cu6zl49AuOoygLZo9cZ+tCgu7FJ1S/ZyiiHqhufwrparYak46DiRy0xw5ip2+HfSaEDCdI8dz0giseDD0cwFMGwGTqYTaDcSi5VmfXHuMRvEyD4lCuum1XQjpWEmoVIZSO2kkZkhjyvKuG0Do8JRQ6jehppXB1e2SdpPbFTdQQtF+ZCvjfdouch0FSvn5pPLf1DL/+DJxYytKv76+q5/naiaR2vOvkcBpl2Ll6NoiErZOiIRC7abK10a2gjfdE/s5SNDc/x3ZfqdQVRONr4cMPJqJ3qDVZSt9rHzGW1EIq+8Rz+rdH2/V4JsNephM3foopOMKL3LI5G8/eGZt3kOtd/6tyYgSDngV9ks3GvxapwguBRqnncDrjHTVyULjkZNmEOx+1LYA0AjF3kHeRbhelk2pg6jGP6qx3nTZ5IseybxsOk/a+a5PnbBjn0mwdi3ruxQ7An3XndOP+3m7r/NBc5+fMUisLydVBclzG4m3IOYz13b4OQcqO2yIdeS+IKaRsdpKQv7lmWNKnfAQjNLoBCoBzcwqZFgC5yccnPL4UyWt6yeixFvlQhAogysOWZbZ7sDsNxVroWcqDE3v3xvjcQNqzTNuUtNM6//W5fblugyrE1oZRS1EHTMnkoI36usmOYA/uktRjp6m4xdKA1onf3UWg5WlvlUUYVPHf3W1jxt1rhLZmT60fNtfyzuNG8R8Q9Max+uBhtTzXFPr/yh+B/128QufJ0RNqW9hA9H8Y8A6yW+jHnOHo2gJpmm67vJ0QWAazxSo9VPKj9hV/xb+yoKzo5ITG/16DFp/C9Y2wgJOKWAa13vAAIbmGT5a/yRAPBBTz5qAjJcXMp5olFM51ughRj3MkC44RRY3G+Qw17y2Tve+IGPmBaDVM3Yxxv6bnx3dNUAvYEIo+5dT8ZFJNDyTpnKgHQfqW/eYvIX1WFuQsARuBpzcoaQowZOrUAwEtRfxYhzpyW1VHEECxrLQy8PElJ8PpEACHND/W+YZaQd5ZIUbDZ9wXndnmHgptTtFx3On18jO/1fuRy28GVIo3OAjRoAH8KAZek/CmeYFS/8PJw7e5nL10sh+jhAonwU8AwshyecApS/H+6w1trMLwhPMVpuNAatB44I3DjUx6ZcrdgMG3GKm3GoOIAecp1iZAuW5054ssIYZN488pdgX1Z+qt6NXEAMW6QF4KFomYZvBnwCjfPDhriKXFNKd/ahhzAn2UfAnIv6CLl57SzDI0lA2AfxS9MrWl/fJ3JCt6E12KqUVUsEBsywaGrHAKGqKs7BGej8tFFFOAxzhuzHxoKCUvY4UUJSLGWrF5JCudrjPudKS4kabxSu/XwgBWfLyrU8XlwuIkfx+npcTqW4pDU1+RYStaGbJyw8NCzMBSCvhTTOMQK5ff0pyxvyVIaHFBH9LJRhW9pKNMYV4kNTVu0kGtENx9YSgZR51YpJluk5PhVtFiSN4yrglsTNZngU6rFhIoFDTPCvBuLk7zqD/vtd1CIWGmEQJ3IFJ7jtZl7bBAwH7xEXzhXVxILg5aO0qfr2rEzJytV5goLQJSvgtmo5iYcaS4DAYfXQYe2BDGNG9i5IJf3G1pnYOeqa8FweUsgpHcubC0bdXqCw0ICP8aJrtp1yCZtyLhwVPobDH63BExz5+nptesLN/s89t5J5JWOa9ZPyUSpVsgLGGggaS86q6geXwT3KXIUV5g0vfpIFU/QEZDuM4ne7FRU1ppqDp8SX0ESU9MoR2GuuH82Gb3XHQgAVOIwUntUpsF3nVAVZ8nxc/p6qJQzQ+/0repAUEIgM0/3AXbgEIoUQqyARO5q4tsrqqGYc9Tjy1IsytL88HxmoTLRMdTlDr4MC2RpDcy5W005gpgyO5EjgeRdcXFAJkjUcaSBqKetm2FsZJ2xE1dugAm5J13cPIQQp7f1d3RDimV9tiZN5pEWUY62I9U+DnAKBD8c6qiXRYsreNzeyHO5+j77DVCt5/9vHqt2guLfWtblnml8jCPozsHQLbGThExtqKBeFvElCM/Z/zqxbv+7TYSnk9+sc1WRe0ghD+Jt/ZXB9ovXTwOkrSlwTCKWRBQ2dODjd2nQDxr9x1S8UbHrKIv7nqPCgqtsw2rXZmLebjM1Y6Qk3D5e44YCoW90Xa3CqMQ2PwUh2eST7MCUWAnjZp3o67AcDfqoAoKakT4C+HWGzWPrVIoYVgbp100T732Xyqp2xeNbKGYSKP+avWfLzTSR1xdIo8acI7RWj+T3+ylSZ3cY/mYHRbQckPvBs8nSUdynlm4JeEyWmi9qdntx7B6gV2ZuppUtFjSCgcVMFAWggZQIVUXmwbJgfvnL0gmRTuq4mdyI4r9wiaKSTqe5fDBVBjKL1wnqsjxmhNRuuXUoy2CGi90FcUDTQWEtH8XEJ2A73hkYcnNJpMfbZzO4c1u8sZt1tDdPcybn7nOaESNO4BK8cUYd3VjRToFRYny8C4owa/JV4R9DGjNCWcdnYAOXoJUjomSKR3kqLAjTIkV013gMUA3lju+54XIn3w+KtliUPSMRF10kzr98C4nki7C/DMJLDa0T+qHQXylusWb4CMRLsPg5yTbe5NXLOfy2eQI+fnyxXadD1ZxO7YIr6aOfrosEf/VCZc7r/K7sCTFNWG9ipxX37I07VZA7joJeu6xir6ukBT5sYh6yfBLM4NiKRWSxdbq/lMjxD0cqrM/hD9EteELwYpHRiZFyd2v/xttXWSkBEh6RGxntj+yLSLuO+iRJNU57ThXKwxaolQuKtZHnfYolk8qrckwpn7a9xEK6w0tONNw1RPk4wTImN2+3FiF8WSKYq0B1A0Eg39n2ea7d1eTMAMQg9M77wVOsHSGLMXH5ECSuX/JvY6yW/1KdYiXC1o/Z761yQBj2ZPLxH1slSM6DmDHqL1ncuYmFHbV9jzNFIfF1lK151LmIbmUtICe7XJPvGxLSzuC/Xw+Ka1NzbYs4BFeXjnG/IgRvVteCklnMy/fO4hUrSmwq7QNc1465LdQFQ2qHh3tGijI1e4leNkU06QzglyFGEosW99XhIAWs0DgElCkUoF5FbmlFYPwQpAaCqxVYP9Wc5Pon5tEZ9/BBdda2KczXAYoTucY5AGDf41Et/7u4htmey82XO2IEnQ83qEXEYmOlpF5YljtAWlBqSbUhCU81BNhVMooOoVRKU6sio3x/BAUwc59CnfyRwYBoNFLVoLv07eL6rHQwU/ZyJTkGYW4f3HQxUPDaSkp+1b/2e8cDkdb9Dv3SzVKQ5NM7BHVkpGaRz8E71Dd58/PILH2XOXKd2jPBbOFRsxXlaHCEAzc4qTvi8GrRnBLooIXFSyd+cr6hqz0xoY6mzReT+wPi8/6yOQb+J4VXmLKyfssqdzMvvx0mztX8aK0EDb1ZCNkLFoGVNCJauK/ptGuBKdRG/9rlheo+LYdiv9Y+t012yKz1vAZzYv0LjSSX0Q8HcIBfYBSNin10jy6eOzdtUtRVvZF1UcZBnuUoal+PTwaW/aPLBWT6+jl0MbJKaljQmEaVomKfMnKi/e7hl+JnszA9n3iEbZWAO5iX2RDLPPI5DwUfX7B49SKQdmKSi7dj6DmRe0fr6fQhnM7qi9ZQx3V7RRQwOa8kijlayOzNXkNoBA0WEdSNUOvJpWgnxUFDoJ+AALFlp8JQxn+721xqPHDTxDfvRGKsWTtCX8HbLLYLiZ2i9SkShcmQKi1v8nEaMlFCzB1WFOfDC4dSDri582+YsaJL8DyH/ETLIWaGJK5TSTH5BFOkAlw+zjrxeTcQVuQoTkd3v6fOpJLfYWc0/RsCMPKXJWI88t5Prjbpyz5B1RrpagvAvBm+C6Y0BWr7zcgrARggCh6Sz0KuBtp90u1WxGBCUxpmv7bc7MG//8lnV010iUVuSOeFBu4/Pf3w2VNwZmrS0j77uLHN3X8HUR25cqGtcJZ9BRKwLSCfPcQtrHylWbtQqe72gygCbksdpyg+WsqVcS4vWFkYjhSIdYb/gjxRN1WVHKqZ0nChBocNMun7u8DryMA/REL3PDQdlhhvDGClO2KLC9L+7CmOolOX3xnjXBQvnPTv1AJWXCGs0hFoEPwrsEuIAW3skz4FGZtofdKdHQd5NbrQFDWSiq8YuhdlRpU+zV3JEC6JL/AyZlTkWCLxKs1gBy+MnectBYNuPag4cCQDLjXso+OdKHgFmCREnZNaL5ND8yALe+uMORJd5lAqmOdtS1+/LbxOG2YWpMxqIXF4nFiKpoIjZ/zKwKO1k/bkDcS+4RX8pCsamesmps3xkh0QfQYOzhjfsfLSpUOGZv3/OG24s6NPdA0NubwWOJ8oIXPY/TAVNyATb6OSAHAYJ8h0sqce8SNhn+mbn3OXdXqWylSEWmjeJPxjC9qG8JaePqDmtQI+VHGtJZyUHyINOjT3bUuMqU7Tf6ellBvk5aVaJvVlfRRlHSUA8Bbgiffe3/1rFSsa7axnwnX0SXhQuc7YG8zjJqIJ/F7XX8wLjZhWouMn/qSjiui0Lmez2ZCx69RugXiQZJ+0FU/d6VHnbIXkMNHJLyWSEAC1aYVfDGDfGzpx2z1ESKvZeUrRie9jcMU2poXXu2d4Vsr7HTjt1ck/7LioSlQvxf/W5ypcve2z7hLfeo8oyflcFaQSJMRZU/MQ10c3cq9kdnHl13lJk+zdC2C6e7aP2JsL7jAxJr4q8ni1xkirxoEBsiCxyt0cxLj+YceMkRrgnajXr9sejXpAxRijebru8qGS5roCc5FCdjcel+KCX8aUjOn7GQd95eLU5mqlpcgWKUmF5DRc1dP4H42srZUB3PNPs/n/XZrhEvhW+tc0a0s9+alBCUXJja7ROMIjCTmh9Xwj9mce92fhOObEDZp2QYNc58f/eLNXtULwWEJjeRFqYHWQzOU/WUAjas7GChgh3C8fPs5hJ0S00SxwG5G5hCj5uJR7VraUNYzXBzDlILW0b3cnuo6opPT+wrwAcnh81t+eGSh7jJ3wJclSlRLIFHBvFFcVjIgOxh/fMC6i4LVSAAAA=',
    'prod-scone.webp':
      'data:image/webp;base64,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',
    'prod-toast.webp':
      'data:image/webp;base64,UklGRlwYAABXRUJQVlA4WAoAAAAgAAAAnwAAnwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggbhYAABBSAJ0BKqAAoAA+lTiWSCWjIiEwF66IsBKJQBiLDlNNb+8ESEIh+4f54zTrpUX74/wH5N+bfka+T6A2R/tI1I+6fOr/Xd/fy11EfZ2+hgG+u/gu6uMqpmL0B/1L6Q+hr7C9g3piejmrLR97B2iWjHKFmeAz/EgdWZyl/9YF0loDJHyqIWDElCKLFO0w39G7FhMVmCeXvJHCXkaLbS9m+oGDXz9KE22UgT9rebOl1nwixcQF4lCGe/xksp0+E11lH8PANlv3jUf+tTNhvGEqlIV4JclAE23UsFQCqBPqg4gVz8YongJFlapfxt4tSFa6bhcyLzaBeqeu+3e7XaUHmff0k2XJLRvKMR5fr5Cy2JxK7/tYCjVTXE2Cy4b9uZ8EqF8am3P7Tyc7LLcz33TJJK+uakQnQZu5/nUB7BIM1VHIYeO/GdQPV05/UVnlMc92lx4IDSHLRmyJEY3K+3ncztK+YVVjT0ZlFeIDYGNLOn91XDfVQ/Zc32ski1m+uLD215l8sjE4e/29PR81pU3pzNCdkWM8e4d3MQuX8BlY3Dn3Q/MHzn/ZVLfdvoqBatYtYi0OEC/OEn4tnV5RaFa4sbSSEg1y1AkFWDB0lOoBca7UV3J5kYfUNDksGWsTs3bXl2k8oRiPidMhb4F7NfE8G3kQ1AOqdMrT9huJP2UVZOeUW3cmg35lPvl2XtnAWYKeYIYt4+WdFOkqTAXnbWx8KnNMLIrvMNhKzz8o43x2U3H/1sLc6gOBnyAA6UetyDen4jlOZXEt4ipCCkK6KcLG+PIcfNXXjS0I15LYWAc61jNjb9vZnTirL8XKFV7CnXfdRj8HjNxCVA57cJkiiOGqANIVQFflXYTrECbBp9+tX5LEb8ae5mVy/cQAAP784Y1CP2X9nql55lQctUfa1cxRtuRTmdTJk2JIEq6sQN3ucY8XaipqXXM6XPVmwMv32VdfudYOnjf+xQ9Qlsm8Di9xel0ffVO/bVsgQ/J6fMTorsZUrey988PmkAJ2qAY0SuUg+SDZxZElf95ellOfBJVTavtQ48jjaMuIkca35o9MwLPq4oyz1b+WeFOxcO8689ruCPwlKoz1sQfPOARdNwMQOaFHAAZf5z9aPdvvlCt6sKfkKPllltHRt7krs/ZZhYVeb3spGxN53reWOAlE63tqrd3vOYQixsrjPTlhfNavT/c7Ftud+Nc5hYUfLmpVHN71K5u9UwJVzWJiVyQic1u9wdG20dWqq+KeN6PW+W61A2fj/69npTTOTH1XynnGsWEQUfRaD6GF81sTuQ2YEljxEd2M6Pj2DzAVnrR7YcgWiosOaM/SrkmzrajXCNrSmEckDoicaA2+yOPgyqVcAwdEEH9HCXPPuuN0KQUWrh1nqXuyMh9aBNKMugzC9sXgJmewohA95tmwPiqmPFdEzsffR10aqrXLEDfUlx6qMPUTMXB9Sey3vjZ3ttseXNTZDaaOMzuiDb3Vu885IOkcdLuFoRvbW2PccaLxRasdnxNm/BD0LLGHEraKpTdO4IfmABYoTrix1T3puNzqJUnZiJMdjW3xiARkRA5A8ES16Zn0i0gTMe8qyP1cVWgWkhE1329MBRlFVgsPv7CjtI4FXDURsT5Fi7soTfP8YTI7WhodE07aqe95wWdmAq4+xb7HYPrSLgDMW/8kiXSYnwV4bW5oPd4WqwE5J7QRHYDv0LJ/O2pXWSrPCkOWkxaPCVbfv3RIpqjL7pVabH4R4xZ71PR8/LQKGEnjT1sqMS+bOfBlakQGPKc32mpzL2EAvhhMPBZ+0JryqOic5WZIHzSWcN7xXHR4Dxu4suGjGw3YO9IC0BMs3EKVwdO5OZBeVcMHCuJSZwtX2f/K4Rj8I54SPMYOUPKZnqVTFrHdf+CVcNyIynO0yOwo61v5UfIWcXv62YMTqaFoBh21a4kSYDA2sQBHbhZe2ZY6kxv67Wqtj+vGByA7XVTvLSj/PwDxoqOY1RaTYPvfiX7Dx7PiyVsChRJaBMxUODgnsRKXsAyjpzs9WPMqrhzOhXrNje1iXKqp06eEcz2Wb/Uu1hQ+qkfrv2TtPSMiaioe52xHOUauLwRbRSxKVz0fENgH/YW/YVq8wWuRtA7/fIiqngTVWYp4UbiSrCbJ7ZnrlA//ndi76goupP29A5tM3MQr3r71f5dFhECOCMjFMHvgGcmeikZe5enJZsX4ayol/gioX9VJMdOcmC4+N18fNzkMe0gV+a6p6fsLuW4K2SEzwJ8mf5eRygAZS88zurpR0jDphshr/SnUkU9JqtlTDV/eYALMztMJk1oJhyJF/2jAtk328BPtnA3EqCqWGABghvRgyv2sncflw4KfR54pbuZyTCbHEWCyAOv8sJxk2Cvd3c+XRzOTlEBxOc36bQKOhzBLAbdSpvSdim4DxxjU07ML9bz9OHrDfkcusrG3oKwX3YZ3lYCTvgLdDfbGlKoKps4mzB1eu8s9Pviu+4guFvqDT2wijjP0Okn4bFTdtSSQt8AGW1zutDuBTCaAU2gBiVMwu4enyfBLmOUFbFUH5eyL82IgQlc6R4GrCIuIY901oc2NTzNRP0rmaNz//XG/3WkRlfjWqfS8WqElfwwFeoIeohGRKtr+i5CZwP5pek61ygrm7AUUxQe93l75rKs/yG+dJ6xzwhfYNplXC3isnUirzZS0/h//YNsToREPAW/vqVw1vozbZP6+l361Msz+PoRksoTjr9S6RPF7eBO1zj95vCmipNWXf/k7OuFwpDbUu/H/gAMhF40wyoYYvrfTzsuPJ2TP8Ug0+odY9HvbE85wx6Qb6ZUXKRuWwacOhd8nlovKAp+KQBejfJ9uBNfh+tEJ4QX9OwXnYJPX1iDJavuJha73mBgfsgN4siJQpiyVP3ScVQBkMT7Yvje8VnhU4NBIBSvuCK4U6mPxtT8njKrRW/sG1Md55Z3SsXiac2NE3p9/U/HogXEugnZMamhxkNipcQnplsfWjPYEFZE+Rxq7cktuGDbVIU6Ic+di1w8tU0l4LicC36jj57XkieRsF6RGygJn5p3gd+qBCaPG6zl7PjSTblzVTOige0yIuNmQtFuD4vXwdgkqbWpO6bPgJtCXYqDk7h7vLkKPuZbOsFc5gv6K5MoA4ukk5NsgyMPdiL5VyQ1mPgooEcH4P9eab0rIpwhJ+O1I21JAb2vbC+om2qiqPWB4M2bE0/Zqm0UDz3i96H+oKxa0L4fdsWJQYqPGAmnjkxpCg5qyP/fmKxGoOC4Bm9FFyuFld84xsDyuTL0GDtQwud4Q0QD4BKgfrozpYVQQJxAcZJfyrIi8tMorl2+rlLfS80OKbEv52AADmdNUBfOALYqpPuCM7yk+9t1CyPHd315b3Tbg4anHLnfp2eTRjhTOxXilORjQuU2Ih2QDD1tnkEKqh6C+a1+1Me2rSMWZgjg0e4bp/zSxBSEBPqtt+TCNloAD69kfMWFBp5rtNdObknevDV7cVj/HjM2W0202cnpCbWeTlWjx41GapK6U0I+fY+pJu17mfgQAHIwGaHwU/LCBkERhsw4qeJlQcaOBzRo91rs6xj5z2mcZhFBMmWtv/wr08qrnKxQhrVoM2Xbx3ChfWchr4z53XDZAbe+fhKf5Ju6x6vibIFqnkt6EmRNG0+xhUIA0T4UXudvINNg2OSpJqDFUYphp9FegvNNvaXy72xmVPufhb+QxnAMWPlRw0TKm4N2WT/HArd67U/NbIohVjbrHnrPXaqo4ZKukrY2eTcz2Di3DQcHM1KYzlca5FjJnfVYSiE51wErMfT9iR9Y4vsXvqqbRhGtyOeeVxfyZyGiaIH1xiakkMjbAQU5F5oCBEgjW7fUYX2oetIa+/Hd+t3Qj0QYy5j7IswRgt1ZKEd40revpmo2cBP6B34t52mYSxVpS7bded1auogXyG/ggdr6sfpKILouCRdkEQrmHvaVHIIkCaqzaVfdCKy+lip3HPrSfFnLut3Ngqs9mHZrJMfmuMPZNFtZ/ZGjeT0NL43nJZ7ayMxkDzRI/ubxNWkhSRe//pwtpd5cU804i2/2VOVGC1je1F4awBFkrjdX9Nn2npDjPA8vsHfBLYiDVZ+CxrTdLGznQ4i+j5yFUqN6M014muuNQ7TNXFZfIl0HjWiC/Qcc73jh/IiZqkyGxWnnRlc5yw8sJuFJ85J5j6bmDJkxlRiu5i0OvHhffrpSxmvAgi5jtyElD3yFrokCGQZlYyqvOpte+3Jw/B+RflEIQLdmI5znXOgMRTMz2ygcUi0SYvM/PdGL/waPraWXyO5t8jigaNuL08j53m4I4pRfc9sZoDLoJzuw9YRV3VcdxmbM/xQna63U/TuqnMyZ+HWp+JLTYsptPtNMQLJfy2eAn91wpTZ6F6TyUin1ytK2yAtsLICAx9VMxzbmy9Fce6H+2gCaofj3pQKaePAtaGffP+7kaOtEAkEGRBVg2LKmqV7sj5VudZEJ7B5SCmvT/dHboOEt05/Pav/z3N64xPy0dxY8m/CYfImrEOWzC4CPa7QBqrUDS1wqKriohLKpP8C3+wObNqeYDxQniH0In1Ow7DAshpfIMbICfzRorKF9HfQp/1dIYg6qgYCBnfwDk6cBl8qPZAKzsWk3QoOxGzlhV3bIK1rjQt/L+X7cIzgFcqpET3MbSwzjPaYEjMKTfy7FCTeYOhGqA9B0xH6jXsUM4ImvpwLhKpV2SP4JPnkNAN1uX7Izp4GflNNb5ElF2SmB6hYHGvyVjNtiV/bQXnvXk6OYOqE+0vmjdXWEtjnOSp7o7Pm6R90CXh9Q1wv0K7M1tBwmmJdwmzGTPozxr6uk87swvFQV9JirKjoR68X7Xrf08+Oy5irN3MbNI77wTZEFcq58WC6RU40UVtdJwQugQkaRxLnyuo1gUkYvYua4z8T3F5rTbKV/L16LnohF1cSW5wFm081wprhImpMQONPCzlWV5wF9oThj2Eq/T/ABgxCvxSiyexjB2g2vVtfVyZFXDTlno4mG3qsqbmoNbDlMb2FzMABoUxwzhmTcixb/ILaUPh90fxWxLFyp5IaAm3ZpixcNQ83Z1VqaTP+3sfp9Rh1Ma7IfSC0QfFosGrryjlmwnu8orZaVBRNncMzeaJ9s1yrHzWfEr9QLafQget4R8uynDjGWpfCtB9vTw8S5ajKLBnU9k5Rt/KyekKJBn7mXSredYY4i2w6QttcPQVU94n5NWWQhYmwyJLHE7xr0L9v8cQufgW4dnwLY6T4t1aWi5H0qM9VpVc6v6WkFsZvPd+oC7ReVc7EbvHt8Xnmqgm0c0VA2+ux0BL1UpJbzIO385Ia9gavMkpzcRlvJJZN05dFP3mqyM5sfci616vwSeQD2IBmNlRuNygRnm/6AMOKr6bd17svBTyMjcdI1X6FjikgmuiusYPse+e89Rei9sg3b9aYWVlK/I5J40WjkytI8c/c1vhzNiTMkB9Iij4WV9m4zkZw8kLLoU975enrjl2CBEWOzGT8K1EhmyBPY/nyuvfnFegZTS5HfpTmawzc1TVXdd0E689FQC23JmYfGN8k2H4E8WC2Y/6nlJYkgm+cZwrNKta2uwfe/SXm0+focH7kUY4fkoLYZkMzfEtwt115QIJg1wkDDWu7TniBZYie9umUEjgBZHyJonIuPstI7IN86W2bRLk0RVUR7mzxX8g6eoyYypB7DcLO5zIxDGGLGbhBHw+uo+p/hktDklAZM4KItjB2/ZPkC9q2cFLuF91PLFWMFH2U5NtrQkORJ68JmObmYgoZJzvFZNZBN3kwq8XXgMnk6beBEg9HKjnOzcqNlTCIqKoq8ROo6hh3rBpsMnI4yBBiLIiIwksHpcaO/fYRKlTIvRlTyR3EyMFQYR47i2UU7fXv4hVT4wrR1TQ51Yn5/rkvGK1kxtXXU+BnHwreXya/DNBXvEMmlO36dzCXjXyd07sGaNZmUB8uA1F1nxj58biDHc1RlADiBTevKAcarN/2jxsBaUB8gBj3gddLmyk61a3TvZyd2dh4H5bRCBbKMCbI/d2HS4LMlYw7/Hd0tqe5dZ21kzajgmhwK0shcyVtq1p8mYLmQutAksYVAY+BD+QlavIawEzN1fjGgEiAPTrrIvbQowzAv32Mkh10ZAHeBC2EcLF5pljqFLR6BLQZYGimncn40ZgLzjTrdD40Wr9zQkysg+qm8KpTC9hZcO6BJLoZFHTaKtDcDCPkB9ZXGQUllSWQCtDS5GUFJ6qtqGdaw6uP5z+C9M2C8RGdgY9JYy30JKDUhJaK2ZHcydIMdLo1wJf8hAwiSEi+rNWO05NONzofIY9aOe/ChZDQlfzQUYIm0lW7C2scIIc1lqN1GHWQm5Z70e74959/mLRZ1jGeKHQ2b7HACjqJsSxg8a1iNkVvRDGOFrSyfPOSaLsnLT8v0P+1QfOAJxxUfwTOnNd2Mlad9xinek/lPXIoMnQ6F81QdIC9PF0AuatnmGahJURuQnhQoP+HOVIRYcPQLHW9699Puu2Y/eGPcai8rMfuaZEG1LAUiRk91Cx4gfPXMqn6qRwwfBQoTRDDCLqxLt8EZp4ULsNS5hedyvKr6AbdJXj9SRMMrvu+mLOLjSM1CchO4L6dswhgmQmLvRkDaE8vgOn4FnjXMIAofoG9n0sGxVoFhn+RosIfYITWOfrj2cTaHmeXeEikibVALPDrhO83GuJTX5gqzhobHiVndPZs84EKGvKEE9XY4UJOyGrWSm5O84yCHzOtDZBpvuXfZwwlOtdwVt9nk6cE7WqI3ohu6yM7U9afI6YZFVfCiaUl0TMRErVPAny/gUCXzr8YlXNNq5hna6aHjbfPHpbtWCuqsRyLsmLfLu37Z9Hl9EM2i5i2UK1FuSgkY3uOWtQGqozogZ8/UTvjAu5UDeKI+Oxs8z8ekeLVaYqC4it+0EzeTPaUI9yXYHxfgyvmOWZHZdGdShqX6GmXRSOC12T0bvn1CQYf9+rSZKkFPkQyACON3ijx6qYww9C2/8KRV7D2votKUo+W2q4FnYiGRUaov7ly2tn/yZg4qoTkmW+faj0u8hrDM8DGGfXRiOQOiwjRAmP9RBd05gKbImERMCWLjk0UDL2S1HyNq6B7BKDOgSJ0JRuLyU4oa0GkYEZgFr5uJte7IeoMJANBBS9CCCVNtPC/wlQK6tGDGAAABXvxzzF9ycnIs1nsiQZ6vyMr5djpVHMpTwlvoPM6Xir1Zf4r9l4P6QAeB9NQaKjzCdYVvWc5EsSxHFZ6uMSbYOzwj/6j+bpRQZrw/qgZROur/oTwVR3KQl/HmjUFWgTvivOB7lhIkhwvfdbHxwI7L68Np+Ud6fPgEFeY+76jQf2mFqgm7llgVMAvKtRGpMbdBUFx2w7V9Sh2Jo87g6y3Au06UDhNV5jLGISLZ2QyTMgdnTw6wANFCCi/hhMzC56v3PrYb9l1kDNII1xgYQEwYyD3GM4+guJcFEgJhOH99k5kUi6O7G8p1R1Lqb0rW8ep0DP/Sj4/y+o0HulB+Hg5WYU6vEq9jPeCNX8Ba7n8fL9H/YYt2JQa9Z9M1akZXcrnCkcO77pAUPj1v7CCkofz4DZNLv76/HGFgZu50Tr9g9PvMM84jbpb1wMB70dG/l0Vw/lxhwFbwGzmPDHY/F9HC9LFYPn+zAVsO3kuLy25IN/dgAAA==',
  };
  const productAssetMap = {
    'prod-latte': 'prod-latte.webp',
    'prod-cappuccino': 'prod-latte.webp',
    'prod-mocha': 'prod-latte.webp',
    'prod-flat-white': 'prod-flat-white.webp',
    'prod-espresso': 'prod-flat-white.webp',
    'prod-americano': 'prod-flat-white.webp',
    'prod-chai-latte': 'prod-cold-brew.webp',
    'prod-iced-coffee': 'prod-cold-brew.webp',
    'prod-matcha-latte': 'prod-cold-brew.webp',
    'prod-lemonade': 'prod-cold-brew.webp',
    'prod-croissant': 'prod-croissant.webp',
    'prod-banana-bread': 'prod-croissant.webp',
    'prod-muffin': 'prod-scone.webp',
    'prod-cookie': 'prod-scone.webp',
    'prod-avocado-toast': 'prod-toast.webp',
    'prod-grilled-cheese': 'prod-toast.webp',
    'prod-veggie-wrap': 'prod-toast.webp',
    'prod-breakfast-bagel': 'prod-toast.webp',
  };

  function resolveProductImage(productId) {
    const assetFile = productAssetMap[productId] || 'prod-latte.webp';
    const assetPath = path.join(demoAssetsDir, assetFile);
    if (fs.existsSync(assetPath)) {
      return `data:image/webp;base64,${fs.readFileSync(assetPath).toString('base64')}`;
    }
    return fallbackImages[assetFile] || null;
  }

  const insertProduct = db.prepare(`
    INSERT OR REPLACE INTO products (
      id, category_id, name, price, tax_type, tax_category_id, tax_behavior,
      cb_percent, track_inventory, stock_quantity, image_url, is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'none', 'standard', 'exclusive', 5, 1, ?, ?, 1, ?, ?, ?)
  `);

  for (const p of products) {
    insertProduct.run(
      p.id,
      p.cat,
      p.name,
      p.price,
      p.stock,
      resolveProductImage(p.id),
      p.sort,
      createdAt,
      createdAt,
    );
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
      x: 25,
      y: 28,
      status: 'available',
    },
    { id: 'tbl-2', number: 'T2', cap: 4, floor: 'Main Dining', x: 65, y: 28, status: 'occupied' },
    {
      id: 'tbl-3',
      number: 'T3',
      cap: 4,
      floor: 'Main Dining',
      x: 25,
      y: 68,
      status: 'held',
    },
    {
      id: 'tbl-4',
      number: 'T4',
      cap: 6,
      floor: 'Main Dining',
      x: 65,
      y: 68,
      status: 'available',
    },
    {
      id: 'tbl-p1',
      number: 'P1',
      cap: 2,
      floor: 'Patio Terrace',
      x: 30,
      y: 45,
      status: 'available',
    },
    {
      id: 'tbl-p2',
      number: 'P2',
      cap: 4,
      floor: 'Patio Terrace',
      x: 65,
      y: 45,
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
  // Order 1: Dine-in order at Table T2 (preparing in kitchen)
  const order1 = db
    .prepare(`
    INSERT INTO orders (
      order_number, table_id, customer_id, user_id, type, guest_count,
      status, subtotal, tax_amount, total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'dine_in', 2, 'preparing', 20.00, 2.60, 22.60, ?, ?)
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
    ) VALUES (?, ?, 'takeaway', 'ready', 5.50, 0.72, 6.22, ?, ?)
  `)
    .run('ORD-1003', 'usr-cashier', createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-matcha-latte', 'Iced Matcha Latte', 5.50, 1, 5.50, 0.72, 6.22, 'ready', ?, ?)
  `).run(order3.lastInsertRowid, createdAt, createdAt);

  // Order 4: Held dine-in order at Table T3
  const order4 = db
    .prepare(`
    INSERT INTO orders (
      order_number, table_id, customer_id, user_id, type, guest_count,
      status, subtotal, tax_amount, total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'dine_in', 3, 'held', 18.25, 2.37, 20.62, ?, ?)
  `)
    .run('ORD-1004', 'tbl-3', 'cust-3', 'usr-server', createdAt, createdAt);

  const order4Id = order4.lastInsertRowid;
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-grilled-cheese', 'Aged Cheddar Grilled Cheese', 8.50, 1, 8.50, 1.11, 9.61, 'pending', ?, ?)
  `).run(order4Id, createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-flat-white', 'Flat White', 5.00, 1, 5.00, 0.65, 5.65, 'pending', ?, ?)
  `).run(order4Id, createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-cappuccino', 'Cappuccino', 4.75, 1, 4.75, 0.61, 5.36, 'pending', ?, ?)
  `).run(order4Id, createdAt, createdAt);

  const heldOrderItems = JSON.stringify([
    {
      id: 'line-gc-1',
      product: {
        id: 'prod-grilled-cheese',
        name: 'Aged Cheddar Grilled Cheese',
        price: 8.5,
      },
      quantity: 1,
      addons: [],
    },
    {
      id: 'line-fw-1',
      product: { id: 'prod-flat-white', name: 'Flat White', price: 5.0 },
      quantity: 1,
      addons: [],
    },
    {
      id: 'line-cap-1',
      product: { id: 'prod-cappuccino', name: 'Cappuccino', price: 4.75 },
      quantity: 1,
      addons: [],
    },
  ]);
  db.prepare(`
    INSERT OR REPLACE INTO held_orders (
      id, table_id, items, customer_id, guest_count, order_notes,
      waived_charge_ids, opted_in_charge_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 3, 'Extra napkins, oat milk on the side', '[]', '[]', ?, ?)
  `).run('ho-demo-tbl3', 'tbl-3', heldOrderItems, 'cust-3', createdAt, createdAt);

  // Order 5: Completed dine-in brunch order for healthy sales analytics
  const order5 = db
    .prepare(`
    INSERT INTO orders (
      order_number, table_id, customer_id, user_id, type, guest_count,
      status, subtotal, tax_amount, total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'dine_in', 2, 'completed', 28.00, 3.64, 31.64, ?, ?)
  `)
    .run('ORD-1005', 'tbl-1', 'cust-3', 'usr-server', createdAt, createdAt);

  const order5Id = order5.lastInsertRowid;
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-avocado-toast', 'Sourdough Avocado Toast', 9.50, 2, 19.00, 2.47, 21.47, 'served', ?, ?)
  `).run(order5Id, createdAt, createdAt);

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'prod-iced-coffee', 'Cold Brew Coffee', 4.50, 2, 9.00, 1.17, 10.17, 'served', ?, ?)
  `).run(order5Id, createdAt, createdAt);

  const paymentDetails5 = JSON.stringify([{ method: 'cash', amount: 31.64 }]);
  db.prepare(`
    INSERT INTO bills (order_id, bill_number, subtotal, tax_amount, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES (?, 'BILL-1005', 28.00, 3.64, 31.64, 31.64, 0.00, 'paid', ?, ?, ?, ?)
  `).run(order5Id, paymentDetails5, createdAt, createdAt, createdAt);

  console.log('[Seed] Blue Harbor Café seeding complete!');
}

module.exports = { seedBlueHarborCafe };
