const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TARGET_STATE_VERSION = 4;
const DEFAULT_FILE_PATH = path.resolve(__dirname, "../../.runtime/question-families.json");

function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    execute: false,
    filePath: DEFAULT_FILE_PATH,
    questionsFilePath: "",
    backupDirectory: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") options.execute = true;
    else if (value === "--file") options.filePath = path.resolve(argv[++index] || "");
    else if (value === "--questions-file") options.questionsFilePath = path.resolve(argv[++index] || "");
    else if (value === "--backup-dir") options.backupDirectory = path.resolve(argv[++index] || "");
    else if (value === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.filePath) throw new Error("A question-family state file is required");
  return options;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function factHash(state) {
  const facts = structuredClone(state);
  delete facts.version;
  delete facts.unresolvedByBook;
  return sha256(JSON.stringify(canonicalize(facts)));
}

function legacyIndexSummary(state) {
  const source = state?.unresolvedByBook && typeof state.unresolvedByBook === "object"
    ? state.unresolvedByBook
    : {};
  const byBook = Object.fromEntries(Object.entries(source).map(([bookId, questionIds]) => [
    bookId,
    Array.isArray(questionIds) ? questionIds.length : 0,
  ]));
  return {
    byBook,
    entryCount: Object.values(byBook).reduce((total, count) => total + count, 0),
  };
}

function buildRetiredState(state) {
  return {
    ...structuredClone(state),
    version: Math.max(TARGET_STATE_VERSION, Number(state?.version) || 0),
    unresolvedByBook: {},
  };
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function run(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE_PATH);
  const questionsFilePath = path.resolve(options.questionsFilePath
    || path.join(path.dirname(filePath), "questions.json"));
  const execute = options.execute === true;
  const sourceBuffer = fs.readFileSync(filePath);
  const questionsBuffer = fs.existsSync(questionsFilePath) ? fs.readFileSync(questionsFilePath) : null;
  const sourceState = JSON.parse(sourceBuffer.toString("utf8"));
  const nextState = buildRetiredState(sourceState);
  const beforeIndex = legacyIndexSummary(sourceState);
  const afterIndex = legacyIndexSummary(nextState);
  const beforeFactSha256 = factHash(sourceState);
  const afterFactSha256 = factHash(nextState);
  if (beforeFactSha256 !== afterFactSha256) throw new Error("Question-family facts changed while retiring the legacy index");

  const changed = Number(sourceState.version) !== Number(nextState.version)
    || JSON.stringify(sourceState.unresolvedByBook) !== JSON.stringify(nextState.unresolvedByBook);
  const result = {
    mode: execute ? "execute" : "dry-run",
    changed,
    filePath,
    questionsFilePath: questionsBuffer ? questionsFilePath : "",
    stateVersion: { before: Number(sourceState.version) || 0, after: nextState.version },
    legacyIndex: { before: beforeIndex, after: afterIndex },
    sourceSha256: sha256(sourceBuffer),
    questionsSha256: questionsBuffer ? sha256(questionsBuffer) : "",
    factsSha256: beforeFactSha256,
    snapshotPath: "",
    manifestPath: "",
  };

  if (!execute || !changed) return result;

  const backupDirectory = path.resolve(options.backupDirectory
    || path.join(path.dirname(filePath), "maintenance-backups"));
  fs.mkdirSync(backupDirectory, { recursive: true });
  const currentBuffer = fs.readFileSync(filePath);
  if (sha256(currentBuffer) !== result.sourceSha256) {
    throw new Error("Question-family state changed after inspection; retry from a fresh snapshot");
  }
  if (questionsBuffer && sha256(fs.readFileSync(questionsFilePath)) !== result.questionsSha256) {
    throw new Error("Question state changed after inspection; retry from a fresh snapshot");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `question-families.before-unresolved-index-retirement.${timestamp}.${result.sourceSha256.slice(0, 12)}`;
  const snapshotPath = path.join(backupDirectory, `${baseName}.json`);
  const manifestPath = path.join(backupDirectory, `${baseName}.manifest.json`);
  fs.writeFileSync(snapshotPath, sourceBuffer, { flag: "wx", mode: 0o400 });
  try { fs.chmodSync(snapshotPath, 0o400); } catch (error) { if (process.platform !== "win32") throw error; }

  const originalMode = fs.statSync(filePath).mode & 0o777;
  atomicWriteJson(filePath, nextState, originalMode || 0o600);
  const savedBuffer = fs.readFileSync(filePath);
  const savedState = JSON.parse(savedBuffer.toString("utf8"));
  const savedIndex = legacyIndexSummary(savedState);
  const savedFactSha256 = factHash(savedState);
  if (savedIndex.entryCount !== 0 || savedFactSha256 !== beforeFactSha256) {
    throw new Error("Post-write verification failed while retiring the legacy index");
  }
  if (questionsBuffer && sha256(fs.readFileSync(questionsFilePath)) !== result.questionsSha256) {
    throw new Error("Question state changed during legacy-index retirement");
  }

  Object.assign(result, {
    snapshotPath,
    manifestPath,
    savedSha256: sha256(savedBuffer),
    verified: true,
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    operation: "retire_question_family_unresolved_index",
    executedAt: new Date().toISOString(),
    ...result,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

function usage() {
  return [
    "Usage: node scripts/maintenance/retire-question-family-unresolved-index.js [--execute] [--file PATH] [--questions-file PATH] [--backup-dir PATH]",
    "Without --execute the command is a read-only dry run.",
  ].join("\n");
}

if (require.main === module) {
  try {
    const options = parseArguments();
    if (options.help) console.log(usage());
    else console.log(JSON.stringify(run(options), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  TARGET_STATE_VERSION,
  buildRetiredState,
  factHash,
  legacyIndexSummary,
  parseArguments,
  run,
};
