const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

class ObjectStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = "ObjectStorageError";
    this.code = code;
    this.status = Number(options.status || 0);
    this.details = options.details;
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeObjectKey(value) {
  const key = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!key || key.includes("\u0000")) throw new ObjectStorageError("object_storage_key_invalid");
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new ObjectStorageError("object_storage_key_invalid");
  }
  return parts.join("/");
}

function safeFileName(value, fallback = "file") {
  return path.basename(String(value || fallback)).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || fallback;
}

function defaultMimeType(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
  }[extension] || "application/octet-stream";
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); }
  catch { return {}; }
}

function normalizeRecord(row) {
  if (!row) return null;
  return {
    objectKey: row.object_key || row.objectKey,
    provider: row.provider,
    storageBackend: row.storage_backend || row.storageBackend || "",
    remoteId: row.remote_id || row.remoteId,
    downloadUrl: row.download_url || row.downloadUrl,
    shareUrl: row.share_url || row.shareUrl || "",
    deleteUrl: row.delete_url || row.deleteUrl || "",
    fileName: row.original_file_name || row.fileName,
    mimeType: row.mime_type || row.mimeType || "application/octet-stream",
    size: Number(row.size_bytes ?? row.size ?? 0),
    sha256: row.sha256,
    status: row.status || "active",
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    deletedAt: row.deleted_at || row.deletedAt || null,
  };
}

function createMemoryFileMetadataRepository(initialRows = []) {
  const rows = new Map(initialRows.map((row) => {
    const normalized = normalizeRecord(row);
    return [normalized.objectKey, normalized];
  }));
  return {
    async find(objectKey, options = {}) {
      const row = rows.get(normalizeObjectKey(objectKey));
      if (!row || (!options.includeDeleted && row.status !== "active")) return null;
      return { ...row, metadata: { ...row.metadata } };
    },
    async upsert(record) {
      const now = new Date().toISOString();
      const previous = rows.get(record.objectKey);
      const normalized = normalizeRecord({
        ...record,
        status: "active",
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        deletedAt: null,
      });
      rows.set(normalized.objectKey, normalized);
      return { ...normalized, metadata: { ...normalized.metadata } };
    },
    async markDeleted(objectKey) {
      const previous = rows.get(normalizeObjectKey(objectKey));
      if (!previous) return false;
      rows.set(previous.objectKey, { ...previous, status: "deleted", deletedAt: new Date().toISOString() });
      return true;
    },
    async list(options = {}) {
      return [...rows.values()]
        .filter((row) => options.includeDeleted || row.status === "active")
        .map((row) => ({ ...row, metadata: { ...row.metadata } }));
    },
  };
}

function createPostgresFileMetadataRepository(knex) {
  if (!knex) throw new ObjectStorageError("object_storage_database_required");
  return {
    async find(objectKey, options = {}) {
      let query = knex("object_storage_files").where({ object_key: normalizeObjectKey(objectKey) });
      if (!options.includeDeleted) query = query.where({ status: "active" });
      return normalizeRecord(await query.first());
    },
    async upsert(record) {
      const now = new Date();
      const row = {
        object_key: normalizeObjectKey(record.objectKey),
        provider: String(record.provider || "kvault"),
        storage_backend: String(record.storageBackend || ""),
        remote_id: String(record.remoteId || ""),
        download_url: String(record.downloadUrl || ""),
        share_url: String(record.shareUrl || ""),
        delete_url: String(record.deleteUrl || ""),
        original_file_name: safeFileName(record.fileName),
        mime_type: String(record.mimeType || defaultMimeType(record.fileName)),
        size_bytes: Number(record.size || 0),
        sha256: String(record.sha256 || ""),
        status: "active",
        metadata: JSON.stringify(record.metadata || {}),
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      await knex("object_storage_files").insert(row).onConflict("object_key").merge({
        provider: row.provider,
        storage_backend: row.storage_backend,
        remote_id: row.remote_id,
        download_url: row.download_url,
        share_url: row.share_url,
        delete_url: row.delete_url,
        original_file_name: row.original_file_name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        status: row.status,
        metadata: row.metadata,
        updated_at: now,
        deleted_at: null,
      });
      return this.find(row.object_key);
    },
    async markDeleted(objectKey) {
      const changed = await knex("object_storage_files")
        .where({ object_key: normalizeObjectKey(objectKey) })
        .update({ status: "deleted", deleted_at: knex.fn.now(), updated_at: knex.fn.now() });
      return changed > 0;
    },
    async list(options = {}) {
      let query = knex("object_storage_files").orderBy("object_key");
      if (!options.includeDeleted) query = query.where({ status: "active" });
      return (await query).map(normalizeRecord);
    },
  };
}

function responseErrorCode(payload, fallback) {
  return String(payload?.error?.code || payload?.code || fallback || "object_storage_request_failed");
}

function responseErrorMessage(payload, fallback) {
  return String(payload?.error?.message || payload?.message || fallback || "K-Vault request failed");
}

function resolveAbsoluteUrl(baseUrl, value, fallbackPath = "") {
  const candidate = String(value || fallbackPath || "");
  return candidate ? new URL(candidate, `${baseUrl}/`).toString() : "";
}

function createKVaultObjectStorage(options = {}) {
  const baseUrl = String(options.baseUrl || "").trim().replace(/\/+$/, "");
  const token = String(options.token || "").trim();
  if (!baseUrl) throw new ObjectStorageError("kvault_base_url_required");
  if (!token) throw new ObjectStorageError("kvault_api_token_required");
  let parsedBaseUrl;
  try { parsedBaseUrl = new URL(baseUrl); }
  catch { throw new ObjectStorageError("kvault_base_url_invalid"); }
  if (!/^https?:$/.test(parsedBaseUrl.protocol)) throw new ObjectStorageError("kvault_base_url_invalid");

  const repository = options.repository || createMemoryFileMetadataRepository();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const storageType = String(options.storageType || "").trim().toLowerCase();
  const folderPrefix = String(options.folderPrefix || "shukao").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const cacheRoot = options.cacheRoot === false ? "" : path.resolve(options.cacheRoot || path.resolve(__dirname, "../../../.runtime/object-cache"));
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_BYTES));
  const uploadTimeoutMs = Math.max(1000, Number(options.uploadTimeoutMs || DEFAULT_UPLOAD_TIMEOUT_MS));
  const downloadTimeoutMs = Math.max(1000, Number(options.downloadTimeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS));

  const authorizationHeaders = () => ({ Authorization: `Bearer ${token}` });
  const cachePathFor = (record) => cacheRoot
    ? path.join(cacheRoot, crypto.createHash("sha256").update(`${record.objectKey}\u0000${record.sha256}`).digest("hex"))
    : "";

  async function parseResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { message: text.slice(0, 500) }; }
  }

  async function requestJson(urlPath, requestOptions = {}, timeoutMs = downloadTimeoutMs) {
    let response;
    try {
      response = await fetchImpl(resolveAbsoluteUrl(baseUrl, urlPath), {
        ...requestOptions,
        headers: { ...authorizationHeaders(), ...(requestOptions.headers || {}) },
        signal: requestOptions.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "kvault_request_timeout"
        : "kvault_unreachable";
      throw new ObjectStorageError(code, error.message, { details: error });
    }
    const payload = await parseResponse(response);
    if (!response.ok || payload.success === false) {
      throw new ObjectStorageError(
        responseErrorCode(payload, `kvault_http_${response.status}`),
        responseErrorMessage(payload, response.statusText),
        { status: response.status, details: payload },
      );
    }
    return payload;
  }

  async function deleteRemote(remoteId) {
    if (!remoteId) return false;
    try {
      await requestJson(`/api/v1/file/${encodeURIComponent(remoteId)}`, { method: "DELETE" });
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async function writeCache(record, buffer) {
    const target = cachePathFor(record);
    if (!target) return "";
    await fsp.mkdir(cacheRoot, { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, buffer, { mode: 0o600 });
    await fsp.rename(temporary, target).catch(async (error) => {
      await fsp.rm(temporary, { force: true });
      if (error.code !== "EEXIST") throw error;
    });
    return target;
  }

  async function readValidCache(record) {
    const target = cachePathFor(record);
    if (!target) return null;
    try {
      const stat = await fsp.stat(target);
      if (stat.size !== record.size) return null;
      return await fsp.readFile(target);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function fetchRemoteBuffer(record) {
    let response;
    try {
      response = await fetchImpl(resolveAbsoluteUrl(baseUrl, `/api/v1/file/${encodeURIComponent(record.remoteId)}`), {
        headers: authorizationHeaders(),
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
    } catch (error) {
      const code = error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "kvault_download_timeout"
        : "kvault_unreachable";
      throw new ObjectStorageError(code, error.message, { details: error });
    }
    if (!response.ok) {
      const payload = await parseResponse(response);
      throw new ObjectStorageError(
        responseErrorCode(payload, `kvault_http_${response.status}`),
        responseErrorMessage(payload, response.statusText),
        { status: response.status, details: payload },
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== record.size || sha256(buffer) !== record.sha256) {
      throw new ObjectStorageError("object_storage_integrity_mismatch", `Integrity check failed for ${record.objectKey}`);
    }
    return buffer;
  }

  return {
    driver: "kvault",
    repository,
    maxBytes,
    async put(objectKeyValue, file = {}) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const buffer = file.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ObjectStorageError("object_storage_file_empty");
      if (buffer.length > maxBytes) throw new ObjectStorageError("object_storage_file_too_large");
      const fileName = safeFileName(file.fileName, path.basename(objectKey));
      const mimeType = String(file.mimeType || defaultMimeType(fileName));
      const digest = sha256(buffer);
      const previous = await repository.find(objectKey);
      if (previous && previous.sha256 === digest && previous.size === buffer.length) {
        await writeCache(previous, buffer);
        return { ...previous, reused: true };
      }

      const formData = new FormData();
      formData.append("file", new Blob([buffer], { type: mimeType }), fileName);
      if (storageType) formData.append("storage", storageType);
      const parent = objectKey.includes("/") ? objectKey.slice(0, objectKey.lastIndexOf("/")) : "";
      const folderPath = [folderPrefix, parent].filter(Boolean).join("/");
      if (folderPath) formData.append("folderPath", folderPath);

      const payload = await requestJson("/api/v1/upload", { method: "POST", body: formData }, uploadTimeoutMs);
      if (!payload.file?.id || !payload.links?.download) {
        throw new ObjectStorageError("kvault_upload_response_invalid", "K-Vault did not return a file id and download link", { details: payload });
      }
      const record = {
        objectKey,
        provider: "kvault",
        storageBackend: String(payload.file.storage || storageType || ""),
        remoteId: String(payload.file.id),
        downloadUrl: resolveAbsoluteUrl(baseUrl, payload.links.download),
        shareUrl: resolveAbsoluteUrl(baseUrl, payload.links.share),
        deleteUrl: resolveAbsoluteUrl(baseUrl, payload.links.delete, `/api/v1/file/${encodeURIComponent(payload.file.id)}`),
        fileName,
        mimeType,
        size: buffer.length,
        sha256: digest,
        metadata: { ...(file.metadata || {}) },
      };
      let saved;
      try {
        saved = await repository.upsert(record);
      } catch (error) {
        await deleteRemote(record.remoteId).catch(() => undefined);
        throw error;
      }
      await writeCache(saved, buffer);
      if (previous && previous.remoteId !== saved.remoteId) {
        await deleteRemote(previous.remoteId).catch(() => undefined);
      }
      return saved;
    },
    async stat(objectKey) {
      return repository.find(normalizeObjectKey(objectKey));
    },
    async getBuffer(objectKeyValue, options = {}) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const record = await repository.find(objectKey);
      if (!record) throw new ObjectStorageError("object_storage_file_not_found", objectKey, { status: 404 });
      if (!options.bypassCache) {
        const cached = await readValidCache(record);
        if (cached) return cached;
      }
      const buffer = await fetchRemoteBuffer(record);
      if (!options.bypassCache) await writeCache(record, buffer);
      return buffer;
    },
    async materialize(objectKeyValue) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const record = await repository.find(objectKey);
      if (!record) throw new ObjectStorageError("object_storage_file_not_found", objectKey, { status: 404 });
      const cached = await readValidCache(record);
      if (cached) return cachePathFor(record);
      const buffer = await fetchRemoteBuffer(record);
      return writeCache(record, buffer);
    },
    async delete(objectKeyValue) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const record = await repository.find(objectKey);
      if (!record) return false;
      await deleteRemote(record.remoteId);
      await repository.markDeleted(objectKey);
      const target = cachePathFor(record);
      if (target) await fsp.rm(target, { force: true });
      return true;
    },
    async verify(objectKeyValue) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const record = await repository.find(objectKey);
      if (!record) throw new ObjectStorageError("object_storage_file_not_found", objectKey, { status: 404 });
      const buffer = await fetchRemoteBuffer(record);
      return { objectKey, size: buffer.length, sha256: sha256(buffer), remoteId: record.remoteId };
    },
  };
}

function createMemoryObjectStorage(initialFiles = {}) {
  const files = new Map();
  Object.entries(initialFiles).forEach(([objectKey, value]) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer || "");
    files.set(normalizeObjectKey(objectKey), {
      buffer,
      fileName: value.fileName || path.basename(objectKey),
      mimeType: value.mimeType || defaultMimeType(value.fileName || objectKey),
      metadata: value.metadata || {},
      sha256: sha256(buffer),
    });
  });
  return {
    driver: "memory",
    async put(objectKeyValue, file) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const buffer = Buffer.from(file.buffer);
      const record = {
        objectKey,
        provider: "memory",
        storageBackend: "memory",
        remoteId: objectKey,
        downloadUrl: `memory://${objectKey}`,
        shareUrl: "",
        deleteUrl: "",
        fileName: file.fileName || path.basename(objectKey),
        mimeType: file.mimeType || defaultMimeType(file.fileName || objectKey),
        size: buffer.length,
        sha256: sha256(buffer),
        metadata: { ...(file.metadata || {}) },
      };
      files.set(objectKey, { ...record, buffer });
      return record;
    },
    async stat(objectKeyValue) {
      const file = files.get(normalizeObjectKey(objectKeyValue));
      if (!file) return null;
      const { buffer, ...record } = file;
      return { ...record, size: buffer.length };
    },
    async getBuffer(objectKeyValue) {
      const file = files.get(normalizeObjectKey(objectKeyValue));
      if (!file) throw new ObjectStorageError("object_storage_file_not_found", objectKeyValue, { status: 404 });
      return Buffer.from(file.buffer);
    },
    async delete(objectKeyValue) {
      return files.delete(normalizeObjectKey(objectKeyValue));
    },
    async verify(objectKeyValue) {
      const objectKey = normalizeObjectKey(objectKeyValue);
      const file = files.get(objectKey);
      if (!file) throw new ObjectStorageError("object_storage_file_not_found", objectKey, { status: 404 });
      return { objectKey, size: file.buffer.length, sha256: sha256(file.buffer), remoteId: objectKey };
    },
  };
}

function createObjectStorageFromEnv(options = {}) {
  const driver = String(process.env.FILE_STORAGE_DRIVER || "local").trim().toLowerCase();
  if (!driver || driver === "local") return null;
  if (driver !== "kvault") throw new ObjectStorageError("object_storage_driver_invalid", driver);
  const repository = options.repository || createPostgresFileMetadataRepository(options.knex);
  return createKVaultObjectStorage({
    repository,
    baseUrl: process.env.KVAULT_BASE_URL,
    token: process.env.KVAULT_API_TOKEN,
    storageType: process.env.KVAULT_STORAGE_TYPE,
    folderPrefix: process.env.KVAULT_FOLDER_PREFIX,
    cacheRoot: process.env.OBJECT_STORAGE_CACHE_DIR || undefined,
    maxBytes: process.env.OBJECT_STORAGE_MAX_BYTES,
    uploadTimeoutMs: process.env.KVAULT_UPLOAD_TIMEOUT_MS,
    downloadTimeoutMs: process.env.KVAULT_DOWNLOAD_TIMEOUT_MS,
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  ObjectStorageError,
  createKVaultObjectStorage,
  createMemoryFileMetadataRepository,
  createMemoryObjectStorage,
  createObjectStorageFromEnv,
  createPostgresFileMetadataRepository,
  defaultMimeType,
  normalizeObjectKey,
  sha256,
};
