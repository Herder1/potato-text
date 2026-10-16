const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createMemoryUserAuthStore, createFileUserAuthStore } = require("../apps/api/src/user-auth-store");

test("numeric public IDs are unique, stable, and never replace internal user IDs", () => {
  const store = createMemoryUserAuthStore();
  const first = store.loginWechat({ openid: "first" }).user;
  const second = store.loginWechat({ openid: "second" }).user;
  assert.match(first.publicId, /^[1-9]\d{8}$/);
  assert.match(second.publicId, /^[1-9]\d{8}$/);
  assert.notEqual(first.publicId, second.publicId);
  assert.match(first.id, /^user-/);
  assert.equal(store.resolveUserId(first.publicId), first.id);
  assert.equal(store.resolveUserId(first.id), first.id);
  assert.equal(store.resolveUserId("123456789"), "");
  assert.equal(store.loginWechat({ openid: "first" }).user.publicId, first.publicId);
});

test("old accounts backfill without changing associations; invalid or repeated IDs fail atomically", () => {
  const store = createMemoryUserAuthStore({
    users: [
      { id: "user-old", wechatOpenId: "old", nickname: "Old", createdAt: 1 },
      { id: "user-new", publicId: "123456789", wechatOpenId: "new", nickname: "New", createdAt: 2 },
    ],
    sessions: [{ id: "session-old", userId: "user-old", tokenHash: "test", expiresAt: 999 }],
  });
  assert.equal(store.assignPublicIds().assigned, 1);
  assert.equal(store.assignPublicIds().assigned, 0);
  assert.equal(store.resolveUserId("123456789"), "user-new");
  assert.equal(store.exportState().sessions[0].userId, "user-old");
  assert.equal(store.exportState().users[0].id, "user-old");
  const conflict = createMemoryUserAuthStore({
    users: [{ id: "a", publicId: "123456789" }, { id: "b", publicId: "123456789" }],
    sessions: [],
  });
  assert.throws(() => conflict.assignPublicIds(), /user_public_id_conflict/);
  assert.equal(conflict.exportState().users[1].publicId, "123456789");
});

test("file migration previews, backs up and validates through the Store", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "public-id-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "users.json");
  const initial = { users: [{ id: "user-legacy", nickname: "Legacy" }], sessions: [] };
  fs.writeFileSync(file, JSON.stringify(initial));
  const script = path.resolve(__dirname, "../scripts/migrate-user-public-ids.js");
  execFileSync(process.execPath, [script, "--file", file]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), initial);
  execFileSync(process.execPath, [script, "--file", file, "--write"]);
  const migrated = createFileUserAuthStore(file).exportState();
  assert.match(migrated.users[0].publicId, /^[1-9]\d{8}$/);
  assert.equal(migrated.users[0].id, "user-legacy");
  assert.equal(fs.readdirSync(directory).filter((name) => name.includes(".bak-")).length, 1);
});
