const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const serviceWorkerSource = fs.readFileSync(
  require('node:path').join(__dirname, '../frontend/public/sw.js'),
  'utf8',
);

class TestCache {
  constructor() {
    this.entries = new Map();
  }

  key(request) {
    return typeof request === 'string' ? request : request.url;
  }

  async match(request) {
    return this.entries.get(this.key(request));
  }

  async put(request, response) {
    this.entries.set(this.key(request), response);
  }
}

class TestCaches {
  constructor(cacheNames = ['flo-v18']) {
    this.cache = new TestCache();
    this.cacheNames = cacheNames;
    this.deletedNames = [];
  }

  async open() {
    return this.cache;
  }

  async match(request) {
    return this.cache.match(request);
  }

  async keys() {
    return this.cacheNames;
  }

  async delete(name) {
    this.deletedNames.push(name);
    this.cache.entries.clear();
    return true;
  }
}

function loadFetchHandler(caches, fetchImpl) {
  const listeners = new Map();
  const self = {
    location: { hostname: 'localhost' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  vm.runInNewContext(serviceWorkerSource, {
    self,
    caches,
    fetch: fetchImpl,
    URL,
    Response,
    Promise,
    console,
  });
  return {
    fetch: listeners.get('fetch'),
    activate: listeners.get('activate'),
  };
}

async function dispatch(fetchHandler, request) {
  let responsePromise;
  const waitUntilPromises = [];
  fetchHandler({
    request,
    respondWith(promise) {
      responsePromise = Promise.resolve(promise);
    },
    waitUntil(promise) {
      waitUntilPromises.push(Promise.resolve(promise));
    },
  });
  await Promise.all(waitUntilPromises);
  return responsePromise;
}

async function dispatchLifecycle(lifecycleHandler) {
  const waitUntilPromises = [];
  lifecycleHandler({
    waitUntil(promise) {
      waitUntilPromises.push(Promise.resolve(promise));
    },
  });
  await Promise.all(waitUntilPromises);
}

async function run() {
  const successfulCaches = new TestCaches();
  const successfulWorker = loadFetchHandler(
    successfulCaches,
    async () => new Response('fresh', { status: 200 }),
  );
  const freshResponse = await dispatch(successfulWorker.fetch, {
    method: 'GET',
    url: 'http://localhost:3001/_next/static/chunk.js',
    mode: 'script',
  });
  assert.ok(freshResponse instanceof Response, 'successful fetch resolves a Response');
  assert.equal(await freshResponse.text(), 'fresh');

  const failureCaches = new TestCaches();
  const failureWorker = loadFetchHandler(
    failureCaches,
    async () => { throw new TypeError('Failed to fetch'); },
  );

  const uncachedSubresource = await dispatch(failureWorker.fetch, {
    method: 'GET',
    url: 'http://localhost:3001/_next/static/missing.js',
    mode: 'script',
  });
  assert.ok(
    uncachedSubresource instanceof Response,
    'uncached subresource failure resolves a valid network-error Response',
  );
  assert.equal(uncachedSubresource.type, 'error');

  const startupNavigation = await dispatch(failureWorker.fetch, {
    method: 'GET',
    url: 'http://localhost:3001/dashboard/',
    mode: 'navigate',
  });
  assert.ok(startupNavigation instanceof Response, 'startup navigation always resolves a Response');
  assert.equal(startupNavigation.status, 503);
  assert.equal(await startupNavigation.text(), 'Offline');

  const shellCaches = new TestCaches();
  await shellCaches.cache.put(
    '/dashboard',
    new Response('<html>cached shell</html>', { status: 200 }),
  );
  const shellWorker = loadFetchHandler(
    shellCaches,
    async () => { throw new TypeError('Failed to fetch'); },
  );
  const cachedNavigation = await dispatch(shellWorker.fetch, {
    method: 'GET',
    url: 'http://localhost:3001/dashboard/',
    mode: 'navigate',
  });
  assert.ok(cachedNavigation instanceof Response, 'offline navigation shell is a Response');
  assert.equal(await cachedNavigation.text(), '<html>cached shell</html>');

  const nonOkCaches = new TestCaches();
  await nonOkCaches.cache.put(
    '/dashboard',
    new Response('<html>known-good shell</html>', { status: 200 }),
  );
  const nonOkWorker = loadFetchHandler(
    nonOkCaches,
    async () => new Response('server starting', { status: 503 }),
  );
  const nonOkNavigation = await dispatch(nonOkWorker.fetch, {
    method: 'GET',
    url: 'http://localhost:3001/dashboard/',
    mode: 'navigate',
  });
  assert.equal(
    await nonOkNavigation.text(),
    '<html>known-good shell</html>',
    'startup HTTP 503 uses a cached shell instead of poisoning the cache',
  );

  const staleCaches = new TestCaches(['flo-v17']);
  await staleCaches.cache.put(
    '/dashboard',
    new Response('stale cached 503', { status: 503 }),
  );
  const staleWorker = loadFetchHandler(
    staleCaches,
    async () => { throw new TypeError('Failed to fetch'); },
  );
  await dispatchLifecycle(staleWorker.activate);
  assert.deepEqual(staleCaches.deletedNames, ['flo-v17']);
  const staleResponse = await dispatch(staleWorker.fetch, {
    method: 'GET',
    url: 'http://localhost:3001/dashboard/',
    mode: 'navigate',
  });
  assert.equal(
    await staleResponse.text(),
    'Offline',
    'activation removes the previous cache version instead of serving stale 503s',
  );

  let bypassResponded = false;
  failureWorker.fetch({
    request: { method: 'GET', url: 'http://localhost:3001/api/health', mode: 'cors' },
    respondWith() { bypassResponded = true; },
    waitUntil() {},
  });
  assert.equal(bypassResponded, false, 'API requests remain network-authoritative');

  console.log('Service-worker fetch failures always resolve valid Responses with offline shell behavior.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
