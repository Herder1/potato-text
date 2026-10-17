const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createExamExportCacheKey,
  readExamExportCache,
  saveExamExportCache,
} = require("../apps/miniprogram/utils/exam-export-cache");

function createStorage() {
  const values = new Map();
  const removedFiles = [];
  return {
    values,
    removedFiles,
    getStorageSync(key) {
      return values.get(key);
    },
    setStorageSync(key, value) {
      values.set(key, structuredClone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    },
    removeSavedFile({ filePath }) {
      removedFiles.push(filePath);
    },
  };
}

function exportValue(suffix = "1") {
  return {
    exportRecord: { id: `export-${suffix}`, status: "ready", files: [] },
    files: [
      { kind: "paper", label: "试卷", localPath: `wxfile://paper-${suffix}.pdf`, persistent: true },
      { kind: "answer", label: "答案", localPath: `wxfile://answer-${suffix}.pdf`, persistent: true },
    ],
  };
}

test("exam export cache key isolates account, exam version and generated content", () => {
  const base = {
    userId: "user-a",
    apiBaseUrl: "https://hhtodo.cn",
    examId: "exam-1",
    examVersion: "100",
    questions: [{ id: "q1", stem: "题干", referenceAnswer: "答案一" }],
  };
  assert.equal(createExamExportCacheKey(base), createExamExportCacheKey({ ...base }));
  assert.notEqual(createExamExportCacheKey(base), createExamExportCacheKey({ ...base, userId: "user-b" }));
  assert.notEqual(createExamExportCacheKey(base), createExamExportCacheKey({ ...base, examVersion: "101" }));
  assert.notEqual(
    createExamExportCacheKey(base),
    createExamExportCacheKey({
      ...base,
      questions: [{ id: "q1", stem: "题干", referenceAnswer: "答案二" }],
    }),
  );

  const generated = {
    userId: "user-a",
    apiBaseUrl: "https://hhtodo.cn",
    title: "自定义试卷",
    durationMinutes: 120,
    totalScore: 100,
    questions: [{ id: "q1", stem: "题干", referenceAnswer: "答案一" }],
  };
  assert.equal(createExamExportCacheKey(generated), createExamExportCacheKey(structuredClone(generated)));
  assert.notEqual(
    createExamExportCacheKey(generated),
    createExamExportCacheKey({
      ...generated,
      questions: [{ id: "q1", stem: "题干", referenceAnswer: "答案二" }],
    }),
  );
});

test("saved exam export is restored with both local PDF files", () => {
  const storage = createStorage();
  const cacheKey = createExamExportCacheKey({ userId: "user-a", examId: "exam-1", examVersion: "1" });
  assert.equal(saveExamExportCache(cacheKey, exportValue(), { storage, fileExists: () => true }), true);

  const restored = readExamExportCache(cacheKey, { storage, fileExists: () => true });
  assert.equal(restored.exportRecord.id, "export-1");
  assert.deepEqual(restored.files.map((file) => file.kind), ["paper", "answer"]);
  assert.deepEqual(restored.files.map((file) => file.localPath), [
    "wxfile://paper-1.pdf",
    "wxfile://answer-1.pdf",
  ]);
});

test("cache rejects temporary files and missing local PDFs", () => {
  const storage = createStorage();
  const cacheKey = createExamExportCacheKey({ userId: "user-a", examId: "exam-1", examVersion: "1" });
  const temporary = exportValue();
  temporary.files[1].persistent = false;
  assert.equal(saveExamExportCache(cacheKey, temporary, { storage, fileExists: () => true }), false);

  assert.equal(saveExamExportCache(cacheKey, exportValue(), { storage, fileExists: () => true }), true);
  const restored = readExamExportCache(cacheKey, {
    storage,
    fileExists: (filePath) => !filePath.includes("answer"),
  });
  assert.equal(restored, null);
  assert.deepEqual(storage.removedFiles, ["wxfile://paper-1.pdf", "wxfile://answer-1.pdf"]);
});

test("regenerating the same exam replaces its cache without leaving old PDFs behind", () => {
  const storage = createStorage();
  const cacheKey = createExamExportCacheKey({ userId: "user-a", examId: "exam-1", examVersion: "1" });
  assert.equal(saveExamExportCache(cacheKey, exportValue("old"), { storage, fileExists: () => true }), true);
  assert.equal(saveExamExportCache(cacheKey, exportValue("new"), { storage, fileExists: () => true }), true);
  assert.deepEqual(storage.removedFiles, ["wxfile://paper-old.pdf", "wxfile://answer-old.pdf"]);
  assert.equal(readExamExportCache(cacheKey, { storage, fileExists: () => true }).exportRecord.id, "export-new");
});

test("cache keeps only the newest six exports and removes evicted saved files", () => {
  const storage = createStorage();
  const cacheKeys = [];
  for (let index = 1; index <= 7; index += 1) {
    const cacheKey = createExamExportCacheKey({
      userId: "user-a",
      examId: `exam-${index}`,
      examVersion: "1",
    });
    cacheKeys.push(cacheKey);
    assert.equal(
      saveExamExportCache(cacheKey, exportValue(String(index)), { storage, fileExists: () => true }),
      true,
    );
  }
  assert.equal(readExamExportCache(cacheKeys[0], { storage, fileExists: () => true }), null);
  assert.equal(readExamExportCache(cacheKeys[6], { storage, fileExists: () => true }).exportRecord.id, "export-7");
  assert.deepEqual(storage.removedFiles, ["wxfile://paper-1.pdf", "wxfile://answer-1.pdf"]);
});
