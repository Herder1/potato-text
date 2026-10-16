const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./helpers/admin-auth");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");

// 2026-10-03 历史实例：计费看板里一个 TypeError 没被兜住，进程直接退出；此后页面上任何操作都变成
// 「Failed to fetch」，看不出真因（2026-10-09 产品负责人再次遇到这个现象的后半段）。
// 这里锁住：请求处理里的未捕获异常只能毁掉这一个请求，服务必须继续可用。
test("请求处理里的未捕获异常只回 500，不会带走整个后台进程", async (context) => {
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(),
    billingStore: {
      dashboard() { throw new Error("injected_billing_dashboard_boom"); },
      exportState: () => ({}),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const failing = await fetch(`${base}/api/admin/billing`);
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { success: false, error: "internal_error" });

  // 关键断言：进程还活着，后续请求照常工作
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const config = await fetch(`${base}/api/admin/ai-config`);
  assert.equal(config.status, 200);
  assert.equal((await config.json()).success !== false, true);
});
