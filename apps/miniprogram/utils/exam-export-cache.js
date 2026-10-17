const CACHE_VERSION = 1;
const CACHE_PREFIX = `shukao_exam_export_cache_v${CACHE_VERSION}_`;
const INDEX_KEY = `shukao_exam_export_cache_v${CACHE_VERSION}_index`;
const MAX_CACHE_ENTRIES = 6;
const REQUIRED_KINDS = ["paper", "answer"];

function hashText(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function questionFingerprintSource(question) {
  const record = question || {};
  return JSON.stringify([
    record.id,
    record.type,
    record.answerMode,
    record.stem,
    record.material,
    record.options,
    record.correctAnswer,
    record.referenceAnswer,
    record.scoringPoints,
    record.answerVariants,
    record.maxScore ?? record.score,
  ]);
}

function generatedExamFingerprint(questions) {
  const records = (Array.isArray(questions) ? questions : []).map(questionFingerprintSource);
  let hash = 2166136261;
  records.forEach((record) => {
    for (let index = 0; index < record.length; index += 1) {
      hash ^= record.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  });
  return `${(hash >>> 0).toString(16).padStart(8, "0")}-${records.length}`;
}

function createExamExportCacheKey(options = {}) {
  const owner = hashText(`${String(options.userId || "test-user")}|${String(options.apiBaseUrl || "")}`);
  const examId = String(options.examId || "");
  const examVersion = String(options.examVersion || "");
  const contentFingerprint = generatedExamFingerprint(options.questions);
  const identity = examId
    ? `exam:${examId}:${examVersion}:${contentFingerprint}`
    : [
      "generated",
      String(options.title || ""),
      Number(options.durationMinutes) || 0,
      Number(options.totalScore) || 0,
      contentFingerprint,
    ].join(":");
  return `${owner}:${identity}`;
}

function storageFrom(options = {}) {
  return options.storage || (typeof wx === "undefined" ? null : wx);
}

function fileExists(filePath, options = {}) {
  if (typeof options.fileExists === "function") return options.fileExists(filePath);
  const storage = storageFrom(options);
  if (!storage || !filePath) return false;
  const fileSystem = typeof storage.getFileSystemManager === "function"
    ? storage.getFileSystemManager()
    : null;
  if (fileSystem && typeof fileSystem.accessSync === "function") {
    try {
      fileSystem.accessSync(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }
  // Older runtimes without accessSync cannot inspect the file synchronously.
  // Keep the record; openDocument will invalidate it if the file is gone.
  return true;
}

function readIndex(storage) {
  try {
    const keys = storage.getStorageSync(INDEX_KEY);
    return Array.isArray(keys) ? keys.filter((key) => typeof key === "string" && key) : [];
  } catch (error) {
    return [];
  }
}

function writeIndex(storage, keys) {
  try {
    storage.setStorageSync(INDEX_KEY, [...new Set(keys)].slice(0, MAX_CACHE_ENTRIES));
  } catch (error) {
    // Cache maintenance is best effort and must not block a completed download.
  }
}

function removeSavedFiles(record, options = {}) {
  const storage = storageFrom(options);
  if (!storage || typeof storage.removeSavedFile !== "function") return;
  const paths = [...new Set((record && Array.isArray(record.files) ? record.files : [])
    .map((file) => String(file && file.localPath || ""))
    .filter(Boolean))];
  paths.forEach((filePath) => {
    try {
      storage.removeSavedFile({ filePath, fail() {} });
    } catch (error) {
      // A missing old file is already the desired end state.
    }
  });
}

function removeByStorageKey(storage, storageKey, options = {}) {
  try {
    const record = storage.getStorageSync(storageKey);
    removeSavedFiles(record, options);
    storage.removeStorageSync(storageKey);
  } catch (error) {
    // Best effort cleanup only.
  }
  writeIndex(storage, readIndex(storage).filter((key) => key !== storageKey));
}

function removeExamExportCache(cacheKey, options = {}) {
  const storage = storageFrom(options);
  if (!storage || !cacheKey) return false;
  removeByStorageKey(storage, `${CACHE_PREFIX}${hashText(cacheKey)}`, options);
  return true;
}

function validFiles(files, options = {}) {
  const records = Array.isArray(files) ? files : [];
  return REQUIRED_KINDS.every((kind) => {
    const file = records.find((item) => item && item.kind === kind);
    return Boolean(file && file.localPath && fileExists(String(file.localPath), options));
  });
}

function readExamExportCache(cacheKey, options = {}) {
  const storage = storageFrom(options);
  if (!storage || !cacheKey) return null;
  const storageKey = `${CACHE_PREFIX}${hashText(cacheKey)}`;
  let record;
  try {
    record = storage.getStorageSync(storageKey);
  } catch (error) {
    return null;
  }
  const valid = record
    && record.version === CACHE_VERSION
    && record.cacheKey === cacheKey
    && record.exportRecord
    && validFiles(record.files, options);
  if (!valid) {
    removeByStorageKey(storage, storageKey, options);
    return null;
  }
  return {
    exportRecord: record.exportRecord,
    files: record.files,
    savedAt: Number(record.savedAt) || 0,
  };
}

function saveExamExportCache(cacheKey, value = {}, options = {}) {
  const storage = storageFrom(options);
  if (!storage || !cacheKey || !value.exportRecord || !Array.isArray(value.files)) return false;
  const persistentFiles = value.files.filter((file) => file && file.persistent === true && file.localPath);
  if (!REQUIRED_KINDS.every((kind) => persistentFiles.some((file) => file.kind === kind))) return false;

  const storageKey = `${CACHE_PREFIX}${hashText(cacheKey)}`;
  const record = {
    version: CACHE_VERSION,
    cacheKey,
    savedAt: Date.now(),
    exportRecord: value.exportRecord,
    files: persistentFiles.map((file) => ({
      kind: file.kind,
      label: file.label,
      name: file.name,
      size: Number(file.size) || 0,
      pageCount: Number(file.pageCount) || 0,
      localPath: file.localPath,
      remoteUrl: String(file.remoteUrl || ""),
      persistent: true,
    })),
  };

  let previousRecord = null;
  try {
    previousRecord = storage.getStorageSync(storageKey);
  } catch (error) {
    previousRecord = null;
  }
  try {
    storage.setStorageSync(storageKey, record);
  } catch (error) {
    return false;
  }
  const currentPaths = new Set(record.files.map((file) => file.localPath));
  removeSavedFiles({
    files: (previousRecord && Array.isArray(previousRecord.files) ? previousRecord.files : [])
      .filter((file) => !currentPaths.has(String(file && file.localPath || ""))),
  }, options);

  const previous = readIndex(storage);
  const next = [storageKey, ...previous.filter((key) => key !== storageKey)];
  const evicted = next.slice(MAX_CACHE_ENTRIES);
  writeIndex(storage, next);
  evicted.forEach((key) => removeByStorageKey(storage, key, options));
  return true;
}

module.exports = {
  CACHE_VERSION,
  createExamExportCacheKey,
  generatedExamFingerprint,
  readExamExportCache,
  removeExamExportCache,
  saveExamExportCache,
};
