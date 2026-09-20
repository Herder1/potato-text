const test = require("node:test");
const assert = require("node:assert/strict");

test("mini program stores the wechat session and synchronizes learning records", () => {
  let definition;
  const storage = new Map([
    ["shukao_attempts", [{ questionId: "q1", isCorrect: false, createdAt: 100 }]],
  ]);
  const requests = [];
  global.App = (value) => { definition = value; };
  global.wx = {
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    login: ({ success }) => success({ code: "wechat-code" }),
    request(options) {
      requests.push(options);
      if (options.url.endsWith("/api/auth/wechat/login")) {
        options.success({
          statusCode: 200,
          data: {
            token: "session-token",
            expiresAt: Date.now() + 100000,
            authMode: "development",
            user: { id: "user-live", nickname: "微信同学", avatarUrl: "" },
            account: { creditBalance: 5, subscriptions: [], transactions: [] },
          },
        });
        return;
      }
      if (options.url.endsWith("/api/learning/state/sync")) {
        options.success({ statusCode: 200, data: { state: { ...options.data, bookmarks: {}, savedKnowledgeIds: [], scoreHistory: [] } } });
      }
    },
  };
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);

  let result;
  definition.loginWithWechat({ nickName: "微信同学" }, (user, error) => { result = { user, error }; });
  assert.equal(result.error, "");
  assert.equal(result.user.id, "user-live");
  assert.equal(definition.globalData.loggedIn, true);
  assert.equal(definition.globalData.userId, "user-live");
  assert.equal(storage.get("shukao_auth_session").token, "session-token");
  assert.equal(requests.find((request) => request.url.endsWith("/api/learning/state/sync")).data.attempts.length, 1);

  delete global.App;
  delete global.wx;
});
