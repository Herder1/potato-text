const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { fixture, bookId } = require("./helpers/library-completion-fixture");

async function api(t, f, options = {}) {
  const server = createServer({ ...f.stores, aiConfigStore: createMemoryAiConfigStore(), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (route, body, method = "POST") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/${route}`, body === undefined ? {} : {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("completion API previews without writes, then fills explicitly selected fields only", async (t) => {
  const f = fixture(); const call = await api(t, f);
  const before = f.knowledgeStructureStore.exportState();
  const preview = await call("question-enrichment/completion-preview", { questionIds: ["missing-1"] });
  assert.equal(preview.status, 200);
  assert.deepEqual(f.knowledgeStructureStore.exportState(), before);
  const row = preview.body.rows[0];
  const result = await call("question-enrichment/completion-commit", { items: [{ questionId: row.questionId, token: row.token, fingerprint: true, familyId: "new" }] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.fingerprintsAdded, 1);
  assert.equal(f.knowledgeStructureStore.get(bookId).fingerprints.some((fp) => fp.questionId === "missing-2"), false);
  const again = await call("question-enrichment/completion-commit", { items: [{ questionId: row.questionId, token: row.token, fingerprint: true, familyId: "new" }] });
  assert.equal(again.status, 409);
});

test("mapping API supports many targets and rejects stale writes without changing records", async (t) => {
  const f = fixture(); const call = await api(t, f);
  const before = f.knowledgeStructureStore.get(bookId);
  const current = await call(`knowledge-structure/directories?bookId=${bookId}`);
  const body = { bookId, questionNodeId: "merged-meaning", dossierNodeIds: ["meaning", "standard"], revision: current.body.directories.revision };
  assert.equal((await call("knowledge-structure/directory-mapping", body, "PUT")).status, 200);
  assert.equal((await call("knowledge-structure/directory-mapping", body, "PUT")).status, 409);
  assert.deepEqual(f.knowledgeStructureStore.get(bookId), before);
});

test("missing selected questions produce an explicit error instead of a partial preview", async (t) => {
  const f = fixture(); const call = await api(t, f);
  const response = await call("question-enrichment/completion-preview", { questionIds: ["missing-1", "nonexistent"] });
  assert.equal(response.status, 422);
  assert.equal(response.body.error, "question_not_found");
  assert.equal(f.knowledgeStructureStore.get(bookId).fingerprints.length, 0);
});

test("source-only dossier nodes reach evidence validation even when deleted from working tree", async (t) => {
  const f = fixture();
  const dossier = f.knowledgeDossierStore.save({ bookId, canonicalName: "来源独立档案", definition: "定义", occurrences: [{ nodeId: "meaning", role: "defines" }], status: "draft" });
  const call = await api(t, f);
  const compile = await call("knowledge-dossiers/compile", { bookId, nodeId: "meaning", directory: "source" });
  assert.equal(compile.body.error, "textbook_knowledge_not_built");
  const verify = await call(`knowledge-dossiers/${dossier.id}/verify`, {});
  assert.equal(verify.body.error, "textbook_knowledge_not_built");
});

test("source dossier scope projects legacy working IDs and counts each dossier only once", async (t) => {
  const f = fixture();
  f.knowledgeDossierStore.save({ bookId, canonicalName: "旧节点档案", definition: "定义", occurrences: [{ nodeId: "merged-meaning", role: "defines" }], status: "draft" });
  f.knowledgeDossierStore.save({ bookId, canonicalName: "来源节点档案", definition: "定义", occurrences: [{ nodeId: "meaning", role: "defines" }], status: "draft" });
  const before = f.knowledgeDossierStore.list({ bookId });
  const call = await api(t, f);
  const result = await call(`knowledge-dossiers?bookId=${bookId}&directory=source&nodeId=meaning`);
  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 2);
  assert.equal(result.body.treeSummary.nodeDossierCounts.meaning, 2);
  assert.equal(result.body.treeSummary.nodeDossierCounts.chapter, 2);
  assert.deepEqual(f.knowledgeDossierStore.list({ bookId }), before);
  assert.equal((await call(`knowledge-dossiers?bookId=${bookId}&directory=source&nodeId=fake`)).body.items.length, 0);
});

test("all old bulk regeneration endpoints are disabled and cannot mutate stores", async (t) => {
  const f = fixture(); const call = await api(t, f);
  const before = f.knowledgeStructureStore.exportState();
  for (const route of ["knowledge-structure/generate", "question-families/generate", "question-enrichment/deterministic-rebuild", "question-enrichment/deterministic-rebuild-selection"]) {
    const result = await call(route, { bookId, questionIds: ["missing-1"] });
    assert.equal(result.status, 410);
    assert.equal(result.body.error, "completion_preview_required");
  }
  assert.deepEqual(f.knowledgeStructureStore.exportState(), before);
});

test("batch preview respects batch scope and requires no preexisting pair", async (t) => {
  const f = fixture(); const call = await api(t, f);
  const result = await call("question-enrichment/completion-preview", { importBatchId: "completion-test" });
  assert.equal(result.status, 200);
  assert.equal(result.body.rows.length, 2);
  assert.ok(result.body.rows.every((row) => row.family?.draft));
  assert.equal((await call("question-enrichment/completion-preview", { importBatchId: "absent" })).body.rows.length, 0);
});

test("completion rejects PostgreSQL commits before touching any store", async (t) => {
  const f = fixture(); const call = await api(t, f, { persistence: { flush: async () => {} } });
  const result = await call("question-enrichment/completion-commit", { items: [] });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "completion_postgres_transaction_required");
  assert.equal(f.knowledgeStructureStore.get(bookId).fingerprints.length, 0);
});

test("admin loads mapping module before app and has no regeneration network callers", () => {
  const html = fs.readFileSync(path.join(__dirname, "../apps/admin/index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../apps/admin/app.js"), "utf8");
  assert.ok(html.indexOf('src="library-workspace.js') < html.indexOf('src="app.js'));
  assert.doesNotMatch(html, /id="generate-question-families"/);
  assert.doesNotMatch(app, /requestJson\("\/api\/admin\/(?:knowledge-structure\/generate|question-families\/generate|question-enrichment\/deterministic-rebuild)/);
  const loader = app.slice(app.indexOf("async function loadKnowledgeStructure("), app.indexOf("function loadCurrentQuestionLibraryContent("));
  assert.match(loader, /optional=true/);
  assert.doesNotMatch(loader, /generate=true/);
});
