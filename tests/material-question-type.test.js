const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { normalizeQuestionType } = require("../apps/miniprogram/utils/question-type");
const { normalizeOfficialQuestion } = require("../apps/miniprogram/utils/question-sync");
const { normalizeQuestionForPractice } = require("../apps/miniprogram/utils/private-pack-store");
const { createMemoryQuestionStore, questionFingerprint, questionTypes } = require("../apps/api/src/question-store");
const { parseQuestionImportText } = require("../apps/api/src/question-text-import");
const { normalizeExamModelOutput } = require("../apps/api/src/exam-paper-import");
const { createMemoryExamImportStore } = require("../apps/api/src/exam-import-store");
const { normalizeExamSnapshot } = require("../apps/api/src/exam-export");
const { generatedQuestionSchema, normalizeGeneratedQuestions } = require("../apps/api/src/textbook-rag");
const { scoringPointStructure } = require("../apps/api/src/scoring-point-structure");
const { createAssessmentModeService } = require("../apps/api/src/assessment-mode-standards");
const { createMemoryKnowledgeClassificationExperienceStore } = require("../apps/api/src/knowledge-classification-experience-store");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createServer } = require("./helpers/admin-auth");

function legacyQuestion(patch = {}) {
  return {
    id: "legacy-appreciation", type: "appreciation", typeLabel: "作品赏析题",
    subjectId: "ancient-literature", bookId: "ancient-literature-2-1",
    chapter: "宋代文学", knowledgePoints: ["苏轼"], stem: "谈谈这首词的艺术特点。",
    material: "大江东去，浪淘尽，千古风流人物。", materialGroupId: "g49", subNumber: "1",
    referenceAnswer: "境界开阔，气势雄浑。", answerSource: "team_verified",
    scoringPoints: [{ id: "style", description: "指出境界开阔", score: 4 }],
    options: [], correctAnswer: [], maxScore: 4, version: 3, updatedAt: 123,
    library: "official", status: "official", answerReviewStatus: "verified",
    versions: [{ version: 3, changeNote: "已审核", previousSnapshot: { type: "appreciation" } }],
    ...patch,
  };
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("retired type and all legacy labels resolve to one selectable material type", () => {
  for (const value of ["appreciation", "作品赏析", "作品赏析题", "赏析题", "material_analysis"]) {
    assert.equal(normalizeQuestionType(value), "material_analysis");
  }
  assert.equal(normalizeQuestionType("short_answer"), "short_answer");
  assert.equal(questionTypes.some(([id]) => id === "appreciation"), false);
  assert.equal(questionTypes.filter(([id]) => id === "material_analysis").length, 1);
});

test("legacy reads and both filter spellings preserve raw state, groups, history and scores", () => {
  const raw = legacyQuestion();
  const store = createMemoryQuestionStore([raw]);
  const before = store.exportState();
  const q = store.get(raw.id);
  assert.equal(q.type, "material_analysis");
  assert.equal(q.typeLabel, "材料分析题");
  for (const field of ["id", "material", "stem", "referenceAnswer", "maxScore", "version", "materialGroupId", "subNumber", "status", "answerReviewStatus", "versions"]) {
    assert.deepEqual(q[field], raw[field], field);
  }
  assert.equal(store.getMany([raw.id])[0].type, "material_analysis");
  for (const type of ["material_analysis", "appreciation"]) {
    assert.equal(store.list({ type }).questions.length, 1);
    assert.equal(store.list({ types: [type] }).questions.length, 1);
  }
  assert.deepEqual(store.exportState(), before);
});

test("saving other questions never migrates untouched rows; editing the old question writes a version", () => {
  const raw = legacyQuestion();
  const store = createMemoryQuestionStore([raw, legacyQuestion({ id: "old-2", typeLabel: undefined })]);
  store.create(legacyQuestion({ id: "new-material", stem: "分析另一首词。", type: "appreciation" }));
  assert.equal(store.get("new-material").type, "material_analysis");
  assert.equal(store.exportState().find((q) => q.id === raw.id).type, "appreciation");
  assert.equal("typeLabel" in store.exportState().find((q) => q.id === "old-2"), false);
  store.update("new-material", { sourcePage: "12" });
  assert.equal(store.exportState().find((q) => q.id === raw.id).type, "appreciation");
  const edited = store.update(raw.id, { sourcePage: "45" });
  assert.equal(edited.type, "material_analysis");
  assert.equal(edited.version, raw.version + 1);
  assert.deepEqual(edited.versions.slice(1), raw.versions);
  assert.equal(edited.materialGroupId, raw.materialGroupId);
  assert.equal(store.exportState().find((q) => q.id === raw.id).type, "material_analysis");
  assert.equal(store.exportState().find((q) => q.id === "old-2").type, "appreciation");
});

test("raw snapshot restore remains exact and missing material is never fabricated", () => {
  const raw = legacyQuestion({ material: "", materialGroupId: "" });
  const store = createMemoryQuestionStore([]);
  assert.deepEqual(store.replaceState([raw]), [raw]);
  assert.deepEqual(store.exportState(), [raw]);
  assert.equal(store.get(raw.id).material, "");
  assert.equal(store.get(raw.id).type, "material_analysis");
});

test("canonical and legacy questions deduplicate under the same fingerprint", () => {
  const old = legacyQuestion();
  assert.equal(questionFingerprint(old), questionFingerprint({ ...old, type: "material_analysis" }));
  const store = createMemoryQuestionStore([old]);
  const result = store.previewImport([{ ...old, id: undefined, type: "material_analysis" }], "测试员");
  assert.equal(result[0].duplicate, true);
  assert.equal(result[0].duplicateOf, old.id);
  assert.equal(store.exportState().length, 1);
});

test("legacy text headings retain material A/B lines and split the same way as material questions", () => {
  const body = "阅读下列作品。\nA. 第一段原文。\nB. 第二段原文。\n（1）分析第一段的形象。\n（2）比较两段的表达。\n参考答案：（1）形象鲜明。（2）表达有别。\n分值：20";
  const defaults = { subjectId: "ancient-literature" };
  const canonical = parseQuestionImportText(`[材料分析题]${body}`, defaults);
  assert.equal(canonical.length, 2);
  for (const heading of ["作品赏析", "作品赏析题", "赏析题", "appreciation"]) {
    const result = parseQuestionImportText(`[${heading}]${body}`, defaults);
    assert.deepEqual(result.map(({ sourceRange, ...q }) => q), canonical.map(({ sourceRange, ...q }) => q));
    assert.match(result[0].material, /A\. 第一段/);
    assert.match(result[0].material, /B\. 第二段/);
    assert.equal(result[0].materialGroupId, result[1].materialGroupId);
  }
});

test("JSON and OCR recognition normalize aliases without losing answers or original section title", () => {
  for (const type of ["appreciation", "作品赏析题", "赏析题"]) {
    const input = legacyQuestion({ type, sectionTitle: "七、作品赏析题" });
    assert.equal(parseQuestionImportText(JSON.stringify([input]))[0].type, "material_analysis");
    const result = normalizeExamModelOutput({ questions: [input] }).questions[0];
    assert.equal(result.type, "material_analysis");
    assert.equal(result.sectionTitle, input.sectionTitle);
    assert.equal(result.material, input.material);
    assert.equal(result.referenceAnswer, input.referenceAnswer);
  }
});

test("legacy exam drafts normalize on read without rewriting stored recognition", () => {
  const draft = { id: "old-draft", questions: [legacyQuestion()], metadata: { title: "试卷" }, source: {}, warnings: [], status: "needs_review" };
  const store = createMemoryExamImportStore([draft]);
  const before = store.exportState();
  assert.equal(store.get(draft.id).questions[0].type, "material_analysis");
  assert.deepEqual(store.exportState(), before);
  assert.equal(store.update(draft.id, {}).questions[0].type, "material_analysis");
});

test("export snapshots and AI generation use material_analysis while accepting legacy responses", () => {
  const raw = legacyQuestion();
  const snapshot = normalizeExamSnapshot({ title: "测试卷" }, [raw]);
  assert.equal(snapshot.questions[0].type, "material_analysis");
  assert.equal(snapshot.questions[0].typeLabel, "材料分析题");
  assert.equal(snapshot.questions[0].materialGroupId, raw.materialGroupId);
  assert.doesNotMatch(generatedQuestionSchema().questions[0].type, /appreciation/);
  assert.equal(normalizeGeneratedQuestions({ questions: [raw] })[0].type, "material_analysis");
  assert.equal(scoringPointStructure("appreciation", raw.referenceAnswer, raw.scoringPoints, raw.maxScore).status, "complete");
});

test("legacy questions get material assessment modes without automatic annotation or question mutation", () => {
  const store = createMemoryQuestionStore([legacyQuestion()]);
  const before = store.exportState();
  const experience = createMemoryKnowledgeClassificationExperienceStore();
  const service = createAssessmentModeService(experience, store);
  const state = service.get("legacy-appreciation");
  assert.equal(state.options.length, 8);
  assert.equal(state.assignment, null);
  assert.deepEqual(service.list({ type: "appreciation" }), service.list({ type: "material_analysis" }));
  const mode = state.options[0];
  assert.equal(service.confirm("legacy-appreciation", {
    expectedQuestionVersion: 3, expectedRevision: 0, modeIds: [mode.id], modeVersions: { [mode.id]: mode.version },
  }, "测试员").status, "confirmed");
  assert.deepEqual(store.exportState(), before);
  assert.equal(service.get("legacy-appreciation").assignment.type, "material_analysis");
});

test("old custom standard scopes are compatible but their saved revisions remain unchanged", () => {
  const store = createMemoryQuestionStore([legacyQuestion()]);
  const experience = createMemoryKnowledgeClassificationExperienceStore();
  const state = experience.exportState();
  state.assessmentModes = [{
    id: "old-standard", name: "旧赏析范围", subjectId: "ancient-literature", status: "trial",
    questionTypes: ["appreciation", "material_analysis"], version: 1, history: [], definition: "测试定义",
  }];
  experience.replaceState(state);
  const before = experience.exportState();
  const service = createAssessmentModeService(experience, store);
  assert.deepEqual(service.get("legacy-appreciation").options.find((m) => m.id === "old-standard").questionTypes, ["material_analysis"]);
  assert.deepEqual(experience.exportState(), before);
  const saved = service.saveStandard("old-standard", { expectedVersion: 1, definition: "更新定义" }, "测试员");
  assert.deepEqual(saved.mode.questionTypes, ["material_analysis"]);
});

test("official cache and private practice records display material type without mutating input", () => {
  const raw = legacyQuestion();
  const normalized = normalizeOfficialQuestion(raw);
  assert.equal(normalized.type, "material_analysis");
  assert.equal(normalized.typeLabel, "材料分析题");
  assert.equal(raw.type, "appreciation");
  for (const fields of [{ questionType: "作品赏析题" }, { typeCode: "appreciation" }, { questionType: "赏析题" }]) {
    const question = normalizeQuestionForPractice({ id: "private", stem: "分析形象。", ...fields });
    assert.equal(question.type, "material_analysis");
    assert.equal(question.typeLabel, "材料分析题");
    assert.equal(question.answerMode, "text");
    assert.doesNotMatch(question.breadcrumb, /赏析题/);
  }
});

test("mini contribution editor restores legacy type to material instead of defaulting to single choice", (t) => {
  const oldPage = global.Page;
  const oldWx = global.wx;
  t.after(() => { global.Page = oldPage; global.wx = oldWx; });
  global.wx = { getStorageSync: () => "" };
  let definition;
  global.Page = (value) => { definition = value; };
  const modulePath = require.resolve("../apps/miniprogram/pages/contribute/contribute");
  delete require.cache[modulePath];
  require(modulePath);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.restoreAssetDraft({ questionType: "作品赏析题", subjectId: "ancient-literature" });
  assert.equal(page.data.types[page.data.typeIndex], "材料分析题");
  assert.equal(page.data.types.includes("作品赏析题"), false);
});

test("retired type is absent from new admin and practice choices", () => {
  for (const file of ["apps/admin/index.html", "apps/miniprogram/pages/practice/practice.js", "apps/miniprogram/pages/contribute/contribute.js"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /["']appreciation["']|["']作品赏析题["']/);
  }
});

test("API catalog, public questions and assessment picker expose one canonical material type", async (t) => {
  const store = createMemoryQuestionStore([legacyQuestion()]);
  const base = await listen(t, createServer({ questionStore: store, aiConfigStore: createMemoryAiConfigStore() }));
  const before = store.exportState();
  const catalog = await (await fetch(`${base}/api/admin/question-catalog`)).json();
  assert.equal(catalog.questionTypes.some((type) => type.id === "appreciation"), false);
  for (const type of ["material_analysis", "appreciation"]) {
    const result = await (await fetch(`${base}/api/admin/questions?type=${type}`)).json();
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].type, "material_analysis");
  }
  const result = await (await fetch(`${base}/api/questions?library=official`)).json();
  assert.equal(result.questions[0].type, "material_analysis");
  assert.equal(normalizeOfficialQuestion(result.questions[0]).answerMode, "text");
  const modes = await (await fetch(`${base}/api/admin/questions/legacy-appreciation/assessment-modes`)).json();
  assert.equal(modes.options.length, 8);
  assert.deepEqual(store.exportState(), before);
});

test("merged appreciation uses material scoring, with review on request or low confidence only", async (t) => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      calls.push(payload.model);
      const result = { points: [{ id: "style", awardedScore: 4, evidence: ["境界开阔"], missingHints: [] }],
        errors: [], confidence: body.includes("低置信度") && payload.model === "base-model" ? 0.5 : 0.95 };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: payload.model, choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
  });
  const upstreamUrl = await listen(t, upstream);
  const config = createMemoryAiConfigStore({
    providers: [{ id: "score-test", name: "测试", protocol: "openai_chat_completions", baseUrl: upstreamUrl,
      apiKey: "test", models: ["base-model", "review-model"], enabled: true, supportsJsonMode: true, timeoutMs: 5000 }],
    routes: { subjective_scoring: { mode: "provider", providerId: "score-test", model: "base-model", reviewModel: "review-model", confidenceThreshold: 0.75 } },
  });
  const base = await listen(t, createServer({ questionStore: createMemoryQuestionStore([legacyQuestion()]), aiConfigStore: config }));
  for (const payload of [{ answer: "境界开阔" }, { answer: "境界开阔", rescore: true }, { answer: "境界开阔，低置信度测试" }]) {
    const response = await fetch(`${base}/api/ai/score`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: "legacy-appreciation", ...payload }) });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  assert.deepEqual(calls, ["base-model", "review-model", "base-model", "review-model"]);
});
