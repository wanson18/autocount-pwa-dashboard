'use strict';

// Build step: stamps which commit a deployment was built from into
// public/version.json, so anyone can check what is live:
//   curl https://autocount-pwa-dashboard.vercel.app/version.json
// Vercel provides VERCEL_GIT_COMMIT_SHA, VERCEL_GIT_COMMIT_REF and VERCEL_ENV
// (production or preview) for Git deployments; a deployment uploaded from a
// computer may lack some of them, so every field can be null. This must never
// fail a deploy, so any problem is logged and ignored.

const fs = require('node:fs');
const path = require('node:path');

function versionStamp(env = process.env, now = new Date()) {
  return {
    commit: env.VERCEL_GIT_COMMIT_SHA || null,
    branch: env.VERCEL_GIT_COMMIT_REF || null,
    target: env.VERCEL_ENV || null,
    builtAt: now.toISOString(),
  };
}

function writeVersionStamp(file, stamp) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stamp)}\n`);
}

if (require.main === module) {
  try {
    const file = process.env.VERSION_FILE || path.join(__dirname, '..', 'public', 'version.json');
    writeVersionStamp(file, versionStamp());
    console.log(`version stamp written to ${path.relative(process.cwd(), file)}`);
  } catch (error) {
    console.error(`version stamp skipped: ${error.message}`);
  }
}

module.exports = { versionStamp, writeVersionStamp };
