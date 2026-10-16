const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { subjects, books } = require("../../../packages/domain/catalog");
const { DEFAULT_EXAM_PROJECT_ID, listExamProjects } = require("./exam-project-registry");

const DAY_MS = 24 * 60 * 60 * 1000;
// DEC-107（2026-10-02，产品手册 §0.4）：账户只有豆币，取消 AI 额度与余额；
// 兑换率 1 豆币 = 10 AI 额度 → 历史 1 点 AI 额度 = 0.1 豆币；「价目不调整」＝保价换算。
const BEANS_PER_CREDIT = 0.1;
const BEAN_UNIT = "bean-v1";
const MIN_BEAN_AMOUNT = 0.1;
const productTypes = new Set(["project_subscription", "subject_subscription", "bean_pack"]);
const legacyProductTypes = { ai_credit_pack: "bean_pack" };
// 豆币充值套餐组（2026-10-11 产品负责人确认「真分组」口径）：所有豆币充值商品同属**唯一**的
// 「豆币充值」组——组标识固定（不允许出现第二个豆币组），组名可在后台「编辑组」里改。
// 与订阅套餐组的差别：豆币组没有考试项目/范围/科目/教材，也没有期限去重（期限恒为 0）。
const BEAN_RECHARGE_PACKAGE_KEY = "bean-recharge";
const BEAN_RECHARGE_PACKAGE_NAME = "豆币充值";
const BEAN_RECHARGE_PACKAGE = { key: BEAN_RECHARGE_PACKAGE_KEY, name: BEAN_RECHARGE_PACKAGE_NAME };

function isBeanPackType(productType) {
  return productType === "bean_pack" || productType === "ai_credit_pack";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 豆币按 0.1 精度记账：所有加减都归整到一位小数，避免浮点累积误差。
function roundBeans(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function isBeanAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < MIN_BEAN_AMOUNT) return false;
  return Math.abs(Math.round(amount * 10) - amount * 10) < 1e-6;
}

function isBeanAmountOrZero(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return false;
  return Math.abs(Math.round(amount * 10) - amount * 10) < 1e-6;
}

function formatBeans(value) {
  const amount = roundBeans(value);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function renameCreditText(text) {
  return String(text || "").replace(/AI\s*额度/g, "豆币").replace(/额度/g, "豆币");
}

function seedProducts(now = Date.now()) {
  return [
    {
      id: "product-chinese-literature-2026",
      name: "汉语言文学题库 365 天权益",
      packageKey: "project-chinese-literature",
      packageName: "汉语言文学题库",
      projectId: DEFAULT_EXAM_PROJECT_ID,
      productType: "project_subscription",
      scopeLabel: "广东普通专升本 · 五科九本",
      subjectIds: subjects.map((subject) => subject.id),
      bookIds: books.map((book) => book.id),
      durationDays: 365,
      priceCents: 19900,
      // 原「赠送 100 点 AI 额度」按 1 豆币 = 10 额度折算为 10 豆币（DEC-107）
      bonusBeans: 10,
      bonusValidityDays: 365,
      beanAmount: 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "product-modern-chinese-2026",
      name: "现代汉语题库 365 天权益",
      packageKey: "subject-modern-chinese",
      packageName: "现代汉语题库",
      projectId: DEFAULT_EXAM_PROJECT_ID,
      productType: "subject_subscription",
      scopeLabel: "现代汉语 · 上下册",
      subjectIds: ["modern-chinese"],
      bookIds: ["modern-chinese-7-1", "modern-chinese-7-2"],
      durationDays: 365,
      priceCents: 6900,
      // 原「赠送 30 点 AI 额度」→ 3 豆币
      bonusBeans: 3,
      bonusValidityDays: 365,
      beanAmount: 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "product-beans-5",
      name: "豆币 5 枚",
      packageKey: BEAN_RECHARGE_PACKAGE_KEY,
      packageName: BEAN_RECHARGE_PACKAGE_NAME,
      projectId: "",
      productType: "bean_pack",
      scopeLabel: "充值豆币长期有效",
      subjectIds: [],
      bookIds: [],
      durationDays: 0,
      priceCents: 990,
      bonusBeans: 0,
      bonusValidityDays: 0,
      // 原「AI 额度 50 点」→ 5 豆币，价格不变
      beanAmount: 5,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function initialState(now = Date.now()) {
  const lotId = `bean-lot-${crypto.randomUUID()}`;
  return {
    unit: BEAN_UNIT,
    products: seedProducts(now),
    accounts: [{
      userId: "test-user",
      nickname: "薯考同学",
      entitlements: [],
      orders: [],
      beanLots: [{
        id: lotId,
        source: "registration_reward",
        sourceLabel: "注册测试奖励",
        grantedAmount: 2,
        remainingAmount: 2,
        expiresAt: now + 30 * DAY_MS,
        createdAt: now,
        unit: BEAN_UNIT,
      }],
      transactions: [{
        id: `bean-tx-${crypto.randomUUID()}`,
        beanLotId: lotId,
        transactionType: "grant",
        amount: 2,
        balanceAfter: 2,
        source: "registration_reward",
        description: "注册测试奖励",
        referenceId: "seed-registration-reward",
        createdAt: now,
        unit: BEAN_UNIT,
      }],
      createdAt: now,
      updatedAt: now,
    }],
  };
}

// 历史 AI 额度 → 豆币的一次性折算。
// 判定依据是「形状」（旧字段是否存在）而不是版本号：迁完旧键即消失，因此天然幂等——
// 即使 PostgreSQL 分支的快照没来得及回写，进程重启也不会二次 ×0.1。
function migrateLegacyState(state) {
  if (!state || typeof state !== "object") return { state, changed: false };
  let changed = false;
  const products = Array.isArray(state.products) ? state.products : [];
  products.forEach((product) => {
    if (!product || typeof product !== "object") return;
    const isSubscription = product.productType !== "bean_pack" && product.productType !== "ai_credit_pack";
    if (!hasOwn(product, "projectId")) {
      product.projectId = isSubscription ? DEFAULT_EXAM_PROJECT_ID : "";
      changed = true;
    }
    if (!hasOwn(product, "packageKey") || !String(product.packageKey || "").trim()) {
      product.packageKey = String(product.id || "");
      changed = true;
    }
    if (!hasOwn(product, "packageName") || !String(product.packageName || "").trim()) {
      product.packageName = String(product.name || product.id || "");
      changed = true;
    }
    if (hasOwn(product, "bonusAiCredits")) {
      product.bonusBeans = roundBeans(Number(product.bonusAiCredits || 0) * BEANS_PER_CREDIT);
      delete product.bonusAiCredits;
      changed = true;
    }
    if (hasOwn(product, "creditAmount")) {
      product.beanAmount = roundBeans(Number(product.creditAmount || 0) * BEANS_PER_CREDIT);
      delete product.creditAmount;
      changed = true;
    }
    if (legacyProductTypes[product.productType]) {
      product.productType = legacyProductTypes[product.productType];
      changed = true;
    }
    // 豆币充值归入唯一的「豆币充值」组：读时就把散落的每条豆币商品收进同一组标识（读不写盘，
    // 落盘靠 scripts/migrate-bean-recharge-group.js --write）。组名只在缺失时补默认值，
    // 否则后台改过的组名会在下一次读取时被打回。
    if (isBeanPackType(product.productType)) {
      if (product.packageKey !== BEAN_RECHARGE_PACKAGE_KEY) {
        product.packageKey = BEAN_RECHARGE_PACKAGE_KEY;
        changed = true;
      }
      if (!String(product.packageName || "").trim()) {
        product.packageName = BEAN_RECHARGE_PACKAGE_NAME;
        changed = true;
      }
    }
    if (product.id === "product-ai-credits-50") {
      product.id = "product-beans-5";
      changed = true;
    }
    if (product.productType === "bean_pack") {
      if (typeof product.name === "string" && /AI\s*额度|额度/.test(product.name)) {
        product.name = `豆币 ${formatBeans(product.beanAmount)} 枚`;
        changed = true;
      }
      if (typeof product.scopeLabel === "string" && /AI\s*额度|额度/.test(product.scopeLabel)) {
        product.scopeLabel = renameCreditText(product.scopeLabel);
        changed = true;
      }
    }
  });
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  accounts.forEach((account) => {
    if (!account || typeof account !== "object") return;
    if (Array.isArray(account.creditLots)) {
      account.beanLots = account.creditLots.map((lot) => ({
        ...lot,
        id: String(lot.id || "").replace(/^credit-lot-/, "bean-lot-"),
        sourceLabel: renameCreditText(lot.sourceLabel),
        grantedAmount: roundBeans(Number(lot.grantedAmount || 0) * BEANS_PER_CREDIT),
        remainingAmount: roundBeans(Number(lot.remainingAmount || 0) * BEANS_PER_CREDIT),
        unit: BEAN_UNIT,
      }));
      delete account.creditLots;
      changed = true;
    }
    if (Array.isArray(account.transactions)) {
      account.transactions = account.transactions.map((transaction) => {
        if (!transaction || typeof transaction !== "object") return transaction;
        const next = { ...transaction };
        if (hasOwn(next, "creditLotId")) {
          next.beanLotId = String(next.creditLotId || "").replace(/^credit-lot-/, "bean-lot-");
          delete next.creditLotId;
          changed = true;
        }
        if (!hasOwn(next, "unit")) {
          next.amount = roundBeans(Number(next.amount || 0) * BEANS_PER_CREDIT);
          next.balanceAfter = roundBeans(Number(next.balanceAfter || 0) * BEANS_PER_CREDIT);
          next.unit = BEAN_UNIT;
          changed = true;
        }
        return next;
      });
    }
    if (!Array.isArray(account.beanLots)) {
      account.beanLots = [];
      changed = true;
    }
    if (!Array.isArray(account.orders)) {
      account.orders = [];
      changed = true;
    }
  });
  if (state.unit !== BEAN_UNIT) {
    state.unit = BEAN_UNIT;
    changed = true;
  }
  return { state, changed };
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[，,\n]/))
    .map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeProduct(payload, existing = null, now = Date.now()) {
  const requestedType = String(payload.productType ?? existing?.productType ?? "");
  // 兼容旧后台页签仍提交 ai_credit_pack 的情况：语义等同于豆币充值包。
  const productType = legacyProductTypes[requestedType] || requestedType;
  if (!productTypes.has(productType)) throw new Error("billing_product_type_invalid");
  const name = String(payload.name ?? existing?.name ?? "").trim();
  const id = String(payload.id || existing?.id || `product-${crypto.randomUUID()}`);
  const priceCents = Number(payload.priceCents ?? existing?.priceCents);
  const subscriptionProduct = productType !== "bean_pack";
  const projectId = subscriptionProduct
    ? String(payload.projectId ?? existing?.projectId ?? DEFAULT_EXAM_PROJECT_ID).trim() || DEFAULT_EXAM_PROJECT_ID
    : "";
  const packageKey = subscriptionProduct
    ? String(payload.packageKey ?? existing?.packageKey ?? id).trim() || id
    : BEAN_RECHARGE_PACKAGE_KEY;
  const packageName = subscriptionProduct
    ? String(payload.packageName ?? existing?.packageName ?? name).trim() || name
    : String(payload.packageName ?? existing?.packageName ?? "").trim() || BEAN_RECHARGE_PACKAGE_NAME;
  // 订阅时长 0 表示永久；豆币充值包本来就使用 0 表示不适用。
  const durationDays = subscriptionProduct ? Number(payload.durationDays ?? existing?.durationDays ?? 365) : 0;
  // 旧字段（bonusAiCredits / creditAmount，单位 AI 额度）继续接受，按 ×0.1 折算成豆币。
  const bonusBeansValue = firstDefined(
    payload.bonusBeans,
    payload.bonusAiCredits === undefined ? undefined : roundBeans(Number(payload.bonusAiCredits) * BEANS_PER_CREDIT),
    existing?.bonusBeans,
    0,
  );
  const beanAmountValue = firstDefined(
    payload.beanAmount,
    payload.creditAmount === undefined ? undefined : roundBeans(Number(payload.creditAmount) * BEANS_PER_CREDIT),
    existing?.beanAmount,
  );
  const bonusValidityDays = subscriptionProduct ? Number(payload.bonusValidityDays ?? existing?.bonusValidityDays ?? durationDays) : 0;
  // 精度按**原始值**判定（0.05 这类非 0.1 整数倍直接拒绝），然后用 roundBeans 归整。
  if (!name) throw new Error("billing_product_name_required");
  if (subscriptionProduct && !listExamProjects().some((project) => project.id === projectId)) throw new Error("billing_project_invalid");
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10000000) throw new Error("billing_product_price_invalid");
  if (subscriptionProduct && (!Number.isInteger(durationDays) || durationDays < 0 || durationDays > 1095)) throw new Error("billing_product_duration_invalid");
  if (!isBeanAmountOrZero(bonusBeansValue) || !Number.isInteger(bonusValidityDays) || bonusValidityDays < 0) throw new Error("billing_bean_amount_invalid");
  if (productType === "bean_pack" && !isBeanAmount(beanAmountValue)) throw new Error("billing_bean_amount_invalid");
  const bonusBeans = subscriptionProduct ? roundBeans(bonusBeansValue) : 0;
  const beanAmount = productType === "bean_pack" ? roundBeans(beanAmountValue) : 0;
  return {
    id,
    name,
    packageKey,
    packageName,
    projectId,
    productType,
    scopeLabel: String(payload.scopeLabel ?? existing?.scopeLabel ?? "").trim().slice(0, 200),
    subjectIds: subscriptionProduct ? stringList(payload.subjectIds ?? existing?.subjectIds) : [],
    bookIds: subscriptionProduct ? stringList(payload.bookIds ?? existing?.bookIds) : [],
    durationDays,
    priceCents,
    bonusBeans,
    bonusValidityDays,
    beanAmount,
    active: payload.active === undefined ? existing?.active !== false : payload.active === true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function createBillingStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));
  const ensureAccount = (state, userId, nickname = "薯考同学", now = Date.now()) => {
    let account = state.accounts.find((item) => item.userId === userId);
    if (!account) {
      account = { userId, nickname, entitlements: [], orders: [], beanLots: [], transactions: [], createdAt: now, updatedAt: now };
      state.accounts.push(account);
    }
    if (!Array.isArray(account.orders)) account.orders = [];
    if (!Array.isArray(account.beanLots)) account.beanLots = [];
    return account;
  };
  const activeLots = (account, now) => account.beanLots.filter((lot) => lot.remainingAmount > 0 && (!lot.expiresAt || lot.expiresAt > now));
  const balance = (account, now) => roundBeans(activeLots(account, now).reduce((total, lot) => total + lot.remainingAmount, 0));
  const sortLotsByExpiry = (left, right) => {
    if (left.expiresAt && right.expiresAt) return left.expiresAt - right.expiresAt;
    if (left.expiresAt) return -1;
    if (right.expiresAt) return 1;
    return left.createdAt - right.createdAt;
  };
  const accountView = (account, products, now = Date.now()) => {
    const subscriptions = account.entitlements
      // 退款收回的权益不再算「有效订阅」（记录保留，审计可追溯）
      .filter((item) => !item.revokedAt && (!item.expiresAt || item.expiresAt > now))
      .sort((left, right) => {
        if (!left.expiresAt) return 1;
        if (!right.expiresAt) return -1;
        return left.expiresAt - right.expiresAt;
      })
      .map((item) => ({ ...clone(item), product: clone(products.find((product) => product.id === item.productId) || null) }));
    const lots = account.beanLots.slice().sort(sortLotsByExpiry);
    const live = activeLots(account, now);
    return {
      userId: account.userId,
      nickname: account.nickname,
      beanBalance: balance(account, now),
      expiringBeans: roundBeans(live.filter((lot) => lot.expiresAt).reduce((total, lot) => total + lot.remainingAmount, 0)),
      permanentBeans: roundBeans(live.filter((lot) => !lot.expiresAt).reduce((total, lot) => total + lot.remainingAmount, 0)),
      subscriptions,
      beanLots: clone(lots),
      transactions: clone(account.transactions.slice().sort((left, right) => right.createdAt - left.createdAt)),
      orders: clone((account.orders || []).slice().sort((left, right) => right.createdAt - left.createdAt)),
    };
  };
  const grantLot = (account, payload, now) => {
    // 先按**原始值**校验精度：0.05 这类非 0.1 整数倍必须拒绝，不能被 roundBeans 悄悄抬成 0.1。
    if (!isBeanAmount(payload.amount)) throw new Error("billing_bean_amount_invalid");
    const amount = roundBeans(payload.amount);
    const lot = {
      id: `bean-lot-${crypto.randomUUID()}`,
      source: String(payload.source || "admin_adjustment"),
      sourceLabel: String(payload.sourceLabel || payload.description || "豆币发放").slice(0, 200),
      grantedAmount: amount,
      remainingAmount: amount,
      expiresAt: payload.expiresAt ? Number(payload.expiresAt) : null,
      orderId: String(payload.orderId || ""),
      createdAt: now,
      unit: BEAN_UNIT,
    };
    if (lot.expiresAt && lot.expiresAt <= now) throw new Error("billing_bean_expiry_invalid");
    account.beanLots.push(lot);
    const balanceAfter = balance(account, now);
    const transaction = {
      id: `bean-tx-${crypto.randomUUID()}`,
      beanLotId: lot.id,
      transactionType: "grant",
      amount,
      balanceAfter,
      source: lot.source,
      description: lot.sourceLabel,
      referenceId: String(payload.referenceId || ""),
      createdAt: now,
      unit: BEAN_UNIT,
    };
    account.transactions.push(transaction);
    account.updatedAt = now;
    return { lot, transaction, balanceAfter };
  };
  return {
    exportState: () => clone(adapter.read()),
    dashboard(userId = "test-user", now = Date.now()) {
      const state = read();
      const account = ensureAccount(state, userId, "薯考同学", now);
      const view = accountView(account, state.products, now);
      return {
        products: clone(state.products).sort((left, right) => left.createdAt - right.createdAt),
        account: view,
        counts: {
          activeProducts: state.products.filter((item) => item.active).length,
          activeSubscriptions: view.subscriptions.length,
          beanBalance: view.beanBalance,
          transactions: view.transactions.length,
          orders: view.orders.length,
        },
      };
    },
    listAccountSummaries(now = Date.now()) {
      const state = read();
      const products = new Map(state.products.map((product) => [product.id, product]));
      return state.accounts.map((account) => ({
        userId: account.userId,
        beanBalance: balance(account, now),
        orderCount: (account.orders || []).length,
        subscriptions: (account.entitlements || [])
          .filter((item) => !item.revokedAt && (!item.expiresAt || item.expiresAt > now))
          .map((item) => {
            const product = products.get(item.productId);
            return {
              id: item.id,
              name: product?.packageName || product?.name || item.productId,
              productType: product?.productType || "unknown",
              expiresAt: item.expiresAt,
            };
          }),
      }));
    },
    listAllOrders() {
      return read().accounts.flatMap((account) => (account.orders || []).map((order) => {
        const lot = (account.beanLots || []).find((item) => item.id === order.beanLotId);
        const entitlement = (account.entitlements || []).find((item) => item.id === order.entitlementId);
        return {
          ...clone(order),
          userId: account.userId,
          beanGranted: lot?.grantedAmount || 0,
          beanRemaining: lot?.remainingAmount || 0,
          entitlementExpiresAt: entitlement?.expiresAt || null,
          entitlementRevoked: Boolean(entitlement?.revokedAt),
        };
      })).sort((left, right) => right.createdAt - left.createdAt);
    },
    listProducts(activeOnly = false) {
      const products = read().products;
      return clone(activeOnly ? products.filter((item) => item.active) : products);
    },
    upsertProduct(payload) {
      const state = read();
      const index = state.products.findIndex((item) => item.id === payload.id);
      const product = normalizeProduct(payload, index >= 0 ? state.products[index] : null);
      if (index >= 0 && (state.products[index].productType === "bean_pack") !== (product.productType === "bean_pack")) {
        throw new Error("billing_product_type_invalid");
      }
      if (product.productType !== "bean_pack") {
        const samePackage = state.products.filter((item) => item.id !== product.id && item.packageKey === product.packageKey);
        const scope = (item) => JSON.stringify({
          projectId: item.projectId,
          productType: item.productType,
          packageName: item.packageName,
          scopeLabel: item.scopeLabel,
          subjectIds: stringList(item.subjectIds).sort(),
          bookIds: stringList(item.bookIds).sort(),
        });
        if (samePackage.some((item) => scope(item) !== scope(product))) throw new Error("billing_package_scope_conflict");
        if (samePackage.some((item) => item.durationDays === product.durationDays)) throw new Error("billing_package_duration_duplicate");
      } else {
        // 豆币组的组名只能由「编辑组」改：新增/编辑单条豆币规格时一律继承同组现有组名，
        // 否则组内会出现几个不同的 packageName，组表头和订单文案就会互相打架。
        const sibling = state.products.find((item) => isBeanPackType(item.productType) && item.id !== product.id);
        if (sibling) product.packageName = sibling.packageName;
      }
      if (index >= 0) state.products[index] = product;
      else state.products.push(product);
      write(state);
      return clone(product);
    },
    updatePackageGroup(packageKey, payload) {
      const state = read();
      const members = state.products.filter((item) => item.packageKey === packageKey);
      if (!members.length) throw new Error("billing_package_not_found");
      const beanMembers = members.filter((item) => isBeanPackType(item.productType));
      // 一个组要么全是豆币充值、要么全是订阅规格：混在一起是脏数据，直接拒绝并保持原状态。
      if (beanMembers.length && beanMembers.length !== members.length) throw new Error("billing_product_type_invalid");
      if (beanMembers.length) {
        // 豆币充值组只有「组名」是组级资料（没有考试项目/范围/科目/教材，也没有期限去重）。
        const updated = members.map((item) => normalizeProduct({ packageName: payload.packageName, id: item.id }, item));
        state.products = state.products.map((item) => updated.find((member) => member.id === item.id) || item);
        write(state);
        return clone(updated);
      }
      if (payload.productType === "bean_pack" || payload.productType === "ai_credit_pack") {
        throw new Error("billing_product_type_invalid");
      }
      const shared = {
        packageName: payload.packageName,
        projectId: payload.projectId,
        productType: payload.productType,
        scopeLabel: payload.scopeLabel,
        subjectIds: payload.subjectIds,
        bookIds: payload.bookIds,
      };
      const updated = members.map((item) => normalizeProduct({ ...shared, id: item.id }, item));
      state.products = state.products.map((item) => updated.find((member) => member.id === item.id) || item);
      write(state);
      return clone(updated);
    },
    setProductActive(productId, active) {
      const state = read();
      const product = state.products.find((item) => item.id === productId);
      if (!product) throw new Error("billing_product_not_found");
      product.active = active === true;
      product.updatedAt = Date.now();
      write(state);
      return clone(product);
    },
    // 模拟支付开通/充值：订阅走支付接口（本轮无真实微信支付，渠道记为 admin_simulation）
    // 并建**订单**；套餐赠送的豆币单独记流水（source=subscription_bonus，挂 orderId），
    // 两者分账，便于退款时按订单扣回赠币（DEC-107）。
    purchaseProduct(userId, productId, options = {}, now = Date.now()) {
      const state = read();
      const product = state.products.find((item) => item.id === productId && item.active);
      if (!product) throw new Error("billing_product_not_found");
      const account = ensureAccount(state, userId, "薯考同学", now);
      const requestId = String(options.requestId || "").trim();
      if (requestId) {
        const previous = account.orders.find((item) => item.requestId === requestId);
        if (previous) {
          if (previous.productId !== productId) throw new Error("billing_request_conflict");
          return {
            duplicated: true,
            product: clone(product),
            order: clone(previous),
            entitlement: clone(account.entitlements.find((item) => item.id === previous.entitlementId) || null),
            beanGrant: null,
            account: accountView(account, state.products, now),
          };
        }
      }
      const channel = String(options.channel || options.source || "admin_simulation");
      const order = {
        id: `billing-order-${crypto.randomUUID()}`,
        productId: product.id,
        productName: product.name,
        packageKey: product.packageKey,
        packageName: product.packageName,
        projectId: product.projectId,
        productType: product.productType,
        priceCents: product.priceCents,
        channel,
        requestId,
        status: "paid",
        entitlementId: "",
        beanLotId: "",
        createdAt: now,
      };
      let entitlement = null;
      let beanGrant = null;
      if (product.productType === "bean_pack") {
        beanGrant = grantLot(account, {
          amount: product.beanAmount,
          source: "paid_recharge",
          sourceLabel: `${product.name}（模拟支付）`,
          referenceId: order.id,
          orderId: order.id,
        }, now);
        order.beanLotId = beanGrant.lot.id;
      } else {
        const activeEntitlements = account.entitlements
          // 已被退款收回的权益不再参与续订叠加
          .filter((item) => {
            if (item.revokedAt || (item.expiresAt && item.expiresAt <= now)) return false;
            const purchasedProduct = state.products.find((candidate) => candidate.id === item.productId);
            const purchasedPackageKey = purchasedProduct && purchasedProduct.packageKey
              ? purchasedProduct.packageKey
              : item.productId;
            return purchasedPackageKey === product.packageKey;
          });
        const hasPermanentEntitlement = activeEntitlements.some((item) => !item.expiresAt);
        const latestExpiry = activeEntitlements.reduce((latest, item) => Math.max(latest, item.expiresAt || now), now);
        entitlement = {
          id: `entitlement-${crypto.randomUUID()}`,
          productId: product.id,
          orderId: order.id,
          startsAt: now,
          expiresAt: product.durationDays === 0 || hasPermanentEntitlement ? null : latestExpiry + product.durationDays * DAY_MS,
          source: channel,
          priceCents: product.priceCents,
          createdAt: now,
        };
        account.entitlements.push(entitlement);
        order.entitlementId = entitlement.id;
        if (product.bonusBeans > 0) {
          beanGrant = grantLot(account, {
            amount: product.bonusBeans,
            source: "subscription_bonus",
            sourceLabel: `${product.name}开通赠送`,
            expiresAt: product.bonusValidityDays > 0 ? now + product.bonusValidityDays * DAY_MS : null,
            referenceId: order.id,
            orderId: order.id,
          }, now);
          order.beanLotId = beanGrant.lot.id;
        }
      }
      account.orders.push(order);
      account.updatedAt = now;
      write(state);
      return {
        product: clone(product),
        order: clone(order),
        entitlement: clone(entitlement),
        beanGrant: clone(beanGrant),
        account: accountView(account, state.products, now),
      };
    },
    grantBeans(userId, payload, now = Date.now()) {
      const state = read();
      const account = ensureAccount(state, userId, "薯考同学", now);
      const result = grantLot(account, payload, now);
      write(state);
      return { ...clone(result), account: accountView(account, state.products, now) };
    },
    consumeBeans(userId, payload, now = Date.now()) {
      const state = read();
      const account = ensureAccount(state, userId, "薯考同学", now);
      const referenceId = String(payload.referenceId || "");
      // 同上：按原始值校验精度，避免 0.05 被抬成 0.1 后多扣费。
      if (!isBeanAmount(payload.amount)) throw new Error("billing_bean_amount_invalid");
      const amount = roundBeans(payload.amount);
      if (referenceId) {
        const prior = account.transactions.filter((item) => item.transactionType === "consume" && item.referenceId === referenceId);
        if (prior.length) return { duplicated: true, consumedAmount: roundBeans(-prior.reduce((total, item) => total + item.amount, 0)), account: accountView(account, state.products, now) };
      }
      if (balance(account, now) + 1e-9 < amount) throw new Error("billing_bean_insufficient");
      const lots = activeLots(account, now).sort(sortLotsByExpiry);
      let remaining = amount;
      const transactions = [];
      lots.forEach((lot) => {
        if (!remaining) return;
        const consumed = roundBeans(Math.min(remaining, lot.remainingAmount));
        lot.remainingAmount = roundBeans(lot.remainingAmount - consumed);
        remaining = roundBeans(remaining - consumed);
        const transaction = {
          id: `bean-tx-${crypto.randomUUID()}`,
          beanLotId: lot.id,
          transactionType: "consume",
          amount: -consumed,
          balanceAfter: balance(account, now),
          source: String(payload.source || "ai_call"),
          description: String(payload.description || "AI 有效调用").slice(0, 200),
          referenceId,
          createdAt: now,
          unit: BEAN_UNIT,
        };
        account.transactions.push(transaction);
        transactions.push(transaction);
      });
      account.updatedAt = now;
      write(state);
      return { duplicated: false, consumedAmount: amount, transactions: clone(transactions), account: accountView(account, state.products, now) };
    },
    // 收回订阅权（与「扣回赠币」是**两件独立的事**，可分别执行，产品负责人 2026-10-03 口径）：
    // 只把该订单对应的 entitlement 置为已收回（保留记录与原因，审计可追溯），
    // 不动豆币；同一商品的其它订单（续订叠加）不受影响。幂等。
    revokeOrderEntitlement(orderId, reason = "", now = Date.now()) {
      const state = read();
      const account = state.accounts.find((item) => (item.orders || []).some((order) => order.id === orderId));
      if (!account) throw new Error("billing_order_not_found");
      const order = account.orders.find((item) => item.id === orderId);
      const entitlement = (account.entitlements || []).find((item) => item.id === order.entitlementId);
      if (!entitlement) {
        return { duplicated: false, revokedEntitlement: null, account: accountView(account, state.products, now) };
      }
      if (entitlement.revokedAt) {
        return { duplicated: true, revokedEntitlement: clone(entitlement), account: accountView(account, state.products, now) };
      }
      entitlement.revokedAt = now;
      entitlement.revokeReason = String(reason || "").slice(0, 200);
      entitlement.updatedAt = now;
      account.updatedAt = now;
      write(state);
      return { duplicated: false, revokedEntitlement: clone(entitlement), account: accountView(account, state.products, now) };
    },
    // 扣回赠币（独立操作）：只扣该订单**未消费**的赠币/充值批次（已消费部分不动、不冲减其它批次），写一条 revoke 流水。幂等。
    clawBackOrderBeans(orderId, reason = "", now = Date.now()) {
      const state = read();
      const account = state.accounts.find((item) => (item.orders || []).some((order) => order.id === orderId));
      if (!account) throw new Error("billing_order_not_found");
      const order = account.orders.find((item) => item.id === orderId);
      const lot = (account.beanLots || []).find((item) => item.id === order.beanLotId);
      if (!lot || lot.remainingAmount <= 0) {
        return { duplicated: false, clawedBackBeans: 0, account: accountView(account, state.products, now) };
      }
      const clawedBackBeans = roundBeans(lot.remainingAmount);
      lot.remainingAmount = 0;
      account.transactions.push({
        id: `bean-tx-${crypto.randomUUID()}`,
        beanLotId: lot.id,
        transactionType: "revoke",
        amount: -clawedBackBeans,
        balanceAfter: balance(account, now),
        source: "order_refund",
        description: String(reason || "订单退款扣回赠送豆币").slice(0, 200),
        referenceId: order.id,
        createdAt: now,
        unit: BEAN_UNIT,
      });
      account.updatedAt = now;
      write(state);
      return { duplicated: false, clawedBackBeans, account: accountView(account, state.products, now) };
    },
    // 退款（把上面两件事按模式组合；两者本身仍是独立操作）：
    //   mode = "revoke"（默认，一般情况）：收回该订单的订阅权 **且** 扣回未消费赠币；
    //   mode = "refund_only"（仅退款）：钱退了，但**不**收回订阅权、**不**扣回赠币。
    // 套餐订单（钱）与赠币流水分开记账，所以两种模式都能如实记录。
    refundOrder(orderId, options = {}, now = Date.now()) {
      const payload = typeof options === "string" ? { reason: options } : (options || {});
      const mode = String(payload.mode || "revoke");
      if (!["revoke", "refund_only"].includes(mode)) throw new Error("billing_refund_mode_invalid");
      const state = read();
      const account = state.accounts.find((item) => (item.orders || []).some((order) => order.id === orderId));
      if (!account) throw new Error("billing_order_not_found");
      const order = account.orders.find((item) => item.id === orderId);
      if (order.status === "refunded") {
        return { duplicated: true, mode: order.refundMode || "revoke", order: clone(order), clawedBackBeans: 0, revokedEntitlement: null, account: accountView(account, state.products, now) };
      }
      const reason = String(payload.reason || "").slice(0, 200);
      // 先在本进程内按模式完成两件事（独立方法各自 write 一次；这里直接改同一份 state，避免中间态落盘）。
      let clawedBackBeans = 0;
      let revokedEntitlement = null;
      if (mode === "revoke") {
        const entitlement = (account.entitlements || []).find((item) => item.id === order.entitlementId);
        if (entitlement && !entitlement.revokedAt) {
          entitlement.revokedAt = now;
          entitlement.revokeReason = reason;
          entitlement.updatedAt = now;
          revokedEntitlement = entitlement;
        }
        const lot = (account.beanLots || []).find((item) => item.id === order.beanLotId);
        if (lot && lot.remainingAmount > 0) {
          clawedBackBeans = roundBeans(lot.remainingAmount);
          lot.remainingAmount = 0;
          account.transactions.push({
            id: `bean-tx-${crypto.randomUUID()}`,
            beanLotId: lot.id,
            transactionType: "revoke",
            amount: -clawedBackBeans,
            balanceAfter: balance(account, now),
            source: "order_refund",
            description: reason || "订单退款扣回赠送豆币",
            referenceId: order.id,
            createdAt: now,
            unit: BEAN_UNIT,
          });
        }
      }
      order.status = "refunded";
      order.refundMode = mode;
      order.refundedAt = now;
      order.refundReason = reason;
      account.updatedAt = now;
      write(state);
      return {
        duplicated: false,
        mode,
        order: clone(order),
        clawedBackBeans,
        revokedEntitlement: clone(revokedEntitlement),
        account: accountView(account, state.products, now),
      };
    },
    /**
     * 交易与税务审计字段按留存要求保留，但解除业务账号关联。
     * 账号注销后旧 userId 不再能访问这条账务记录。
     */
    anonymizeUser(userId, now = Date.now()) {
      const target = String(userId || "").trim();
      if (!target) return false;
      const state = read();
      const index = state.accounts.findIndex((item) => item.userId === target);
      if (index < 0) return false;
      const account = state.accounts[index];
      const hasFinancialRecords = (account.orders || []).length
        || (account.transactions || []).length
        || (account.entitlements || []).length
        || (account.beanLots || []).length;
      if (!hasFinancialRecords) {
        state.accounts.splice(index, 1);
      } else {
        account.userId = `billing-anonymous-${crypto.randomUUID()}`;
        account.nickname = "匿名用户";
        account.anonymizedAt = now;
        account.updatedAt = now;
      }
      write(state);
      return true;
    },
    // 幂等落盘点：把内存里已折算好的豆币状态写回（文件分支 / PostgreSQL 快照分支共用）。
    normalizeUnits(now = Date.now()) {
      const state = read();
      state.unit = BEAN_UNIT;
      write(state);
      return { unit: BEAN_UNIT, accounts: state.accounts.length, products: state.products.length, normalizedAt: now };
    },
  };
}

function writeStateFile(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function createFileBillingStore(filePath = path.resolve(__dirname, "../../../.runtime/billing.json")) {
  return createBillingStore({
    read() {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        // 折算只在内存里做，**读不写盘**：否则任何创建了默认文件 store 的进程（含测试）都会改正式数据。
        // 落盘路径有两条：① 下一次真正的写操作（write 会把折算后的状态整份写回）；
        // ② 运维显式执行 scripts/migrate-billing-beans.js --write。
        return migrateLegacyState(parsed).state;
      } catch (error) {
        if (error.code === "ENOENT") return initialState();
        throw error;
      }
    },
    write(state) {
      writeStateFile(filePath, state);
    },
  });
}

function createMemoryBillingStore(state = initialState()) {
  const { state: migrated } = migrateLegacyState(clone(state));
  let value = clone(migrated);
  return createBillingStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  DAY_MS,
  BEANS_PER_CREDIT,
  BEAN_UNIT,
  BEAN_RECHARGE_PACKAGE,
  BEAN_RECHARGE_PACKAGE_KEY,
  BEAN_RECHARGE_PACKAGE_NAME,
  createFileBillingStore,
  createMemoryBillingStore,
  initialState,
  migrateLegacyState,
  normalizeProduct,
  roundBeans,
  formatBeans,
};
