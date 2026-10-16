const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryPersonalCloudAssetStore } = require("../apps/api/src/personal-cloud-asset-store");
const { STORE_SPECS, createPersistenceController, wrapStore } = require("../apps/api/src/postgres-persistence");
const { PRIMARY_RUNTIME_FILES } = require("../scripts/db/runtime-migration-lib");

test("explicit deletion removes resolved and unresolved private conflict history", () => {
  const store = createMemoryPersonalCloudAssetStore();
  const change = (mutationId, content, baseRevision) => ({ kind: "notes", id: "n", mutationId, baseRevision, record: { id: "n", type: "note", content } });
  store.sync("a", { changes: [change("first", "secret 1", 0)] });
  const result = store.sync("a", { changes: [change("conflict", "secret 2", 0)] });
  store.resolve("a", result.library.conflicts[0].id, { choice: "current", expectedRevision: 1 });
  store.sync("a", { changes: [change("another", "secret 3", 0)] });
  store.sync("a", { changes: [{ kind: "notes", id: "n", mutationId: "delete", baseRevision: 1, deleted: true }] });
  const exported = store.exportUser("a");
  assert.deepEqual(exported.library.notes, []); assert.deepEqual(exported.library.conflicts, []);
  assert.doesNotMatch(JSON.stringify(exported), /secret/);
});

test("choosing a conflicting deletion clears both body and conflict history", () => {
  const store = createMemoryPersonalCloudAssetStore();
  store.sync("a", { changes: [{ kind: "notes", id: "n", mutationId: "one", baseRevision: 0, record: { id: "n", type: "note", content: "secret" } }] });
  const result = store.sync("a", { changes: [{ kind: "notes", id: "n", mutationId: "del", baseRevision: 0, deleted: true }] });
  store.resolve("a", result.library.conflicts[0].id, { choice: "incoming", expectedRevision: 1 });
  assert.deepEqual(store.exportUser("a").library.conflicts, []);
  assert.deepEqual(store.get("a").notes, []);
});

test("PostgreSQL adapter registers cloud mutations and persists exportable snapshots", async () => {
  assert.equal(PRIMARY_RUNTIME_FILES.includes("personal-cloud-assets.json"), true);
  const spec = STORE_SPECS.find((item) => item.option === "personalCloudAssetStore");
  assert.equal(spec.key, "personal-cloud-assets"); assert.deepEqual(spec.mutations, ["sync", "resolve", "deleteUser"]);
  const snapshots = []; const controller = createPersistenceController(async (state) => snapshots.push(state));
  const store = wrapStore(spec.factory(), spec.mutations, (target) => target.exportState(), controller);
  store.sync("a", { changes: [{ kind: "notes", id: "n", mutationId: "one", baseRevision: 0, record: { id: "n", type: "note" } }] });
  await controller.flush(); assert.equal(spec.factory(snapshots[0]).get("a").notes.length, 1);
  store.deleteUser("a"); await controller.flush(); assert.deepEqual(snapshots[1].users, {});
});
