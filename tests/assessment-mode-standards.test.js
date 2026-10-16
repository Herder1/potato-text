const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAssessmentModeService, assessmentModePrompt } = require("../apps/api/src/assessment-mode-standards");
const { createMemoryKnowledgeClassificationExperienceStore, createFileKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { renderPromptTemplate } = require("../apps/api/src/ai-provider");

function fixture(experience = createMemoryKnowledgeClassificationExperienceStore()) {
  const q = { id: "mode-q", subjectId: "ancient-literature", bookId: "", type: "multiple_choice", version: 1,
    stem: "下列作家与作品、时代的说法正确的是？", options: [{ key: "A", text: "完整选项文本" }], correctAnswer: ["A"],
    referenceAnswer: "参考答案", assessmentAction: "旧动作", focus: { action: "旧动作" } };
  const questions = createMemoryQuestionStore([q]);
  const service = createAssessmentModeService(experience, questions);
  return { service, experience, questions, q };
}
function confirmPayload(service, ids) {
  const state = service.get("mode-q");
  return { modeIds: ids, expectedQuestionVersion: state.questionVersion, expectedRevision: state.assignment?.revision || 0,
    modeVersions: Object.fromEntries(state.options.map((row) => [row.id, row.version])) };
}

test("trial seed coverage is subject/type scoped, read-only, and has 14/8/8 candidates", () => {
  const { service, experience } = fixture();
  const before = experience.exportState();
  assert.equal(service.list().length, 30);
  for (const [type, count] of [["single_choice", 14], ["multiple_choice", 14], ["short_answer", 8], ["material_analysis", 8], ["fill_blank", 0]]) {
    assert.equal(service.list({ subjectId: "ancient-literature", type }).length, count);
  }
  assert.equal(service.list({ subjectId: "modern-chinese" }).length, 0);
  assert.ok(service.list().every((row) => row.status === "trial" && row.definition && row.positiveExamples && row.negativeExamples));
  assert.deepEqual(experience.exportState(), before);
});

test("confirmed multi-selection does not modify question, legacy action or classification experience", () => {
  const { service, questions, experience } = fixture();
  const before = questions.exportState();
  const ids = ["ancient-literature-c01", "ancient-literature-c04"];
  const result = service.confirm("mode-q", confirmPayload(service, ids), "审核人");
  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.assignment.modes.map((row) => row.id), ids);
  assert.equal(result.assignment.confirmedBy, "审核人");
  assert.deepEqual(questions.exportState(), before);
  assert.equal(experience.rules().length, 0);
});

test("scope, forged IDs, stale standard, stale question and concurrent assignments are rejected", () => {
  const { service } = fixture();
  const payload = confirmPayload(service, ["ancient-literature-c01"]);
  assert.throws(() => service.confirm("mode-q", { ...payload, modeIds: ["invented"] }, "a"), /out_of_scope/);
  assert.throws(() => service.confirm("mode-q", { ...payload, modeIds: ["ancient-literature-q1"] }, "a"), /out_of_scope/);
  assert.throws(() => service.confirm("mode-q", { ...payload, expectedQuestionVersion: 9 }, "a"), /question_changed/);
  assert.throws(() => service.confirm("mode-q", { ...payload, modeVersions: {} }, "a"), /version_conflict/);
  service.confirm("mode-q", payload, "a");
  assert.throws(() => service.confirm("mode-q", payload, "b"), /assignment_changed/);
});

test("editing and disabling standards preserve old references and expose affected questions", () => {
  const { service, experience } = fixture();
  const id = "ancient-literature-c01";
  service.confirm("mode-q", confirmPayload(service, [id]), "a");
  const before = experience.exportState().questionAssessmentModes;
  const result = service.saveStandard(id, { expectedVersion: 1, definition: "修订定义", status: "inactive" }, "教研员");
  assert.equal(result.mode.version, 2);
  assert.equal(result.mode.history[0].version, 1);
  assert.equal(result.affected.length, 1);
  assert.equal(service.get("mode-q").status, "needs_review");
  assert.ok(service.get("mode-q").reviewReasons.some((s) => s.includes("停用")));
  assert.equal(service.get("mode-q").options.length, 13);
  assert.deepEqual(experience.exportState().questionAssessmentModes, before);
  assert.throws(() => service.saveStandard(id, { expectedVersion: 1, name: "覆盖" }, "b"), /version_conflict/);
  const cleared = service.confirm("mode-q", confirmPayload(service, []), "a");
  assert.equal(cleared.status, "unmarked");
  assert.equal(cleared.assignment.history.length, 1);
});

test("question version and scope changes derive review state without rewriting assignments", () => {
  const { service, questions, experience } = fixture();
  service.confirm("mode-q", confirmPayload(service, ["ancient-literature-c01"]), "a");
  const saved = experience.exportState();
  const rows = questions.exportState();
  rows[0].version = 2;
  rows[0].type = "short_answer";
  questions.replaceState(rows);
  const result = service.get("mode-q");
  assert.equal(result.status, "needs_review");
  assert.equal(result.options.length, 8);
  assert.ok(result.reviewReasons.some((s) => s.includes("题型范围")));
  assert.deepEqual(experience.exportState(), saved);
});

test("create validates definition, overlapping names, subject and types", () => {
  const { service } = fixture();
  const payload = { name: "新考法", subjectId: "ancient-literature", questionTypes: ["short_answer"], status: "trial", definition: "定义" };
  assert.throws(() => service.saveStandard("", { ...payload, definition: "" }, "a"), /required/);
  assert.throws(() => service.saveStandard("", { ...payload, subjectId: "made-up" }, "a"), /scope_invalid/);
  assert.throws(() => service.saveStandard("", { ...payload, questionTypes: ["invalid"] }, "a"), /scope_invalid/);
  const { mode } = service.saveStandard("", payload, "a");
  assert.ok(mode.id);
  assert.throws(() => service.saveStandard("", payload, "a"), /duplicate/);
});

test("suggestion consumes the same latest standards and full options, never persists labels", () => {
  const { service, experience } = fixture();
  const id = "ancient-literature-c01";
  service.saveStandard(id, { expectedVersion: 1, definition: "动态定义测试" }, "a");
  const context = service.suggestionContext("mode-q");
  const prompt = renderPromptTemplate(assessmentModePrompt.userPromptTemplate, context);
  assert.match(prompt, /动态定义测试/);
  assert.match(prompt, /完整选项文本/);
  assert.doesNotMatch(prompt, /旧动作/);
  const before = experience.exportState();
  const output = service.validateSuggestion(context, { selections: [{ id, reason: "作者作品对应" }], uncertainty: "" });
  assert.equal(output.status, "suggested");
  assert.equal(output.selections[0].version, 2);
  assert.deepEqual(experience.exportState(), before);
  assert.throws(() => service.validateSuggestion(context, { selections: [{ id: "invented", reason: "x" }] }), /output_invalid/);
  assert.throws(() => service.validateSuggestion(context, { selections: [{ id }] }), /output_invalid/);
  service.saveStandard(id, { expectedVersion: 2, name: "已改名" }, "b");
  assert.throws(() => service.validateSuggestion(context, { selections: [] }), /version_conflict/);
});

test("file persistence survives restart and old experience writes, and seed reads never create a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-mode-test-"));
  const file = path.join(dir, "experience.json");
  try {
    const { service, experience, questions } = fixture(createFileKnowledgeClassificationExperienceStore(file));
    service.list();
    assert.equal(fs.existsSync(file), false);
    service.confirm("mode-q", confirmPayload(service, ["ancient-literature-c01"]), "a");
    experience.addMessage({ resultId: "r", questionId: "mode-q", bookId: "book", message: "原有功能照常保存" });
    const restarted = createAssessmentModeService(createFileKnowledgeClassificationExperienceStore(file), questions);
    assert.equal(restarted.get("mode-q").assignment.modes.length, 1);
    assert.equal(restarted.list().length, 30);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PostgreSQL experience wrapper schedules new metadata and restores it without a new store", async () => {
  const { STORE_SPECS, wrapStore, createPersistenceController } = require("../apps/api/src/postgres-persistence");
  const spec = STORE_SPECS.find((row) => row.option === "knowledgeClassificationExperienceStore");
  const persisted = [];
  const controller = createPersistenceController(async (state) => persisted.push(state));
  const wrapped = wrapStore(createMemoryKnowledgeClassificationExperienceStore(), spec.mutations, (store) => store.exportState(), controller);
  const { service, questions } = fixture(wrapped);
  service.saveStandard("ancient-literature-c01", { expectedVersion: 1, definition: "数据库定义" }, "a");
  service.confirm("mode-q", confirmPayload(service, ["ancient-literature-c01"]), "a");
  await controller.flush();
  const restored = createAssessmentModeService(createMemoryKnowledgeClassificationExperienceStore(persisted.at(-1)), questions);
  assert.equal(restored.get("mode-q").status, "confirmed");
  assert.equal(restored.get("mode-q").assignment.modes[0].version, 2);
  assert.equal(restored.list().find((row) => row.id.endsWith("c01")).definition, "数据库定义");
});
