const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { personalCloudSync } = require("../apps/miniprogram/utils/personal-cloud-sync");

function pageFixture(t) {
  const storage = new Map();
  const events = [];
  let status = { queued: 0, conflicts: 0, conflictItems: [], blocked: 0, unowned: 0 };
  let definition;
  const app = { globalData: { loggedIn: true }, personalAssetSyncStatus: () => status,
    syncPersonalAssets: async () => { status = { ...status, queued: 0, lastError: "", lastSyncedAt: 1 }; },
    exportPersonalAssets: async () => ({ schemaVersion: 1, library: { notes: [{ content: "private" }] } }) };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
    showToast: (value) => events.push(["toast", value.title]),
    showModal: (value) => { events.push(["confirm", value.content]); value.success({ confirm: true }); },
    env: { USER_DATA_PATH: "wxfile://usr" },
    shareFileMessage: (value) => { events.push(["share", value.fileName]); value.complete(); },
    getFileSystemManager: () => ({
      writeFile: (value) => { events.push(["write", JSON.parse(value.data)]); value.success(); },
      unlink: (value) => { events.push(["cleanup", value.filePath]); },
    }),
  };
  global.Page = (value) => { definition = value; };
  // 2026-10-02：「隐私与数据」页下线，同步/导出/冲突处理搬到 pages/settings。
  const file = require.resolve("../apps/miniprogram/pages/settings/settings.js"); delete require.cache[file]; require(file);
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
  personalCloudSync().configure({ userId: "alice", token: "alice", baseUrl: "http://127.0.0.1:3212" });
  t.after(() => { personalCloudSync().forget(); delete global.wx; delete global.getApp; delete global.Page; });
  return { page, events, app, setStatus: (value) => { status = { ...status, ...value }; } };
}

test("privacy state never reports synced before success and makes failures and blocked attachments visible", (t) => {
  const { page, setStatus, app } = pageFixture(t);
  page.onShow(); assert.equal(page.data.personalSyncLabel, "尚未完成首次同步");
  setStatus({ lastSyncedAt: 1 }); page.onShow(); assert.equal(page.data.personalSyncLabel, "个人资产已同步");
  setStatus({ lastError: "network_failed", queued: 2, blocked: 1, unowned: 3 }); page.onShow();
  assert.match(page.data.personalSyncLabel, /同步未完成/); assert.equal(page.data.blockedCount, 1); assert.equal(page.data.unownedCount, 3);
  app.globalData.loggedIn = false; page.onShow(); assert.equal(page.data.cloudConflicts.length, 0); assert.equal(page.data.blockedCount, 0);
});

test("privacy retry updates the visible status after the request settles", async (t) => {
  const { page, setStatus } = pageFixture(t); setStatus({ lastError: "offline", queued: 1 }); page.onShow();
  await page.retryPersonalAssets();
  assert.equal(page.data.cloudBusy, false); assert.equal(page.data.personalSyncLabel, "个人资产已同步");
});

test("export requires confirmation, produces private JSON and removes its temporary file", async (t) => {
  const { page, events } = pageFixture(t); page.onShow(); page.exportPersonalAssets();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event[0]), ["confirm", "write", "share", "cleanup"]);
  assert.match(events[0][1], /不包含待同步/);
  assert.equal(events[1][1].library.notes[0].content, "private");
});

test("export shows a real unsupported error rather than a fake success", async (t) => {
  const { page, events } = pageFixture(t); delete global.wx.shareFileMessage; page.onShow(); page.exportPersonalAssets();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event[0] === "write"), false);
  assert.equal(events.some((event) => /不支持/.test(event[1])), true);
});

test("switching account during export never shares the previous user's file", async (t) => {
  const { page, app, events } = pageFixture(t); let finish;
  app.exportPersonalAssets = () => new Promise((resolve) => { finish = resolve; }); page.onShow(); page.exportPersonalAssets();
  personalCloudSync().configure({ userId: "bob", token: "bob", baseUrl: "http://127.0.0.1:3212" });
  finish({ secret: "alice" }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event[0] === "write" || event[0] === "share"), false);
});

test("settings and history controls have real handlers, conditional visibility, and stable keys", () => {
  const markup = fs.readFileSync(require.resolve("../apps/miniprogram/pages/settings/settings.wxml"), "utf8");
  const script = fs.readFileSync(require.resolve("../apps/miniprogram/pages/settings/settings.js"), "utf8");
  assert.match(markup, /disabled="\{\{cloudBusy \|\| !loggedIn\}\}"/);
  assert.match(markup, /wx:if="\{\{blockedCount\}\}"/);
  assert.match(markup, /wx:if="\{\{unownedCount\}\}"/);
  assert.match(markup, /wx:for="\{\{cloudConflicts\}\}" wx:key="id"/);
  assert.doesNotMatch(markup, /\shidden=/);
  for (const name of [...markup.matchAll(/bindtap="(\w+)"/g)].map((m) => m[1])) assert.match(script, new RegExp(`\\b${name}\\(`));
  const history = fs.readFileSync(require.resolve("../apps/miniprogram/pages/practice/practice.wxml"), "utf8");
  const practice = fs.readFileSync(require.resolve("../apps/miniprogram/pages/practice/practice.js"), "utf8");
  assert.match(history, /catchtap="deleteAiSession"/); assert.match(practice, /kind: "aiSessions", id, deleted: true/);
});
