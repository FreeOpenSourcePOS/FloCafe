import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'frontend/src/hooks/useKdsConnection.ts'),
  'utf8',
);
const conflictBranch = source.match(/if \(statusCode === 409\) \{[\s\S]*?\n\s*return;/)?.[0] || '';

assert.match(
  conflictBranch,
  /await fetchOrdersRest\(\);/,
  'KDS conflicts refresh REST state even with an active WebSocket',
);
assert.doesNotMatch(
  conflictBranch,
  /wsRef\.current === null/,
  'KDS conflict refresh is not gated on WebSocket absence',
);

const Module = require('node:module') as {
  createRequire: (filename: string) => NodeRequire;
  _resolveFilename: (...args: any[]) => string;
};
const frontendRequire = Module.createRequire(path.resolve(process.cwd(), 'frontend/package.json'));
const originalResolveFilename = Module._resolveFilename;
const frontendResolved = new Map<string, string>(
  [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/server',
    'use-intl',
    '@dnd-kit/dom',
    '@dnd-kit/react',
    'lucide-react',
    'react-hot-toast',
    'radix-ui',
    'clsx',
    'tailwind-merge',
    'class-variance-authority',
  ].map((pkg) => [pkg, frontendRequire.resolve(pkg)]),
);

Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = frontendResolved.get(request) ?? request;
  if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(process.cwd(), 'frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(process.cwd(), 'shared/print', request.slice('@print/'.length));
  } else if (request.startsWith('@shared/')) {
    resolvedRequest = path.resolve(process.cwd(), 'shared', request.slice('@shared/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

try {
  const React = frontendRequire('react');
  const ReactDOMServer = frontendRequire('react-dom/server');
  const { IntlProvider } = frontendRequire('use-intl');
  const enMessages = require('../frontend/src/lib/i18n/messages/en.json');
  const { KdsKanbanBoard } = require('../frontend/src/components/kds/KdsKanbanBoard');

  const kanbanMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      IntlProvider,
      { locale: 'en', messages: enMessages, timeZone: 'UTC' },
      React.createElement(KdsKanbanBoard, {
        updating: null,
        updateItemStatus: async () => true,
        orders: [
          {
            id: 101,
            order_number: 'KDS-1513',
            type: 'dine_in',
            created_at: '2026-11-08 15:00:00',
            table: { name: 'T4' },
            items: [
              {
                id: 1,
                order_id: 101,
                product_id: 'prod-burger',
                product_name: 'Smash Burger',
                quantity: 2,
                status: 'pending',
                addons: [
                  { id: 'addon-cheese', name: 'Extra Cheese', quantity: 2 },
                  { id: 'addon-bacon', name: 'Bacon', quantity: 1 },
                ],
                special_instructions: 'No onions',
              },
              {
                id: 2,
                order_id: 101,
                product_id: 'prod-latte',
                product_name: 'Latte',
                quantity: 1,
                status: 'voided',
                addons: [
                  { id: 'addon-oat', name: 'Oat Milk', quantity: 2 },
                  { id: 'addon-cinnamon', name: 'Cinnamon', quantity: 1 },
                ],
                special_instructions: 'Extra hot',
              },
            ],
          },
        ],
      }),
    ),
  );

  assert.match(
    kanbanMarkup,
    /\+ Extra Cheese ×2/,
    'KDS Kanban card renders multi-quantity add-on name and quantity inline',
  );
  assert.match(
    kanbanMarkup,
    /\+ Bacon(?! ×)/,
    'KDS Kanban card renders single-quantity add-on name inline without ×1 suffix',
  );
  assert.match(
    kanbanMarkup,
    /&quot;No onions&quot;/,
    'KDS Kanban card renders item special instructions alongside add-on pills',
  );
  assert.doesNotMatch(
    kanbanMarkup,
    />\+2<\/span>/,
    'KDS Kanban card does not render redundant +count badge once add-on pills are inline',
  );
  assert.match(
    kanbanMarkup,
    /\+ Oat Milk ×2/,
    'KDS Kanban voided column renders multi-quantity add-on pill inline',
  );
  assert.match(
    kanbanMarkup,
    /\+ Cinnamon(?! ×)/,
    'KDS Kanban voided column renders single-quantity add-on pill inline',
  );
  assert.match(
    kanbanMarkup,
    /&quot;Extra hot&quot;/,
    'KDS Kanban voided column renders item special instructions inline',
  );
} finally {
  Module._resolveFilename = originalResolveFilename;
}

console.log('✅ KDS frontend conflict refresh & Kanban inline add-ons regression test passed');
