/**
 * Table Move UI: modal rendering, disabled states, floor filtering,
 * and entry point wiring across Floorplan, Tables list, and POS Checkout.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/table-move-ui.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));
const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
  _load: (...args: any[]) => any;
};
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
  const resolvedRequest = request.startsWith('@/')
    ? path.resolve(ROOT, 'frontend/src', request.slice(2))
    : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const React = frontendRequire('react');
const ReactDOMServer = frontendRequire('react-dom/server');

const apiCalls: Array<{ url: string; payload?: unknown }> = [];
const authState = {
  currentTenant: {
    id: 'tenant-1',
    name: 'Flo Cafe',
    role: 'cashier',
    permission_ids: ['tables.orders.move'],
  },
  user: { id: 'usr-1', name: 'Staff' },
};

const mocks: Record<string, unknown> = {
  'use-intl': {
    useTranslations:
      (namespace: string) => (key: string, values?: Record<string, string | number>) => {
        let result = `${namespace}.${key}`;
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            result = result.replace(`{${k}}`, String(v));
          }
        }
        return result;
      },
  },
  '@/hooks/useFormatCurrency': {
    useFormatCurrency: () => (value: number) => `$${Number(value).toFixed(2)}`,
  },
  'lucide-react': {
    X: () => null,
    ArrowRightLeft: () => null,
    Loader2: () => null,
    Users: () => null,
    MapPin: () => null,
    MapPinned: () => null,
    ChevronRight: () => null,
    Eye: () => null,
    LayoutGrid: () => null,
    Maximize2: () => null,
    Minimize2: () => null,
    MoreHorizontal: () => null,
    Pencil: () => null,
    Plus: () => null,
    Sparkles: () => null,
    Table2: () => null,
    Trash2: () => null,
    Search: () => null,
    UserPlus: () => null,
    RotateCcw: () => null,
    List: () => null,
    ShoppingCart: () => null,
    Printer: () => null,
  },
  '@/lib/api': {
    __esModule: true,
    default: {
      get: async (url: string) => {
        apiCalls.push({ url });
        return { data: { tables: [] } };
      },
      post: async (url: string, payload?: unknown) => {
        apiCalls.push({ url, payload });
        return { data: { success: true } };
      },
    },
  },
  '@/store/auth': {
    useAuthStore: (selector?: (state: typeof authState) => unknown) =>
      selector ? selector(authState) : authState,
  },
  'react-hot-toast': {
    __esModule: true,
    default: {
      success: () => undefined,
      error: () => undefined,
    },
  },
};

const originalLoad = moduleApi._load;
moduleApi._load = function (request: string, parent: any, isMain: boolean) {
  if (request in mocks) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};

const MoveTableModalModule = require('../frontend/src/components/tables/MoveTableModal');
const MoveTableModal = MoveTableModalModule.default;

function mockTable(
  id: string,
  name: string,
  status: 'available' | 'occupied' | 'reserved' | 'cleaning' | 'held',
  floor = 'Ground',
  capacity = 4,
  activeOrder?: any,
) {
  return {
    id,
    name,
    capacity,
    status,
    kitchen_station_id: null,
    floor,
    section: 'Main',
    position_x: null,
    position_y: null,
    is_active: true,
    activeOrder: activeOrder || null,
    current_order: activeOrder || null,
  };
}

function testMoveTableModalRendering() {
  const source = mockTable('tbl-1', 'Table 1', 'occupied', 'Ground', 4, {
    id: 101,
    order_number: '001',
    total: 35.5,
  });

  const candidates = [
    source,
    mockTable('tbl-2', 'Table 2', 'available', 'Ground', 2),
    mockTable('tbl-3', 'Table 3', 'occupied', 'Ground', 4),
    mockTable('tbl-4', 'Table 4', 'cleaning', 'Patio', 6),
    mockTable('tbl-5', 'Table 5', 'reserved', 'Patio', 4),
  ];

  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(MoveTableModal, {
      sourceTable: source,
      tables: candidates,
      onClose: () => undefined,
      onSuccess: () => undefined,
    }),
  );

  // Source table banner
  assert.ok(markup.includes('Table 1'), 'renders source table name');
  assert.ok(markup.includes('tables.capacitySeats'), 'renders seat capacity');
  assert.ok(markup.includes('001'), 'renders active order number');
  assert.ok(markup.includes('$35.50'), 'renders formatted active order total');

  // Candidate tables
  assert.ok(markup.includes('Table 2'), 'renders available candidate table');
  assert.ok(markup.includes('Table 3'), 'renders occupied candidate table');
  assert.ok(markup.includes('Table 4'), 'renders cleaning candidate table');
  assert.ok(markup.includes('Table 5'), 'renders reserved candidate table');

  // Occupied tables must be disabled
  assert.ok(markup.includes('disabled=""'), 'occupied candidate table has disabled attribute');

  // Multiple floors present -> floor filter pills rendered
  assert.ok(markup.includes('tables.allFloors'), 'renders All Floors filter tab');
  assert.ok(markup.includes('Ground'), 'renders Ground floor filter tab');
  assert.ok(markup.includes('Patio'), 'renders Patio floor filter tab');

  console.log(
    '  ✓ MoveTableModal renders source summary, candidates, floor filters, and disabled states',
  );
}

function testFloorplanEditorWiring() {
  const floorplanSrc = fs.readFileSync(
    path.join(ROOT, 'frontend/src/components/tables/FloorplanEditor.tsx'),
    'utf8',
  );

  assert.ok(
    floorplanSrc.includes('onMoveTable?: (tb: Table) => void;'),
    'FloorplanEditor accepts onMoveTable prop',
  );
  assert.ok(
    floorplanSrc.includes("label: t('moveTable')"),
    'sheetActionsFor includes moveTable action',
  );
  assert.ok(
    floorplanSrc.includes('ArrowRightLeft'),
    'sheetActionsFor uses ArrowRightLeft icon for moveTable',
  );
  assert.ok(
    floorplanSrc.includes('onMoveTable(tb)'),
    'sheetActionsFor invokes onMoveTable callback',
  );
  assert.ok(
    floorplanSrc.includes('!!onMoveTable'),
    'canOpenActionSheet opens for occupied table when onMoveTable is supplied',
  );

  console.log('  ✓ FloorplanEditor is properly wired with onMoveTable prop and action sheet entry');
}

function testTablesPageWiring() {
  const tablesPageSrc = fs.readFileSync(
    path.join(ROOT, 'frontend/src/app/(dashboard)/tables/page.tsx'),
    'utf8',
  );

  assert.ok(
    tablesPageSrc.includes("tenantCan(currentTenant, 'tables.orders.move')"),
    'checks tables.orders.move permission',
  );
  assert.ok(
    tablesPageSrc.includes('const [movingTable, setMovingTable] = useState<Table | null>(null);'),
    'has movingTable state',
  );
  assert.ok(
    tablesPageSrc.includes('onMoveTable={canMoveTable ? (tb) => setMovingTable(tb) : undefined}'),
    'passes onMoveTable to FloorplanEditor',
  );
  assert.ok(
    tablesPageSrc.includes('<MoveTableModal'),
    'mounts MoveTableModal when movingTable is active',
  );
  assert.ok(
    tablesPageSrc.includes("tTables('moveTable')"),
    'renders Move Table button in list view',
  );

  console.log('  ✓ Tables page is properly wired in both Plan and List views');
}

function testTableCheckoutModalWiring() {
  const checkoutModalSrc = fs.readFileSync(
    path.join(ROOT, 'frontend/src/components/pos/TableCheckoutModal.tsx'),
    'utf8',
  );

  assert.ok(
    checkoutModalSrc.includes("tenantCan(currentTenant, 'tables.orders.move')"),
    'checks tables.orders.move permission',
  );
  assert.ok(checkoutModalSrc.includes('<MoveTableModal'), 'mounts MoveTableModal');
  assert.ok(checkoutModalSrc.includes("tTables('moveTable')"), 'renders Move Table action button');
  assert.ok(checkoutModalSrc.includes('ArrowRightLeft'), 'uses ArrowRightLeft icon');

  console.log('  ✓ TableCheckoutModal is properly wired with permission gate and MoveTableModal');
}

async function main() {
  console.log('Table Move UI tests');
  try {
    testMoveTableModalRendering();
    testFloorplanEditorWiring();
    testTablesPageWiring();
    testTableCheckoutModalWiring();
  } finally {
    moduleApi._load = originalLoad;
    moduleApi._resolveFilename = originalResolveFilename;
  }
  console.log('All Table Move UI tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
