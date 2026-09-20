const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const knexFactory = require("knex");
const knexfile = require("../knexfile");
const { createObjectStorageFromEnv, defaultMimeType } = require("../apps/api/src/object-storage");

const MIGRATED_DIRECTORIES = ["textbooks", "exams/uploads", "exam-exports"];
const DERIVED_DIRECTORIES = ["textbook-page-previews", "exams/jobs"];

function parseArguments(argv) {
  const options = {
    execute: false,
    verifyOnly: false,
    runtimeRoot: path.resolve(__dirname, "../.runtime"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") options.execute = true;
    else if (value === "--verify-only") options.verifyOnly = true;
    else if (value === "--runtime-root") options.runtimeRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.execute && options.verifyOnly) throw new Error("Choose either --execute or --verify-only");
  return options;
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const visit = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && !entry.name.endsWith(".tmp")) output.push(target);
    });
  };
  visit(root);
  return output;
}

function collectFiles(runtimeRoot) {
  return MIGRATED_DIRECTORIES.flatMap((relativeDirectory) => walkFiles(path.join(runtimeRoot, relativeDirectory)))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function countFiles(runtimeRoot, directories) {
  const files = directories.flatMap((relativeDirectory) => walkFiles(path.join(runtimeRoot, relativeDirectory)));
  return { files: files.length, bytes: files.reduce((total, filePath) => total + fs.statSync(filePath).size, 0) };
}

function objectKeyFor(runtimeRoot, filePath) {
  return path.relative(runtimeRoot, filePath).split(path.sep).join("/");
}

function readExportManifest(filePath) {
  const manifestPath = path.join(path.dirname(filePath), "manifest.json");
  try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { return null; }
}

function fileDescriptor(runtimeRoot, filePath) {
  const objectKey = objectKeyFor(runtimeRoot, filePath);
  const fileName = path.basename(filePath);
  const metadata = { migratedFrom: objectKey };
  let originalFileName = fileName;
  if (objectKey.startsWith("textbooks/")) {
    metadata.category = "textbook";
    metadata.bookId = path.basename(fileName, path.extname(fileName));
  } else if (objectKey.startsWith("exams/uploads/")) {
    metadata.category = "exam_import";
    const match = fileName.match(/^(exam-import-[a-z0-9-]+)-(paper|answer)\.(pdf|docx)$/i);
    if (match) {
      metadata.importId = match[1];
      metadata.role = match[2].toLowerCase();
    }
  } else if (objectKey.startsWith("exam-exports/")) {
    metadata.category = "exam_export";
    metadata.exportId = objectKey.split("/")[1] || "";
    const kind = path.basename(fileName, path.extname(fileName));
    if (kind === "paper" || kind === "answer") {
      metadata.kind = kind;
      const manifest = readExportManifest(filePath);
      const manifestFile = manifest?.files?.find((item) => item.kind === kind);
      if (manifestFile?.name) originalFileName = manifestFile.name;
      if (manifestFile?.label) metadata.label = manifestFile.label;
      if (manifestFile?.pageCount) metadata.pageCount = manifestFile.pageCount;
      if (manifest?.examId) metadata.examId = manifest.examId;
      if (manifest?.userId) metadata.userId = manifest.userId;
    }
  }
  return { objectKey, fileName: originalFileName, mimeType: defaultMimeType(fileName), metadata };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function writeEvent(event, payload = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`);
}

async function migrateFile(storage, runtimeRoot, filePath, options) {
  const descriptor = fileDescriptor(runtimeRoot, filePath);
  const stat = await fsp.stat(filePath);
  const digest = await hashFile(filePath);
  if (stat.size === 0) {
    return { objectKey: descriptor.objectKey, status: "empty_skipped", bytes: 0, sha256: digest };
  }
  const existing = await storage.stat(descriptor.objectKey);
  if (options.verifyOnly) {
    if (!existing) return { objectKey: descriptor.objectKey, status: "missing", bytes: stat.size, sha256: digest };
    if (existing.size !== stat.size || existing.sha256 !== digest) {
      return { objectKey: descriptor.objectKey, status: "metadata_mismatch", bytes: stat.size, sha256: digest };
    }
    const verified = await storage.verify(descriptor.objectKey);
    return { objectKey: descriptor.objectKey, status: "verified", bytes: verified.size, sha256: verified.sha256 };
  }
  if (existing && existing.size === stat.size && existing.sha256 === digest) {
    const verified = await storage.verify(descriptor.objectKey);
    return { objectKey: descriptor.objectKey, status: "already_verified", bytes: verified.size, sha256: verified.sha256 };
  }
  const buffer = await fsp.readFile(filePath);
  const saved = await storage.put(descriptor.objectKey, { ...descriptor, buffer });
  const verified = await storage.verify(descriptor.objectKey);
  if (verified.size !== stat.size || verified.sha256 !== digest) throw new Error(`Verification failed: ${descriptor.objectKey}`);
  return { objectKey: descriptor.objectKey, status: "uploaded", bytes: saved.size, sha256: saved.sha256, remoteId: saved.remoteId };
}

async function run(options) {
  const files = collectFiles(options.runtimeRoot);
  const inventory = {
    runtimeRoot: options.runtimeRoot,
    files: files.length,
    bytes: files.reduce((total, filePath) => total + fs.statSync(filePath).size, 0),
    emptyFiles: files.filter((filePath) => fs.statSync(filePath).size === 0).length,
    excludedDerived: countFiles(options.runtimeRoot, DERIVED_DIRECTORIES),
    mode: options.verifyOnly ? "verify" : (options.execute ? "execute" : "dry-run"),
  };
  writeEvent("inventory", inventory);
  if (!options.execute && !options.verifyOnly) return { ...inventory, processed: 0, failures: 0 };

  const environment = process.env.NODE_ENV || "development";
  const knex = knexFactory(knexfile[environment] || knexfile.development);
  let failures = 0;
  let processed = 0;
  let uploadedBytes = 0;
  try {
    await knex.raw("select 1");
    const storage = createObjectStorageFromEnv({ knex });
    if (!storage) throw new Error("FILE_STORAGE_DRIVER must be kvault");
    for (const filePath of files) {
      try {
        const result = await migrateFile(storage, options.runtimeRoot, filePath, options);
        processed += 1;
        if (result.status === "uploaded") uploadedBytes += result.bytes;
        writeEvent("file", result);
      } catch (error) {
        failures += 1;
        writeEvent("file_error", { objectKey: objectKeyFor(options.runtimeRoot, filePath), error: error.code || error.message });
      }
    }
  } finally {
    await knex.destroy();
  }
  const summary = { ...inventory, processed, failures, uploadedBytes };
  writeEvent("summary", summary);
  if (failures) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATED_DIRECTORIES,
  collectFiles,
  fileDescriptor,
  objectKeyFor,
  parseArguments,
  run,
};
