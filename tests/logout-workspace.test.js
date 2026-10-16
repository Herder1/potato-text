const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { applyDataPatch } = require("./helpers/set-data");
const {
  createPersonalCloudSync,
  PERSONAL_DATA_KEYS,
  SCOPE_RETENTION_DAYS,
  SYNCED_SNAPSHOT_RETENTION_DAYS,
  MAX_ACCOUNT_SCOPES,
} = require("../apps/miniprogram/utils/personal-cloud-sync");
const { createSyncStatus } = require("../apps/miniprogram/utils/sync-status");

// 2026-10-03 口径「临时 B、最终混合」（产品负责人 9 条）：本地数据按账号命名空间保存、
// 退出/切换不得立即清空、换账号看不到别人的数据、服务端不可达要标"待同步"、同步成功后按保留期限回收。
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const ACCOUNT = (userId = "alice") => ({ userId, token: userId, environment: "develop", baseUrl: "http://127.0.0.1:3212" });
const LEARNING_KEYS = ["shukao_card_box_sets", "shukao_bookmarks", "shukao_review_states", "shukao_attempts"];

function device(initial = {}, { now = () => Date.now() } = {}) {
  const values = new Map(Object.entries(initial));
  const requests = [];
  const storage = {
    getStorageSync: (key) => clone(values.get(key)),
    setStorageSync: (key, value) => values.set(key, clone(value)),
    removeStorageSync: (key) => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
  };
  const api = createPersonalCloudSync({
    storage, request: (options) => requests.push(options), now,
    setTimeoutFn: () => 1, clearTimeoutFn: () => {},
  });
  const scopeKeyOf = (scope) => `shukao_personal_cloud_scope_${scope}`;
  return {
    storage, api, requests, values,
    get: (key) => values.get(key),
    has: (key) => values.has(key),
    // 注意：storage 桩背后是 Map，Object.keys 对它恒为空——一律走这两个辅助。
    keys: () => [...values.keys()],
    scopeKeys: () => [...values.keys()].filter((key) => key.startsWith("shukao_personal_cloud_scope_")),
    scopeRecord: (scope) => clone(values.get(scopeKeyOf(scope))) || {},
    status: () => createSyncStatus({ storage, now }).summary(),
    /** 把最近一次请求按失败送达（模拟弱网 / 服务端不可达）。 */
    failLastRequest: (message = "request:fail timeout") => {
      const options = requests[requests.length - 1];
      options.fail({ errMsg: message });
    },
    /** 把最近一次请求按 500 送达。 */
    serverErrorLastRequest: () => {
      const options = requests[requests.length - 1];
      options.success({ statusCode: 500, data: { success: false, error: "internal_error" } });
    },
  };
}

test("learning data is namespaced per account: hidden after logout, restored on the same account, invisible to others", () => {
  const d = device();
  d.api.configure(ACCOUNT("alice"));
  d.storage.setStorageSync("shukao_card_box_sets", [{ id: "set-1" }]);
  d.storage.setStorageSync("shukao_bookmarks", [{ questionId: "q1" }]);
  d.storage.setStorageSync("shukao_review_states", { q1: { state: "review" } });
  d.storage.setStorageSync("shukao_attempts", [{ id: "a1", questionId: "q1" }]);

  d.api.configure(null); // 退出登录
  LEARNING_KEYS.forEach((key) => assert.equal(d.has(key), false, `${key} 退出后界面不该还看得见`));

  // 第 3 条：不得立即清空——数据要在 alice 的命名空间里等着
  const aliceScope = d.scopeKeys().find((key) => JSON.stringify(d.values.get(key)).includes("set-1"));
  assert.ok(aliceScope, "alice 的存档必须留在本机（弱网兜底）");

  d.api.configure(ACCOUNT("alice")); // 重登同一账号
  assert.deepEqual(d.get("shukao_card_box_sets"), [{ id: "set-1" }]);
  assert.deepEqual(d.get("shukao_bookmarks"), [{ questionId: "q1" }]);
  assert.deepEqual(d.get("shukao_review_states"), { q1: { state: "review" } });
  assert.deepEqual(d.get("shukao_attempts"), [{ id: "a1", questionId: "q1" }]);

  d.api.configure(ACCOUNT("bob")); // 第 5 条：换账号只能读自己的命名空间
  LEARNING_KEYS.forEach((key) => assert.equal(d.has(key), false, `${key} 不该出现在别的账号下`));
  assert.equal(JSON.stringify([...d.values.values()]).includes("set-1"), true, "但 alice 的存档仍留在本机，没被删");
});

test("content created before login is taken over by that account, not silently dropped", () => {
  const d = device();
  d.storage.setStorageSync("shukao_attempts", [{ id: "guest-1", questionId: "q1" }]);
  d.storage.setStorageSync("shukao_bookmarks", [{ questionId: "q1" }]);
  d.storage.setStorageSync("shukao_bookmark_legacy-1", true);

  d.api.configure(ACCOUNT("alice")); // 学习与复习数据由这个账号接管（口径第 3 条）
  assert.deepEqual(d.get("shukao_attempts"), [{ id: "guest-1", questionId: "q1" }]);
  assert.deepEqual(d.get("shukao_bookmarks"), [{ questionId: "q1" }]);
  assert.equal(d.get("shukao_bookmark_legacy-1"), true, "历史逐题书签也算学习数据");
});

test("personal assets and note drafts are never auto-attributed on login (DEC-106 privacy intent)", () => {
  const d = device();
  d.storage.setStorageSync("shukao_private_packs", [{ id: "legacy-pack" }]);
  d.storage.setStorageSync("shukao_user_assets", [{ id: "private-note", type: "note" }]);
  d.storage.setStorageSync("shukao_note_draft_old", { content: "draft" });
  d.storage.setStorageSync("shukao_beans", 7.5);

  d.api.configure(ACCOUNT("alice"));
  assert.equal(d.has("shukao_private_packs"), false, "题包不静默归属，留在 guest 命名空间等用户确认");
  assert.equal(d.has("shukao_user_assets"), false, "私人资产同理");
  assert.equal(d.has("shukao_note_draft_old"), false, "笔记草稿同理");
  assert.equal(d.has("shukao_beans"), false, "余额镜像以服务端下发为准，不接管");
});

test("the pending local content is offered once, and 归入 moves it without leaving a second copy", () => {
  const d = device();
  d.storage.setStorageSync("shukao_private_packs", [{ id: "legacy-pack" }]);
  d.storage.setStorageSync("shukao_note_draft_old", { content: "draft" });

  d.api.configure(ACCOUNT("alice"));
  const pending = d.api.pendingGuestAdoption();
  assert.equal(pending.count, 2, "题包 1 项 + 草稿 1 项");
  assert.equal(pending.declined, false);

  assert.equal(d.api.adoptGuestWorkspace(), true);
  assert.deepEqual(d.get("shukao_private_packs"), [{ id: "legacy-pack" }]);
  assert.deepEqual(d.get("shukao_note_draft_old"), { content: "draft" });
  assert.equal(d.api.pendingGuestAdoption().count, 0, "归入后 guest 快照不再留副本：一份内容只留一份");
});

test("choosing 留在本机 keeps the content local and stops asking again", () => {
  const d = device();
  d.storage.setStorageSync("shukao_private_packs", [{ id: "legacy-pack" }]);
  d.api.configure(ACCOUNT("alice"));
  assert.equal(d.api.keepGuestWorkspace(), true);
  assert.equal(d.has("shukao_private_packs"), false, "选择留在本机就不归入");

  d.api.configure(null);
  d.api.configure(ACCOUNT("alice"));
  assert.equal(d.api.pendingGuestAdoption().declined, true, "已问过就不再自动问");
  assert.equal(d.has("shukao_private_packs"), false);
});

test("a weak-network logout keeps the snapshot and says 待同步 instead of pretending it synced", async () => {
  const d = device();
  d.api.configure(ACCOUNT("alice"));
  d.storage.setStorageSync("shukao_attempts", [{ id: "a1" }]);
  assert.equal(d.status().label, "已同步", "刚写入还没发起同步时不能凭空说待同步");

  d.api.enqueue({ kind: "packs", record: { id: "p1" } });
  assert.match(d.status().label, /待同步/, "入队即有未送上去的内容");

  const flight = d.api.sync();
  d.failLastRequest("request:fail timeout"); // 服务端不可达
  await flight;

  assert.match(d.status().label, /待同步/, "同步失败后不得显示已同步");
  d.api.configure(null);
  assert.equal(d.has("shukao_attempts"), false, "退出后界面看不到");
  assert.equal(
    d.scopeKeys().some((key) => JSON.stringify(d.values.get(key)).includes("a1")),
    true,
    "本地快照保留，没有被清掉",
  );
});

test("a successful sync clears the pending mark", async () => {
  const d = device();
  d.api.configure(ACCOUNT("alice"));
  d.api.enqueue({ kind: "packs", record: { id: "p1" } });
  const flight = d.api.sync();
  const options = d.requests[d.requests.length - 1];
  options.success({
    statusCode: 200,
    data: {
      success: true,
      acknowledgements: [{ mutationId: options.data.changes[0].mutationId, revision: 1 }],
      library: { packs: [{ id: "p1" }], packCategories: [], questions: [], notes: [], aiSessions: [], revisions: {}, conflicts: [] },
    },
  });
  await flight;
  assert.equal(d.status().label, "已同步");
});

test("server errors also leave the pending mark on", async () => {
  const d = device();
  d.api.configure(ACCOUNT("alice"));
  d.api.enqueue({ kind: "packs", record: { id: "p1" } });
  const flight = d.api.sync();
  d.serverErrorLastRequest();
  await flight;
  assert.match(d.status().label, /待同步/);
});

test("old account namespaces are reclaimed by retention, and synced snapshots are dropped first", () => {
  const day = 24 * 60 * 60 * 1000;
  const base = Date.parse("2026-10-03T10:00:00+08:00");
  const now = () => base;
  const staleScope = "stale-account";
  const syncedScope = "synced-account";
  const d = device({
    [`shukao_personal_cloud_scope_${staleScope}`]: {
      queue: [], revisions: {}, conflicts: [], lastSyncedAt: 0,
      lastUsedAt: base - (SCOPE_RETENTION_DAYS + 1) * day,
      workspace: { shukao_attempts: [{ id: "old" }] },
    },
    [`shukao_personal_cloud_scope_${syncedScope}`]: {
      queue: [], revisions: {}, conflicts: [], lastSyncedAt: base - 2 * day,
      lastUsedAt: base - (SYNCED_SNAPSHOT_RETENTION_DAYS + 1) * day,
      workspace: { shukao_attempts: [{ id: "synced" }] },
    },
  }, { now });

  d.api.configure(ACCOUNT("alice")); // 触发回收
  assert.equal(d.has(`shukao_personal_cloud_scope_${staleScope}`), false, `超过 ${SCOPE_RETENTION_DAYS} 天未用的账号整条回收`);
  assert.equal(d.has(`shukao_personal_cloud_scope_${syncedScope}`), true, "已同步账号只丢存档、留簿记");
  assert.deepEqual(d.scopeRecord(syncedScope).workspace, {}, "已确认同步的存档先被回收");
});

test("a device keeps only the most recent account namespaces", () => {
  const day = 24 * 60 * 60 * 1000;
  const base = Date.parse("2026-10-03T10:00:00+08:00");
  const initial = {};
  for (let index = 0; index < MAX_ACCOUNT_SCOPES + 2; index += 1) {
    initial[`shukao_personal_cloud_scope_old-${index}`] = {
      queue: [], revisions: {}, conflicts: [], lastSyncedAt: 0,
      lastUsedAt: base - (index + 1) * day, workspace: { shukao_attempts: [{ id: `old-${index}` }] },
    };
  }
  const d = device(initial, { now: () => base });
  d.api.configure(ACCOUNT("alice"));
  const remaining = d.keys().filter((key) => key.startsWith("shukao_personal_cloud_scope_old-"));
  assert.equal(remaining.length, MAX_ACCOUNT_SCOPES, `最多保留 ${MAX_ACCOUNT_SCOPES} 个账号的存档`);
  assert.equal(d.has("shukao_personal_cloud_scope_old-0"), true, "最近用过的账号保留");
  assert.equal(d.has("shukao_personal_cloud_scope_old-3"), false, "最旧的先被回收");
});

test("logging out never wipes local learning data, only the session and the in-memory bean mirror", () => {
  const values = new Map([
    ["shukao_card_box_sets", [{ id: "set-1" }]],
    ["shukao_attempts", [{ id: "a1" }]],
    ["shukao_beans", 7.5],
    ["shukao_auth_session", { token: "t" }],
  ]);
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => (values.has(key) ? values.get(key) : ""),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);
  const app = { ...definition, globalData: structuredClone(definition.globalData) };
  try {
    app.globalData.authToken = "token";
    app.globalData.loggedIn = true;
    app.globalData.beans = 7.5;
    app.clearAuthSession();
    assert.equal(app.globalData.beans, 2, "内存里的豆币镜像复位，不显示上一个账号的余额");
    assert.equal(app.globalData.loggedIn, false);
    assert.equal(values.has("shukao_auth_session"), false, "会话要清掉");
    // 口径第 3 条：本地学习数据不得被立即清空（它们由账号命名空间接管）
    assert.equal(values.has("shukao_card_box_sets"), true, "卡集不能被退出登录删掉");
    assert.equal(values.has("shukao_attempts"), true, "学习记录不能被退出登录删掉");
    assert.equal(values.has("shukao_beans"), true, "豆币缓存随命名空间存档，不是直接删");
  } finally {
    delete global.App;
    delete global.wx;
  }
});

test("logging out from the settings page goes straight back to the registration gate", () => {
  const calls = { modal: null, reLaunch: [], toast: [] };
  let definition;
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ logout: (callback) => callback() });
  global.wx = {
    showModal: (options) => { calls.modal = options; options.success({ confirm: true }); },
    reLaunch: ({ url }) => calls.reLaunch.push(url),
    showToast: ({ title }) => calls.toast.push(title),
  };
  const pagePath = path.join(__dirname, "..", "apps", "miniprogram", "pages", "settings", "settings.js");
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) { applyDataPatch(this.data, patch); if (callback) callback(); };
  try {
    page.logoutAccount();
    assert.deepEqual(calls.reLaunch, ["/pages/onboarding/onboarding"], "退出登录要直接回引导页");
    assert.deepEqual(calls.toast, [], "跳走之后不再弹一个会被销毁的 toast");
    assert.doesNotMatch(calls.modal.content, /保留的学习数据不会删除/);
    assert.match(calls.modal.content, /不再显示/);
  } finally {
    delete global.Page;
    delete global.getApp;
    delete global.wx;
  }
});

test("the app asks once on login and honors 归入当前账号", () => {
  const values = new Map();
  const modals = [];
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => (values.has(key) ? values.get(key) : ""),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
    showModal: (options) => { modals.push(options); options.success({ confirm: true }); },
    showToast: () => {},
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);
  const app = { ...definition, globalData: structuredClone(definition.globalData) };
  const sync = require("../apps/miniprogram/utils/personal-cloud-sync").personalCloudSync();
  try {
    // 未登录期间建了一个题包
    global.wx.setStorageSync("shukao_private_packs", [{ id: "p1" }]);
    // 登录：切到 alice 的命名空间，题包先不归属
    sync.configure({ userId: "alice", token: "a", environment: "develop", baseUrl: "http://127.0.0.1:3212" });
    assert.equal(global.wx.getStorageSync("shukao_private_packs"), "", "登录瞬间不静默归属");

    assert.equal(app.settleGuestWorkspace(), true, "有待归属内容时要问一次");
    assert.equal(modals.length, 1);
    assert.equal(modals[0].title, "本机有内容未归属");
    assert.match(modals[0].content, /1 项/);
    assert.equal(modals[0].confirmText, "归入当前账号");
    assert.equal(modals[0].cancelText, "留在本机");
    assert.deepEqual(global.wx.getStorageSync("shukao_private_packs"), [{ id: "p1" }], "选归入后内容进当前账号");
  } finally {
    sync.forget();
    delete require.cache[appPath];
    delete global.App;
    delete global.wx;
  }
});

test("the app stays quiet when there is nothing unowned, and remembers 留在本机", () => {
  const values = new Map();
  const modals = [];
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => (values.has(key) ? values.get(key) : ""),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
    getStorageInfoSync: () => ({ keys: [...values.keys()] }),
    showModal: (options) => { modals.push(options); options.success({ confirm: false }); },
    showToast: () => {},
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);
  const app = { ...definition, globalData: structuredClone(definition.globalData) };
  const sync = require("../apps/miniprogram/utils/personal-cloud-sync").personalCloudSync();
  try {
    assert.equal(app.settleGuestWorkspace(), false, "没有未归属内容时一个字都不问");
    assert.equal(modals.length, 0);

    global.wx.setStorageSync("shukao_private_packs", [{ id: "p1" }]);
    sync.configure({ userId: "alice", token: "a", environment: "develop", baseUrl: "http://127.0.0.1:3212" });
    app.settleGuestWorkspace();
    assert.equal(modals.length, 1, "第一次问");
    assert.equal(global.wx.getStorageSync("shukao_private_packs"), "", "选了留在本机就不归入");

    sync.configure(null);
    sync.configure({ userId: "alice", token: "a", environment: "develop", baseUrl: "http://127.0.0.1:3212" });
    app.settleGuestWorkspace();
    assert.equal(modals.length, 1, "同一份未归属内容不再重复打扰");
  } finally {
    sync.forget();
    delete require.cache[appPath];
    delete global.App;
    delete global.wx;
  }
});

test("every learning key is in the per-account namespace list", () => {
  LEARNING_KEYS.forEach((key) => assert.ok(PERSONAL_DATA_KEYS.includes(key), `${key} 必须在按账号命名空间存档的清单里`));
});
