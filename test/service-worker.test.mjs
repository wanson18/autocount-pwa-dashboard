import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerSource = fs.readFileSync(path.join(root, '..', 'public', 'sw.js'), 'utf8');

function loadServiceWorker() {
  const listeners = new Map();
  const openedCaches = [];
  const deletedCaches = [];
  const putRequests = [];
  const fetchedRequests = [];
  const cache = {
    async put(request) {
      putRequests.push(request);
    },
  };
  const context = {
    URL,
    Request,
    Response,
    Promise,
    fetch: async (request, options) => {
      fetchedRequests.push({ request, options });
      return { ok: true, clone: () => ({}) };
    },
    caches: {
      async open(name) {
        openedCaches.push(name);
        return cache;
      },
      async keys() {
        return ['sales-dashboard-v4', 'dispatch-api-old', 'sales-dashboard-v5', 'sales-dashboard-v6', 'sales-dashboard-v7', 'sales-dashboard-v8', 'sales-dashboard-v9', 'sales-dashboard-v10'];
      },
      async delete(name) {
        deletedCaches.push(name);
        return true;
      },
      async match() {
        return undefined;
      },
    },
    self: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      skipWaiting() {},
      clients: { claim() {} },
    },
  };
  vm.runInNewContext(serviceWorkerSource, context, { filename: 'public/sw.js' });
  return { listeners, openedCaches, deletedCaches, putRequests, fetchedRequests };
}

test('service worker installs a new cache namespace and activation removes every prior namespace', async () => {
  const worker = loadServiceWorker();
  let installPromise;
  worker.listeners.get('install')({ waitUntil(promise) { installPromise = promise; } });
  await installPromise;
  assert.equal(worker.openedCaches[0], 'sales-dashboard-v11');

  let activationPromise;
  worker.listeners.get('activate')({ waitUntil(promise) { activationPromise = promise; } });
  await activationPromise;
  assert.deepEqual(worker.deletedCaches, ['sales-dashboard-v4', 'dispatch-api-old', 'sales-dashboard-v5', 'sales-dashboard-v6', 'sales-dashboard-v7', 'sales-dashboard-v8', 'sales-dashboard-v9', 'sales-dashboard-v10']);
});

test('dispatch API requests stay network-only and never enter the static/API cache', async () => {
  const worker = loadServiceWorker();
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new Request('https://dispatch.example/api/dispatch/resources', { method: 'GET' }),
    respondWith(promise) { responsePromise = promise; },
  });
  await responsePromise;
  assert.equal(worker.fetchedRequests.length, 1);
  assert.equal(worker.putRequests.length, 0);
  assert.equal(worker.openedCaches.length, 0);
});

test('sales API requests stay network-only and do not replay cached invoice data', async () => {
  const worker = loadServiceWorker();
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new Request('https://dispatch.example/api/sales?startDate=2026-09-01&endDate=2026-09-01', { method: 'GET' }),
    respondWith(promise) { responsePromise = promise; },
  });
  await responsePromise;
  assert.equal(worker.fetchedRequests.length, 1);
  assert.equal(worker.fetchedRequests[0].options.cache, 'no-store');
  assert.equal(worker.putRequests.length, 0);
  assert.equal(worker.openedCaches.length, 0);
});

test('price check API requests stay network-only and never enter the static/API cache', async () => {
  const worker = loadServiceWorker();
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new Request('https://dispatch.example/api/price-check?range=today', { method: 'GET' }),
    respondWith(promise) { responsePromise = promise; },
  });
  await responsePromise;
  assert.equal(worker.fetchedRequests.length, 1);
  assert.equal(worker.fetchedRequests[0].options.cache, 'no-store');
  assert.equal(worker.putRequests.length, 0);
  assert.equal(worker.openedCaches.length, 0);
});
