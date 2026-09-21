const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TARGET_STATE_VERSION,
  factHash,
  parseArguments,
  run,
} = require("../scripts/maintenance/retire-question-family-unresolved-index");

function fixture() {
  return {
    version: 3,
    families: [{ id: "family-a", members: [{ questionId: "question-a" }] }],
    familySets: [{ id: "set-a" }],
    familySetLinks: [{ setId: "set-a", memberId: "family-a" }],
    unresolvedByBook: { "book-a": ["question-a", "question-b"], "book-b": ["question-c"] },
    historyByBook: { "book-a": [{ reason: "historic-review" }] },
    membershipRevisionByQuestion: { "question-a": 7 },
  };
}

function workspace(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shukao-retire-unresolved-index-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "question-families.json");
  const questionsFilePath = path.join(directory, "questions.json");
  fs.writeFileSync(filePath, `${JSON.stringify(fixture(), null, 2)}\n`);
  fs.writeFileSync(questionsFilePath, `${JSON.stringify([{ id: "question-a", status: "official" }], null, 2)}\n`);
  return { directory, filePath, questionsFilePath };
}

test("legacy unresolved index retirement is dry-run by default", (context) => {
  const { directory, filePath } = workspace(context);
  const before = fs.readFileSync(filePath);
  const result = run({ filePath });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.changed, true);
  assert.equal(result.legacyIndex.before.entryCount, 3);
  assert.equal(result.legacyIndex.after.entryCount, 0);
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(fs.existsSync(path.join(directory, "maintenance-backups")), false);
});

test("execute snapshots the source and changes only the compatibility field and version", (context) => {
  const { directory, filePath, questionsFilePath } = workspace(context);
  const beforeBuffer = fs.readFileSync(filePath);
  const beforeQuestions = fs.readFileSync(questionsFilePath);
  const beforeState = JSON.parse(beforeBuffer.toString("utf8"));
  const result = run({ filePath, execute: true });
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));

  assert.equal(result.verified, true);
  assert.equal(saved.version, TARGET_STATE_VERSION);
  assert.deepEqual(saved.unresolvedByBook, {});
  assert.equal(factHash(saved), factHash(beforeState));
  assert.deepEqual(fs.readFileSync(result.snapshotPath), beforeBuffer);
  assert.deepEqual(fs.readFileSync(questionsFilePath), beforeQuestions);
  assert.match(result.questionsSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).sourceSha256, result.sourceSha256);
  assert.equal(fs.readdirSync(path.join(directory, "maintenance-backups")).length, 2);

  const repeated = run({ filePath, execute: true });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.legacyIndex.before.entryCount, 0);
  assert.equal(fs.readdirSync(path.join(directory, "maintenance-backups")).length, 2);
});

test("CLI parsing requires explicit execute and supports isolated paths", () => {
  assert.equal(parseArguments([]).execute, false);
  const options = parseArguments(["--execute", "--file", "fixture.json", "--questions-file", "questions.json", "--backup-dir", "backups"]);
  assert.equal(options.execute, true);
  assert.equal(options.filePath, path.resolve("fixture.json"));
  assert.equal(options.questionsFilePath, path.resolve("questions.json"));
  assert.equal(options.backupDirectory, path.resolve("backups"));
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});
