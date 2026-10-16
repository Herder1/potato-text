const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n}", start) + 2;
  return `${source.slice(start - 6, start) === "async " ? "async " : ""}${source.slice(start, end)}`;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: true, inert: false, value: "", innerHTML: "", attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    return elements.get(selector);
  };
  const requests = [];
  const ctx = vm.createContext({
    AbortController, URLSearchParams,
    state: { questionLibraryTab: "library", questionSelectedIds: [], questionFamilySets: [], questionFamilies: [] },
    document: { querySelector: element },
    loadQuestionCatalog: async () => {},
    libraryWorkspace: { needsDirectorySelection: () => false },
    questionWorkspaceFilters: () => ({ bookId: element("#question-book-filter").value || "all" }),
    requestJson(url, options = {}) {
      if (url.includes("import-batches")) return Promise.resolve({ batches: [] });
      const pending = deferred();
      requests.push({ url, signal: options.signal, ...pending });
      return pending.promise;
    },
    renderQuestionImportBatchFilter() {}, renderQuestionSummary() {}, renderQuestionTable() {}, renderQuestionSelection() {},
    renderQuestionFamilySummary() {}, renderKnowledgeTree() {}, renderQuestionFamilyTable() {}, setQuestionFamilyFeedback() {},
    escapeHtml: String, friendlyError: error => error.message,
  });
  for (const name of ["setQuestionWorkspaceLoading", "cancelQuestionWorkspaceLoad", "beginQuestionWorkspaceLoad", "reloadQuestionWorkspaceScope", "loadQuestions", "loadQuestionFamilies"]) {
    vm.runInContext(functionSource(name), ctx);
  }
  return { ctx, element, requests };
}
const familyPayload = id => ({ families: [{ id }], familySets: [], ungroupedQuestions: [], summary: {} });

test("workspace loading is visible before catalog returns and clears on success", async () => {
  const { ctx, element, requests } = harness();
  const catalog = deferred();
  ctx.loadQuestionCatalog = () => catalog.promise;
  const task = ctx.loadQuestionFamilies();
  assert.equal(element("#question-workspace-loading").hidden, false);
  assert.equal(element("#question-family-panel").inert, true);
  assert.equal(requests.length, 0);
  catalog.resolve();
  await tick();
  requests[0].resolve(familyPayload("loaded"));
  await task;
  assert.equal(element("#question-workspace-loading").hidden, true);
  assert.equal(element("#question-family-panel").attributes["aria-busy"], "false");
  assert.equal(element("#question-family-panel").inert, false);
});

for (const mode of ["families", "questions"]) test(`${mode}: late old response cannot overwrite latest results or hide loading`, async () => {
  const { ctx, element, requests } = harness();
  const load = mode === "families" ? ctx.loadQuestionFamilies : ctx.loadQuestions;
  const payload = id => mode === "families" ? familyPayload(id) : { questions: [{ id }], counts: {} };
  const first = load();
  await tick();
  const second = load();
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(payload("old"));
  await first;
  assert.equal(element("#question-workspace-loading").hidden, false);
  requests[1].resolve(payload("latest"));
  await second;
  assert.equal((mode === "families" ? ctx.state.questionFamilies : ctx.state.questions)[0].id, "latest");
  assert.equal(element("#question-workspace-loading").hidden, true);
});

test("switching result modes cancels the previous request even across loaders", async () => {
  const { ctx, element, requests } = harness();
  const families = ctx.loadQuestionFamilies();
  await tick();
  const questions = ctx.loadQuestions();
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ questions: [{ id: "latest" }], counts: {} });
  await questions;
  requests[0].resolve(familyPayload("stale"));
  await families;
  assert.equal(ctx.state.questionFamilies.length, 0);
  assert.equal(ctx.state.questions[0].id, "latest");
  assert.equal(element("#question-workspace-loading").hidden, true);
});

test("catalog failures end loading and show an actionable read error", async () => {
  const { ctx, element } = harness();
  ctx.loadQuestionCatalog = async () => { throw new Error("catalog unavailable"); };
  await ctx.loadQuestionFamilies();
  assert.match(element("#question-family-table-body").innerHTML, /catalog unavailable/);
  assert.equal(element("#question-workspace-loading").hidden, true);
  assert.equal(element("#question-family-panel").inert, false);
});

test("request failure allows a normal subsequent refresh", async () => {
  const { ctx, element, requests } = harness();
  const first = ctx.loadQuestions();
  await tick();
  requests[0].reject(new Error("temporarily unavailable"));
  await first;
  assert.match(element("#question-table-body").innerHTML, /temporarily unavailable/);
  assert.equal(element("#question-list-panel").inert, false);
  const retry = ctx.loadQuestions();
  await tick();
  requests[1].resolve({ questions: [{ id: "recovered" }], counts: {} });
  await retry;
  assert.equal(ctx.state.questions[0].id, "recovered");
  assert.equal(element("#question-workspace-loading").hidden, true);
});

test("changing textbook invalidates results immediately before directory loading finishes", async () => {
  const { ctx, element, requests } = harness();
  const directories = [];
  let loads = 0;
  ctx.loadKnowledgeStructure = () => { const pending = deferred(); directories.push(pending); return pending.promise; };
  ctx.loadCurrentQuestionLibraryContent = async () => { loads++; };
  const firstResults = ctx.loadQuestionFamilies();
  await tick();
  const firstSwitch = ctx.reloadQuestionWorkspaceScope();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(element("#question-workspace-loading").hidden, false);
  const secondSwitch = ctx.reloadQuestionWorkspaceScope();
  requests[0].resolve(familyPayload("stale"));
  await firstResults;
  directories[0].resolve();
  await firstSwitch;
  assert.equal(loads, 0);
  assert.equal(element("#question-workspace-loading").hidden, false);
  directories[1].resolve();
  await secondSwitch;
  assert.equal(loads, 1);
  assert.equal(ctx.state.questionFamilies.length, 0);
  assert.equal(element("#question-workspace-loading").hidden, true);
});

test("background refresh never exposes loading feedback in other library tabs", () => {
  const { ctx, element } = harness();
  ctx.state.questionLibraryTab = "enrichment";
  ctx.beginQuestionWorkspaceLoad();
  assert.equal(element("#question-workspace-loading").hidden, true);
  ctx.cancelQuestionWorkspaceLoad();
  assert.equal(element("#question-family-panel").inert, false);
});

test("unresolved source mappings never silently load all questions", async () => {
  const { ctx, element, requests } = harness();
  ctx.libraryWorkspace.needsDirectorySelection = () => true;
  ctx.state.questions = [{ id: "old" }];
  await ctx.loadQuestions();
  assert.equal(requests.length, 0);
  assert.equal(ctx.state.questions.length, 0);
  assert.equal(ctx.state.questionSourceTreeSummary, null);
  assert.match(element("#question-table-body").innerHTML, /请先选择/);
  assert.equal(element("#question-workspace-loading").hidden, true);
});

test("source counts follow the latest successful response and clear on failure", async () => {
  const { ctx, requests } = harness();
  const first = ctx.loadQuestions();
  await tick();
  requests[0].resolve({ questions: [{ id: "latest" }], counts: {}, treeSummary: { bookId: "book", questionCount: 1 } });
  await first;
  assert.equal(ctx.state.questionSourceTreeSummary.questionCount, 1);
  const retry = ctx.loadQuestions();
  assert.equal(ctx.state.questionSourceTreeSummary, null);
  await tick();
  requests[1].reject(new Error("unavailable"));
  await retry;
  assert.equal(ctx.state.questionSourceTreeSummary, null);
  assert.match(ctx.state.questionSourceTreeError, /读取失败/);
});

test("old backends cannot return unrestricted rows as source-filtered results", async () => {
  const { ctx, element, requests } = harness();
  ctx.questionWorkspaceFilters = () => ({ bookId: "book", directory: "source", sourceNodeId: "selected" });
  ctx.state.questions = [{ id: "previous" }];
  const task = ctx.loadQuestions();
  await tick();
  requests[0].resolve({ questions: [{ id: "unrestricted" }], counts: {} });
  await task;
  assert.equal(ctx.state.questions.length, 0);
  assert.match(element("#question-table-body").innerHTML, /重启后台/);
  assert.equal(element("#question-workspace-loading").hidden, true);
});
