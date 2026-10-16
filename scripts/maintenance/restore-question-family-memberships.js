const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createFileQuestionFamilyStore, createMemoryQuestionFamilyStore } = require("../../apps/api/src/question-family-store");
const { createFileAdminOperationStore } = require("../../apps/api/src/admin-operation-store");

const ACTOR = "用户授权的历史归属恢复";
const REASON = "historical_restore_requires_member_review";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const fileHash = (file) => sha256(fs.readFileSync(file));

function buildRestoration({ current, source, questions, structures, targets }) {
  assert.ok(Array.isArray(targets) && targets.length > 0 && targets.length <= 20, "Explicit recovery targets (1-20) are required");
  assert.deepStrictEqual(createMemoryQuestionFamilyStore(current).exportState(), current,
    "Current state requires unrelated normalization; refuse recovery");
  const selected = new Set();
  const additions = new Map();
  const warnings = [];
  for (const { questionId, familyId } of targets) {
    assert.ok(questionId && familyId && !selected.has(questionId), "Missing or duplicate recovery target");
    selected.add(questionId);
    const family = source.families?.find((item) => item.id === familyId);
    const member = family?.members?.find((item) => item.questionId === questionId);
    assert.ok(family && member, `Historical relationship not found: ${questionId}`);
    assert.equal(family.status, "confirmed", "Only verified historical confirmed definitions may be restored");
    assert.ok(["manual_family", "manual_empty_family"].includes(family.source), "Historical definition must be manual");
    const question = questions.find((item) => item.id === questionId);
    assert.ok(question && question.bookId === family.bookId && question.subjectId === family.subjectId,
      `Question missing or moved to another book: ${questionId}`);
    assert.ok(!question.deletedAt && !["deleted", "archived", "merged"].includes(question.status),
      `Question is no longer active: ${questionId}`);
    assert.ok(!current.families.some((item) => item.id === familyId
      || (item.bookId === family.bookId && item.name.normalize("NFKC").trim() === family.name.normalize("NFKC").trim())),
    `Target family already exists or has a name conflict: ${familyId}`);
    assert.ok(!Object.entries(current.familyAliases || {}).some(([alias, canonical]) => alias === familyId || canonical === familyId),
      `Target family has a current alias: ${familyId}`);
    assert.ok(!current.families.some((item) => item.members.some((entry) => entry.questionId === questionId)),
      `Question already has a current relationship: ${questionId}`);
    const structure = structures.records.find((item) => item.bookId === family.bookId);
    const nodes = new Set((structure?.nodes || []).map((item) => item.id));
    const requiredNodes = [family.coreKnowledgeNodeId, family.knowledgeNodeId,
      ...(family.requiredKnowledgeNodeIds || []), ...(family.textbookAnchorNodeIds || [])].filter(Boolean);
    assert.ok(requiredNodes.length && requiredNodes.every((id) => nodes.has(id)),
      `Historical family references missing knowledge nodes: ${familyId}`);
    const fingerprint = structure.fingerprints?.find((item) => item.questionId === questionId);
    warnings.push({ questionId, familyId, fingerprintStatus: fingerprint?.status || "missing",
      coreDiffers: Boolean(fingerprint?.primaryNodeId && fingerprint.primaryNodeId !== family.coreKnowledgeNodeId),
      legacyMemberStatus: member.reviewStatus || "legacy_inherited",
      contributionMissing: !member.contributionKnowledgeNodeIds?.length });
    if (!additions.has(familyId)) additions.set(familyId, { ...structuredClone(family), members: [] });
    // A recovered link is not a fresh fit approval against today's fingerprint.
    additions.get(familyId).members.push({ ...structuredClone(member), reviewStatus: "pending_fit",
      reviewedAt: null, reviewedBy: "", reviewInvalidationReason: REASON, reviewInvalidatedBy: ACTOR });
  }
  for (const family of additions.values()) {
    assert.equal(family.members.filter((member) => member.role === "prototype").length, 1,
      `The selected relationships must include the original prototype: ${family.id}`);
    family.reason = `${family.reason || ""} [历史恢复：本次仅恢复获授权的 ${family.members.length} 条关系，成员适配待复核]`;
  }
  const next = structuredClone(current);
  next.families.push(...additions.values());
  for (const id of selected) next.membershipRevisionByQuestion[id] = (next.membershipRevisionByQuestion[id] || 0) + 1;
  const normalized = createMemoryQuestionFamilyStore(next).exportState();
  const preserved = structuredClone(normalized);
  preserved.families = preserved.families.filter((item) => !additions.has(item.id));
  preserved.membershipRevisionByQuestion = structuredClone(current.membershipRevisionByQuestion);
  assert.deepStrictEqual(preserved, current, "Recovery would change existing families, aliases, sets, or history");
  assert.deepStrictEqual(normalized.membershipRevisionByQuestion, next.membershipRevisionByQuestion);
  for (const id of selected) assert.equal(normalized.membershipRevisionByQuestion[id], (current.membershipRevisionByQuestion[id] || 0) + 1);
  assert.equal(normalized.families.length, current.families.length + additions.size, "Recovery merged a family unexpectedly");
  return { next: normalized, familyIds: [...additions.keys()], questionIds: [...selected], warnings };
}

function runtimeHashes(directory) {
  return Object.fromEntries(fs.readdirSync(directory).filter((name) => name.endsWith(".json")
    && fs.statSync(path.join(directory, name)).isFile()).sort().map((name) => [name, fileHash(path.join(directory, name))]));
}

function run(options, hooks = {}) {
  assert.ok(options.planPath && options.runtimeDirectory, "--plan and --runtime are required");
  const runtimeDirectory = path.resolve(options.runtimeDirectory);
  const planPath = path.resolve(options.planPath);
  const planBytes = fs.readFileSync(planPath);
  const plan = JSON.parse(planBytes.toString("utf8"));
  const sourcePath = path.resolve(plan.sourcePath);
  assert.equal(fileHash(sourcePath), plan.sourceSha256, "Historical backup hash mismatch");
  const beforeHashes = runtimeHashes(runtimeDirectory);
  const file = path.join(runtimeDirectory, "question-families.json");
  const auditFile = path.join(runtimeDirectory, "admin-actions.json");
  const familyBytes = fs.readFileSync(file);
  const auditBytes = fs.readFileSync(auditFile);
  const audits = JSON.parse(auditBytes.toString("utf8"));
  assert.ok(Array.isArray(audits) && audits.length < 5000, "Recovery must not truncate existing audit records");
  const recoveryKey = sha256(planBytes);
  const prior = audits.find((item) => item.action === "question_family.restore_history" && item.metadata?.recoveryKey === recoveryKey);
  const current = JSON.parse(familyBytes.toString("utf8"));
  if (prior) {
    for (const target of plan.targets) assert.ok(current.families.find((item) => item.id === target.familyId)
      ?.members.some((member) => member.questionId === target.questionId), "Previously restored relationship has since changed; manual review required");
    return { mode: options.execute ? "execute" : "dry-run", changed: false, alreadyApplied: true, operationId: prior.id };
  }
  const restoration = buildRestoration({ current, source: readJson(sourcePath),
    questions: readJson(path.join(runtimeDirectory, "questions.json")),
    structures: readJson(path.join(runtimeDirectory, "knowledge-structures.json")), targets: plan.targets });
  const previewHash = sha256(JSON.stringify({ recoveryKey, beforeHashes, next: restoration.next }));
  const result = { mode: options.execute ? "execute" : "dry-run", changed: true, recoveryKey, previewHash,
    sourcePath, sourceSha256: plan.sourceSha256, familyIds: restoration.familyIds,
    questionIds: restoration.questionIds, memberStatus: "pending_fit", warnings: restoration.warnings, beforeHashes };
  if (!options.execute) return result;
  assert.equal(options.confirm, previewHash, "Preview changed or not confirmed; run a fresh dry run");
  assert.ok(!fs.existsSync(`${file}.tmp`) && !fs.existsSync(`${auditFile}.tmp`), "A Store write is already in progress");
  const backupDirectory = path.join(runtimeDirectory, "maintenance-backups",
    `restore-family-links.${new Date().toISOString().replace(/[:.]/g, "-")}.${crypto.randomUUID()}`);
  fs.mkdirSync(backupDirectory, { recursive: true });
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const manifest = { ...result, status: "prepared", backupDirectory, preparedAt: new Date().toISOString() };
  const saveManifest = () => fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(backupDirectory, "question-families.before.json"), familyBytes, { flag: "wx" });
  fs.writeFileSync(path.join(backupDirectory, "admin-actions.before.json"), auditBytes, { flag: "wx" });
  fs.writeFileSync(path.join(backupDirectory, "plan.json"), planBytes, { flag: "wx" });
  assert.equal(fileHash(path.join(backupDirectory, "question-families.before.json")), beforeHashes["question-families.json"]);
  assert.equal(fileHash(path.join(backupDirectory, "admin-actions.before.json")), beforeHashes["admin-actions.json"]);
  saveManifest();
  const store = createFileQuestionFamilyStore(file);
  const expectedFamilyHash = sha256(`${JSON.stringify(restoration.next, null, 2)}\n`);
  let wroteFamilies = false;
  try {
    hooks.beforeCommit?.();
    assert.equal(fileHash(sourcePath), plan.sourceSha256, "Historical backup changed during preparation");
    assert.deepStrictEqual(runtimeHashes(runtimeDirectory), beforeHashes, "Runtime changed during preparation; nothing restored");
    store.replaceState(restoration.next);
    wroteFamilies = true;
    assert.equal(fileHash(file), expectedFamilyHash);
    assert.deepStrictEqual(store.exportState(), restoration.next);
    hooks.afterFamilyWrite?.();
    assert.equal(fileHash(auditFile), beforeHashes["admin-actions.json"], "Audit log changed during recovery");
    const operation = createFileAdminOperationStore(auditFile).append({
      actorId: "", actor: ACTOR, actorRole: "maintenance", action: "question_family.restore_history",
      category: "question_family", targetType: "question_family", targetId: restoration.familyIds.join(","),
      summary: `经用户授权，从已核验历史备份恢复 ${restoration.familyIds.length} 个题族、${restoration.questionIds.length} 条缺失归属；成员适配待复核，不改题目或指纹。`,
      metadata: { recoveryKey, sourceSha256: plan.sourceSha256, previewHash,
        questionIds: restoration.questionIds, familyIds: restoration.familyIds, memberStatus: "pending_fit" },
    });
    assert.deepStrictEqual(readJson(auditFile).slice(1), audits, "Existing audit records changed");
    const afterHashes = runtimeHashes(runtimeDirectory);
    const unchanged = { ...afterHashes, "question-families.json": beforeHashes["question-families.json"], "admin-actions.json": beforeHashes["admin-actions.json"] };
    assert.deepStrictEqual(unchanged, beforeHashes, "Unrelated runtime data changed during recovery");
    assert.equal(afterHashes["question-families.json"], expectedFamilyHash);
    Object.assign(manifest, { status: "committed", completedAt: new Date().toISOString(), operationId: operation.id, afterHashes, verified: true });
    saveManifest();
    return { ...manifest, manifestPath };
  } catch (error) {
    // Only compensate our own write, never roll back another operator's newer work.
    if (wroteFamilies && fileHash(file) === expectedFamilyHash && fileHash(auditFile) === beforeHashes["admin-actions.json"]) {
      store.replaceState(current);
      assert.deepStrictEqual(store.exportState(), current);
      manifest.status = "rolled_back";
    } else manifest.status = wroteFamilies ? "requires_manual_review" : "aborted";
    manifest.error = error.message;
    saveManifest();
    throw new Error(`${error.message}; recovery manifest: ${manifestPath}`);
  }
}

function parseArguments(argv) {
  const options = { execute: false };
  const flags = { "--plan": "planPath", "--runtime": "runtimeDirectory", "--confirm": "confirm" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--execute") options.execute = true;
    else {
      assert.ok(flags[flag] && argv[index + 1] && !argv[index + 1].startsWith("--"), `Unknown or incomplete argument: ${flag}`);
      options[flags[flag]] = argv[++index];
    }
  }
  return options;
}

if (require.main === module) {
  try { console.log(JSON.stringify(run(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { buildRestoration, run, parseArguments, sha256, runtimeHashes };
