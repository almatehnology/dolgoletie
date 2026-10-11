declare module 'better-sqlite3-multiple-ciphers' {
  import type { Database as BaseDatabase, Options } from 'better-sqlite3';
  interface CipherDatabase extends BaseDatabase { key(key: Buffer): number; rekey(key: Buffer): number }
  const Database: { new(path: string | Buffer, options?: Options): CipherDatabase };
  namespace Database { type Database = CipherDatabase }
  export default Database;
}
