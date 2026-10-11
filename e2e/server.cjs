// A source-linked sandbox follows the parent's live edits without loading repository .env files.
const { mkdirSync, symlinkSync, copyFileSync, createWriteStream, readdirSync, existsSync, cpSync } = require('node:fs');
const { join, resolve, isAbsolute, relative } = require('node:path');
const { protectedResource } = require('../desktop/resource-policy.cjs');
const { spawn } = require('node:child_process');
const root = process.env.TDB_QA_ROOT;
const repo = process.env.TDB_QA_REPO;
if (!root || !repo || !isAbsolute(root) || !isAbsolute(repo)) throw new Error('Run node e2e/run.cjs');
const sandbox = join(root, 'app');
mkdirSync(sandbox);
const production = process.env.TDB_QA_PRODUCTION === '1';
// Next's route discovery does not descend through a directory symlink. Keep
// real route directories and link individual source files instead.
function mirrorRoutes(source, target) {
  mkdirSync(target, { recursive: true });
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const destination = join(target, item.name);
    if (item.isDirectory()) mirrorRoutes(join(source, item.name), destination);
    else if (item.isFile() && !existsSync(destination)) symlinkSync(join(source, item.name), destination);
  }
}
if (production) {
  const standalone = join(repo, '.next/standalone');
  cpSync(standalone, sandbox, { recursive: true, filter: file => !protectedResource(relative(standalone, file), true) });
  cpSync(join(repo, '.next/static'), join(sandbox, '.next/static'), { recursive: true });
  for (const name of ['assets', 'public']) cpSync(join(repo, name), join(sandbox, name), { recursive: true });
  cpSync(join(repo, 'prisma/migrations'), join(sandbox, 'prisma/migrations'), { recursive: true });
} else {
  mirrorRoutes(join(repo, 'app'), join(sandbox, 'app'));
  const routeWatcher = setInterval(() => mirrorRoutes(join(repo, 'app'), join(sandbox, 'app')), 1000);
  routeWatcher.unref();
  for (const name of ['components', 'lib', 'assets', 'public', 'prisma', 'types', 'node_modules', 'middleware.ts', 'next.config.ts', 'postcss.config.mjs']) symlinkSync(join(repo, name), join(sandbox, name));
  for (const name of ['package.json', 'tsconfig.json', 'next-env.d.ts']) copyFileSync(join(repo, name), join(sandbox, name));
}
// Do not inherit production settings, injected preloaders, or external service credentials.
const env = {};
for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'TDB_DIST_DIR', 'DATA_DIR', 'DATABASE_URL', 'AUTH_FILE', 'UPLOADS_DIR', 'SESSION_SECRET']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, { APP_PASSWORD: '', COOKIE_SECURE: 'false', NODE_ENV: production ? 'production' : 'development', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: '3327' });
if (production) delete env.TDB_DIST_DIR;
const log = createWriteStream(join(root, 'server.log'));
const command = production ? [join(sandbox, 'server.js')] : [resolve(repo, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3327'];
const child = spawn(process.execPath, command, { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', data => { log.write(data); process.stdout.write(data); });
child.stderr.on('data', data => { log.write(data); process.stderr.write(data); });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  timer.unref();
});
child.on('exit', (code, signal) => log.end(() => process.exit(stopping ? 0 : code || (signal ? 1 : 0))));
