const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const unknownApi = optionalRequire('./dispatch-unknown');

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('dispatch namespace catch-all is before the generic sales catch-all', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const dispatchCatchAllIndex = vercel.rewrites.findIndex((rewrite) => rewrite.source === '/api/dispatch/(.*)');
  const salesCatchAllIndex = vercel.rewrites.findIndex((rewrite) => rewrite.source === '/api/(.*)');
  assert.ok(dispatchCatchAllIndex >= 0);
  assert.ok(salesCatchAllIndex >= 0);
  assert.ok(dispatchCatchAllIndex < salesCatchAllIndex);
  assert.equal(vercel.rewrites[dispatchCatchAllIndex].destination, '/api/dispatch-unknown.js');
  assert.ok(vercel.rewrites.findIndex((rewrite) => rewrite.source === '/api/dispatch/invoices') < dispatchCatchAllIndex);
  const dispatchRootIndex = vercel.rewrites.findIndex((rewrite) => rewrite.source === '/api/dispatch');
  assert.ok(dispatchRootIndex >= 0 && dispatchRootIndex < salesCatchAllIndex);
  assert.equal(vercel.rewrites[dispatchRootIndex].destination, '/api/dispatch-unknown.js');
});

test('unknown dispatch paths return a safe 404 and never invoke the sales handler', async () => {
  assert.ok(unknownApi, 'dispatch namespace fallback should exist');
  const handler = unknownApi.createDispatchUnknownHandler();
  const response = responseRecorder();
  let salesCalled = false;
  await handler({ method: 'GET', url: '/api/dispatch/not-a-route', query: {} }, response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    success: false,
    error: { code: 'not_found', message: 'The requested dispatch route was not found.' },
  });
  assert.equal(salesCalled, false);
  assert.equal(JSON.stringify(response.body).includes('sales'), false);
});
