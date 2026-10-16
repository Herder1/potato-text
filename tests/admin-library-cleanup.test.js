const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createServer } = require("./helpers/admin-auth");
const { fixture, question } = require("./helpers/library-completion-fixture");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");
const { createMemoryKnowledgeClassificationStore } = require("../apps/api/src/knowledge-classification-store");

async function setup(context) {
  const f = fixture({ questions: ["missing-1", "missing-2"].map(id => question(id, { chapter: "", knowledgePoints: [], subKnowledgePoints: [], primaryKnowledgePoint: "" })) });
  const questionEnrichmentStore = createMemoryQuestionEnrichmentStore();
  const knowledgeClassificationStore = createMemoryKnowledgeClassificationStore();
  for (const question of f.questions) questionEnrichmentStore.addSuggestion({
    id: `suggestion-${question.id}`, questionId: question.id, questionVersion: question.version,
    bookId: f.bookId, chapterNodeId: "meaning", knowledgePoints: ["现代汉语的含义"],
    confidence: 0.97, status: "recommended", updatedAt: Date.now(),
  });
  knowledgeClassificationStore.replaceState({ jobs: [], results: [
    { id: "historic-review", questionId: "missing-1", bookId: f.bookId, reviewStatus: "rejected", status: "pending_review", updatedAt: 100 },
  ] });
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), questionEnrichmentStore, knowledgeClassificationStore });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, payload) => {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = () => JSON.stringify({ questions: f.questionStore.list({ status: "all" }),
    structure: f.knowledgeStructureStore.exportState(), families: f.questionFamilyStore.exportState(),
    suggestions: questionEnrichmentStore.suggestions(), reviews: knowledgeClassificationStore.allResults() });
  return { ...f, base, post, snapshot, questionEnrichmentStore, knowledgeClassificationStore };
}

test("removed new library and adjudication routes are inert and preserve reviews and formal data", async context => {
  const f = await setup(context);
  const before = f.snapshot();
  for (const route of ["/api/admin/new-library/status", "/api/admin/new-library/questions", "/api/admin/adjudication/queue", "/api/admin/question-enrichment/deterministic-impact"]) {
    const response = await fetch(f.base + route);
    assert.equal(response.status, 410, route);
  }
  for (const route of ["/api/admin/new-library/clone", "/api/admin/new-library/family", "/api/admin/question-enrichment/deterministic-rebuild", "/api/admin/question-enrichment/deterministic-rebuild-selection"]) {
    assert.equal((await f.post(route, { bookId: f.bookId, questionIds: ["missing-1"], force: true })).status, 410, route);
  }
  assert.equal(f.snapshot(), before);
});

test("batch adoption requires explicit nonempty IDs and never falls back to all suggestions", async context => {
  const f = await setup(context);
  const before = f.snapshot();
  for (const payload of [{}, { questionIds: [] }, { questionIds: "missing-1" }, { questionIds: [""] }]) {
    const response = await f.post("/api/admin/question-enrichment/apply-batch", payload);
    assert.equal(response.status, 422);
    assert.equal(response.body.error, "question_enrichment_selection_required");
    assert.equal(f.snapshot(), before);
  }
  const excessive = await f.post("/api/admin/question-enrichment/apply-batch", { questionIds: Array.from({ length: 101 }, (_, i) => `q-${i}`) });
  assert.equal(excessive.body.error, "question_enrichment_selection_limit");
  assert.equal(f.snapshot(), before);
});

test("batch adoption updates the selected question only and leaves other suggestions and reviews intact", async context => {
  const f = await setup(context);
  const questionFacts = question => {
    const copy = structuredClone(question);
    // These two values are recalculated from the current peer group on reads.
    delete copy.difficultyAssessment.groupSize;
    delete copy.difficultyAssessment.confidence;
    return copy;
  };
  const updatedIds = [];
  const update = f.questionStore.update.bind(f.questionStore);
  f.questionStore.update = (id, ...args) => { updatedIds.push(id); return update(id, ...args); };
  const untouched = questionFacts(f.questionStore.get("missing-2"));
  const otherSuggestion = structuredClone(f.questionEnrichmentStore.latest("missing-2"));
  const reviews = structuredClone(f.knowledgeClassificationStore.allResults());
  const response = await f.post("/api/admin/question-enrichment/apply-batch", { questionIds: ["missing-1", "missing-1"], confidenceThreshold: 0.85 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.appliedCount, 1, JSON.stringify(response.body));
  assert.deepEqual(response.body.results.map(item => item.questionId), ["missing-1"]);
  assert.deepEqual(updatedIds, ["missing-1"]);
  assert.deepEqual(questionFacts(f.questionStore.get("missing-2")), untouched);
  assert.deepEqual(f.questionEnrichmentStore.latest("missing-2"), otherSuggestion);
  assert.deepEqual(f.knowledgeClassificationStore.allResults(), reviews);
});

test("selection-only controls live in the selection bar and obsolete reconstruction dialog is absent", () => {
  const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const selection = html.slice(html.indexOf('id="question-enrichment-selection"'), html.indexOf('class="question-enrichment-table"'));
  for (const id of ["run-selected-question-enrichment", "run-deterministic-selection", "apply-question-enrichment-batch"]) {
    assert.match(selection, new RegExp(`id="${id}"[^>]*disabled`));
  }
  assert.doesNotMatch(html, /id="question-enrichment-deterministic-dialog"|批量重算指纹并生成题族候选/);
  assert.doesNotMatch(app, /refreshEnrichmentDeterministicImpact|enrichmentDeterministicConfirmCode|正在采纳全部高置信度建议/);
  assert.match(app, /async function runQuestionEnrichment\(questionIds = \[\]\)/);
  assert.match(app, /async function runSelectedQuestionEnrichment\(\)/);
});

test("enrichment action labels distinguish the action and its scope without changing the handlers", () => {
  const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const actions = [
    ["run-question-enrichment", "AI 生成建议（筛选结果）", "科目、教材、章节、知识点和得分点", "不受勾选限制"],
    ["run-selected-question-enrichment", "AI 生成建议（勾选题）", "仅为已勾选题目", "人工采纳前不改题"],
    ["run-deterministic-rebuild", "补指纹与题族（选范围）", "另选教材或导入批次", "不覆盖已有内容"],
    ["run-deterministic-selection", "补指纹与题族（勾选题）", "仅预览已勾选题目", "不覆盖已有内容"],
  ];
  for (const [id, label, scope, consequence] of actions) {
    const button = html.match(new RegExp(`<button\\b[^>]*id="${id}"[^>]*>([^<]+)</button>`));
    assert.ok(button, id);
    assert.equal(button[1], label, id);
    assert.ok(button[0].includes(scope), id);
    assert.ok(button[0].includes(consequence), id);
  }
  assert.match(app, /请先勾选题目，再点「补指纹与题族（勾选题）」/);
  assert.match(app, /querySelector\("#run-question-enrichment"\)\.addEventListener\("click", \(\) => runQuestionEnrichment\(\)\)/);
  assert.match(app, /querySelector\("#run-selected-question-enrichment"\)\.addEventListener\("click", runSelectedQuestionEnrichment\)/);
  assert.match(app, /querySelector\("#run-deterministic-rebuild"\)\.addEventListener\("click", openEnrichmentDeterministicDialog\)/);
  assert.match(app, /querySelector\("#run-deterministic-selection"\)\.addEventListener\("click", runEnrichmentDeterministicSelection\)/);
});

test("enrichment polling follows the current library subtab rather than the retired top-level page", () => {
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const source = app.slice(app.indexOf("function stopQuestionEnrichmentPolling()"), app.indexOf("function setQuestionEnrichmentFeedback("));
  let callback, loads = 0, clears = 0;
  const state = { currentView: "题库管理", questionLibrary: "official", questionLibraryTab: "enrichment", questionEnrichmentJobs: [{ status: "running" }] };
  const ctx = vm.createContext({ state, questionEnrichmentRefreshTimer: null, loadQuestionEnrichment: () => loads++,
    setInterval: fn => { callback = fn; return 1; }, clearInterval: () => clears++ });
  vm.runInContext(source, ctx);
  vm.runInContext("syncQuestionEnrichmentPolling()", ctx);
  assert.equal(typeof callback, "function");
  callback(); assert.equal(loads, 1);
  state.questionLibraryTab = "library";
  callback(); assert.equal(loads, 1); assert.equal(clears, 1);
  state.questionLibraryTab = "enrichment";
  state.questionLibrary = "public";
  assert.equal(vm.runInContext("isQuestionEnrichmentActive()", ctx), false);
  state.questionLibrary = "official";
  state.currentView = "工作台";
  assert.equal(vm.runInContext("isQuestionEnrichmentActive()", ctx), false);
});

test("summary keeps detailed counts, highlights subject changes and preserves expanded state", () => {
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const source = app.slice(app.indexOf("function renderQuestionEnrichmentSummary()"), app.indexOf("function renderQuestionEnrichmentBatchFilter()"));
  const host = { innerHTML: "", querySelector: () => ({ open: true }) };
  const state = { questionEnrichmentSummary: { pending: 2, recommended: 1, subject: 1, knowledgeFingerprint: 2, family: 2 } };
  const ctx = vm.createContext({ state, document: { querySelector: () => host }, escapeHtml: value => String(value) });
  vm.runInContext(source + "\nrenderQuestionEnrichmentSummary();", ctx);
  const main = host.innerHTML.split('<details')[0];
  assert.equal((main.match(/question-summary-item/g) || []).length, 5);
  assert.match(main, /建议换科目/);
  assert.match(host.innerHTML, /<details class="enrichment-summary-details" open>/);
  const breakdown = host.innerHTML.split('<div class="enrichment-summary-breakdown">')[1];
  assert.equal((breakdown.match(/class="question-summary-item"/g) || []).length, 7);
  assert.match(breakdown, /<div class="question-summary-item"><span>待建知识指纹<\/span><strong>2<\/strong><\/div>/);
  assert.match(host.innerHTML, /待建知识指纹/);
  assert.match(host.innerHTML, /无题族归属/);
  assert.match(app, /knowledge_fingerprint: "待建知识指纹"/);
  assert.match(app, /family: "无题族归属"/);
});

test("missing-item cards retain zero counts and do not change initial collapse or metric order", () => {
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  const source = app.slice(app.indexOf("function renderQuestionEnrichmentSummary()"), app.indexOf("function renderQuestionEnrichmentBatchFilter()"));
  const host = { innerHTML: "", querySelector: () => null };
  vm.runInNewContext(source + "\nrenderQuestionEnrichmentSummary();", { state: { questionEnrichmentSummary: null }, document: { querySelector: () => host }, escapeHtml: String });
  assert.match(host.innerHTML, /<details class="enrichment-summary-details">/);
  const breakdown = host.innerHTML.split('<div class="enrichment-summary-breakdown">')[1];
  const cards = [...breakdown.matchAll(/<div class="question-summary-item"><span>(.*?)<\/span><strong>(.*?)<\/strong><\/div>/g)];
  assert.deepEqual(cards.map(card => card[1]), ["待定教材", "建议换科目", "待补章节", "待补知识点", "待处理得分点", "待建知识指纹", "无题族归属", "待归类（缺归属）"]);
  assert.ok(cards.every(card => card[2] === "0"));
});

test("missing-item statistics use scoped responsive card styles", () => {
  const css = fs.readFileSync(path.join(__dirname, "../apps/admin/styles.css"), "utf8");
  assert.match(css, /\.enrichment-summary-breakdown\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(130px, 100%\), 1fr\)\)/);
  assert.match(css, /\.enrichment-summary-breakdown \.question-summary-item\s*\{[^}]*min-height: 64px;[^}]*border: 1px solid #dde5e1;[^}]*background: #fff;/);
  assert.match(css, /\.enrichment-summary-breakdown strong\s*\{[^}]*font-size: 20px;/);
});

test("enrichment toolbar keeps search and all filters on one horizontal row", () => {
  const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../apps/admin/styles.css"), "utf8");
  const toolbar = html.slice(html.indexOf('<div class="question-enrichment-toolbar">'), html.indexOf('<div class="question-enrichment-selection"'));
  // 2026-10-12：六个筛选控件统一成勾选式下拉（div.filter-select），筛选行里再没有 <select>；
  // 归类漏斗已删除（能力并入「待完善项」的归属组），只剩搜索框一个 <input>。
  assert.equal((toolbar.match(/<input\b/g) || []).length, 1);
  assert.equal((toolbar.match(/<select\b/g) || []).length, 0);
  assert.deepEqual(
    [...toolbar.matchAll(/<div class="filter-select" id="([^"]+)"/g)].map((match) => match[1]),
    [
      "question-enrichment-subject",
      "question-enrichment-book",
      "question-enrichment-batch",
      "question-enrichment-type",
      "question-enrichment-need",
      "question-enrichment-status",
    ],
  );
  // 一行排布：宽屏不折行（wrap 只在窄屏生效）；工具栏不再是会裁掉勾选浮层的横向滚动容器。
  const toolbarRule = css.slice(css.indexOf(".question-enrichment-toolbar {"), css.indexOf("}", css.indexOf(".question-enrichment-toolbar {")));
  assert.match(toolbarRule, /display: flex;/);
  assert.match(toolbarRule, /flex-wrap: wrap;/);
  assert.doesNotMatch(toolbarRule, /overflow-x/);
  assert.match(css, /\.question-enrichment-toolbar > input\s*\{[^}]*flex: 1 1 210px;/s);
  assert.match(css, /\.filter-select\s*\{[^}]*position: relative;[^}]*flex: 0 0 140px;/s);
  assert.doesNotMatch(css, /\.question-enrichment-toolbar\s*\{[^}]*grid-template-columns/);
  assert.doesNotMatch(css, /\.question-enrichment-toolbar input\s*\{[^}]*grid-column/);
});
