// All credentials, databases, uploads, reports and Next output live in a fresh tmp directory.
const { mkdtempSync, mkdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const root = mkdtempSync(join(tmpdir(), 'tdb-acceptance-'));
const production = process.argv.includes('--production');
for (const name of ['data', 'uploads', 'fixtures', 'screenshots', 'downloads']) mkdirSync(join(root, name));
const env = {
  ...process.env,
  TDB_QA_ROOT: root,
  TDB_QA_REPO: resolve(__dirname, '..'),
  TDB_DIST_DIR: `.next-qa-${randomBytes(5).toString('hex')}`,
  DATA_DIR: join(root, 'data'),
  DATABASE_URL: `file:${join(root, 'data', 'qa.db')}`,
  AUTH_FILE: join(root, 'auth.json'),
  UPLOADS_DIR: join(root, 'uploads'),
  APP_PASSWORD: '',
  SESSION_SECRET: randomBytes(48).toString('hex'),
  COOKIE_SECURE: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
  TDB_QA_PRODUCTION: production ? '1' : '0',
  TDB_QA_ORIGIN: production ? 'http://127.0.0.1:3327' : 'http://localhost:3327',
};
console.log(`QA_ARTIFACTS=${root}`);
console.log(`QA_URL=${env.TDB_QA_ORIGIN} (${production ? 'production standalone' : 'Next dev'}; fresh synthetic installation)`);
const cli = require.resolve('@playwright/test/cli');
if (!existsSync(chromium.executablePath())) {
  const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { env, stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
}
const result = spawnSync(process.execPath, [cli, 'test', '--config', join(__dirname, 'playwright.config.ts'), ...process.argv.slice(2).filter(argument => argument !== '--production')], { env, stdio: 'inherit' });
console.log(`QA_ARTIFACTS=${root}`);
process.exit(result.status || (result.signal ? 1 : 0));
