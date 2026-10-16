const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, question, bookId } = require("./helpers/library-completion-fixture");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryQuestionEnrichmentStore } = require("../apps/api/src/question-enrichment-store");

async function setup(t) {
  const chapter = "第一章 绪论 > 第一节 现代汉语 > 一、现代汉语的含义";
  const f = fixture({ questions: [question("same", { chapter }), question("different", { chapter: "" })],
    fingerprints: [{ questionId: "same", status: "confirmed", primaryNodeId: "merged-meaning", requiredNodeIds: ["merged-meaning"] }],
    families: [{ id: "family", bookId, name: "已确认题族", knowledgeNodeId: "merged-meaning", status: "confirmed", members: [{ questionId: "same", reviewStatus: "confirmed" }] }] });
  const enrich = createMemoryQuestionEnrichmentStore();
  for (const id of ["same", "different"]) enrich.addSuggestion({ id: `s-${id}`, questionId: id, questionVersion: 1,
    status: "recommended", subjectId: "modern-chinese", bookId, chapterNodeId: "meaning", catalogPath: chapter,
    knowledgePoints: ["现代汉语的含义"], confidence: 0.95 });
  const audit = createMemoryAdminOperationStore();
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), operationLogStore: audit, questionEnrichmentStore: enrich });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async path => (await fetch(base + path)).json();
  const post = async (path, body) => (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const snapshot = () => JSON.stringify([f.questionStore.exportState(), f.knowledgeStructureStore.exportState(), f.questionFamilyStore.exportState(), enrich.suggestions()]);
  return { f, enrich, base, read, post, snapshot };
}

test("same suggestions remain in history but not actionable counts or recommended filter", async t => {
  const { read, snapshot } = await setup(t);
  const before = snapshot();
  const all = await read("/api/admin/question-enrichment?need=all");
  assert.equal(all.summary.recommended, 1);
  const same = all.items.find(item => item.question.id === "same");
  assert.equal(same.suggestion.status, "recommended");
  assert.equal(same.hasActionableSuggestion, false);
  const filtered = await read("/api/admin/question-enrichment?need=all&suggestionStatus=recommended");
  assert.deepEqual(filtered.items.map(item => item.question.id), ["different"]);
  assert.equal(snapshot(), before);
});

test("explicitly reapplying identical content returns unchanged without writes", async t => {
  const { post, snapshot } = await setup(t);
  const before = snapshot();
  const result = await post("/api/admin/question-enrichment/questions/same/apply", {
    suggestionId: "s-same", fields: { chapter: true, knowledgePoints: true },
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.unchanged, true);
  assert.equal(result.question.version, 1);
  assert.equal(snapshot(), before);
});

test("batch adoption skips identical suggestions and applies real changes only", async t => {
  const { f, enrich, post } = await setup(t);
  const before = JSON.stringify([f.questionStore.get("same"), f.knowledgeStructureStore.exportState(), f.questionFamilyStore.exportState()]);
  const result = await post("/api/admin/question-enrichment/apply-batch", { questionIds: ["same", "different"], confidenceThreshold: 0.85 });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.appliedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(f.questionStore.get("different").version, 2);
  assert.equal(enrich.latest("same").status, "recommended");
  assert.equal(JSON.stringify([f.questionStore.get("same"), f.knowledgeStructureStore.exportState(), f.questionFamilyStore.exportState()]), before);
});

test("shared comparison is served as javascript before the review model", async t => {
  const { base } = await setup(t);
  const asset = await fetch(`${base}/admin/question-enrichment-diff.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(await asset.text(), /QuestionEnrichmentDiff/);
  const html = await (await fetch(`${base}/admin/`)).text();
  assert.ok(html.indexOf('src="question-enrichment-diff.js') < html.indexOf('src="question-review-model.js'));
});
