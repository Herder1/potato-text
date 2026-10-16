const { formatBeans } = require("../../utils/bean-pricing");
const { closeTransientLayers } = require("../../utils/page-layers");

const STORE_TABS = [
  { id: "subscriptions", label: "订阅" },
  { id: "beans", label: "豆币" },
];

const TRANSACTION_FILTERS = [
  { id: "all", label: "全部" },
  { id: "in", label: "获取" },
  { id: "out", label: "消耗" },
  { id: "expired", label: "过期" },
];

// 账面分项来源（后端 beanLots.source 的真实取值）：
// paid_recharge = 个人充值；registration_reward / subscription_bonus / order_refund / admin_adjustment = 平台赠送。
const RECHARGE_SOURCES = new Set(["paid_recharge"]);

function formatPrice(priceCents) {
  const amount = Math.max(0, Number(priceCents) || 0) / 100;
  return `¥${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2).replace(/0$/, "")}`;
}

function formatDate(timestamp) {
  const numeric = Number(timestamp);
  if (!numeric) return "--";
  const date = new Date(numeric < 1000000000000 ? numeric * 1000 : numeric);
  if (Number.isNaN(date.getTime())) return "--";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}.${month}.${day} ${hours}:${minutes}`;
}

function formatDay(timestamp) {
  const numeric = Number(timestamp);
  if (!numeric) return "";
  const date = new Date(numeric < 1000000000000 ? numeric * 1000 : numeric);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function normalizeBeanProduct(product = {}) {
  return {
    ...product,
    storeType: "beans",
    priceLabel: formatPrice(product.priceCents),
    beanAmountNumber: formatBeans(product.beanAmount),
  };
}

function groupSubscriptions(records = []) {
  const groups = new Map();
  records.forEach((item) => {
    const product = item.product || {};
    const key = String(product.packageKey || item.productId);
    const current = groups.get(key);
    const permanent = !item.expiresAt;
    const later = !current || (permanent && current.expiresAt)
      || (!permanent && current.expiresAt && Number(item.expiresAt) > Number(current.expiresAt));
    const representative = later ? item : current;
    groups.set(key, {
      ...representative,
      product: representative.product || {},
      packageKey: key,
      purchaseCount: (current ? current.purchaseCount : 0) + 1,
      expiresText: representative.expiresAt ? formatDate(representative.expiresAt).split(" ")[0] : "永久有效",
      expiresLabel: representative.expiresAt ? `至 ${formatDate(representative.expiresAt).split(" ")[0]}` : "永久有效",
      scopeText: (representative.product && representative.product.scopeLabel) || "订阅权益",
    });
  });
  return [...groups.values()];
}

function currentMembership(records = []) {
  return records
    .filter((item) => item && item.product && item.product.productType === "membership_subscription"
      && !item.revokedAt && (!item.expiresAt || Number(item.expiresAt) > Date.now()))
    .reduce((latest, item) => {
      if (!latest || !item.expiresAt || (latest.expiresAt && Number(item.expiresAt) > Number(latest.expiresAt))) return item;
      return latest;
    }, null);
}

Page({
  data: {
    tabs: STORE_TABS,
    transactionFilters: TRANSACTION_FILTERS,
    activeTab: "subscriptions",
    transactionFilter: "all",
    products: [],
    visibleProducts: [],
    beanProducts: [],
    selectedBeanId: "",
    selectedBean: null,
    rechargeSheetOpen: false,
    loading: false,
    loadFailed: false,
    // 四种可见状态：guest（未登录）/ loading（加载中）/ failed（加载失败）/ ready
    accountState: "guest",
    beanBalanceText: "0",
    beans: 0,
    rechargeBeans: 0,
    grantBeans: 0,
    // 优惠券：后端暂无券模型（2026-10-05 确认），这一栏如实显示「-」，不编数量。
    couponText: "-",
    subscriptions: [],
    memberActive: false,
    memberExpiryText: "",
    permanentBeans: 0,
    expiringBeans: 0,
    expiringText: "",
    beanTransactions: [],
    visibleTransactions: [],
    orders: [],
    ordersOpen: false,
    subscriptionDetailOpen: false,
    selectedSubscription: null,
    loggedIn: false,
  },

  onLoad(options = {}) {
    // 兼容旧入口仍带 tab=credits 的情况：语义就是现在的「豆币」页签。
    const requestedTab = options.tab === "credits" ? "beans" : options.tab;
    const activeTab = STORE_TABS.some((tab) => tab.id === requestedTab) ? requestedTab : "subscriptions";
    this.setData({ activeTab });
  },

  onShow() {
    const app = getApp();
    const loggedIn = app.globalData.loggedIn === true;
    this.setData({ loggedIn, accountState: loggedIn ? "loading" : "guest" });
    this.applyAccount(app.globalData.billingAccount);
    if (typeof app.syncBillingAccount === "function") app.syncBillingAccount((account) => this.applyAccount(account));
    this.loadProducts();
  },

  // 离开页面收掉所有瞬态浮层（订单 / 充值弹层），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["ordersOpen", "rechargeSheetOpen", "subscriptionDetailOpen"], { selectedSubscription: null });
  },

  applyAccount(account = {}) {
    const entitlements = Array.isArray(account && account.subscriptions) ? account.subscriptions : [];
    const membership = currentMembership(entitlements);
    const subscriptions = groupSubscriptions(entitlements.filter((item) => item && (!item.product || item.product.productType !== "membership_subscription")));
    const beanTransactions = (Array.isArray(account && account.transactions) ? account.transactions : []).slice(0, 30).map((item) => ({
      ...item,
      amountText: `${Number(item.amount) > 0 ? "+" : ""}${formatBeans(item.amount)}`,
      timeText: formatDate(item.createdAt),
      income: Number(item.amount) > 0,
      // 过期流水：后端目前只实时计算到期金额、不写流水（2026-10-05 确认），
      // 所以「过期」筛选按描述兜底识别；没有记录时该页签显示空态，不编数据。
      expired: Number(item.amount) < 0 && /过期|expired/i.test(String(item.description || "")),
    }));
    const orders = (Array.isArray(account && account.orders) ? account.orders : []).slice(0, 30).map((item) => ({
      ...item,
      timeText: formatDate(item.createdAt),
      amountText: formatPrice(item.amountCents || item.priceCents || 0),
      statusText: item.status === "refunded" ? "已退款" : item.channel === "user_test_simulation" ? "测试已开通" : item.status === "paid" ? "已支付" : item.status === "pending" ? "待支付" : String(item.status || "已记录"),
    }));
    // 限时豆币到期日：取最早到期的那一批（真实数据，不编日期）。
    const liveLots = (Array.isArray(account && account.beanLots) ? account.beanLots : [])
      .filter((lot) => lot && Number(lot.remainingAmount) > 0);
    const expiringLot = liveLots
      .filter((lot) => lot.expiresAt)
      .sort((left, right) => Number(left.expiresAt) - Number(right.expiresAt))[0];
    // 账面分项：按批次来源拆分（个人充值 / 平台赠送）。
    const sumLots = (predicate) => liveLots
      .filter(predicate)
      .reduce((total, lot) => total + (Number(lot.remainingAmount) || 0), 0);
    const rechargeBeans = sumLots((lot) => RECHARGE_SOURCES.has(String(lot.source || "")));
    const grantBeans = sumLots((lot) => !RECHARGE_SOURCES.has(String(lot.source || "")));
    const beans = Number(account && account.beanBalance) || 0;
    this.setData({
      beans,
      beanBalanceText: formatBeans(beans),
      rechargeBeans,
      grantBeans,
      subscriptions,
      memberActive: Boolean(membership),
      memberExpiryText: membership ? (membership.expiresAt ? `${formatDay(membership.expiresAt)} 到期` : "永久有效") : "",
      permanentBeans: Number(account && account.permanentBeans) || 0,
      expiringBeans: Number(account && account.expiringBeans) || 0,
      expiringText: expiringLot ? `${formatDay(expiringLot.expiresAt)} 到期` : "",
      beanTransactions,
      orders,
    }, () => this.applyFilter());
  },

  loadProducts() {
    const app = getApp();
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") {
      this.setData({ loadFailed: true, accountState: this.data.loggedIn ? "failed" : "guest" });
      return;
    }
    this.setData({ loading: true, loadFailed: false });
    wx.request({
      url: `${baseUrl}/api/billing/products`,
      method: "GET",
      timeout: 8000,
      success: (response) => {
        const records = response.statusCode === 200 && response.data && response.data.products;
        if (!Array.isArray(records)) {
          this.setData({ loading: false, loadFailed: true, accountState: this.data.loggedIn ? "failed" : "guest" });
          return;
        }
        const products = records.filter((product) => product.productType === "bean_pack").map(normalizeBeanProduct);
        this.setData({ products, loading: false, loadFailed: false, accountState: this.data.loggedIn ? "ready" : "guest" }, () => this.applyFilter());
      },
      fail: () => this.setData({ loading: false, loadFailed: true, accountState: this.data.loggedIn ? "failed" : "guest" }),
    });
  },

  applyFilter() {
    const { activeTab, transactionFilter } = this.data;
    const visibleProducts = activeTab === "beans" ? this.data.products : [];
    const visibleTransactions = this.data.beanTransactions.filter((item) => {
      if (transactionFilter === "all") return true;
      if (transactionFilter === "in") return item.income;
      if (transactionFilter === "out") return !item.income && !item.expired;
      if (transactionFilter === "expired") return item.expired;
      return true;
    });
    this.setData({
      visibleProducts,
      beanProducts: this.data.products,
      visibleTransactions,
    });
  },

  selectTab(event) {
    const activeTab = event.currentTarget.dataset.id;
    if (!STORE_TABS.some((tab) => tab.id === activeTab)) return;
    this.setData({ activeTab }, () => this.applyFilter());
  },

  selectTransactionFilter(event) {
    const id = event.currentTarget.dataset.id;
    if (!TRANSACTION_FILTERS.some((filter) => filter.id === id)) return;
    this.setData({ transactionFilter: id }, () => this.applyFilter());
  },

  // 充值规格：点一下只做**选中**（品牌绿），真正的支付在弹窗底栏的「立即支付」。
  selectBeanPack(event) {
    this.applyBeanSelection(String(event.currentTarget.dataset.id || ""));
  },

  applyBeanSelection(id) {
    const selected = this.data.beanProducts.find((item) => String(item.id) === String(id)) || this.data.beanProducts[0] || null;
    this.setData({ selectedBeanId: selected ? selected.id : "", selectedBean: selected });
  },

  // 充值下滑弹窗（2026-10-05 产品负责人要求：充值改到底部弹层里）
  openRechargeSheet() {
    this.setData({ rechargeSheetOpen: true });
    this.applyBeanSelection(this.data.selectedBeanId || (this.data.beanProducts[0] || {}).id);
  },

  closeRechargeSheet() {
    this.setData({ rechargeSheetOpen: false });
  },

  // 弹窗底栏「立即支付」：仍走原有购买确认（微信支付通道未启用，不扣款）。
  paySelectedBeanPack() {
    const selected = this.data.selectedBean;
    if (!selected) return;
    this.startPurchase({ currentTarget: { dataset: { id: selected.id } } });
  },

  openOrders() {
    if (!this.data.orders.length) {
      wx.showToast({ title: "暂无订单记录", icon: "none" });
      return;
    }
    this.setData({ ordersOpen: true });
  },

  closeOrders() {
    this.setData({ ordersOpen: false });
  },

  openSubscriptionDetail(event) {
    const productId = String(event.currentTarget.dataset.id || "");
    const selectedSubscription = this.data.subscriptions.find((item) => String(item.productId) === productId);
    if (!selectedSubscription) return;
    this.setData({ subscriptionDetailOpen: true, selectedSubscription });
  },

  closeSubscriptionDetail() {
    this.setData({ subscriptionDetailOpen: false, selectedSubscription: null });
  },

  openOrderPage() {
    wx.navigateTo({ url: "/pages/store-order/store-order" });
  },

  // 「续订」进入统一订购页，并优先带上当前套餐的分组。
  renewSubscription(event) {
    const productId = String(event.currentTarget.dataset.id || "");
    const subscription = this.data.subscriptions.find((item) => String(item.productId) === productId);
    const product = subscription && subscription.product;
    if (!product) {
      wx.showToast({ title: "该套餐已下架，请在订购页选择其他套餐", icon: "none" });
      return;
    }
    const packageKey = product.packageKey || productId;
    wx.navigateTo({ url: `/pages/store-order/store-order?packageKey=${encodeURIComponent(packageKey)}` });
  },

  // 购买须知 / 退款说明：沿用原有口径文案（套餐订单与赠送豆币分账），不新造规则。
  openPurchaseNotice() {
    wx.showModal({
      title: "购买须知与退款说明",
      content: "套餐订单与赠送豆币分账，权益以支付确认页为准。微信支付通道尚未启用；启用后如需退款，请通过「帮助与反馈」联系我们。",
      showCancel: false,
      confirmText: "我知道了",
    });
  },

  openLegal(event) {
    const doc = String(event.currentTarget.dataset.doc || "");
    wx.navigateTo({ url: `/pages/legal/legal?doc=${encodeURIComponent(doc)}` });
  },

  startPurchase(event) {
    const id = event.currentTarget.dataset.id;
    const product = this.data.products.find((item) => item.id === id);
    if (!product) return;
    const app = getApp();
    if (app.globalData.loggedIn !== true) {
      wx.showModal({
        title: "登录后购买",
        content: "登录后，订阅权益和豆币才能同步到账号。",
        confirmText: "去登录",
        success: (result) => {
          if (result.confirm) wx.switchTab({ url: "/pages/profile/profile" });
        },
      });
      return;
    }
    wx.showModal({
      title: product.name,
      content: `${product.priceLabel} · ${product.scopeLabel}\n\n微信支付通道尚未启用，本次不会扣款。`,
      confirmText: "我知道了",
      showCancel: false,
      success: () => wx.setStorageSync("shukao_pending_billing_product", product.id),
    });
  },
});

module.exports = { STORE_TABS, TRANSACTION_FILTERS, formatDate, formatPrice, normalizeBeanProduct, groupSubscriptions };
