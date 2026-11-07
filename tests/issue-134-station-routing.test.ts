/**
 * Integration Test: Issue #134 — Route kitchen tickets to per-category stations
 *
 * Replaces the earlier send_to_kitchen boolean idea. Each kitchen station
 * (kitchen, bar, dessert counter, etc.) can be linked to a printer and a set
 * of categories; KOT items are split and routed to whichever station's
 * printer their category belongs to. Items with no matching station, and
 * the whole order when no stations are configured at all, fall back to the
 * plain default-printer ticket — no behavior change for stores not using
 * stations.
 *
 * This tests routeItemsToStations() directly — no printer dispatch involved,
 * so it exercises the actual routing/grouping logic without touching network
 * or USB I/O.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-134-station-routing.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-134-routing-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-134-routing';

const {
  initTestDb,
  seedCategory,
  seedProduct,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { routeItemsToStations } = require('../main/routes/printers');
const {
  expandCategoryIdsWithSubcategories,
  getKdsStationCategoryIds,
  getKdsStationRoutingScope,
  isKdsStationItemAllowed,
} = require('../main/db');

function main() {
  console.log('Integration Test: Issue #134 — Station-based KOT routing');
  console.log('='.repeat(60));

  const db = initTestDb();

  seedCategory(db, 'cat-food', 'Food');
  seedCategory(db, 'cat-bev', 'Beverages');
  seedCategory(db, 'cat-dessert', 'Desserts');
  seedProduct(db, 'prod-food', 'cat-food', 'Sandwich', 150);
  seedProduct(db, 'prod-bev', 'cat-bev', 'Cola', 40);
  seedProduct(db, 'prod-dessert', 'cat-dessert', 'Brownie', 90);

  console.log('\n─── Scenario A: no stations configured — single ticket, default printer ───');
  {
    const items = [{ product_id: 'prod-food' }, { product_id: 'prod-bev' }];
    const groups = routeItemsToStations(db, items);
    assertEqual(groups.length, 1, 'A: exactly one group');
    assertEqual(groups[0].stationName, 'Kitchen', 'A: falls back to the generic Kitchen label');
    assert(groups[0].printer === null, 'A: printer is null (caller falls back to default printer)');
    assertEqual(groups[0].items.length, 2, 'A: both items stay in the one ticket');
  }

  console.log('\n─── Scenario B: bar station configured — beverages split to bar printer ───');
  {
    db.prepare(
      `INSERT INTO printers (id, name, connection_type, ip_address, port) VALUES ('pr-bar', 'Bar Printer', 'network', '192.168.1.60', 9100)`,
    ).run();
    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active) VALUES ('stn-bar', 'Bar', ?, 'pr-bar', 1)`,
    ).run(JSON.stringify(['cat-bev']));

    const items = [{ product_id: 'prod-food' }, { product_id: 'prod-bev' }];
    const groups = routeItemsToStations(db, items);
    assertEqual(groups.length, 2, 'B: two groups — bar and fallback kitchen');

    const bar = groups.find((g: any) => g.stationName === 'Bar');
    assert(!!bar, 'B: a Bar group exists');
    assertEqual(bar.items.length, 1, 'B: Bar group has exactly the beverage');
    assertEqual(bar.items[0].product_id, 'prod-bev', 'B: Bar group item is the beverage');
    assertEqual(bar.printer.id, 'pr-bar', 'B: Bar group is routed to the bar printer');

    const kitchen = groups.find((g: any) => g.stationName === 'Kitchen');
    assert(!!kitchen, 'B: unmatched food item still lands on a fallback Kitchen ticket');
    assertEqual(kitchen.items.length, 1, 'B: Kitchen group has just the food item');
    assert(kitchen.printer === null, 'B: fallback Kitchen group uses the default printer');
  }

  console.log('\n─── Scenario C: two fully-covered stations — everything routed, no fallback ───');
  {
    db.prepare(
      `INSERT INTO printers (id, name, connection_type, ip_address, port) VALUES ('pr-kitchen', 'Kitchen Printer', 'network', '192.168.1.61', 9100)`,
    ).run();
    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active) VALUES ('stn-kitchen', 'Kitchen', ?, 'pr-kitchen', 1)`,
    ).run(JSON.stringify(['cat-food', 'cat-dessert']));

    const items = [
      { product_id: 'prod-food' },
      { product_id: 'prod-bev' },
      { product_id: 'prod-dessert' },
    ];
    const groups = routeItemsToStations(db, items);
    assertEqual(groups.length, 2, 'C: two groups — Kitchen and Bar, no generic fallback');
    assert(
      !groups.some((g: any) => g.printer === null),
      'C: no group falls back to the default printer',
    );

    const kitchenGroup = groups.find((g: any) => g.stationName === 'Kitchen');
    assertEqual(kitchenGroup.items.length, 2, 'C: Kitchen group has food + dessert');
    const barGroup = groups.find((g: any) => g.stationName === 'Bar');
    assertEqual(barGroup.items.length, 1, 'C: Bar group has just the beverage');
  }

  console.log('\n─── Scenario D: inactive station is ignored ───');
  {
    db.prepare(`UPDATE kitchen_stations SET is_active = 0 WHERE id = 'stn-bar'`).run();
    const items = [{ product_id: 'prod-bev' }];
    const groups = routeItemsToStations(db, items);
    assertEqual(groups.length, 1, 'D: only the fallback Kitchen group remains');
    assertEqual(
      groups[0].stationName,
      'Kitchen',
      'D: beverage falls back once its station is deactivated',
    );
    db.prepare(`UPDATE kitchen_stations SET is_active = 1 WHERE id = 'stn-bar'`).run();
  }

  console.log('\n─── Scenario E: station with no printer linked is skipped (misconfigured) ───');
  {
    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active) VALUES ('stn-dessert', 'Dessert', ?, NULL, 1)`,
    ).run(JSON.stringify(['cat-dessert']));
    const items = [{ product_id: 'prod-dessert' }];
    const groups = routeItemsToStations(db, items);
    // stn-kitchen already claims cat-dessert from scenario C, so this should still route there
    assertEqual(
      groups.length,
      1,
      'E: dessert still routes via the station that has both a printer and the category',
    );
    assertEqual(
      groups[0].stationName,
      'Kitchen',
      'E: unlinked Dessert station is ignored in favor of the configured one',
    );
  }

  console.log('\n─── Scenario F: WebUSB station printer is skipped for backend KOT routing ───');
  {
    db.prepare('UPDATE kitchen_stations SET is_active = 0').run();
    db.prepare(
      `INSERT INTO printers (id, name, connection_type, ip_address, port) VALUES ('pr-webusb', 'Browser WebUSB', 'webusb', null, null)`,
    ).run();
    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active) VALUES ('stn-webusb', 'Browser Bar', ?, 'pr-webusb', 1)`,
    ).run(JSON.stringify(['cat-bev']));

    const groups = routeItemsToStations(db, [{ product_id: 'prod-bev' }]);
    assertEqual(groups.length, 1, 'F: WebUSB station falls back to one generic Kitchen group');
    assertEqual(
      groups[0].stationName,
      'Kitchen',
      'F: WebUSB station does not receive backend KOT items',
    );
    assert(
      groups[0].printer === null,
      'F: fallback group leaves printer selection to the backend fallback',
    );
  }

  console.log(
    '\n─── Scenario G: subcategory inherits parent category station & chef KDS/KOT routing ───',
  );
  {
    db.prepare(`UPDATE kitchen_stations SET is_active = 0 WHERE id = 'stn-webusb'`).run();
    db.prepare(
      `UPDATE kitchen_stations SET is_active = 1, category_ids = ? WHERE id = 'stn-bar'`,
    ).run(JSON.stringify(['cat-bev']));
    db.prepare(
      `UPDATE kitchen_stations SET is_active = 1, category_ids = ? WHERE id = 'stn-kitchen'`,
    ).run(JSON.stringify(['cat-food']));

    // Create a child subcategory under 'cat-bev' after 'stn-bar' was already assigned ['cat-bev']
    db.prepare(
      `INSERT INTO categories (id, name, parent_id, is_active) VALUES ('cat-bev-hot', 'Hot Beverages', 'cat-bev', 1)`,
    ).run();
    seedProduct(db, 'prod-espresso', 'cat-bev-hot', 'Espresso', 80);

    // KDS station category expansion & routing scope
    const barStationCats = getKdsStationCategoryIds(db, ['stn-bar']);
    assert(
      Array.isArray(barStationCats) &&
        barStationCats.includes('cat-bev') &&
        barStationCats.includes('cat-bev-hot'),
      'G: getKdsStationCategoryIds expands assigned parent category to include child subcategory',
    );

    const barScope = getKdsStationRoutingScope(db, ['stn-bar'], ['cat-bev']);
    assert(!!barScope, 'G: getKdsStationRoutingScope returns a valid scope for stn-bar');
    assert(
      isKdsStationItemAllowed(
        ['stn-bar'],
        barScope.tablelessCategoryIds,
        null,
        'cat-bev-hot',
        undefined,
        barScope.hasUnrestrictedStation,
      ),
      'G: getKdsStationRoutingScope + isKdsStationItemAllowed permits child subcategory for station and chef assigned to parent category',
    );
    assert(
      !isKdsStationItemAllowed(
        ['stn-bar'],
        barScope.tablelessCategoryIds,
        null,
        'cat-food',
        undefined,
        barScope.hasUnrestrictedStation,
      ),
      'G: getKdsStationRoutingScope + isKdsStationItemAllowed still blocks unrelated category',
    );
    assert(
      isKdsStationItemAllowed(
        ['stn-bar'],
        barScope.tablelessCategoryIds,
        'stn-bar',
        'cat-bev-hot',
        barScope.categoryIdsByStation['stn-bar'],
        barScope.hasUnrestrictedStation,
      ),
      'G: table-assigned order on stn-bar permits child subcategory of parent category',
    );

    const expandedChefCats = expandCategoryIdsWithSubcategories(db, ['cat-bev']);
    assert(
      expandedChefCats.includes('cat-bev') && expandedChefCats.includes('cat-bev-hot'),
      'G: chef userCategoryIds assigned to parent category expands to include child subcategory on KDS',
    );

    // KOT printer routing via routeItemsToStations
    const groups = routeItemsToStations(db, [
      { product_id: 'prod-espresso' },
      { product_id: 'prod-food' },
    ]);
    assertEqual(groups.length, 2, 'G: subcategory beverage and food split into their two stations');
    const barGroup = groups.find((g: any) => g.stationName === 'Bar');
    assert(!!barGroup, 'G: Bar group receives item from child subcategory of cat-bev');
    assertEqual(barGroup.items.length, 1, 'G: Bar group has 1 item');
    assertEqual(
      barGroup.items[0].product_id,
      'prod-espresso',
      'G: Espresso routed to Bar printer via parent category',
    );
    assertEqual(barGroup.printer.id, 'pr-bar', 'G: Bar printer used for child subcategory item');
  }

  console.log(
    '\n─── Scenario H: explicit subcategory assignment on Station B overrides parent on Station A ───',
  );
  {
    db.prepare(
      `INSERT INTO printers (id, name, connection_type, ip_address, port) VALUES ('pr-coffee', 'Coffee Printer', 'network', '192.168.1.62', 9100)`,
    ).run();
    // Station A ('stn-bar') has parent 'cat-bev'; Station B ('stn-coffee') explicitly claims child 'cat-bev-hot'
    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active) VALUES ('stn-coffee', 'Coffee Bar', ?, 'pr-coffee', 1)`,
    ).run(JSON.stringify(['cat-bev-hot']));

    const groups = routeItemsToStations(db, [
      { product_id: 'prod-bev' },
      { product_id: 'prod-espresso' },
    ]);
    assertEqual(
      groups.length,
      2,
      'H: parent beverage and explicit child subcategory split across Station A and Station B',
    );

    const barGroup = groups.find((g: any) => g.stationName === 'Bar');
    assert(!!barGroup, 'H: Station A (Bar) still receives direct parent category items');
    assertEqual(barGroup.items.length, 1, 'H: Bar group has 1 item');
    assertEqual(barGroup.items[0].product_id, 'prod-bev', 'H: Cola stays on Bar');
    assertEqual(barGroup.printer.id, 'pr-bar', 'H: Bar uses pr-bar');

    const coffeeGroup = groups.find((g: any) => g.stationName === 'Coffee Bar');
    assert(
      !!coffeeGroup,
      'H: Station B (Coffee Bar) receives explicitly assigned subcategory items',
    );
    assertEqual(coffeeGroup.items.length, 1, 'H: Coffee Bar group has 1 item');
    assertEqual(
      coffeeGroup.items[0].product_id,
      'prod-espresso',
      'H: Espresso routes to Coffee Bar instead of parent Bar',
    );
    assertEqual(coffeeGroup.printer.id, 'pr-coffee', 'H: Coffee Bar uses pr-coffee');

    // Verify KDS station scope also excludes child subcategory explicitly claimed by another active station
    const barCatsAfterOverride = getKdsStationCategoryIds(db, ['stn-bar']);
    assert(
      Array.isArray(barCatsAfterOverride) &&
        barCatsAfterOverride.includes('cat-bev') &&
        !barCatsAfterOverride.includes('cat-bev-hot'),
      'H: getKdsStationCategoryIds excludes child subcategory explicitly claimed by Station B from Station A',
    );
    const coffeeCatsAfterOverride = getKdsStationCategoryIds(db, ['stn-coffee']);
    assert(
      Array.isArray(coffeeCatsAfterOverride) && coffeeCatsAfterOverride.includes('cat-bev-hot'),
      'H: getKdsStationCategoryIds includes explicitly claimed child subcategory on Station B',
    );
    const barScopeAfterOverride = getKdsStationRoutingScope(db, ['stn-bar'], ['cat-bev']);
    assert(
      !!barScopeAfterOverride &&
        !isKdsStationItemAllowed(
          ['stn-bar'],
          barScopeAfterOverride.tablelessCategoryIds,
          null,
          'cat-bev-hot',
          undefined,
          barScopeAfterOverride.hasUnrestrictedStation,
        ),
      'H: Station A KDS scope does not duplicate child subcategory items claimed by Station B',
    );
    const coffeeScopeAfterOverride = getKdsStationRoutingScope(db, ['stn-coffee'], ['cat-bev']);
    assert(
      !!coffeeScopeAfterOverride &&
        isKdsStationItemAllowed(
          ['stn-coffee'],
          coffeeScopeAfterOverride.tablelessCategoryIds,
          null,
          'cat-bev-hot',
          undefined,
          coffeeScopeAfterOverride.hasUnrestrictedStation,
        ),
      'H: Station B KDS scope allows child subcategory items for chef assigned to parent category',
    );
  }

  console.log(
    '\n─── Scenario I: unrestricted station (category_ids: []) with printer catches unmatched items ───',
  );
  {
    db.prepare(
      `INSERT INTO printers (id, name, connection_type, ip_address, port) VALUES ('pr-all', 'All-Categories Printer', 'network', '192.168.1.63', 9100)`,
    ).run();
    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active) VALUES ('stn-all', 'Main Line', '[]', 'pr-all', 1)`,
    ).run();

    // 'prod-espresso' (explicit subcategory -> Coffee Bar), 'prod-bev' (parent category -> Bar),
    // 'prod-dessert' (unassigned category -> Main Line unrestricted station)
    const groups = routeItemsToStations(db, [
      { product_id: 'prod-espresso' },
      { product_id: 'prod-bev' },
      { product_id: 'prod-dessert' },
    ]);
    assertEqual(
      groups.length,
      3,
      'I: explicit subcategory, parent category, and unrestricted station each receive their item without default fallback',
    );
    assert(
      !groups.some((g: any) => g.printer === null),
      'I: no items fall back to the default kitchen printer when an unrestricted station has a printer',
    );
    const allGroup = groups.find((g: any) => g.stationName === 'Main Line');
    assert(
      !!allGroup,
      'I: unrestricted station (category_ids: []) receives unmatched category item',
    );
    assertEqual(allGroup.items.length, 1, 'I: Main Line has 1 item');
    assertEqual(allGroup.items[0].product_id, 'prod-dessert', 'I: Brownie routes to Main Line');
    assertEqual(allGroup.printer.id, 'pr-all', 'I: Main Line uses pr-all');
  }

  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main();
