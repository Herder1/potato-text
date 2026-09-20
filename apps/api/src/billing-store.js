const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { subjects, books } = require("../../../packages/domain/catalog");

const DAY_MS = 24 * 60 * 60 * 1000;
const productTypes = new Set(["project_subscription", "subject_subscription", "ai_credit_pack"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seedProducts(now = Date.now()) {
  return [
    {
      id: "product-chinese-literature-2026",
      name: "汉语言文学题库 365 天权益",
      productType: "project_subscription",
      scopeLabel: "广东普通专升本 · 五科九本",
      subjectIds: subjects.map((subject) => subject.id),
      bookIds: books.map((book) => book.id),
      durationDays: 365,
      priceCents: 19900,
      bonusAiCredits: 100,
      bonusValidityDays: 365,
      creditAmount: 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "product-modern-chinese-2026",
      name: "现代汉语题库 365 天权益",
      productType: "subject_subscription",
      scopeLabel: "现代汉语 · 上下册",
      subjectIds: ["modern-chinese"],
      bookIds: ["modern-chinese-7-1", "modern-chinese-7-2"],
      durationDays: 365,
      priceCents: 6900,
      bonusAiCredits: 30,
      bonusValidityDays: 365,
      creditAmount: 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "product-ai-credits-50",
      name: "AI 额度 50 点",
      productType: "ai_credit_pack",
      scopeLabel: "充值额度长期有效",
      subjectIds: [],
      bookIds: [],
      durationDays: 0,
      priceCents: 990,
      bonusAiCredits: 0,
      bonusValidityDays: 0,
      creditAmount: 50,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function initialState(now = Date.now()) {
  const lotId = `credit-lot-${crypto.randomUUID()}`;
  return {
    products: seedProducts(now),
    accounts: [{
      userId: "test-user",
      nickname: "薯考同学",
      entitlements: [],
      creditLots: [{
        id: lotId,
        source: "registration_reward",
        sourceLabel: "注册测试奖励",
        grantedAmount: 20,
        remainingAmount: 20,
        expiresAt: now + 30 * DAY_MS,
        createdAt: now,
      }],
      transactions: [{
        id: `credit-tx-${crypto.randomUUID()}`,
        creditLotId: lotId,
        transactionType: "grant",
        amount: 20,
        balanceAfter: 20,
        source: "registration_reward",
        description: "注册测试奖励",
        referenceId: "seed-registration-reward",
        createdAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    }],
  };
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[，,\n]/))
    .map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeProduct(payload, existing = null, now = Date.now()) {
  const productType = String(payload.productType || existing?.productType || "");
  if (!productTypes.has(productType)) throw new Error("billing_product_type_invalid");
  const name = String(payload.name ?? existing?.name ?? "").trim();
  const priceCents = Number(payload.priceCents ?? existing?.priceCents);
  const subscriptionProduct = productType !== "ai_credit_pack";
  const durationDays = subscriptionProduct ? Number(payload.durationDays ?? existing?.durationDays ?? 365) : 0;
  const bonusAiCredits = subscriptionProduct ? Number(payload.bonusAiCredits ?? existing?.bonusAiCredits ?? 0) : 0;
  const bonusValidityDays = subscriptionProduct ? Number(payload.bonusValidityDays ?? existing?.bonusValidityDays ?? durationDays) : 0;
  const creditAmount = productType === "ai_credit_pack" ? Number(payload.creditAmount ?? existing?.creditAmount) : 0;
  if (!name) throw new Error("billing_product_name_required");
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10000000) throw new Error("billing_product_price_invalid");
  if (subscriptionProduct && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 1095)) throw new Error("billing_product_duration_invalid");
  if (![bonusAiCredits, bonusValidityDays, creditAmount].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("billing_credit_amount_invalid");
  if (productType === "ai_credit_pack" && creditAmount < 1) throw new Error("billing_credit_amount_invalid");
  return {
    id: String(payload.id || existing?.id || `product-${crypto.randomUUID()}`),
    name,
    productType,
    scopeLabel: String(payload.scopeLabel ?? existing?.scopeLabel ?? "").trim().slice(0, 200),
    subjectIds: subscriptionProduct ? stringList(payload.subjectIds ?? existing?.subjectIds) : [],
    bookIds: subscriptionProduct ? stringList(payload.bookIds ?? existing?.bookIds) : [],
    durationDays,
    priceCents,
    bonusAiCredits,
    bonusValidityDays,
    creditAmount,
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
      account = { userId, nickname, entitlements: [], creditLots: [], transactions: [], createdAt: now, updatedAt: now };
      state.accounts.push(account);
    }
    return account;
  };
  const activeLots = (account, now) => account.creditLots.filter((lot) => lot.remainingAmount > 0 && (!lot.expiresAt || lot.expiresAt > now));
  const balance = (account, now) => activeLots(account, now).reduce((total, lot) => total + lot.remainingAmount, 0);
  const accountView = (account, products, now = Date.now()) => {
    const subscriptions = account.entitlements
      .filter((item) => item.expiresAt > now)
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .map((item) => ({ ...clone(item), product: clone(products.find((product) => product.id === item.productId) || null) }));
    const lots = account.creditLots.slice().sort((left, right) => {
      if (left.expiresAt && right.expiresAt) return left.expiresAt - right.expiresAt;
      if (left.expiresAt) return -1;
      if (right.expiresAt) return 1;
      return left.createdAt - right.createdAt;
    });
    return {
      userId: account.userId,
      nickname: account.nickname,
      creditBalance: balance(account, now),
      expiringCredits: activeLots(account, now).filter((lot) => lot.expiresAt).reduce((total, lot) => total + lot.remainingAmount, 0),
      permanentCredits: activeLots(account, now).filter((lot) => !lot.expiresAt).reduce((total, lot) => total + lot.remainingAmount, 0),
      subscriptions,
      creditLots: clone(lots),
      transactions: clone(account.transactions.slice().sort((left, right) => right.createdAt - left.createdAt)),
    };
  };
  const grantLot = (account, payload, now) => {
    const amount = Number(payload.amount);
    if (!Number.isInteger(amount) || amount < 1) throw new Error("billing_credit_amount_invalid");
    const lot = {
      id: `credit-lot-${crypto.randomUUID()}`,
      source: String(payload.source || "admin_adjustment"),
      sourceLabel: String(payload.sourceLabel || payload.description || "额度发放").slice(0, 200),
      grantedAmount: amount,
      remainingAmount: amount,
      expiresAt: payload.expiresAt ? Number(payload.expiresAt) : null,
      createdAt: now,
    };
    if (lot.expiresAt && lot.expiresAt <= now) throw new Error("billing_credit_expiry_invalid");
    account.creditLots.push(lot);
    const balanceAfter = balance(account, now);
    const transaction = {
      id: `credit-tx-${crypto.randomUUID()}`,
      creditLotId: lot.id,
      transactionType: "grant",
      amount,
      balanceAfter,
      source: lot.source,
      description: lot.sourceLabel,
      referenceId: String(payload.referenceId || ""),
      createdAt: now,
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
          creditBalance: view.creditBalance,
          transactions: view.transactions.length,
        },
      };
    },
    listProducts(activeOnly = false) {
      const products = read().products;
      return clone(activeOnly ? products.filter((item) => item.active) : products);
    },
    upsertProduct(payload) {
      const state = read();
      const index = state.products.findIndex((item) => item.id === payload.id);
      const product = normalizeProduct(payload, index >= 0 ? state.products[index] : null);
      if (index >= 0) state.products[index] = product;
      else state.products.push(product);
      write(state);
      return clone(product);
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
    grantProduct(userId, productId, source = "admin_simulation", now = Date.now()) {
      const state = read();
      const product = state.products.find((item) => item.id === productId && item.active);
      if (!product) throw new Error("billing_product_not_found");
      const account = ensureAccount(state, userId, "薯考同学", now);
      let entitlement = null;
      let creditGrant = null;
      if (product.productType === "ai_credit_pack") {
        creditGrant = grantLot(account, {
          amount: product.creditAmount,
          source: "paid_recharge",
          sourceLabel: `${product.name}（模拟支付）`,
          referenceId: `product:${product.id}:${now}`,
        }, now);
      } else {
        const latestExpiry = account.entitlements
          .filter((item) => item.productId === product.id && item.expiresAt > now)
          .reduce((latest, item) => Math.max(latest, item.expiresAt), now);
        entitlement = {
          id: `entitlement-${crypto.randomUUID()}`,
          productId: product.id,
          startsAt: now,
          expiresAt: latestExpiry + product.durationDays * DAY_MS,
          source,
          createdAt: now,
        };
        account.entitlements.push(entitlement);
        if (product.bonusAiCredits > 0) {
          creditGrant = grantLot(account, {
            amount: product.bonusAiCredits,
            source: "subscription_bonus",
            sourceLabel: `${product.name}开通赠送`,
            expiresAt: now + product.bonusValidityDays * DAY_MS,
            referenceId: entitlement.id,
          }, now);
        }
      }
      account.updatedAt = now;
      write(state);
      return { product: clone(product), entitlement: clone(entitlement), creditGrant: clone(creditGrant), account: accountView(account, state.products, now) };
    },
    grantCredits(userId, payload, now = Date.now()) {
      const state = read();
      const account = ensureAccount(state, userId, "薯考同学", now);
      const result = grantLot(account, payload, now);
      write(state);
      return { ...clone(result), account: accountView(account, state.products, now) };
    },
    consumeCredits(userId, payload, now = Date.now()) {
      const state = read();
      const account = ensureAccount(state, userId, "薯考同学", now);
      const amount = Number(payload.amount);
      const referenceId = String(payload.referenceId || "");
      if (!Number.isInteger(amount) || amount < 1) throw new Error("billing_credit_amount_invalid");
      if (referenceId) {
        const prior = account.transactions.filter((item) => item.transactionType === "consume" && item.referenceId === referenceId);
        if (prior.length) return { duplicated: true, consumedAmount: -prior.reduce((total, item) => total + item.amount, 0), account: accountView(account, state.products, now) };
      }
      if (balance(account, now) < amount) throw new Error("billing_credit_insufficient");
      const lots = activeLots(account, now).sort((left, right) => {
        if (left.expiresAt && right.expiresAt) return left.expiresAt - right.expiresAt;
        if (left.expiresAt) return -1;
        if (right.expiresAt) return 1;
        return left.createdAt - right.createdAt;
      });
      let remaining = amount;
      const transactions = [];
      lots.forEach((lot) => {
        if (!remaining) return;
        const consumed = Math.min(remaining, lot.remainingAmount);
        lot.remainingAmount -= consumed;
        remaining -= consumed;
        const transaction = {
          id: `credit-tx-${crypto.randomUUID()}`,
          creditLotId: lot.id,
          transactionType: "consume",
          amount: -consumed,
          balanceAfter: balance(account, now),
          source: String(payload.source || "ai_call"),
          description: String(payload.description || "AI 有效调用").slice(0, 200),
          referenceId,
          createdAt: now,
        };
        account.transactions.push(transaction);
        transactions.push(transaction);
      });
      account.updatedAt = now;
      write(state);
      return { duplicated: false, consumedAmount: amount, transactions: clone(transactions), account: accountView(account, state.products, now) };
    },
  };
}

function createFileBillingStore(filePath = path.resolve(__dirname, "../../../.runtime/billing.json")) {
  return createBillingStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return initialState(); throw error; }
    },
    write(state) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryBillingStore(state = initialState()) {
  let value = clone(state);
  return createBillingStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = { DAY_MS, createFileBillingStore, createMemoryBillingStore, initialState };
