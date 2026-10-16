const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminAccountStore } = require("../apps/api/src/admin-account-store");
const { createMemoryAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { createMemoryUserAuthStore } = require("../apps/api/src/user-auth-store");
const { createMemoryPlatformContentStore } = require("../apps/api/src/platform-content-store");

const BODY_V1 = "第一条 平台与用户之间的权利义务以本协议为准。";
const BODY_V2 = "第一条 平台与用户之间的权利义务以本协议为准。\n第二条 本版新增了退费与账号注销的说明入口。";

async function startServer(context) {
  const adminAccountStore = createMemoryAdminAccountStore();
  adminAccountStore.ensureBootstrapAdmin({ username: "admin", password: "super-secret-1", displayName: "测试超管", mustChangePassword: false });
  const platformContentStore = createMemoryPlatformContentStore();
  const operationLogStore = createMemoryAdminOperationStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    adminAccountStore,
    operationLogStore,
    platformContentStore,
    userAuthStore: createMemoryUserAuthStore(),
    bootstrapAdmin: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, payload: await response.json().catch(() => ({})) };
  };
  const adminLogin = async () => (await request("/api/admin/auth/login", { method: "POST", body: { username: "admin", password: "super-secret-1" } })).payload.token;
  const userLogin = async (deviceId) => (await request("/api/auth/wechat/login", { method: "POST", body: { code: `code-${deviceId}`, deviceId } })).payload.token;
  return { baseUrl, request, adminLogin, userLogin, platformContentStore, operationLogStore };
}

test("用户端：没有已发布版本时返回 published:false，绝不下发占位正文", async (context) => {
  const { request } = await startServer(context);

  const list = await request("/api/platform-content");
  assert.equal(list.status, 200);
  assert.deepEqual(list.payload.documents, [], "一份都没发布时清单必须为空");

  const detail = await request("/api/platform-content/terms");
  assert.equal(detail.status, 200, "未发布不是 404——前端要据此显示「尚未发布」");
  assert.equal(detail.payload.published, false);
  assert.equal(detail.payload.document.published, false);
  assert.equal(detail.payload.document.title, "用户协议");
  assert.equal("body" in detail.payload.document, false, "未发布时不得下发任何正文");

  const unknown = await request("/api/platform-content/not-a-doc");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.payload.error, "platform_content_unknown_document");
});

test("后台：新增草稿 → 发布 → 用户端可见；改版只追加历史，用户端始终读当前已发布版本", async (context) => {
  const { request, adminLogin, platformContentStore } = await startServer(context);
  const token = await adminLogin();

  const listed = await request("/api/admin/platform-content", { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.documents.length, 7, "后台固定 7 份文档骨架");
  assert.deepEqual(listed.payload.documents.map((item) => item.key), ["terms", "privacy", "ai-service", "refund", "account-deletion", "operator", "personal-info"]);
  assert.equal(listed.payload.documents.every((item) => item.status === "empty"), true);

  const saved = await request("/api/admin/platform-content/terms/versions", {
    method: "POST",
    token,
    body: { version: "1.0", body: BODY_V1, effectiveDate: "2026-10-10" },
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.payload.version.status, "draft");

  const beforePublish = await request("/api/platform-content/terms");
  assert.equal(beforePublish.payload.published, false, "草稿不进用户端");

  const published = await request("/api/admin/platform-content/terms/publish", { method: "POST", token, body: { version: "1.0" } });
  assert.equal(published.status, 200);
  assert.equal(published.payload.document.currentVersion, "1.0");

  const visible = await request("/api/platform-content/terms");
  assert.equal(visible.payload.published, true);
  assert.equal(visible.payload.document.version, "1.0");
  assert.equal(visible.payload.document.effectiveDate, "2026-10-10");
  assert.equal(visible.payload.document.body, BODY_V1);

  // 改版：新增 2.0 并发布，旧版必须留在历史里（正文与生效时间都在）
  assert.equal((await request("/api/admin/platform-content/terms/versions", { method: "POST", token, body: { version: "2.0", body: BODY_V2, effectiveDate: "2026-11-01" } })).status, 201);
  assert.equal((await request("/api/admin/platform-content/terms/publish", { method: "POST", token, body: { version: "2.0" } })).status, 200);

  const detail = await request("/api/admin/platform-content/terms", { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.document.currentVersion, "2.0");
  assert.deepEqual(detail.payload.history.map((item) => item.version), ["2.0", "1.0"]);
  assert.equal(detail.payload.history[1].status, "retired");
  assert.equal(detail.payload.history[1].effectiveDate, "2026-10-10");
  assert.equal(platformContentStore.current("terms").body, BODY_V2);

  assert.equal((await request("/api/platform-content/terms")).payload.document.body, BODY_V2, "用户端只读当前已发布版本");

  // 下架后用户端回到「尚未发布」，历史不变
  const offline = await request("/api/admin/platform-content/terms/unpublish", { method: "POST", token, body: {} });
  assert.equal(offline.status, 200);
  assert.equal(offline.payload.document.currentVersion, null);
  assert.equal((await request("/api/platform-content/terms")).payload.published, false);
  assert.equal((await request("/api/admin/platform-content/terms", { token })).payload.history.length, 2, "下架不删历史版本");
});

test("后台：已发布版本不可改写（同版本号被拒），错误码与权限都拦住", async (context) => {
  const { request, adminLogin } = await startServer(context);
  const token = await adminLogin();

  await request("/api/admin/platform-content/privacy/versions", { method: "POST", token, body: { version: "1.0", body: BODY_V1, effectiveDate: "2026-10-10" } });
  await request("/api/admin/platform-content/privacy/publish", { method: "POST", token, body: { version: "1.0" } });

  const conflict = await request("/api/admin/platform-content/privacy/versions", { method: "POST", token, body: { version: "1.0", body: "想覆盖已发布版本" } });
  assert.equal(conflict.status, 422);
  assert.equal(conflict.payload.error, "platform_content_version_conflict");

  const noDate = await request("/api/admin/platform-content/refund/versions", { method: "POST", token, body: { version: "1.0", body: BODY_V1 } });
  assert.equal(noDate.status, 201, "草稿允许先不带生效日期");
  const publishNoDate = await request("/api/admin/platform-content/refund/publish", { method: "POST", token, body: { version: "1.0" } });
  assert.equal(publishNoDate.status, 422);
  assert.equal(publishNoDate.payload.error, "platform_content_effective_date_required");

  // 草稿可改写（同版本号重存＝更新草稿，201 而不是冲突），发布时可补填生效日期
  const rewritten = await request("/api/admin/platform-content/refund/versions", { method: "POST", token, body: { version: "1.0", body: BODY_V2, note: "正文改过" } });
  assert.equal(rewritten.status, 201, "同版本号的草稿可以反复改写");
  assert.equal(rewritten.payload.version.status, "draft");
  const history = await request("/api/admin/platform-content/refund", { token });
  assert.equal(history.payload.history.filter((item) => item.version === "1.0").length, 1, "改写草稿不新增历史条目");
  assert.match(history.payload.history[0].body, /新增了退费与账号注销/, "后台历史带正文，才能「载入旧版正文」");
  const publishWithDate = await request("/api/admin/platform-content/refund/publish", { method: "POST", token, body: { version: "1.0", effectiveDate: "2026-10-18" } });
  assert.equal(publishWithDate.status, 200, "发布时可补填生效日期");
  assert.equal(publishWithDate.payload.document.effectiveDate, "2026-10-18");
  const refundVisible = await request("/api/platform-content/refund");
  assert.equal(refundVisible.payload.published, true);
  assert.equal(refundVisible.payload.document.effectiveDate, "2026-10-18", "补填的生效日期真的下发到用户端");

  // 重存草稿：留空生效日期＝沿用原值（后台提示要靠响应里的 effectiveDate 回显，这里一并锁住）
  const dated = await request("/api/admin/platform-content/ai-service/versions", { method: "POST", token, body: { version: "1.0", body: BODY_V1, effectiveDate: "2026-11-01" } });
  assert.equal(dated.status, 201);
  assert.equal(dated.payload.version.effectiveDate, "2026-11-01");
  const redated = await request("/api/admin/platform-content/ai-service/versions", { method: "POST", token, body: { version: "1.0", body: BODY_V2 } });
  assert.equal(redated.status, 201);
  assert.equal(redated.payload.version.effectiveDate, "2026-11-01", "重存草稿留空生效日期＝沿用原值");
  assert.equal(redated.payload.version.status, "draft");

  const unknownVersion = await request("/api/admin/platform-content/terms/publish", { method: "POST", token, body: { version: "9.9" } });
  assert.equal(unknownVersion.status, 404);

  // 未登录 / 普通用户 token 都不能碰后台接口
  assert.equal((await request("/api/admin/platform-content")).status, 401);
  const userToken = await request("/api/auth/wechat/login", { method: "POST", body: { code: "code-plain-user", deviceId: "plain-user" } });
  const denied = await request("/api/admin/platform-content", { token: userToken.payload.token });
  assert.equal(denied.status, 401, "小程序会话不是后台会话");
});

test("后台：发布/下架写操作日志，操作人记真实账号", async (context) => {
  const { request, adminLogin, operationLogStore } = await startServer(context);
  const token = await adminLogin();

  await request("/api/admin/platform-content/refund/versions", { method: "POST", token, body: { version: "1.0", body: BODY_V1, effectiveDate: "2026-10-10" } });
  await request("/api/admin/platform-content/refund/publish", { method: "POST", token, body: { version: "1.0" } });
  await request("/api/admin/platform-content/refund/unpublish", { method: "POST", token, body: {} });

  const actions = operationLogStore.list({ category: "platform-content" }).items.map((item) => item.action).sort();
  assert.deepEqual(actions, ["platform-content.publish", "platform-content.save_version", "platform-content.unpublish"]);
  assert.equal(operationLogStore.list({ category: "platform-content" }).items.every((item) => item.actor === "测试超管"), true);
});

test("同意记录：只认当前已发布版本，同版本幂等，换版本追加且不覆盖历史", async (context) => {
  const { request, adminLogin, userLogin } = await startServer(context);
  const adminToken = await adminLogin();
  const userToken = await userLogin("agreement-device");

  assert.equal((await request("/api/auth/agreements")).status, 401, "未登录不能读同意记录");

  const beforePublish = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { docKey: "terms", version: "1.0" } });
  assert.equal(beforePublish.status, 422);
  assert.equal(beforePublish.payload.error, "platform_content_not_published");

  await request("/api/admin/platform-content/terms/versions", { method: "POST", token: adminToken, body: { version: "1.0", body: BODY_V1, effectiveDate: "2026-10-10" } });
  await request("/api/admin/platform-content/terms/publish", { method: "POST", token: adminToken, body: { version: "1.0" } });

  const stale = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { docKey: "terms", version: "0.9" } });
  assert.equal(stale.status, 409, "不是当前版本不许记录");
  assert.equal(stale.payload.error, "platform_content_version_not_current");
  assert.equal(stale.payload.currentVersion, "1.0");

  const first = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { docKey: "terms", version: "1.0", source: "登录确认" } });
  assert.equal(first.status, 200);
  assert.equal(first.payload.recorded, true);
  assert.equal(first.payload.agreement.source, "登录确认");

  const again = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { docKey: "terms", version: "1.0" } });
  assert.equal(again.payload.recorded, false, "同一版本重复同意不刷记录");
  assert.equal((await request("/api/auth/agreements", { token: userToken })).payload.agreements.length, 1);

  // 协议改版后同意新版：旧版记录必须留着（不覆盖用户过去同意过的版本）
  await request("/api/admin/platform-content/terms/versions", { method: "POST", token: adminToken, body: { version: "2.0", body: BODY_V2, effectiveDate: "2026-11-01" } });
  await request("/api/admin/platform-content/terms/publish", { method: "POST", token: adminToken, body: { version: "2.0" } });
  const upgraded = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { docKey: "terms", version: "2.0", source: "改版确认" } });
  assert.equal(upgraded.payload.recorded, true);
  assert.deepEqual(upgraded.payload.agreements.map((item) => `${item.docKey}@${item.version}`), ["terms@1.0", "terms@2.0"]);

  const mine = await request("/api/auth/agreements", { token: userToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.payload.agreements.length, 2);
  assert.equal(mine.payload.agreements[0].agreedAt > 0, true);

  // 另一个账号看不到别人的同意记录
  const otherToken = await userLogin("agreement-device-2");
  assert.deepEqual((await request("/api/auth/agreements", { token: otherToken })).payload.agreements, []);

  const missingDoc = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { version: "2.0" } });
  assert.equal(missingDoc.status, 400);
  assert.equal(missingDoc.payload.error, "agreement_doc_required");
  const unknownDoc = await request("/api/auth/agreements", { method: "POST", token: userToken, body: { docKey: "nope", version: "2.0" } });
  assert.equal(unknownDoc.status, 404);
});
