import { PrismaClient } from '@prisma/client';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CipherAdapterFactory, openSqlite } from './sqlite-adapter';
import { activeDatabasePath, dataDirectory } from './paths';
import { existsSync } from 'node:fs';
import { recoverCredentialTransition } from './credential-transaction';
import { recoverGenerationTransition } from './generation-transition';

type State = { client?: PrismaClient; key?: Buffer; opening?: Promise<PrismaClient>; blocked: boolean };
const globalState = globalThis as typeof globalThis & { tdbDatabaseState?: State };
const state = globalState.tdbDatabaseState ??= { blocked: false };

function migrate(path: string, key?: Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const db = openSqlite(path, key);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _tdb_migrations (name TEXT PRIMARY KEY)');
    const known = new Set((db.prepare('SELECT name FROM _tdb_migrations').all() as { name: string }[]).map(x => x.name));
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE name = '_prisma_migrations'").get();
    if (legacy) for (const x of db.prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL').all() as { migration_name: string }[]) known.add(x.migration_name);
    const dir = join(process.cwd(), 'prisma/migrations');
    for (const name of readdirSync(dir).filter(x => /^\d/.test(x)).sort()) {
      if (known.has(name)) continue;
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO _tdb_migrations(name) VALUES (?)').run(name); })();
    }
    db.pragma('journal_mode = WAL');
  } finally { db.close(); }
}

export async function getDatabase(): Promise<PrismaClient> {
  recoverCredentialTransition(); recoverGenerationTransition();
  const vault = join(dataDirectory(), 'vault.json');
  if (!state.key && existsSync(vault) && JSON.parse(readFileSync(vault, 'utf8')).enabled) throw new Error('Хранилище заблокировано');
  if (state.blocked) throw new Error('Хранилище заблокировано');
  if (state.client) return state.client;
  if (state.opening) return state.opening;
  state.opening = (async () => {
    const path = activeDatabasePath();
    migrate(path, state.key);
    const client = new PrismaClient({ adapter: new CipherAdapterFactory(path, state.key), log: [] });
    await client.$connect();
    state.client = client;
    return client;
  })();
  try { return await state.opening; } finally { state.opening = undefined; }
}
export async function closeDatabase() {
  if (state.opening) await state.opening;
  if (state.client) await state.client.$disconnect();
  state.client = undefined;
}
export async function setDatabaseKey(key?: Buffer, blocked = false) {
  await closeDatabase();
  state.key?.fill(0);
  state.key = key ? Buffer.from(key) : undefined;
  state.blocked = blocked;
}
