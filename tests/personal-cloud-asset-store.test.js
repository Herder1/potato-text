const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMemoryPersonalCloudAssetStore, createFilePersonalCloudAssetStore, createPersonalCloudAssetStore } = require("../apps/api/src/personal-cloud-asset-store");

const note = (id = "n1", content = "first") => ({ id, type: "note", title: "Note", content, updatedAt: 10 });
const change = (record = note(), extra = {}) => ({ kind: "notes", id: record.id, record, baseRevision: 0, mutationId: "m1", ...extra });

test("personal assets isolate users and an empty device only reads", () => {
  const store = createMemoryPersonalCloudAssetStore();
  store.sync("a", { changes: [change()] });
  const before = store.exportState();
  assert.equal(store.sync("a", {}).library.notes[0].content, "first");
  assert.deepEqual(store.get("b").notes, []);
  assert.deepEqual(store.exportState(), before);
});

test("mutation retry is idempotent even after a later edit", () => {
  const store = createMemoryPersonalCloudAssetStore();
  const first = change();
  const one = store.sync("a", { changes: [first] }).library;
  store.sync("a", { changes: [change(note("n1", "second"), { mutationId: "m2", baseRevision: one.revisions.notes.n1 })] });
  const retried = store.sync("a", { changes: [first] }).library;
  assert.equal(retried.notes[0].content, "second");
  assert.equal(retried.conflicts.length, 0);
  assert.equal(retried.revision, 2);
  assert.throws(() => store.sync("a", { changes: [change(note("n1", "forged"))] }), /mutation_reused/);
});

test("concurrent edits retain both versions instead of timestamp overwriting", () => {
  const store = createMemoryPersonalCloudAssetStore();
  store.sync("a", { changes: [change()] });
  const result = store.sync("a", { changes: [change(note("n1", "offline version"), { mutationId: "m2" })] }).library;
  assert.equal(result.notes[0].content, "first");
  assert.equal(result.conflicts[0].incoming.content, "offline version");
  assert.equal(result.conflicts[0].current.content, "first");
  const conflict = result.conflicts[0];
  assert.throws(() => store.resolve("b", conflict.id, { choice: "incoming", expectedRevision: 1 }), /not_found/);
  assert.throws(() => store.resolve("a", conflict.id, { choice: "incoming", expectedRevision: 0 }), /conflict_changed/);
  const resolved = store.resolve("a", conflict.id, { choice: "incoming", expectedRevision: 1 });
  assert.equal(resolved.notes[0].content, "offline version");
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(store.exportUser("a").library.conflicts[0].resolvedCurrent.content, "first");
});

test("deletion records a tombstone and stale devices cannot resurrect it", () => {
  const store = createMemoryPersonalCloudAssetStore();
  store.sync("a", { changes: [change()] });
  store.sync("a", { changes: [change(note(), { deleted: true, mutationId: "delete", baseRevision: 1 })] });
  const result = store.sync("a", { changes: [change(note("n1", "stale edit"), { mutationId: "stale", baseRevision: 1 })] }).library;
  assert.equal(result.notes.length, 0);
  assert.equal(result.deleted.notes.n1, 2);
  assert.equal(result.conflicts.length, 1);
  const empty = store.sync("a", { changes: [change(note("new"), { deleted: true, mutationId: "delete-new" })] }).library;
  assert.ok(empty.deleted.notes.new);
});

test("stale deletion does not erase a newer version", () => {
  const store = createMemoryPersonalCloudAssetStore();
  store.sync("a", { changes: [change()] });
  const out = store.sync("a", { changes: [change(note(), { deleted: true, mutationId: "stale-delete", baseRevision: 0 })] }).library;
  assert.equal(out.notes.length, 1);
  assert.equal(out.conflicts[0].incomingDeleted, true);
});

test("private pack questions, directories, and complete conversations are preserved without truncation", () => {
  const store = createMemoryPersonalCloudAssetStore();
  const records = {
    packs: { id: "p1", name: "Private", nodes: [{ id: "card", questionId: "q1" }], questionIds: ["q1"] },
    packCategories: { id: "folder", name: "Folder", parentId: "" },
    questions: { id: "q1", type: "question", stem: "Question", referenceAnswer: "Answer", packId: "p1" },
    aiSessions: { id: "chat", aiContent: "AI", messages: Array.from({ length: 150 }, (_, i) => ({ id: `msg-${i}`, role: i % 2 ? "assistant" : "user", text: `message ${i}` })) },
  };
  const changes = Object.entries(records).map(([kind, record]) => change(record, { kind, mutationId: kind }));
  const result = store.sync("a", { changes }).library;
  for (const [kind, record] of Object.entries(records)) assert.deepEqual(result[kind][0], record);
});

test("malformed records and local attachment paths fail atomically", () => {
  const store = createMemoryPersonalCloudAssetStore();
  const before = store.exportState();
  assert.throws(() => store.sync("a", { changes: [change(), change(note("n2", "wxfile://tmp/image.jpg"), { mutationId: "m2" })] }), /local_attachment/);
  assert.deepEqual(store.exportState(), before);
  assert.throws(() => store.sync("a", { changes: [change({ ...note(), id: "__proto__" })] }), /id_invalid/);
  assert.throws(() => store.sync("a", { changes: [change(note(), { baseRevision: -1 })] }), /revision_invalid/);
  assert.throws(() => store.sync("a", { changes: [change({ id: "ai", messages: [{ role: "assistant", text: "partial", streaming: true }] }, { kind: "aiSessions" })] }), /conversation_invalid/);
});

test("file persistence restores after reopening and account deletion removes content and conflict history", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-assets-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "assets.json");
  const store = createFilePersonalCloudAssetStore(filename);
  store.sync("a", { changes: [change()] });
  store.sync("b", { changes: [change(note("b-note"))] });
  const reloaded = createFilePersonalCloudAssetStore(filename);
  assert.equal(reloaded.get("a").notes.length, 1);
  assert.equal(reloaded.deleteUser("a"), true);
  assert.equal(reloaded.get("a").notes.length, 0);
  assert.equal(reloaded.get("b").notes.length, 1);
  fs.writeFileSync(filename, "broken");
  assert.throws(() => reloaded.get("b"));
});

test("failed storage writes do not report successful uploads", () => {
  const store = createPersonalCloudAssetStore({ read: () => ({ users: {} }), write: () => { throw new Error("disk-full"); } });
  assert.throws(() => store.sync("a", { changes: [change()] }), /disk-full/);
});
