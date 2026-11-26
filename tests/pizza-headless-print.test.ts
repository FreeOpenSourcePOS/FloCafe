/**
 * Pizza fork, headless kit: a kitchen ticket printed through the headless server reaches a plain
 * network ESC/POS printer. A loopback TCP printer stands in for the real one.
 *
 * Usage: npm run test:pizza-headless-print
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
const {
  assertEqualOrThrow,
  assertIncludesOrThrow,
  assertOrThrow,
} = require('./helpers/test-setup');
const fakePrinter = require('./helpers/fake-escpos-printer');
import { headlessEnv, liveDbPath, runCases, startHeadless } from './helpers/headless';

void runCases('Pizza headless kit: network ESC/POS kitchen ticket', [
  [
    'the loopback printer receives the kitchen ticket from the headless server',
    async () => {
      const printer = await fakePrinter.start();
      const env = await headlessEnv();
      const server = await startHeadless(env);
      try {
        const db = new Database(liveDbPath(env), { timeout: 5000 });
        let orderId: number;
        try {
          // A finished setup sets these; the printer refuses to format without them.
          const setting = db.prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          );
          for (const [key, value] of [
            ['country', 'CA'],
            ['currency', 'CAD'],
            ['currency_symbol', '$'],
            ['timezone', 'America/Vancouver'],
          ])
            setting.run(key, value);
          db.prepare(
            `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
             VALUES ('owner-headless', 'Owner', 'owner@headless.test', ?, 'owner', 1, datetime('now'), datetime('now'))`,
          ).run(bcrypt.hashSync('headless-pass-1', 10));
          db.prepare(
            `INSERT INTO printers (id, name, connection_type, ip_address, port, is_default)
             VALUES ('pr-kitchen', 'Kitchen', 'network', '127.0.0.1', ?, 1)`,
          ).run(printer.port);
          orderId = Number(
            db
              .prepare(
                `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
                 VALUES ('ORD-HEADLESS-1', NULL, 'takeaway', 'pending', 100, 100, datetime('now'), datetime('now'))`,
              )
              .run().lastInsertRowid,
          );
        } finally {
          db.close();
        }

        const api = `http://127.0.0.1:${env.PORT}/api`;
        const login = await fetch(`${api}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'owner@headless.test', password: 'headless-pass-1' }),
        });
        const loginBody: any = await login.json();
        if (login.status !== 200) console.error(`  login: ${JSON.stringify(loginBody)}`);
        assertEqualOrThrow(login.status, 200, 'login succeeds');

        const print = await fetch(`${api}/printers/print-kot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${loginBody.access_token}`,
          },
          body: JSON.stringify({
            orderId,
            stationName: 'Kitchen',
            items: [{ product_name: 'Margherita Large', quantity: 2, status: 'pending' }],
          }),
        });
        const printBody = await print.json();
        console.log(`  print-kot ${print.status}: ${JSON.stringify(printBody)}`);
        assertEqualOrThrow(print.status, 200, 'print-kot succeeds');

        const bytes = Buffer.from(printer.printed);
        console.log(`  printer received ${printer.received.length} bytes, printed ${bytes.length}`);
        assertOrThrow(bytes.length > 0, 'the printer printed bytes');
        assertOrThrow(
          bytes.includes(Buffer.from([0x1b, 0x40])),
          'the ticket starts an ESC/POS job (ESC @)',
        );
        assertIncludesOrThrow(
          bytes.toString('latin1'),
          'Margherita Large',
          'the ticket names the item',
        );
      } finally {
        await server.stop();
        await printer.close();
      }
    },
  ],
]);
