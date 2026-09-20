const STORE_TABS = [
  { id: "subscriptions", label: "订阅" },
  { id: "credits", label: "AI 额度" },
];

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

function normalizeStoreProduct(product = {}, subscriptions = []) {
  const isCreditPack = product.productType === "ai_credit_pack";
  const owned = !isCreditPack && subscriptions.some((item) => item.productId === product.id);
  const benefits = isCreditPack
    ? [`${Number(product.creditAmount) || 0} 点 AI 额度`, "充值额度长期有效", "评分、解析与追问通用"]
    : [
      `${Number(product.durationDays) || 365} 天使用期`,
      product.scopeLabel || "对应题库与学习资料",
      Number(product.bonusAiCredits) > 0 ? `赠送 ${product.bonusAiCredits} 点 AI 额度` : "学习记录跨设备同步",
    ];
  return {
    ...product,
    storeType: isCreditPack ? "credits" : "subscriptions",
    priceLabel: formatPrice(product.priceCents),
    priceSuffix: isCreditPack ? "一次购买" : `/${Number(product.durationDays) || 365} 天`,
    benefits,
    owned,
    featured: product.productType === "project_subscription",
    actionLabel: owned ? "续订" : (isCreditPack ? "立即购买" : "立即开通"),
  };
}

Page({
  data: {
    tabs: STORE_TABS,
    activeTab: "subscriptions",
    products: [],
    visibleProducts: [],
    loading: false,
    loadFailed: false,
    selectedProduct: null,
    aiCredits: 0,
    subscriptions: [],
    permanentCredits: 0,
    expiringCredits: 0,
    creditTransactions: [],
    loggedIn: false,
  },

  onLoad(options = {}) {
    const activeTab = STORE_TABS.some((tab) => tab.id === options.tab) ? options.tab : "subscriptions";
    this.setData({ activeTab });
  },

  onShow() {
    const app = getApp();
    this.applyAccount(app.globalData.billingAccount);
    this.setData({ loggedIn: app.globalData.loggedIn === true });
    if (typeof app.syncBillingAccount === "function") app.syncBillingAccount((account) => this.applyAccount(account));
    this.loadProducts();
  },

  applyAccount(account = {}) {
    const subscriptions = (Array.isArray(account && account.subscriptions) ? account.subscriptions : []).map((item) => ({
      ...item,
      product: item.product || {},
      expiresText: formatDate(item.expiresAt).split(" ")[0],
    }));
    const creditTransactions = (Array.isArray(account && account.transactions) ? account.transactions : []).slice(0, 30).map((item) => ({
      ...item,
      amountText: `${Number(item.amount) > 0 ? "+" : ""}${Number(item.amount) || 0}`,
      timeText: formatDate(item.createdAt),
    }));
    this.setData({
      aiCredits: Number(account && account.creditBalance) || 0,
      subscriptions,
      permanentCredits: Number(account && account.permanentCredits) || 0,
      expiringCredits: Number(account && account.expiringCredits) || 0,
      creditTransactions,
      products: this.data.products.map((product) => normalizeStoreProduct(product, subscriptions)),
    }, () => this.applyFilter());
  },

  loadProducts() {
    const app = getApp();
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") {
      this.setData({ loadFailed: true });
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
          this.setData({ loading: false, loadFailed: true });
          return;
        }
        const products = records.map((product) => normalizeStoreProduct(product, this.data.subscriptions));
        this.setData({ products, loading: false, loadFailed: false }, () => this.applyFilter());
      },
      fail: () => this.setData({ loading: false, loadFailed: true }),
    });
  },

  applyFilter() {
    this.setData({ visibleProducts: this.data.products.filter((product) => product.storeType === this.data.activeTab) });
  },

  selectTab(event) {
    const activeTab = event.currentTarget.dataset.id;
    if (!STORE_TABS.some((tab) => tab.id === activeTab)) return;
    this.setData({ activeTab, selectedProduct: null }, () => this.applyFilter());
  },

  openProduct(event) {
    const selectedProduct = this.data.products.find((product) => product.id === event.currentTarget.dataset.id);
    if (selectedProduct) this.setData({ selectedProduct });
  },

  closeProduct() {
    this.setData({ selectedProduct: null });
  },

  startPurchase(event) {
    const id = event.currentTarget.dataset.id || (this.data.selectedProduct && this.data.selectedProduct.id);
    const product = this.data.products.find((item) => item.id === id);
    if (!product) return;
    const app = getApp();
    if (app.globalData.loggedIn !== true) {
      wx.showModal({
        title: "登录后购买",
        content: "登录后，订阅权益和 AI 额度才能同步到账号。",
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

module.exports = { STORE_TABS, formatDate, formatPrice, normalizeStoreProduct };
