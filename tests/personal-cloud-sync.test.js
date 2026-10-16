const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryPersonalCloudAssetStore } = require("../apps/api/src/personal-cloud-asset-store");
const { createPersonalCloudSync } = require("../apps/miniprogram/utils/personal-cloud-sync");
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const context = (userId = "alice", environment = "develop") => ({ userId, token: userId, environment, baseUrl: "http://127.0.0.1:3212" });
const keys = { packs: "shukao_private_packs", packCategories: "shukao_private_pack_categories", questions: "shukao_user_assets", notes: "shukao_user_assets", aiSessions: "shukao_ai_history" };

function device(server, initial = {}) {
  const values = new Map(Object.entries(initial));
  const requests = [];
  const timers = new Map();
  let sequence = 0;
  const storage = {
    getStorageSync: (key) => clone(values.get(key)),
    setStorageSync: (key, value) => values.set(key, clone(value)),
    removeStorageSync: (key) => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
  };
  const api = createPersonalCloudSync({ storage, request: (options) => requests.push(options),
    setTimeoutFn: (fn) => { timers.set(++sequence, fn); return sequence; }, clearTimeoutFn: (id) => timers.delete(id) });
  function response(options) {
    const user = options.header.Authorization.replace("Bearer ", "");
    if (options.url.endsWith("/sync")) return { success: true, ...server.sync(user, options.data) };
    if (options.url.endsWith("/export")) return { success: true, export: server.exportUser(user) };
    const id = decodeURIComponent(options.url.split("/").slice(-2)[0]);
    return { success: true, library: server.resolve(user, id, options.data) };
  }
  function deliver(options = requests[requests.length - 1], payload) {
    options.success({ statusCode: 200, data: payload || response(options) });
  }
  function put(kind, record) {
    const list = storage.getStorageSync(keys[kind]) || [];
    storage.setStorageSync(keys[kind], list.filter((item) => item.id !== record.id).concat(record));
    api.enqueue({ kind, record });
  }
  function remove(kind, id) {
    storage.setStorageSync(keys[kind], (storage.getStorageSync(keys[kind]) || []).filter((item) => item.id !== id));
    api.enqueue({ kind, id, deleted: true });
  }
  async function sync() { const result = api.sync(); deliver(); return result; }
  return { api, storage, requests, timers, put, remove, response, deliver, sync };
}

test("message read IDs and badge are local account-scoped data, restored on return and hidden after logout", () => {
  const d = device(createMemoryPersonalCloudAssetStore());
  d.api.configure(context("alice"));
  d.storage.setStorageSync("shukao_message_read_ids", ["feedback:alice:take:1"]);
  d.storage.setStorageSync("shukao_unread_notification_count", 2);
  d.api.configure(context("bob"));
  assert.equal(d.storage.getStorageSync("shukao_message_read_ids"), undefined);
  assert.equal(d.storage.getStorageSync("shukao_unread_notification_count"), undefined);
  d.api.configure(context("alice"));
  assert.deepEqual(d.storage.getStorageSync("shukao_message_read_ids"), ["feedback:alice:take:1"]);
  assert.equal(d.storage.getStorageSync("shukao_unread_notification_count"), 2);
  d.api.configure(null);
  assert.equal(d.storage.getStorageSync("shukao_message_read_ids"), undefined);
});

test("new device restores complete private content without uploading empty-library deletions", async () => {
  const server = createMemoryPersonalCloudAssetStore();
  const first = device(server); first.api.configure(context());
  first.put("questions", { id: "q1", type: "question", stem: "完整题干", referenceAnswer: "完整答案" });
  first.put("packs", { id: "p1", questionIds: ["q1"], nodes: [{ id: "n1", questionId: "q1" }] });
  first.put("notes", { id: "n1", type: "note", content: "私密笔记" });
  first.put("aiSessions", { id: "a1", messages: [{ role: "user", text: "为什么" }, { role: "assistant", text: "解释" }] });
  await first.sync();
  assert.equal(first.api.status().queued, 0);
  const second = device(server); second.api.configure(context());
  await second.sync();
  assert.deepEqual(second.requests[0].data.changes, []);
  assert.equal(second.storage.getStorageSync(keys.questions).find((item) => item.id === "q1").referenceAnswer, "完整答案");
  assert.equal(second.storage.getStorageSync(keys.aiSessions)[0].messages.length, 2);
  assert.deepEqual(second.storage.getStorageSync(keys.packs)[0].questionIds, ["q1"]);
});

test("updates use acknowledged revisions and do not create self-conflicts", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note", content: "one" }); await d.sync();
  d.put("notes", { id: "n", type: "note", content: "two" }); await d.sync();
  assert.equal(server.get("alice").notes[0].content, "two");
  assert.equal(server.get("alice").conflicts.length, 0);
  assert.equal(d.requests[1].data.changes[0].baseRevision, 1);
});

test("editing during upload preserves the new local edit and then uploads it", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note", content: "one" });
  const pending = d.api.sync();
  d.put("notes", { id: "n", type: "note", content: "two" });
  d.deliver(); await pending;
  assert.equal(d.storage.getStorageSync(keys.notes)[0].content, "two");
  assert.equal(d.api.status().queued, 1);
  await d.sync();
  assert.equal(server.get("alice").notes[0].content, "two");
  assert.equal(server.get("alice").conflicts.length, 0);
});

test("lost response retries the same mutation even after another local edit", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note", content: "one" });
  const lost = d.api.sync(); const original = d.requests[0]; d.response(original);
  original.fail({ errMsg: "offline" }); await lost;
  d.put("notes", { id: "n", type: "note", content: "two" });
  await d.sync();
  assert.deepEqual(d.requests[1].data, original.data);
  await d.sync();
  assert.equal(server.get("alice").notes[0].content, "two");
  assert.equal(server.get("alice").revision, 2);
});

test("retry receipt cannot rebase a later edit over another device's unseen change", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const a = device(server); const b = device(server);
  a.api.configure(context()); b.api.configure(context());
  a.put("notes", { id: "n", type: "note", content: "one" });
  const lost = a.api.sync(); a.response(a.requests[0]); a.requests[0].fail({}); await lost;
  await b.sync(); b.put("notes", { id: "n", type: "note", content: "remote" }); await b.sync();
  a.put("notes", { id: "n", type: "note", content: "offline" }); await a.sync(); await a.sync();
  assert.equal(server.get("alice").notes[0].content, "remote");
  assert.equal(server.get("alice").conflicts[0].incoming.content, "offline");
  assert.equal(a.storage.getStorageSync(keys.notes)[0].content, "offline");
});

test("explicit deletion propagates while an empty local cache does not imply deletion", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const a = device(server); const b = device(server);
  a.api.configure(context()); b.api.configure(context()); a.put("notes", { id: "n", type: "note" }); await a.sync(); await b.sync();
  b.storage.removeStorageSync(keys.notes); await b.sync();
  assert.equal(b.storage.getStorageSync(keys.notes).length, 1);
  a.remove("notes", "n"); await a.sync(); await b.sync();
  assert.equal(b.storage.getStorageSync(keys.notes).length, 0);
  assert.equal(Object.hasOwn(server.get("alice").deleted.notes, "n"), true);
});

test("deleting during upload cannot be resurrected by its earlier response", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note" }); const sending = d.api.sync(); d.remove("notes", "n"); d.deliver(); await sending;
  assert.equal(d.storage.getStorageSync(keys.notes).length, 0); await d.sync(); assert.equal(server.get("alice").notes.length, 0);
});

test("guest legacy data and draft keys are isolated without automatic account attribution", async () => {
  const server = createMemoryPersonalCloudAssetStore();
  const d = device(server, { shukao_packs: [{ id: "legacy" }], shukao_user_assets: [{ id: "private", type: "note" }], shukao_note_draft_old: { content: "draft" } });
  d.api.configure(context());
  assert.equal(d.storage.getStorageSync("shukao_packs"), undefined);
  assert.equal(d.storage.getStorageSync("shukao_note_draft_old"), undefined);
  assert.equal(d.storage.getStorageSync("shukao_private_packs_migrated_v1"), true);
  await d.sync(); assert.equal(server.get("alice").notes.length, 0);
  assert.equal(d.api.status().unowned, 1);
  d.api.configure(null);
  assert.equal(d.storage.getStorageSync(keys.notes)[0].id, "private");
  assert.equal(d.storage.getStorageSync("shukao_note_draft_old").content, "draft");
});

test("account switch rejects late responses and restores each user's pending queue", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note", content: "A" }); const pending = d.api.sync(); const oldRequest = d.requests[0];
  d.api.configure(context("bob")); d.put("notes", { id: "b", type: "note", content: "B" });
  d.deliver(oldRequest); await pending;
  assert.deepEqual(d.storage.getStorageSync(keys.notes).map((item) => item.id), ["b"]);
  await d.sync(); assert.equal(server.get("bob").notes[0].content, "B");
  d.api.configure(context()); assert.equal(d.storage.getStorageSync(keys.notes)[0].content, "A");
  await d.sync(); assert.equal(d.api.status().queued, 0);
});

test("environment and server URL isolate local queues even when user IDs match", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note" }); d.api.configure(context("alice", "release"));
  assert.equal(d.api.status().queued, 0); assert.equal(d.storage.getStorageSync(keys.notes), undefined);
  d.api.configure({ ...context(), baseUrl: "https://other.example" }); assert.equal(d.api.status().queued, 0);
  d.api.configure(context()); assert.equal(d.api.status().queued, 1);
});

test("unsupported local attachments remain pending without blocking text records", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "image", type: "note", images: ["wxfile://local.png"] });
  d.put("notes", { id: "text", type: "note", content: "text" }); await d.sync();
  assert.deepEqual(server.get("alice").notes.map((item) => item.id), ["text"]);
  assert.equal(d.api.status().blocked, 1); assert.equal(d.api.status().queued, 1);
  assert.equal(d.storage.getStorageSync(keys.notes).length, 2); assert.equal(d.timers.size, 0);
});

test("two-device conflicts preserve both versions until explicit choice; export includes history", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const a = device(server); const b = device(server);
  a.api.configure(context()); b.api.configure(context()); a.put("notes", { id: "n", type: "note", content: "base" }); await a.sync(); await b.sync();
  a.put("notes", { id: "n", type: "note", content: "A" }); b.put("notes", { id: "n", type: "note", content: "B" });
  await a.sync(); await b.sync();
  const conflict = b.api.status().conflictItems[0];
  assert.equal(b.storage.getStorageSync(keys.notes)[0].content, "B");
  const resolving = b.api.resolveConflict(conflict.id, "incoming"); b.deliver(); await resolving;
  assert.equal(b.api.status().conflicts, 0); assert.equal(server.get("alice").notes[0].content, "B");
  const exporting = b.api.exportAssets(); b.deliver(); const exported = await exporting;
  assert.equal(exported.library.conflicts[0].resolvedCurrent.content, "A");
});

test("large queues are split without truncation and double sync uses one request", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  for (let i = 0; i < 105; i++) d.put("notes", { id: `n-${i}`, type: "note" });
  const one = d.api.sync(); assert.equal(d.api.sync(), one); d.deliver(); await one;
  assert.equal(d.requests.length, 1); assert.equal(d.api.status().queued, 5);
  await d.sync(); assert.equal(server.get("alice").notes.length, 105);
});

test("malformed response does not acknowledge pending data", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "n", type: "note" }); const pending = d.api.sync();
  d.deliver(undefined, { success: true, library: {} }); assert.equal(await pending, null);
  assert.equal(d.api.status().queued, 1); assert.equal(d.storage.getStorageSync(keys.notes).length, 1);
});

test("cold restart restores an immutable queue before retrying", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const first = device(server); first.api.configure(context());
  first.put("notes", { id: "n", type: "note", content: "kept" });
  const pending = first.api.sync(); first.requests[0].fail({}); await pending;
  const restored = device(server, Object.fromEntries(first.storage.getStorageInfoSync().keys.map((key) => [key, first.storage.getStorageSync(key)])));
  restored.api.configure(context()); await restored.sync();
  assert.deepEqual(restored.requests[0].data, first.requests[0].data);
  assert.equal(server.get("alice").notes[0].content, "kept");
});

test("fresh device reads current content even when another device has unresolved conflicts", async () => {
  const server = createMemoryPersonalCloudAssetStore();
  server.sync("alice", { changes: [{ kind: "notes", id: "n", mutationId: "one", baseRevision: 0, record: { id: "n", type: "note", content: "current" } }] });
  server.sync("alice", { changes: [{ kind: "notes", id: "n", mutationId: "two", baseRevision: 0, record: { id: "n", type: "note", content: "incoming" } }] });
  const d = device(server); d.api.configure(context()); await d.sync();
  assert.equal(d.storage.getStorageSync(keys.notes)[0].content, "current");
  assert.equal(d.api.status().conflicts, 1);
  const resolving = d.api.resolveConflict(d.api.status().conflictItems[0].id, "current");
  assert.equal(d.api.sync(), resolving); d.deliver(); await resolving;
  assert.equal(d.api.status().conflicts, 0);
});

test("oversized records remain pending while small records sync", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "big", type: "note", content: "x".repeat(2 * 1024 * 1024) });
  d.put("notes", { id: "small", type: "note", content: "ok" }); await d.sync();
  assert.equal(d.api.status().blocked, 1);
  assert.deepEqual(server.get("alice").notes.map((item) => item.id), ["small"]);
});

test("unfinished notes stay local and upload only after explicit completion", async () => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server); d.api.configure(context());
  d.put("notes", { id: "draft", type: "note", moderationStatus: "draft", content: "unfinished" });
  await d.sync();
  assert.equal(server.get("alice").notes.length, 0);
  assert.equal(d.api.status().drafts, 1); assert.equal(d.api.status().blocked, 0);
  assert.equal(d.storage.getStorageSync(keys.notes)[0].content, "unfinished");
  d.put("notes", { id: "draft", type: "note", moderationStatus: "private", content: "finished" });
  await d.sync();
  assert.equal(server.get("alice").notes[0].content, "finished");
  assert.equal(d.api.status().drafts, 0);
});

test("real local stores enqueue private packs, categories, notes, and explicit deletions", async (t) => {
  const server = createMemoryPersonalCloudAssetStore(); const d = device(server);
  global.wx = { ...d.storage, request: (options) => {
    const result = server.sync("alice", options.data);
    options.success({ statusCode: 200, data: { success: true, ...result } });
  } };
  const { personalCloudSync } = require("../apps/miniprogram/utils/personal-cloud-sync");
  const sync = personalCloudSync(); sync.configure(context());
  t.after(() => { sync.forget(); delete global.wx; });
  const packs = require("../apps/miniprogram/utils/private-pack-store");
  const assets = require("../apps/miniprogram/utils/asset-store");
  const category = packs.createPrivatePackCategory("chapter");
  const pack = packs.createPrivatePack({ name: "private", categoryId: category.id });
  const note = assets.saveAsset({ type: "note", content: "text" });
  assert.equal(sync.status().queued, 3); await sync.sync();
  assert.equal(server.get("alice").packs[0].id, pack.id);
  packs.renamePrivatePackCategory(category.id, "renamed");
  packs.deletePrivatePackCategory(category.id); packs.deletePrivatePack(pack.id); assets.deleteAsset(note.id);
  await sync.sync();
  assert.equal(server.get("alice").packs.length, 0);
  assert.equal(server.get("alice").packCategories.length, 0);
  assert.equal(server.get("alice").notes.length, 0);
});
