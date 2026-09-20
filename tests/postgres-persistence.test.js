const assert = require("node:assert/strict");
const test = require("node:test");
const {
  STORE_SPECS,
  createPersistenceController,
  sourceDocument,
  wrapStore,
} = require("../apps/api/src/postgres-persistence");

test("postgres question-family document persists family and member review mutations", () => {
  const spec = STORE_SPECS.find((item) => item.option === "questionFamilyStore");
  assert.ok(spec);
  assert.equal(["replaceState", "detachQuestions", "reviewMember", "createSet", "updateSet", "addSetMembers", "removeSetMember", "removeSet"]
    .every((name) => spec.mutations.includes(name)), true);
  const questionSpec = STORE_SPECS.find((item) => item.option === "questionStore");
  assert.equal(questionSpec.mutations.includes("replaceState"), true);
});

test("postgres persistence serializes writes and flushes the latest snapshot", async () => {
  const persisted = [];
  const controller = createPersistenceController(async (payload) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delay));
    persisted.push(payload.value);
  });
  controller.schedule({ value: 1, delay: 15 });
  controller.schedule({ value: 2, delay: 0 });
  await controller.flush();
  assert.deepEqual(persisted, [1, 2]);
});

test("postgres store wrapper preserves synchronous behavior and schedules mutations", async () => {
  let state = [];
  const writes = [];
  const store = {
    list: () => state.slice(),
    append(value) { state.push(value); return value; },
    exportState: () => state.slice(),
  };
  const controller = createPersistenceController(async (payload) => writes.push(payload));
  const wrapped = wrapStore(store, ["append"], (target) => target.exportState(), controller);
  assert.equal(wrapped.append("a"), "a");
  assert.deepEqual(wrapped.list(), ["a"]);
  await controller.flush();
  assert.deepEqual(writes, [["a"]]);
});

test("postgres store wrapper persists the restored snapshot after a rolled back mutation", async () => {
  let state = ["original"];
  const writes = [];
  const store = {
    append(value) { state.push(value); return value; },
    replaceState(value) { state = value.slice(); return state.slice(); },
    exportState: () => state.slice(),
  };
  const controller = createPersistenceController(async (payload) => writes.push(payload));
  const wrapped = wrapStore(store, ["append", "replaceState"], (target) => target.exportState(), controller);

  wrapped.append("partial");
  wrapped.replaceState(["original"]);
  await controller.flush();

  assert.deepEqual(writes, [["original", "partial"], ["original"]]);
});

test("postgres live documents retain exact bytes and sanitize JSONB nulls", () => {
  const document = sourceDocument({ text: "A\u0000B" });
  assert.equal(document.payloadContainsNull, true);
  assert.equal(document.databasePayload.text, "A\ufffdB");
  assert.equal(JSON.parse(document.sourceBlob.toString("utf8")).text, "A\u0000B");
  assert.equal(document.sourceSha256.length, 64);
});
