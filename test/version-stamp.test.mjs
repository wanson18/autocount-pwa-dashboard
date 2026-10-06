import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import stamp from '../scripts/write-version.js';

const { versionStamp } = stamp;
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(root, 'scripts', 'write-version.js');
const NOW = new Date('2026-10-06T03:00:00.000Z');

test('the stamp reports the commit, branch and environment Vercel provides', () => {
  assert.deepEqual(
    versionStamp({ VERCEL_GIT_COMMIT_SHA: 'abc123', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_ENV: 'production' }, NOW),
    { commit: 'abc123', branch: 'main', target: 'production', builtAt: '2026-10-06T03:00:00.000Z' },
  );
});

test('a deployment without Git information still gets a stamp, with nulls', () => {
  assert.deepEqual(versionStamp({}, NOW), { commit: null, branch: null, target: null, builtAt: '2026-10-06T03:00:00.000Z' });
});

test('running the build step writes valid JSON to the requested file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-stamp-'));
  const file = path.join(dir, 'nested', 'version.json');
  const run = spawnSync('node', [script], { env: { ...process.env, VERSION_FILE: file, VERCEL_GIT_COMMIT_SHA: 'deadbeef', VERCEL_ENV: 'preview' }, encoding: 'utf8' });

  assert.equal(run.status, 0);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.commit, 'deadbeef');
  assert.equal(written.target, 'preview');
  assert.ok(!Number.isNaN(Date.parse(written.builtAt)));
});

test('a problem writing the stamp never fails the deploy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-stamp-'));
  const blocker = path.join(dir, 'a-file');
  fs.writeFileSync(blocker, 'not a directory');
  const run = spawnSync('node', [script], { env: { ...process.env, VERSION_FILE: path.join(blocker, 'version.json') }, encoding: 'utf8' });

  assert.equal(run.status, 0, 'exit code must stay 0 so the build still succeeds');
  assert.match(run.stderr, /version stamp skipped/);
});

test('the build is wired up: npm build runs it, git ignores the output, and it is never cached', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'node scripts/write-version.js');
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^public\/version\.json$/m);
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const rule = vercel.headers.find((entry) => entry.source === '/version.json');
  assert.ok(rule, 'vercel.json needs a header rule for /version.json');
  assert.match(rule.headers.find((header) => header.key === 'Cache-Control').value, /no-store/);
});
