import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

// The region of the dispatch Postgres (`DATABASE_URL`). Update this, and the
// matching entries in vercel.json, if the database is ever moved.
const DATABASE_REGION = 'iad1';
const ASIA_REGION = 'sin1';

const functionFiles = fs
  .readdirSync(path.join(root, 'api'))
  .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  .map((name) => `api/${name}`);

const regionOf = (file) => vercel.functions?.[file]?.regions;

test('no project-wide region: each function is placed on purpose', () => {
  assert.equal(vercel.regions, undefined);
});

test('every deployable function has exactly one explicit single region', () => {
  assert.ok(functionFiles.length >= 10, 'expected the api/ functions to be found');
  for (const file of functionFiles) {
    const regions = regionOf(file);
    assert.ok(Array.isArray(regions) && regions.length === 1, `${file} needs a single region in vercel.json`);
  }
  for (const pattern of Object.keys(vercel.functions)) {
    assert.ok(functionFiles.includes(pattern), `vercel.json lists ${pattern}, which is not a function file`);
  }
});

test('functions that use the database sit in the database region', () => {
  const usesDatabase = (file) => /lib\/db\/pool|repository|throttle/.test(fs.readFileSync(path.join(root, file), 'utf8'));
  const dbFunctions = functionFiles.filter(usesDatabase);
  assert.ok(dbFunctions.includes('api/dispatch-trips.js'), 'detector should find the dispatch functions');
  for (const file of dbFunctions) {
    assert.deepEqual(regionOf(file), [DATABASE_REGION], `${file} uses the database, so it must run in ${DATABASE_REGION}`);
  }
});

test('functions that only call AutoCount Cloud run in Singapore', () => {
  for (const file of ['api/price-check.js', 'api/sales.js', 'api/dispatch-invoices.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /lib\/db\/pool|repository|throttle/, `${file} must not use the database`);
    assert.deepEqual(regionOf(file), [ASIA_REGION], `${file} should run in ${ASIA_REGION}`);
  }
});
