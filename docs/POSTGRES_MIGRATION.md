# PostgreSQL migration

This migration copies the current `.runtime/*.json` stores into PostgreSQL without changing or deleting the source files. The first phase intentionally keeps each current store as one JSONB document so every field and relationship survives the move. Core domains can be normalized after production parity is established.

## Safety properties

- Only the known primary runtime files are imported; timestamped backup files are ignored.
- Every source file is parsed before a database connection is opened.
- SHA-256, byte size, record count and the complete JSON payload are verified after import.
- Exact source bytes are stored in `source_blob`. OCR null characters that PostgreSQL JSONB cannot represent are replaced with `U+FFFD` only in the queryable JSONB copy; the source blob remains byte-for-byte intact.
- Re-running an unchanged import is idempotent.
- Changed documents archive the previous PostgreSQL value before replacement.
- Imports run in a transaction protected by a PostgreSQL advisory lock.
- The `.runtime` source directory remains untouched.

## Prepare PostgreSQL

Create an empty database and a user that owns it. Set these environment variables in the current shell:

```powershell
$env:DATABASE_URL = "postgresql://shukao:password@127.0.0.1:5432/shukao"
$env:DATABASE_SSL = "false"
```

Use `DATABASE_SSL=true` for a managed database that requires TLS. Do not commit real credentials.

## Run the migration

Validate every current JSON file without touching PostgreSQL:

```powershell
npm.cmd run db:import:dry
```

Create or update the database schema:

```powershell
npm.cmd run db:migrate
```

Import and immediately verify every document:

```powershell
npm.cmd run db:import
```

Verify PostgreSQL against the current JSON sources later:

```powershell
npm.cmd run db:verify
```

The import summary must show every expected store. Keep `.runtime` as a read-only backup until the PostgreSQL-backed application has passed production smoke tests.

## Cutover rule

Stop admin and user writes before the final import. Run `db:import`, verify the result, deploy the PostgreSQL-backed API, and only then reopen writes. Do not let JSON and PostgreSQL accept independent writes during the cutover window.

Start the API with PostgreSQL as its runtime store:

```powershell
$env:PERSISTENCE_DRIVER = "postgres"
npm.cmd start
```

The compatibility runtime loads each store from PostgreSQL and persists every mutation back to PostgreSQL. A successful HTTP response is not completed until pending database writes finish. This compatibility mode is intended for one API instance; normalize high-write domains before deploying multiple API instances.

This switch covers JSON business data. Textbook PDFs, durable exam uploads and export files can be moved to K-Vault by following [`KVAULT_STORAGE.md`](KVAULT_STORAGE.md). Rendered page previews and in-flight exam job files remain disposable local caches.

## Rollback

Application rollback means pointing the previous API build at the untouched `.runtime` directory. Do not run `db:rollback` in production merely to roll back the application; that command drops the migration tables and is intended only for disposable development databases.
