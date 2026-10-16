const test = require("node:test");
const assert = require("node:assert/strict");

const platformContent = require("../apps/miniprogram/utils/platform-content");

// 2026-10-05（DEC-110）：平台文本用户端读取口径的契约测试。
// 这一层是"末页不写死正文"的兜底：只有服务端说"已发布"才给正文，其余一律如实说明。
const published = (document = {}) => ({
  statusCode: 200,
  data: {
    success: true,
    published: true,
    document: { key: "terms", title: "用户协议", version: "1.2", effectiveDate: "2026-10-01", body: "第一条 总则\n\n第二条 账号", ...document },
  },
});

test("registered documents keep the seven DEC-110 keys and each one's entry copy", () => {
  const docs = platformContent.docList();
  assert.deepEqual(docs.map((doc) => doc.key), [
    "terms", "privacy", "ai-service", "refund", "account-deletion", "operator", "personal-info",
  ]);
  for (const doc of docs) {
    assert.match(doc.title, /\S/, `${doc.key} 要有中文标题`);
    assert.match(doc.desc, /\S/, `${doc.key} 要有入口说明`);
    assert.match(doc.icon, /^\/assets\/icons\/[a-z0-9-]+\.svg$/, `${doc.key} 的图标要指向仓库里的 svg`);
  }
  assert.equal(platformContent.findDoc("privacy").title, "隐私政策");
  assert.equal(platformContent.findDoc("license"), null, "营业执照已并入运营主体，不再是独立 key");
  assert.equal(platformContent.docList()[0].key, "terms", "列表第一份是未知 doc 的回落目标");
  // 调用方拿到的是副本，改它不会污染登记表
  platformContent.docList()[0].title = "被改过了";
  assert.equal(platformContent.findDoc("terms").title, "用户协议");
});

test("version line and paragraph splitting cover the shapes the server can return", () => {
  assert.equal(platformContent.versionLabel({ version: "1.2", effectiveDate: "2026-10-01" }), "版本 1.2 · 生效 2026-10-01");
  assert.equal(platformContent.versionLabel({ version: "1.2" }), "版本 1.2");
  assert.equal(platformContent.versionLabel({ effectiveDate: "2026-10-01" }), "生效 2026-10-01");
  assert.equal(platformContent.versionLabel({}), "");
  assert.equal(platformContent.statusLine("published", "版本 1.2"), "版本 1.2");
  assert.equal(platformContent.statusLine("unpublished"), "尚未发布");
  assert.equal(platformContent.statusLine("failed"), "暂时读不到");
  assert.equal(platformContent.statusLine("loading"), "正在读取…");

  assert.deepEqual(platformContent.splitParagraphs("一\n\n  二  \n三\r\n"), ["一", "二", "三"]);
  assert.deepEqual(platformContent.splitParagraphs(""), []);
  assert.deepEqual(platformContent.splitParagraphs(null), []);
});

test("only a published payload yields body text; every other answer is an honest state", () => {
  const ok = platformContent.documentViewState("terms", published());
  assert.equal(ok.state, "published");
  assert.equal(ok.statusLine, "版本 1.2 · 生效 2026-10-01");
  assert.deepEqual(ok.paragraphs, ["第一条 总则", "第二条 账号"]);
  assert.equal(ok.canRetry, false);

  const draft = platformContent.documentViewState("terms", { statusCode: 200, data: { success: true, published: false, status: "draft", document: { key: "terms", title: "用户协议" } } });
  assert.equal(draft.state, "unpublished");
  assert.equal(draft.statusLine, "尚未发布");
  assert.equal(draft.body, "");
  assert.deepEqual(draft.paragraphs, []);
  assert.match(draft.note, /不会用占位或示例文字/, "未发布要说明为什么看不到正文");

  const empty = platformContent.documentViewState("terms", { statusCode: 200, data: { success: true, published: false, status: "empty", document: { key: "terms", title: "用户协议" } } });
  assert.equal(empty.state, "unpublished");

  // 已发布但没有正文 → 按读不到处理，绝不用页面文字补位
  const blank = platformContent.documentViewState("terms", published({ body: "   " }));
  assert.equal(blank.state, "failed");
  assert.equal(blank.body, "");

  for (const broken of [
    null,
    { statusCode: 500, data: { success: false, error: "server_error" } },
    { statusCode: 200, data: { success: false, error: "platform_content_unknown_document" } },
    { statusCode: 200, data: { published: true, document: { body: "x" } } },
    { statusCode: 200, data: "not-json" },
  ]) {
    const state = platformContent.documentViewState("terms", broken);
    assert.equal(state.state, "failed", `${JSON.stringify(broken)} 应判为读不到`);
    assert.equal(state.canRetry, true);
    assert.equal(state.body, "");
  }
  // 未知 key 也回一个能渲染的失败态，而不是抛异常
  const unknown = platformContent.documentViewState("nope", null);
  assert.equal(unknown.state, "failed");
  assert.equal(unknown.key, "nope");
  assert.equal(unknown.title, "平台文本");
});

test("loadDocument hits the public endpoint, caches the answer and never rejects", async () => {
  const requests = [];
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://api.test/" } });
  global.wx = {
    request: (config) => {
      requests.push(config);
      config.success(published());
    },
  };
  platformContent.resetCache();

  const first = await platformContent.loadDocument("terms");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://api.test/api/platform-content/terms", "去掉尾部斜杠、拼上平台文本路径");
  assert.equal(requests[0].method, "GET");
  assert.equal(first.state, "published");

  const cached = await platformContent.loadDocument("terms");
  assert.equal(requests.length, 1, "同一份文本短时间内只打一次接口");
  assert.equal(cached.state, "published");

  await platformContent.loadDocument("terms", { force: true });
  assert.equal(requests.length, 2, "force 要跳过缓存");

  // 网络失败：不 reject、不留缓存；重试仍会重新请求
  global.wx.request = (config) => { requests.push(config); config.fail({ errMsg: "request:fail" }); };
  const failed = await platformContent.loadDocument("privacy");
  assert.equal(failed.state, "failed");
  const failedAgain = await platformContent.loadDocument("privacy");
  assert.equal(failedAgain.state, "failed");
  assert.equal(requests.filter((item) => item.url.endsWith("/privacy")).length, 2, "失败态不缓存，重试要真的重发");

  // 没有 baseUrl / 没有 wx.request：一律回可渲染的失败态，不抛错
  global.getApp = () => ({ globalData: {} });
  const noBase = await platformContent.loadDocument("refund");
  assert.equal(noBase.state, "failed");
  delete global.wx.request;
  const noWx = await platformContent.loadDocument("refund");
  assert.equal(noWx.state, "failed");

  platformContent.resetCache();
  delete global.wx;
  delete global.getApp;
});

test("onboarding consent offers our own two documents next to the wechat guideline", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "apps", "miniprogram");
  const markup = fs.readFileSync(path.join(root, "pages", "onboarding", "onboarding.wxml"), "utf8");
  const script = fs.readFileSync(path.join(root, "pages", "onboarding", "onboarding.js"), "utf8");

  // 微信那份指引仍是勾选绑定的对象（DEC-110 ③：未发布不阻断登录）
  assert.match(markup, /catchtap="openPrivacyContract">《用户隐私保护指引》/);
  assert.match(markup, /data-doc="terms" catchtap="openDoc">《用户协议》/);
  assert.match(markup, /data-doc="privacy" catchtap="openDoc">《隐私政策》/);
  assert.doesNotMatch(markup, /\shidden=/);

  // 点入口真的跳到法律页（正文由后台维护，未发布即显示「尚未发布」）
  let definition;
  const opened = [];
  global.Page = (value) => { definition = value; };
  global.wx = { navigateTo: ({ url }) => opened.push(url) };
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://api.test" } });
  const file = require.resolve("../apps/miniprogram/pages/onboarding/onboarding.js");
  delete require.cache[file];
  require(file);
  definition.openDoc({ currentTarget: { dataset: { doc: "terms" } } });
  definition.openDoc({ currentTarget: { dataset: { doc: "privacy" } } });
  assert.deepEqual(opened, ["/pages/legal/legal?doc=terms", "/pages/legal/legal?doc=privacy"]);
  assert.match(script, /\bopenDoc\(event\)/);

  delete global.wx;
  delete global.Page;
  delete global.getApp;
});
