/**
 * Every main-process `$exception` must arrive usable: a message, a type, a platform on each frame,
 * and the release, OS, install source and process. PostHog flagged the one real main-process
 * exception of 2026-10-16 for `missing field platform`; this suite starts from that exact shape.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-posthog-fields-'));

interface RecordedClient {
  options: { before_send?: (event: unknown) => unknown };
  exceptions: Array<{ properties?: Record<string, unknown>; scrubbed?: Record<string, unknown> }>;
}

const clients: RecordedClient[] = [];

function stackFrames(stack: string) {
  const frames: Array<{ filename: string; lineno: number; colno: number; function: string }> = [];
  for (const line of stack.split('\n').filter((text) => text.trim().startsWith('at '))) {
    const text = line.trim().slice(3);
    const open = text.lastIndexOf('(');
    const location = open === -1 ? text : text.slice(open + 1).replace(/\)$/, '');
    const match = /^(.*):(\d+):(\d+)$/.exec(location);
    if (match) {
      frames.push({
        filename: match[1],
        lineno: Number(match[2]),
        colno: Number(match[3]),
        function: 'frame',
      });
    }
  }
  return frames;
}

Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '1.2.3' } };
  }
  if (request === 'posthog-node') {
    return {
      PostHog: class {
        options: RecordedClient['options'];
        exceptions: RecordedClient['exceptions'] = [];
        constructor(_token: string, options: RecordedClient['options']) {
          this.options = options;
          clients.push(this);
        }
        capture() {}
        captureException(error: Error, distinctId?: string, properties?: Record<string, unknown>) {
          const event = {
            event: '$exception',
            properties: {
              ...(properties ?? {}),
              distinct_id: distinctId,
              $exception_list: [
                {
                  type: error.name,
                  value: error.message,
                  stacktrace: { type: 'raw', frames: stackFrames(error.stack ?? '') },
                },
              ],
            },
          };
          const kept = this.options.before_send?.(event) as
            | { properties?: Record<string, unknown> }
            | null
            | undefined;
          if (!kept) return;
          this.exceptions.push({ properties, scrubbed: kept.properties });
        }
        alias() {}
        async shutdown() {}
      },
    };
  }
  return originalLoad.apply(Module, arguments as never);
};

const { initDatabase, getDatabase, now } = require('../main/db');
const { capturePostHogException, syncPostHogIdentity } = require('../main/services/posthog');
const { scrubPostHogEvent } = require('../shared/posthog-scrub');

function setSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now());
}

/** The event PostHog kept on 2026-10-16: one frame, no message, no release, no platform. */
const brokenEvent = {
  event: '$exception',
  properties: {
    capture_point: 'uncaughtException',
    $exception_list: [
      {
        type: 'TypeError',
        stacktrace: {
          type: 'raw',
          frames: [{ filename: 'main/services/posthog-config.js', lineno: 14 }],
        },
      },
    ],
  },
};

const main = {
  telemetryEnabled: false,
  accountLinked: false,
  allowExceptions: true,
  exceptionContext: {
    app_version: '1.2.3',
    platform: 'darwin',
    install_source: 'mas',
    process_type: 'main',
    $os: 'Mac OS X',
    $os_version: '24.6.0',
  },
};

function requireFields(
  properties: Record<string, unknown> | undefined,
  where: string,
  platform: string,
): void {
  const fields = properties ?? {};
  for (const key of ['app_version', 'platform', 'install_source', 'process_type', '$os']) {
    assert.equal(typeof fields[key], 'string', `${where}: ${key} is a string`);
    assert.ok(String(fields[key]).length > 0, `${where}: ${key} is not empty`);
  }
  // PostHog's own schema check: `missing field platform` rejected the real event.
  assert.equal(fields.platform, platform, `${where}: the event carries the platform`);
  assert.equal(typeof fields.$exception_message, 'string', `${where}: it has a message`);
  assert.ok(String(fields.$exception_message).length > 0, `${where}: the message is not empty`);
  assert.equal(typeof fields.$exception_type, 'string', `${where}: it has a type`);
  const list = fields.$exception_list as
    | Array<{ stacktrace: { frames: Array<Record<string, unknown>> } }>
    | undefined;
  assert.ok(Array.isArray(list) && list.length > 0, `${where}: it has an exception list`);
  for (const entry of list ?? []) {
    assert.ok(entry.stacktrace.frames.length > 0, `${where}: entry keeps its frames`);
    for (const frame of entry.stacktrace.frames) {
      // PostHog's frame parser accepts language tags only, so `darwin` would fail it.
      assert.equal(frame.platform, 'node:javascript', `${where}: every frame is tagged as Node`);
    }
  }
}

async function mainTest(): Promise<void> {
  // The scrub layer, on the exact broken shape, without any notification client involved.
  requireFields(
    scrubPostHogEvent(brokenEvent, main)?.properties,
    'scrubbed broken event',
    'darwin',
  );

  // A frame that names its own platform keeps it.
  const ownPlatform = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'uncaughtException',
        $exception_list: [
          {
            type: 'TypeError',
            stacktrace: {
              type: 'raw',
              frames: [{ filename: 'main/services/posthog-config.js', lineno: 14, platform: 'js' }],
            },
          },
        ],
      },
    },
    main,
  );
  const ownFrames = (
    ownPlatform?.properties?.$exception_list as Array<{ stacktrace: { frames: unknown[] } }>
  )[0].stacktrace.frames as Array<Record<string, unknown>>;
  assert.equal(ownFrames[0].platform, 'js', 'a frame with its own platform keeps it');

  // Values the event already carries are never overwritten by the defaults.
  const carried = scrubPostHogEvent(
    {
      event: '$exception',
      properties: {
        capture_point: 'uncaughtException',
        app_version: '9.9.9',
        $exception_list: [{ type: 'TypeError', value: 'reading 42' }],
      },
    },
    main,
  );
  assert.equal(carried?.properties?.app_version, '9.9.9');

  // Every capture point in main gets the fields, including one the SDK captured on its own.
  delete process.env.CI;
  process.env.FLO_POSTHOG_DEV = '1';
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
  initDatabase();
  setSetting('posthog_host', 'https://us.i.posthog.com');
  setSetting('posthog_project_token', 'phc_test');
  setSetting('product_analytics_level', 'off');
  setSetting('diagnostics_transmission_enabled', 'true');
  syncPostHogIdentity();

  capturePostHogException('uncaughtException', new Error(''));
  assert.equal(clients.length, 1, 'an exception-only install still connects');
  const sent = clients[0].exceptions.at(-1);
  assert.ok(sent, 'the exception was handed to the client');
  assert.equal(sent.properties?.process_type, 'main');
  requireFields(sent.scrubbed, 'captured exception', process.platform);

  // An event the SDK captured itself, with no context at all.
  const fromSdk = await clients[0].options.before_send?.(brokenEvent);
  assert.ok(fromSdk, 'the SDK event is kept');
  requireFields(
    (fromSdk as { properties?: Record<string, unknown> }).properties,
    'sdk captured event',
    process.platform,
  );

  console.log('posthog exception fields: all assertions passed');
}

mainTest().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
