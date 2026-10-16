const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../apps/admin/question-review-model");
const { fixture, question, bookId } = require("./helpers/library-completion-fixture");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");

const item = (overrides = {}) => ({ question: question("q", { knowledgeFingerprint: { status: "confirmed", primaryNodeId: "node", primaryNodeLabel: "当前指纹" }, familyMemberships: [{ familyId: "f", familyName: "当前题族", familyStatus: "confirmed", reviewStatus: "confirmed" }] }), ...overrides });

test("six fields prefer stored values and mark different active suggestions without exposing the draft", () => {
  const current = item();
  current.suggestion = { status: "recommended", questionVersion: 1, bookId: "other-book", bookLabel: "建议教材", catalogPath: "建议目录", knowledgePoints: ["建议知识点"] };
  const fields = model.fields(current, id => id === bookId ? "当前教材" : id);
  assert.deepEqual(fields.map(f => f.label), ["题干", "教材", "目录", "指纹", "知识点", "题族"]);
  assert.equal(fields[1].value, "当前教材");
  assert.equal(fields[2].value, current.question.chapter);
  assert.equal(fields[4].value, current.question.knowledgePoints.join("、"));
  for (const i of [1, 2, 4]) assert.equal(fields[i].newSuggestion, true);
  assert.ok(fields.every(f => f.status === "stored"));
  assert.equal(model.initialTab(current), "suggestions");
});

test("missing values show active proposals as unconfirmed, otherwise missing", () => {
  const current = item({ question: question("q", { bookId: "", chapter: "待归类", knowledgePoints: [] }), suggestion: { status: "recommended", questionVersion: 1, bookId, catalogPath: "建议目录", knowledgePoints: ["建议知识点"] } });
  const fields = model.fields(current);
  assert.deepEqual(fields.map(f => f.status), ["stored", "suggested", "suggested", "missing", "suggested", "missing"]);
  assert.ok(fields.every(f => !f.newSuggestion));
});

for (const status of ["applied", "stale", "failed", "rejected", "reverted"]) test(`${status} suggestions are not actionable and do not replace missing or stored values`, () => {
  const current = item({ suggestion: { status, questionVersion: 1, chapterNodeId: "x", catalogPath: "旧建议" } });
  assert.equal(model.activeSuggestion(current), null);
  assert.equal(model.initialTab(current), "details");
  assert.equal(model.fields(current)[2].newSuggestion, false);
});

test("version mismatch is stale even if the raw suggestion says recommended", () => {
  assert.equal(model.initialTab(item({ suggestion: { status: "recommended", questionVersion: 0, catalogPath: "stale" } })), "details");
});

test("fingerprint and family candidates do not count as confirmed and lead to attribution", () => {
  const current = item({ question: question("q", { candidateKnowledgeFingerprint: { status: "suggested", primaryNodeId: "node" }, familyMemberships: [{ familyId: "candidate", familyName: "候选族", reviewStatus: "pending_fit", familyStatus: "candidate" }] }) });
  const fields = model.fields(current);
  assert.equal(fields[3].status, "suggested");
  assert.equal(fields[5].status, "suggested");
  assert.equal(model.initialTab(current), "classification");
  current.suggestion = { status: "recommended", questionVersion: 1, knowledgePoints: ["新的知识点"] };
  assert.equal(model.initialTab(current), "suggestions");
});

test("confirmed membership and pending alternatives retain the confirmed family", () => {
  const current = item();
  current.question.familyMemberships.push({ familyId: "other", familyName: "新候选族", reviewStatus: "pending_fit", familyStatus: "candidate" });
  const field = model.fields(current)[5];
  assert.equal(field.value, "当前题族");
  assert.equal(field.status, "stored");
  assert.equal(field.newSuggestion, true);
  assert.equal(model.initialTab(current), "classification");
});

test("no confirmed fingerprint or no family membership leads to attribution, not automatic writes", () => {
  assert.equal(model.initialTab(item({ question: question("q") })), "classification");
  const current = item();
  current.question.knowledgeFingerprint.primaryNodeId = "";
  assert.equal(model.fields(current)[3].status, "missing");
});

test("identical enrichment content is not a new suggestion even with duplicate labels and metadata", () => {
  const current = item();
  current.question.scoringPoints = [{ description: "知识", score: 2, textbookPage: "3", sourceNote: "已人工确认" }];
  current.suggestion = { status: "recommended", questionVersion: 1, subjectId: current.question.subjectId,
    bookId: current.question.bookId, catalogPath: current.question.chapter,
    knowledgePoints: [...current.question.knowledgePoints, ` ${current.question.knowledgePoints[0]} `],
    scoringPoints: [{ description: "知识", score: "2", textbookPage: "3", sourceNote: "AI 证据" }],
    confidence: 0.99, createdAt: 123, reason: "重复描述" };
  assert.equal(model.activeSuggestion(current), null);
  assert.equal(model.initialTab(current), "details");
  assert.ok(model.fields(current).every(field => !field.newSuggestion));
  current.suggestion.scoringPoints[0].score = 3;
  assert.deepEqual(model.suggestionChanges(current), ["scoring"]);
  assert.equal(model.initialTab(current), "suggestions");
  current.suggestion.scoringPoints[0].score = 2;
  current.suggestion.subjectId = "new-subject";
  assert.deepEqual(model.suggestionChanges(current), ["subject"]);
});

test("empty recommended draft is not actionable", () => {
  const current = item({ suggestion: { status: "recommended", questionVersion: 1, reason: "没有变更" } });
  assert.equal(model.initialTab(current), "details");
});

test("fingerprint equality ignores provenance and set order but retains all semantic changes", () => {
  const current = item();
  const fp = { ...current.question.knowledgeFingerprint, primaryNodeRole: "core", requiredNodeIds: ["node", "other"],
    problemKnowledgeRangeNodeIds: ["node", "other"], knowledgeThemeRangeAnchorNodeId: "root", action: "识别",
    focus: { key: "concept", label: "概念", action: "识别", confidence: 1 },
    optionKnowledge: [{ key: "A", text: "甲", knowledgeRelation: "option_specific", role: "answer", knowledgeNodeIds: ["node"] }] };
  current.question.knowledgeFingerprint = fp;
  const candidate = { ...structuredClone(fp), status: "suggested", source: "ai", confidence: 0.6,
    reviewedBy: "", reviewedAt: 99, revision: 9, primaryNodeLabel: "另一个显示名", requiredNodeIds: ["other", "node", "node"] };
  candidate.focus.confidence = 0.5;
  current.question.candidateKnowledgeFingerprint = candidate;
  assert.equal(model.sameFingerprint(fp, candidate), true);
  assert.equal(model.fields(current)[3].newSuggestion, false);
  assert.equal(model.initialTab(current), "details");
  for (const patch of [{ primaryNodeId: "different" }, { primaryNodeRole: "scope_anchor" }, { requiredNodeIds: ["node"] },
    { problemKnowledgeRangeNodeIds: ["node", "other", "extra"] }, { knowledgeThemeRangeAnchorNodeId: "different" },
    { action: "解释" }, { focus: { key: "different" } }, { optionKnowledge: [] }]) {
    current.question.candidateKnowledgeFingerprint = { ...candidate, ...patch };
    assert.equal(model.fields(current)[3].newSuggestion, true, JSON.stringify(patch));
    assert.equal(model.initialTab(current), "classification");
  }
});

test("candidate matching an existing label still needs explicit fingerprint confirmation", () => {
  const current = item();
  delete current.question.knowledgeFingerprint;
  current.question.candidateKnowledgeFingerprint = { status: "suggested", primaryNodeId: "node", primaryNodeLabel: current.question.knowledgePoints[0] };
  assert.equal(model.fields(current)[3].status, "suggested");
  assert.equal(model.initialTab(current), "classification");
});

test("family additions skip all existing relations without promoting pending reviews", () => {
  const current = item();
  current.question.familyMemberships.push({ familyId: "pending", reviewStatus: "pending_fit" });
  const before = structuredClone(current.question);
  assert.deepEqual(model.familyAdditions(current.question, [{ familyId: "f" }, { familyId: "pending" }, { familyId: "new" }, { familyId: "new" }]), ["new"]);
  assert.deepEqual(current.question, before);
});

for (const scenario of ["confirmed", "pending_fit", "mixed", "read_failure"]) test(`family-only submit rechecks current facts: ${scenario}`, async () => {
  const source = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const start = source.indexOf("async function applyEnrichmentFamilyMembershipOnly(");
  const end = source.indexOf("async function rebuildEnrichmentDeterministic(", start);
  const writes = [], messages = [], locks = [];
  const fresh = item();
  fresh.question.familyMemberships[0].reviewStatus = scenario === "pending_fit" ? scenario : "confirmed";
  const before = JSON.stringify(fresh);
  const context = vm.createContext({ QuestionReviewModel: model, state: { enrichmentClassificationQuestionId: "q", enrichmentClassificationSession: "session" },
    questionReview: { id: "q", item: item({ question: question("q") }), loaded: new Set(["details", "suggestions"]), dirty: true },
    knowledgeInspectionApplyGuard: { begin: () => ({}), isCurrent: () => true, finish: () => true },
    syncEnrichmentFamilyCoverageSummary() {}, enrichmentClassificationFamilyCandidates: () => [],
    setSmallDialogStatus: (_selector, message, tone) => messages.push({ message, tone }),
    setEnrichmentClassificationLocked: value => locks.push(value),
    readQuestionReviewItem: async () => { if (scenario === "read_failure") throw Error("offline"); return fresh; },
    requestJson: async (url, options) => { writes.push({ url, body: JSON.parse(options.body) }); return { addedCount: 1 }; },
    loadQuestionEnrichment: async () => {}, loadQuestionFamilies: async () => {}, loadEnrichmentFamilyCandidates: async () => {},
    renderEnrichmentFamilyChoices() {}, updateEnrichmentClassificationCopy() {}, friendlyError: error => error.message,
  });
  vm.runInContext(source.slice(start, end), context);
  await context.applyEnrichmentFamilyMembershipOnly("q", { familyMemberships: [{ familyId: "f" }, ...(scenario === "mixed" ? [{ familyId: "new" }] : [])] });
  assert.equal(JSON.stringify(fresh), before);
  assert.deepEqual(locks, [true, false]);
  if (scenario === "mixed") {
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "/api/admin/question-families/new/members");
    assert.deepEqual(writes[0].body, { questionIds: ["q"] });
    assert.match(messages.at(-1).message, /跳过 1 个已有关系/);
  } else {
    assert.deepEqual(writes, []);
    assert.match(messages.at(-1).message, scenario === "read_failure" ? /offline/ : /无需重复写入/);
    assert.equal(messages.at(-1).tone, scenario === "read_failure" ? "error" : "success");
  }
});

test("six list fields use two compact blocks with inline status and full text titles", () => {
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../apps/admin/styles.css"), "utf8");
  assert.match(app, /class="enrichment-field-label">\$\{field.label\}：<\/span>/);
  assert.match(app, /class="enrichment-field-value" title="\$\{escapeHtml\(field.value/);
  assert.match(app, /\[\["stem", "chapter", "fingerprint"\], \["book", "knowledge", "family"\]\]/);
  assert.match(css, /\.enrichment-fields\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.enrichment-field-group\s*\{[^}]*min-width: 0/);
  assert.match(css, /\.enrichment-field\s*\{[^}]*display: flex;[^}]*height: 20px/);
  assert.match(css, /\.enrichment-field-value\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
});

test("list offers only the unified entry and its tabs reuse the original forms", () => {
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
  const action = app.slice(app.indexOf("function questionEnrichmentActions("), app.indexOf("async function revertQuestionReviewSuggestion("));
  assert.equal((action.match(/<button/g) || []).length, 1);
  assert.match(action, /查看\/裁决/);
  assert.doesNotMatch(action, /巡检结论|撤回采纳|审核建议/);
  for (const tab of ["suggestions", "classification", "details"]) assert.match(html, new RegExp(`data-question-review-tab="${tab}"`));
  assert.match(app, /session\.item = await readQuestionReviewItem\(session\.id\)/);
  assert.match(app, /questionReviewDiscardChanges/);
  assert.ok(html.indexOf('src="question-review-model.js') < html.indexOf('src="app.js'));
});

test("no inspection result does not attempt a coverage proof when choosing an existing family", () => {
  const source = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const start = source.indexOf("function syncEnrichmentFamilyCoverageSummary(");
  const end = source.indexOf("function enrichmentClassificationSelectionAdjusted(", start);
  const element = { textContent: "", classList: { toggle: (_name, value) => assert.equal(value, false) } };
  const context = vm.createContext({ state: { enrichmentClassificationResult: null }, document: { querySelector: () => element },
    enrichmentClassificationSelection: () => ({ familyMemberships: [{ familyId: "existing" }] }),
    knowledgeInspectionResultId: () => "", enrichmentClassificationCoverageAudit: () => { throw new Error("must not infer coverage without an inspection result"); } });
  vm.runInContext(source.slice(start, end) + "\nsyncEnrichmentFamilyCoverageSummary();", context);
  assert.match(element.textContent, /新增成员仍需审核/);
  assert.doesNotMatch(element.textContent, /覆盖校验通过/);
});

test("missing family candidate produces no coverage nodes instead of throwing", () => {
  const source = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const start = source.indexOf("function knowledgeInspectionFamilyCoverageNodes(");
  const end = source.indexOf("function knowledgeInspectionFamilyCoverageNodeIds(", start);
  const context = vm.createContext({ state: {} });
  assert.equal(vm.runInContext(source.slice(start, end) + "\nknowledgeInspectionFamilyCoverageNodes(null, {}).length;", context), 0);
});

test("exact-question enrichment read includes authoritative fingerprint and membership and cannot mutate stores", async t => {
  const f = fixture({ fingerprints: [{ questionId: "missing-1", primaryNodeId: "merged-meaning", status: "confirmed", requiredNodeIds: ["merged-meaning"] }],
    families: [{ id: "existing", bookId, name: "人工确认题族", knowledgeNodeId: "merged-meaning", status: "confirmed", members: [{ questionId: "missing-1", reviewStatus: "confirmed" }] }] });
  const enrichment = createMemoryQuestionEnrichmentStore();
  enrichment.addSuggestion({ id: "s1", questionId: "missing-1", questionVersion: 1, bookId, catalogPath: "新目录", status: "recommended" });
  const snapshot = () => JSON.stringify([f.questionStore.exportState(), f.knowledgeStructureStore.exportState(), f.questionFamilyStore.exportState(), enrichment.suggestions()]);
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), questionEnrichmentStore: enrichment });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const before = snapshot();
  const payload = await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/question-enrichment?questionId=missing-1`)).json();
  assert.equal(payload.success, true, JSON.stringify(payload));
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].question.id, "missing-1");
  assert.equal(payload.items[0].question.knowledgeFingerprint.status, "confirmed");
  assert.equal(payload.items[0].question.familyMemberships[0].familyName, "人工确认题族");
  const none = await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/question-enrichment?questionId=missing`)).json();
  assert.deepEqual(none.items, []);
  assert.equal(snapshot(), before);
});
