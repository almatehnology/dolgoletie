import Database from 'better-sqlite3-multiple-ciphers';
import { ColumnTypeEnum as T, DriverAdapterError, type SqlQuery, type SqlDriverAdapter, type Transaction, type ColumnType } from '@prisma/driver-adapter-utils';

function argument(value: unknown, type?: string): unknown {
  if (value == null) return null;
  if (type === 'datetime') return new Date(value as string).getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return Number(value);
  if (type === 'int' || type === 'float' || type === 'decimal') return Number(value);
  if (type === 'bigint') return BigInt(value as string);
  if (type === 'bytes') return Buffer.isBuffer(value) ? value : Buffer.from(value as string, 'base64');
  return value;
}
function columnType(declared: string | null, value: unknown): ColumnType {
  const d = declared?.toUpperCase() ?? '';
  if (d.includes('DATETIME') || d.includes('TIMESTAMP')) return T.DateTime;
  if (d === 'BOOLEAN') return T.Boolean;
  if (d.includes('DECIMAL')) return T.Numeric;
  if (d.includes('INT')) return d.includes('BIG') ? T.Int64 : T.Int32;
  if (/REAL|DOUBLE|FLOAT|NUMERIC/.test(d)) return T.Double;
  if (d === 'BLOB' || Buffer.isBuffer(value)) return T.Bytes;
  if (/TEXT|CHAR|CLOB/.test(d) || typeof value === 'string') return T.Text;
  if (typeof value === 'bigint') return T.Int64;
  return T.UnknownNumber;
}
function driverError(error: unknown): never {
  const e = error as { code?: string; message?: string };
  const codes: Record<string, number> = { SQLITE_CONSTRAINT_UNIQUE: 2067, SQLITE_CONSTRAINT_PRIMARYKEY: 1555, SQLITE_CONSTRAINT_FOREIGNKEY: 787, SQLITE_CONSTRAINT_NOTNULL: 1299, SQLITE_BUSY: 5 };
  throw new DriverAdapterError({ kind: 'sqlite', extendedCode: codes[e.code ?? ''] ?? 1, message: e.message ?? 'SQLite error' });
}

class Queries {
  readonly provider = 'sqlite' as const;
  readonly adapterName = 'dolgoletie/sqlite3mc';
  constructor(protected db: Database.Database) {}
  async queryRaw(q: SqlQuery) {
    try {
      const stmt = this.db.prepare(q.sql);
      const args = q.args.map((v, i) => argument(v, q.argTypes[i]?.scalarType));
      if (!stmt.reader) { stmt.run(...args); return { columnNames: [], columnTypes: [], rows: [] }; }
      const columns = stmt.columns();
      const rows = stmt.raw().all(...args) as unknown[][];
      const types = columns.map((c, i) => columnType(c.type, rows.find(r => r[i] != null)?.[i]));
      return { columnNames: columns.map(c => c.name), columnTypes: types, rows: rows.map(r => r.map((v, i) => {
        if (v == null) return null;
        if (types[i] === T.DateTime) return typeof v === 'string' ? new Date(/Z|[+-]\d\d:\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z').toISOString() : new Date(Number(v)).toISOString();
        if (Buffer.isBuffer(v)) return [...v];
        return typeof v === 'bigint' ? v.toString() : v;
      })) };
    } catch (error) { driverError(error); }
  }
  async executeRaw(q: SqlQuery) {
    try { return this.db.prepare(q.sql).run(...q.args.map((v, i) => argument(v, q.argTypes[i]?.scalarType))).changes; }
    catch (error) { driverError(error); }
  }
}

export class CipherAdapterFactory {
  readonly provider = 'sqlite' as const;
  readonly adapterName = 'dolgoletie/sqlite3mc';
  constructor(private path: string, private key?: Buffer) {}
  async connect(): Promise<SqlDriverAdapter> { return new CipherAdapter(openSqlite(this.path, this.key)); }
  async connectToShadowDb(): Promise<SqlDriverAdapter> { return new CipherAdapter(openSqlite(':memory:')); }
}

export function openSqlite(path: string, key?: Buffer) {
  const db = new Database(path);
  if (key) db.key(key);
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  return db;
}

class CipherAdapter extends Queries implements SqlDriverAdapter {
  private gate: Promise<void> = Promise.resolve();
  async queryRaw(q: SqlQuery) { await this.gate; return super.queryRaw(q); }
  async executeRaw(q: SqlQuery) { await this.gate; return super.executeRaw(q); }
  async executeScript(sql: string) { await this.gate; try { this.db.exec(sql); } catch (e) { driverError(e); } }
  async startTransaction(level?: string): Promise<Transaction> {
    if (level && level !== 'SERIALIZABLE') throw new DriverAdapterError({ kind: 'InvalidIsolationLevel', level });
    const prior = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>(r => { release = r; });
    await prior;
    try { this.db.exec('BEGIN'); } catch (e) { release(); driverError(e); }
    const queries = new Queries(this.db);
    return Object.assign(queries, { options: { usePhantomQuery: false }, commit: async () => { release(); }, rollback: async () => { release(); } });
  }
  getConnectionInfo() { return { supportsRelationJoins: false, maxBindValues: 999 }; }
  async dispose() { await this.gate; if (this.db.open) this.db.close(); }
}
