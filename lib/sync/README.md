# Manual synchronization contracts

Only `lib/sync/journal.ts` is owned by the parent implementation. The synchronizer
uses its `getInstanceId`, `ensureJournalBaseline`, `withoutJournal`, and
`recordChange` helpers. `recordChange` must emit no-op resolutions with explicit
parents. All Prisma transactions are interactive callbacks. No module opens the
database on import.

## Server/API

- `GET /api/sync/export`: protected full `.tdbsync` download, passed through
  `encodeVaultBundle`.
- `POST /api/sync/preview`: multipart `file`, optional `password`; or JSON
  `{ jobId, aliases?: [{ source, target }] }` to refresh the plan. Uses
  `decodeVaultBundle` before bounded ZIP validation. Returns an opaque job ID,
  fingerprint, record/field decisions, name candidates, and a safe access summary.
- `POST /api/sync/apply`: `{ jobId, fingerprint, decisions, accessDecision? }`.
  Record decisions are `accept`, `keep-local`, or `defer`. Conflicting fields must
  select a supplied value. Access decisions are
  `{ choice: 'incoming' | 'local' | 'defer', localPassword?: string }`.
- `DELETE /api/sync/jobs/:id`: closes the owning user's job and zeroes ephemeral
  root buffers. Jobs also expire after 30 minutes. Passwords never enter receipts,
  bundle JSON, logs, or public job responses.

`requireUser` protects every endpoint; thrown `Response` objects are returned
unchanged. Jobs are scoped to `${primary.id}:${primary.version}`.

`registerSyncAccessIntegration` in `access.ts` accepts `preview`, `apply`, and
optional `postCommit`. `preview` and `apply` lazily load the parent's
`lib/storage/sync-access.ts` if no handler is registered. `apply` runs within the
scalar/operation/receipt transaction and validates/prepares access changes.
`postCommit(access, decision, result)` runs after the SQL commit, with the original
server-only `job.access`. Successful credential commits are followed by the
receipt update, then `vaultLock` when `requiresLogin` is set. Failures stay pending
and can retry completion without replaying scalar mutations. Only `status`,
`requiresLogin`, `requiresAdmin`, and validated `adminToken` are public. A pending
mode change links to `/admin?syncToken=...` and is never reported complete.

## Format and causal semantics

Version 1 is a manifest plus `data.json` and SHA-256-addressed original attachment
objects. The manifest identifies the format/schema, bundle, database and source
instance and lists exact paths, lengths and hashes. Unknown versions, duplicate
or unsafe paths, unsupported scalar fields, missing originals, incompatible
operation IDs, missing/cyclic DAG dependencies and inconsistent snapshots fail
closed. Compressed input, expanded input, JSON, entry count and individual objects
are bounded. Extraction never writes archive paths to the filesystem.

Every operation is immutable. Merge evaluates causality independently for scalar
fields, and record existence/archive status participates in concurrent
delete-versus-edit conflicts. Independent field writes are combined. Wall clocks
never choose a scalar winner. A full after image that differs from the inherited
registers resolves those registers, even when `before === after`. A local decision
is therefore emitted against **all** record graph heads. Deferring a record does
not import its operations; new dependent relations are deferred too. Absence from
a snapshot never deletes a local record.

Explicit person aliases are stored as `sync-alias:*` receipts and exported with
the graph. They group the original IDs into the target record's causal graph and
rewrite child references. Name equality only offers candidates. Participation
pair collisions are shown for manual selection and validated before SQL.

## Attachments and failures

Snapshots, journal and retention receipts are read in one transaction. Original
files are copied to memory before that transaction ends. The parent upload store
must retain immutable original versions, including deleted scans, for offline
history. All reads use `readScanFile`; preparations use `saveScanFile` and thus
the parent encryption-aware storage. No plaintext staging directory is used.
Scan paths in transmitted operations are content hashes, while committed database
rows use fresh locally allocated paths. `sync-attachment:*` receipts retain the
mapping for future export, including historical/deleted originals. A failed SQL
commit can leave only unreferenced immutable prepared objects; it never replaces
an existing file. Jobs themselves are ephemeral; after restart select the bundle
again and durable receipts/journal determine remaining work.

`sync-bundle:*` receipts bind the bundle ID to its manifest digest. Full repeats
return the prior result; partial repeats retain deferred branches. A fingerprint
of the local snapshot/graph/aliases and active storage generation is checked before
preparation and again inside the applying transaction. Export, preview and the
attachment/SQL apply phase use `withAuthOperation` to exclude concurrent vault
transitions; the parent's `postCommit` owns its own transition lock. Child-first
deletes and final relation/unique-key
validation prevent cascades from erasing unreviewed local children.

## Verification

Run `node_modules/.bin/tsx --test tests/sync-merge.test.ts tests/sync-bundle.test.ts
tests/sync-apply.test.ts`. Integration tests set an absolute temporary `DATABASE_URL`,
`DATA_DIR`, and `UPLOADS_DIR` before importing database/auth/vault modules and remove
the temporary database afterward. They do not read `.env` or open the real database.
The browser/native UI uses `openLocalFiles('sync')` and `saveLocalFile` from the
parent desktop bridge. Windows/macOS desktop acceptance remains a separate check.
