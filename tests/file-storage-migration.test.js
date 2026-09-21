const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  collectFiles,
  fileDescriptor,
  objectKeyFor,
  parseArguments,
} = require("../scripts/db/migrate-files-to-kvault");

test("file migration inventories durable files and excludes derived caches", (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-storage-migration-"));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const durable = [
    path.join(runtimeRoot, "textbooks", "book-1.pdf"),
    path.join(runtimeRoot, "exams", "uploads", "exam-import-1-paper.pdf"),
    path.join(runtimeRoot, "exam-exports", "export-1", "paper.pdf"),
  ];
  const derived = [
    path.join(runtimeRoot, "textbook-page-previews", "book-1", "1-120.jpg"),
    path.join(runtimeRoot, "exams", "jobs", "job-paper.pdf"),
  ];
  [...durable, ...derived].forEach((filePath) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "data");
  });
  assert.deepEqual(collectFiles(runtimeRoot), durable.slice().sort((left, right) => left.localeCompare(right, "en")));
  assert.equal(objectKeyFor(runtimeRoot, path.join(runtimeRoot, "textbooks", "book-1.pdf")), "textbooks/book-1.pdf");
});

test("file migration preserves export names from the local manifest", (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-export-migration-"));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const directory = path.join(runtimeRoot, "exam-exports", "export-1");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
    examId: "exam-1",
    files: [{ kind: "paper", name: "mock-paper.pdf", label: "paper", pageCount: 2 }],
  }));
  const filePath = path.join(directory, "paper.pdf");
  fs.writeFileSync(filePath, "pdf");
  const descriptor = fileDescriptor(runtimeRoot, filePath);
  assert.equal(descriptor.objectKey, "exam-exports/export-1/paper.pdf");
  assert.equal(descriptor.fileName, "mock-paper.pdf");
  assert.equal(descriptor.metadata.examId, "exam-1");
  assert.equal(descriptor.metadata.pageCount, 2);
});

test("file migration is dry-run by default and requires an explicit execute flag", () => {
  assert.equal(parseArguments([]).execute, false);
  assert.equal(parseArguments(["--execute"]).execute, true);
  assert.equal(parseArguments(["--verify-only"]).verifyOnly, true);
  assert.throws(() => parseArguments(["--execute", "--verify-only"]));
});
