const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryBillingStore } = require("../apps/api/src/billing-store");
const { createMemoryQuestionStore } = require("../apps/api/src/question-store");

async function start(context) {
  const userAuthStore = createMemoryUserAuthStore();
  const { createMemoryPersonalCloudAssetStore } = require("../apps/api/src/personal-cloud-asset-store");
  const personalCloudAssetStore = createMemoryPersonalCloudAssetStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    userAuthStore, personalCloudAssetStore,
    billingStore: createMemoryBillingStore(),
    questionStore: createMemoryQuestionStore([]),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function login(id) {
    const response = await fetch(`${baseUrl}/api/auth/wechat/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: `code-${id}`, deviceId: id }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function call(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    return { status: response.status, body: await response.json() };
  }
  return { login, call, personalCloudAssetStore };
}

test("personal asset API isolates accounts and returns complete export data", async (context) => {
  const { login, call, personalCloudAssetStore } = await start(context);
  const alice = await login("personal-api-alice");
  const bob = await login("personal-api-bob");
  const headers = (token) => ({ Authorization: `Bearer ${token}` });
  const change = {
    kind: "notes", id: "note-api-1", mutationId: "api-m1", baseRevision: 0,
    record: { id: "note-api-1", type: "note", content: "只属于 Alice" },
  };
  const first = await call("/api/personal-assets/sync", {
    method: "POST", headers: headers(alice.token), body: JSON.stringify({ changes: [change] }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.acknowledgements[0].mutationId, "api-m1");
  assert.equal(first.body.library.notes[0].content, "只属于 Alice");

  const duplicate = await call("/api/personal-assets/sync", {
    method: "POST", headers: headers(alice.token), body: JSON.stringify({ changes: [change] }),
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.library.notes.length, 1);

  const bobView = await call("/api/personal-assets", { headers: headers(bob.token) });
  assert.equal(bobView.status, 200);
  assert.deepEqual(bobView.body.library.notes, []);

  const exported = await call("/api/personal-assets/export", { headers: headers(alice.token) });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.export.library.notes[0].content, "只属于 Alice");

  const deleted = await call("/api/account", { method: "DELETE", headers: headers(alice.token) });
  assert.equal(deleted.status, 200);
  const afterDelete = await call("/api/personal-assets", { headers: headers(alice.token) });
  assert.equal(afterDelete.status, 401);
  assert.equal(Object.hasOwn(personalCloudAssetStore.exportState().users, alice.user.id), false);
});

test("personal asset routes reject unauthenticated access and ignore client-supplied owner IDs", async (context) => {
  const { login, call } = await start(context);
  for (const path of ["/api/personal-assets", "/api/personal-assets/export", "/api/personal-assets/sync", "/api/personal-assets/conflicts/x/resolve"]) {
    assert.equal((await call(path, { method: path.endsWith("sync") || path.endsWith("resolve") ? "POST" : "GET" })).status, 401);
  }
  const alice = await login("owner-a"); const bob = await login("owner-b");
  const payload = { userId: alice.user.id, changes: [{ kind: "notes", id: "own", mutationId: "own-1", baseRevision: 0, record: { id: "own", type: "note" } }] };
  assert.equal((await call("/api/personal-assets/sync", { method: "POST", headers: { Authorization: `Bearer ${bob.token}` }, body: JSON.stringify(payload) })).status, 200);
  const a = await call("/api/personal-assets", { headers: { Authorization: `Bearer ${alice.token}` } });
  assert.equal(a.body.library.notes.length, 0);
  const invalid = await call("/api/personal-assets/sync", { method: "POST", headers: { Authorization: `Bearer ${bob.token}` }, body: JSON.stringify({ changes: [{ ...payload.changes[0], id: "toString" }] }) });
  assert.equal(invalid.status, 422);
});

test("personal asset API preserves a concurrent version as a conflict", async (context) => {
  const { login, call } = await start(context);
  const alice = await login("personal-api-conflict");
  const headers = { Authorization: `Bearer ${alice.token}` };
  const create = (content, mutationId, baseRevision) => call("/api/personal-assets/sync", {
    method: "POST", headers, body: JSON.stringify({ changes: [{
      kind: "notes", id: "note-conflict", mutationId, baseRevision,
      record: { id: "note-conflict", type: "note", content },
    }] }),
  });
  assert.equal((await create("base", "c0", 0)).status, 200);
  assert.equal((await create("current", "c1", 1)).status, 200);
  const conflict = await create("incoming", "c2", 1);
  assert.equal(conflict.status, 200);
  assert.equal(conflict.body.library.notes[0].content, "current");
  assert.equal(conflict.body.library.conflicts[0].incoming.content, "incoming");
  const resolved = await call(`/api/personal-assets/conflicts/${encodeURIComponent(conflict.body.library.conflicts[0].id)}/resolve`, {
    method: "POST", headers, body: JSON.stringify({ choice: "incoming", expectedRevision: 2 }),
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.library.notes[0].content, "incoming");
});
