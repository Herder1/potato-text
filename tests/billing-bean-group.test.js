const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("../apps/api/src/server");
const { createMemoryAiConfigStore } = require("../apps/api/src/ai-config");
const { createMemoryAdminAccountStore } = require("../apps/api/src/admin-account-store");
const {
  BEAN_RECHARGE_PACKAGE_KEY,
  BEAN_RECHARGE_PACKAGE_NAME,
  createMemoryBillingStore,
} = require("../apps/api/src/billing-store");

const adminRoot = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
const app = fs.readFileSync(path.join(adminRoot, "app.js"), "utf8");

// 2026-10-11 产品负责人确认「真分组」：5 条豆币充值商品（豆币 5/10/20/30/50 枚）合并成唯一的
// 「豆币充值」套餐组——组标识固定、组名可改，组内每条规格仍是独立购买项（product.id 不变）。
test("豆币充值商品全部归入唯一的「豆币充值」组，组标识固定、组名可改", () => {
  const store = createMemoryBillingStore();
  const seed = store.listProducts().filter((item) => item.productType === "bean_pack");
  assert.equal(seed.length, 1);
  assert.equal(seed[0].packageKey, BEAN_RECHARGE_PACKAGE_KEY);
  assert.equal(seed[0].packageName, BEAN_RECHARGE_PACKAGE_NAME);

  // 客户端就算传别的组标识/组名，豆币商品也只会落在这个组，并继承组内现有组名。
  const first = store.upsertProduct({
    id: "product-beans-10", name: "充值豆币10枚", productType: "bean_pack",
    beanAmount: 10, priceCents: 999, packageKey: "随便一个组", packageName: "随便一个名字",
  });
  assert.equal(first.packageKey, BEAN_RECHARGE_PACKAGE_KEY);
  assert.equal(first.packageName, BEAN_RECHARGE_PACKAGE_NAME);

  const second = store.upsertProduct({
    id: "product-beans-50", name: "充值豆币50枚", productType: "bean_pack",
    beanAmount: 50, priceCents: 4999,
  });
  const beanMembers = store.listProducts().filter((item) => item.productType === "bean_pack");
  assert.equal(beanMembers.length, 3);
  assert.deepEqual([...new Set(beanMembers.map((item) => item.packageKey))], [BEAN_RECHARGE_PACKAGE_KEY]);
  assert.deepEqual([...new Set(beanMembers.map((item) => item.packageName))], [BEAN_RECHARGE_PACKAGE_NAME]);

  // 组名经「编辑组」一次性改到全组；规格自身的价格、豆币数量、上架状态一律不动。
  const renamed = store.updatePackageGroup(BEAN_RECHARGE_PACKAGE_KEY, { packageName: "豆币充值包", productType: "bean_pack" });
  assert.equal(renamed.length, 3);
  assert.ok(renamed.every((item) => item.packageName === "豆币充值包" && item.packageKey === BEAN_RECHARGE_PACKAGE_KEY));
  assert.deepEqual(renamed.map((item) => item.priceCents).sort((a, b) => a - b), [990, 999, 4999]);

  // 改单条规格不能把组名改回去（组名只由「编辑组」改）。
  const edited = store.upsertProduct({ ...second, priceCents: 4299, packageName: "又乱写了一个名字" });
  assert.equal(edited.packageName, "豆币充值包");
  assert.equal(edited.priceCents, 4299);
  assert.equal(store.upsertProduct({ ...first, active: false }).packageKey, BEAN_RECHARGE_PACKAGE_KEY);
});

test("订阅套餐组不能塞进豆币规格，豆币组也不做订阅的期限/范围校验", () => {
  const store = createMemoryBillingStore();
  const subscription = store.listProducts().find((item) => item.id === "product-modern-chinese-2026");
  const before = store.exportState();
  assert.throws(() => store.updatePackageGroup(subscription.packageKey, { productType: "bean_pack" }),
    /billing_product_type_invalid/);
  assert.deepEqual(store.exportState(), before);
  // 豆币组全组期限都是 0，不能因为"同组期限重复"被拦下。
  assert.doesNotThrow(() => store.upsertProduct({
    id: "product-beans-20", name: "充值豆币20枚", productType: "bean_pack",
    beanAmount: 20, priceCents: 1999, durationDays: 0,
  }));
  assert.throws(() => store.updatePackageGroup("不存在的组", { packageName: "x" }),
    /billing_package_not_found/);
});

test("后台接口：豆币组的「编辑组」与「新增规格」都走正式接口", async (context) => {
  const admins = createMemoryAdminAccountStore();
  admins.ensureBootstrapAdmin({ username: "bean-admin", password: "secret-password-1", mustChangePassword: false });
  const billing = createMemoryBillingStore();
  const server = createServer({
    aiConfigStore: createMemoryAiConfigStore(), adminAccountStore: admins,
    billingStore: billing, bootstrapAdmin: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, token, body) {
    const response = await fetch(`${base}${route}`, {
      method: body ? "POST" : "GET",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const login = await call("/api/admin/auth/login", "", { username: "bean-admin", password: "secret-password-1" });
  assert.equal(login.status, 200);
  const token = login.data.token;

  const created = await call("/api/admin/billing/products", token, {
    name: "充值豆币10枚", productType: "bean_pack", beanAmount: 10, priceCents: 999,
    packageKey: "ignored", packageName: "ignored",
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.product.packageKey, BEAN_RECHARGE_PACKAGE_KEY);
  assert.equal(created.data.product.packageName, BEAN_RECHARGE_PACKAGE_NAME);

  const group = await call(`/api/admin/billing/packages/${BEAN_RECHARGE_PACKAGE_KEY}`, token, {
    packageName: "豆币充值包", productType: "bean_pack",
  });
  assert.equal(group.status, 200);
  assert.equal(group.data.products.length, 2);
  assert.ok(group.data.products.every((item) => item.packageName === "豆币充值包"));

  const listed = await call("/api/billing/products", "");
  const beans = listed.data.products.filter((item) => item.productType === "bean_pack");
  assert.ok(beans.length >= 2);
  assert.deepEqual([...new Set(beans.map((item) => item.packageKey))], [BEAN_RECHARGE_PACKAGE_KEY]);
  // 用户端仍按规格逐条展示、逐条购买（合并的是后台分组，不是把 5 个档位并成一个商品）。
  assert.deepEqual(beans.map((item) => item.beanAmount).sort((a, b) => a - b), [5, 10]);
});

test("后台把豆币充值渲染成套餐组：组表头 + 组内规格，编辑组只改组名", () => {
  assert.match(app, /function billingPackageGroupRows\(key, products, kind\)/);
  assert.match(app, /const rechargeGroups = new Map\(\)/);
  assert.match(app, /isBeanPackProduct\(product\) \? rechargeGroups : groups/);
  assert.match(app, /billingPackageGroupRows\(key, products, "bean"\)/);
  assert.match(app, /products\.slice\(\)\.sort\(\(a, b\) => a\.beanAmount - b\.beanAmount\)/);
  // 豆币组的三个按钮与订阅组同一套：收起规格 / 编辑组 / 新增规格
  assert.match(app, /data-billing-product-action="toggle"/);
  assert.match(app, /data-billing-product-action="group"/);
  assert.match(app, /data-billing-product-action="copy"/);
  // 编辑器分支
  assert.match(app, /const beanGroup = Boolean\(!productId && groupKey && product && isBeanPackProduct\(product\)\)/);
  assert.match(app, /beanGroup \? "bean-group"/);
  assert.match(app, /mode === "group" \|\| mode === "bean-group" \? groupFields/);
  assert.match(app, /mode === "group" \|\| mode === "bean-group" \? `\/api\/admin\/billing\/packages\//);
  assert.match(app, /document\.querySelector\("#billing-product-package-name"\)\.readOnly = mode === "recharge"/);
  assert.match(app, /document\.querySelector\("#billing-product-subscription-fields"\)\.hidden = mode === "bean-group" \|\| mode === "recharge"/);
  assert.doesNotMatch(app, /豆币充值不属于套餐组/);
  assert.match(html, /<div id="billing-product-subscription-fields">/);
  // 豆币组没有考试项目/范围：这三个隐藏容器都要能真的藏住（作者 display 会压过 UA 的 [hidden]）
  const css = fs.readFileSync(path.join(adminRoot, "styles.css"), "utf8");
  assert.match(css, /#billing-product-group-fields\[hidden\],[\s\S]*#billing-product-subscription-fields\[hidden\]\s*\{\s*display:\s*none/);
});
