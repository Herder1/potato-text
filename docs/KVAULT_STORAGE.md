# K-Vault file storage

K-Vault is used as the file gateway, not as the business database. PostgreSQL remains the source of truth for questions, users and learning state. PostgreSQL also stores the K-Vault file id, storage backend, URLs, MIME type, size, SHA-256 and lifecycle status for every durable file.

## Production topology

```text
WeChat mini program -> Shukao Node API -> K-Vault -> configured storage backend
                                      \-> PostgreSQL file metadata
```

The mini program never receives the K-Vault API Token. Existing download URLs continue to use the Shukao API, so the mini program does not need a second download-domain allowlist during cutover.

The Shukao adapter does not impose a 50 MiB limit. Its default maximum is 150 MiB, and the largest current textbook is 132,706,976 bytes (126.56 MiB). A customized K-Vault deployment may therefore use Telegram when its `/api/v1/upload` endpoint accepts that size. Upstream builds that retain the standard Telegram Bot API limit should use R2, S3 or WebDAV instead.

## K-Vault requirements

Deploy K-Vault from <https://github.com/katelya77/K-Vault> as a separate service and use HTTPS in production.

- Set `UPLOAD_MAX_SIZE=157286400` or higher.
- Configure the intended default backend. For the customized large-file Telegram build, use `telegram`; keep R2, S3 or WebDAV as the fallback for an upstream-compatible deployment.
- Persist K-Vault's `/data` directory when using Docker.
- Set independent `CONFIG_ENCRYPTION_KEY` and `SESSION_SECRET` values.
- Disable guest uploads.
- Create one API Token with only `upload`, `read` and `delete` scopes.
- Give the K-Vault container at least 512 MB RAM; 1 GB is safer for 150 MiB uploads because the current upload endpoint buffers each file.

Do not reuse the PostgreSQL password, expose the K-Vault Token to the mini program, or commit either secret.

## Application configuration

Set the following variables on the Node API host. Keep `FILE_STORAGE_DRIVER=local` until migration and verification are complete.

```powershell
$env:PERSISTENCE_DRIVER = "postgres"
$env:FILE_STORAGE_DRIVER = "local"
$env:KVAULT_BASE_URL = "https://files.example.com"
$env:KVAULT_API_TOKEN = "replace-with-a-token"
$env:KVAULT_STORAGE_TYPE = "telegram"
$env:KVAULT_FOLDER_PREFIX = "shukao"
$env:OBJECT_STORAGE_MAX_BYTES = "157286400"
```

The Token remains server-side. `OBJECT_STORAGE_CACHE_DIR` is a disposable read-through cache and may live on the API server's local disk. `OBJECT_STORAGE_MIRROR_LOCAL=true` can be used during a short cutover window when a second local copy of new uploads is desired; it should normally be `false` after production verification.

## Migration

1. Stop admin file uploads while performing the final migration.
2. Apply the metadata table migration.
3. Inventory the source files without contacting K-Vault.
4. Upload and remotely verify every non-empty file.
5. Verify all remote bytes again.
6. Switch the API to K-Vault and run smoke tests.

```powershell
npm.cmd run db:migrate
npm.cmd run storage:migrate:dry
$env:FILE_STORAGE_DRIVER = "kvault"
npm.cmd run storage:migrate
npm.cmd run storage:verify
npm.cmd start
```

The migration includes:

- `.runtime/textbooks`
- `.runtime/exams/uploads`
- `.runtime/exam-exports`

It intentionally excludes `.runtime/textbook-page-previews` and `.runtime/exams/jobs` because both are derived or temporary. Each uploaded file is downloaded directly from K-Vault and checked against the local size and SHA-256. Re-running the migration is idempotent. The script never deletes a local source file.

## Cutover checks

- `GET /health` returns `fileStorage: "kvault"`.
- Upload a textbook PDF and reopen it with a byte-range request.
- Create an exam import with both paper and answer files, then recover the official answer.
- Export an exam and download both generated PDFs.
- Restart the API, repeat the reads and confirm that the local cache can be rebuilt.
- Confirm `npm.cmd run storage:verify` reports zero failures.

Keep `.runtime` as a read-only backup for at least one release cycle. Roll back by stopping writes and setting `FILE_STORAGE_DRIVER=local`; do not roll back the database migration merely to roll back the application.
