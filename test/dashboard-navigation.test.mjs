import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('dashboard exposes Delivery Dispatch only when its destination page is present', () => {
  const dashboard = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(dashboard, /href=["']\/dispatch\.html["']/);
  assert.equal(existsSync(new URL('../public/dispatch.html', import.meta.url)), true);
});
