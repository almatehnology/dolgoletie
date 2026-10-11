import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const root = process.env.TDB_QA_ROOT;
if (!root) throw new Error('Use node e2e/run.cjs to create an isolated installation.');
export default defineConfig({
  testDir: __dirname,
  testMatch: 'acceptance.spec.ts',
  outputDir: join(root, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { outputFolder: join(root, 'html-report'), open: 'never' }], ['json', { outputFile: join(root, 'results.json') }]],
  use: { baseURL: process.env.TDB_QA_ORIGIN ?? 'http://localhost:3327', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true },
  webServer: {
    command: `node "${join(__dirname, 'server.cjs')}"`,
    url: 'http://127.0.0.1:3327/setup',
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
