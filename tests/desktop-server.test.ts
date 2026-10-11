import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createServer, get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { installServerBoundary, TOKEN_HEADER } = require('../desktop/server-boundary.cjs');
const { runtimeEnvironment, probe } = require('../desktop/runtime.cjs');

function request(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (response) => {
      let body = '';
      response.on('data', (bytes) => { body += bytes; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    }).on('error', reject);
  });
}

test('standalone boundary binds an OS-assigned loopback port and denies unauthorised HTTP before the app', async () => {
  const token = 'c'.repeat(64);
  let origin = '';
  const boundary = installServerBoundary(token, (url: string) => { origin = url; });
  let reachedApp = 0;
  const server = createServer((_req, response) => { reachedApp++; response.end('private app'); });
  try {
    // Even a bad caller binding cannot expose the service on LAN or a fixed port.
    server.listen(12345, '0.0.0.0');
    await new Promise((resolve) => server.once('listening', resolve));
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await request(origin)).status, 403);
    assert.equal((await request(origin, { [TOKEN_HEADER]: 'd'.repeat(64) })).status, 403);
    assert.equal((await request(origin, { [TOKEN_HEADER]: token, Origin: 'https://evil.test' })).status, 403);
    assert.equal((await request(origin, { [TOKEN_HEADER]: token, Host: 'localhost:12345' })).status, 403);
    assert.equal(await probe(origin, 'd'.repeat(64)), false);
    assert.equal(reachedApp, 0);
    assert.deepEqual(await request(origin, { [TOKEN_HEADER]: token, Origin: origin }), { status: 200, body: 'private app' });
    assert.equal(reachedApp, 1);
    assert.equal(await probe(origin, token), true);
  } finally { await boundary.close(); boundary.restore(); }
});

test('all persistent paths stay in userData and environment cannot inject another runtime or DB', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tdb-runtime-'));
  try {
    const env = await runtimeEnvironment(folder, 'a'.repeat(64), {
      NODE_OPTIONS: '--require=evil.cjs', NODE_PATH: '/evil', ELECTRON_RUN_AS_NODE: '1',
      DATABASE_URL: 'file:/other/db', UPLOADS_DIR: '/other/uploads', APP_PASSWORD: 'leak',
      HTTP_PROXY: 'https://evil.test', HOME: '/example/home', SystemRoot: 'C:\\Windows',
    });
    assert.equal(env.HOME, '/example/home');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'APP_PASSWORD', 'HTTP_PROXY']) assert.equal(env[name], undefined);
    for (const name of ['DATA_DIR', 'UPLOADS_DIR', 'AUTH_FILE']) assert.ok(env[name].startsWith(folder));
    assert.equal(env.VAULT_PATH, undefined);
    assert.equal(env.VaultPath, undefined);
    assert.equal(env.DATABASE_URL, pathToFileURL(join(folder, 'data', 'data.db')).href);
    assert.equal(env.HOSTNAME, '127.0.0.1');
    assert.equal(env.PORT, '0');
    assert.equal(env.DESKTOP_LAUNCH_TOKEN, 'a'.repeat(64));
    assert.ok(env.SESSION_SECRET.length >= 32);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
