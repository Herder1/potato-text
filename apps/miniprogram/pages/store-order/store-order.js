const { formatBeans } = require("../../utils/bean-pricing");

function formatPrice(priceCents, symbol = "¥") {
  const amount = Math.max(0, Number(priceCents) || 0) / 100;
  return `${symbol}${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2).replace(/0$/, "")}`;
}

function formatDuration(days) {
  const value = Number(days);
  return value === 0 ? "永久" : `${Number.isFinite(value) && value > 0 ? value : 365} 天`;
}

function projectOptionsFromCatalog(payload) {
  const projects = Array.isArray(payload && payload.projects) && payload.projects.length
    ? payload.projects
    : (payload && payload.project ? [payload.project] : []);
  return projects
    .filter((project) => project && String(project.id || "").trim())
    .map((project) => ({
      id: String(project.id),
      label: String(project.name || project.id),
      sublabel: [project.region, project.examType].map((part) => String(part || "").trim()).filter(Boolean).join(" · "),
    }));
}

function normalizeVariant(product, projectMap) {
  const durationDays = Number(product.durationDays);
  const effectiveDurationDays = Number.isFinite(durationDays) && durationDays >= 0 ? durationDays : 365;
  const projectId = String(product.projectId || "");
  const project = projectMap.get(projectId);
  const bonusBeans = Number(product.bonusBeans) || 0;
  const bonusLabel = bonusBeans > 0
    ? `赠送${formatBeans(bonusBeans)}豆币`
    : effectiveDurationDays > 0
      ? `仅${formatPrice(Math.ceil(Math.max(0, Number(product.priceCents) || 0) / effectiveDurationDays), "￥")}/天`
      : `仅${formatPrice(product.priceCents, "￥")}永久有效`;
  return {
    ...product,
    projectId,
    projectName: project ? project.label : (product.scopeLabel || "对应考试项目"),
    packageKey: String(product.packageKey || product.id),
    packageName: String(product.packageName || product.name || "学习套餐"),
    durationDays: effectiveDurationDays,
    durationLabel: formatDuration(effectiveDurationDays),
    priceLabel: formatPrice(product.priceCents),
    bonusLabel,
    scopeText: product.scopeLabel || "对应题库与学习资料",
  };
}

function groupProducts(products, projectMap, activeProjectId, selectedPackageKey = "") {
  const groups = new Map();
  products
    .filter((product) => product.productType !== "bean_pack" && product.productType !== "ai_credit_pack")
    .filter((product) => !activeProjectId || String(product.projectId || "") === activeProjectId)
    .forEach((product) => {
      const variant = normalizeVariant(product, projectMap);
      const group = groups.get(variant.packageKey) || {
        packageKey: variant.packageKey,
        packageName: variant.packageName,
        projectId: variant.projectId,
        projectName: variant.projectName,
        scopeText: variant.scopeText,
        variants: [],
        selectedVariantId: "",
      };
      group.variants.push(variant);
      groups.set(variant.packageKey, group);
    });
  return [...groups.values()].map((group) => {
    group.variants.sort((left, right) => {
      if (left.durationDays === 0 && right.durationDays === 0) return left.priceCents - right.priceCents;
      if (left.durationDays === 0) return 1;
      if (right.durationDays === 0) return -1;
      return left.durationDays - right.durationDays || left.priceCents - right.priceCents;
    });
    const preferred = group.variants.find((variant) => variant.id === selectedPackageKey)
      || group.variants[0]
      || null;
    group.selectedVariantId = preferred ? preferred.id : "";
    group.selectedVariant = preferred;
    return group;
  });
}

Page({
  data: {
    activeCategory: "library",
    testPurchaseEnabled: false,
    purchaseBusy: false,
    projects: [],
    activeProjectId: "",
    products: [],
    packageGroups: [],
    selectedProductId: "",
    packageKeyHint: "",
    loading: false,
    loadFailed: false,
  },

  onLoad(options = {}) {
    this.setData({
      activeProjectId: String(options.projectId || ""),
      packageKeyHint: String(options.packageKey || ""),
    });
  },

  onShow() {
    const app = getApp();
    this.setData({ testPurchaseEnabled: app.globalData.apiEnvironment === "develop" });
    this.loadCatalog();
    this.loadProducts();
  },

  selectCategory(event) {
    const category = String(event.currentTarget.dataset.category || "");
    if (category === "membership" || category === "library") this.setData({ activeCategory: category });
  },

  loadCatalog() {
    const app = getApp();
    const baseUrl = String(app && app.globalData && app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl || typeof wx.request !== "function") return;
    wx.request({
      url: `${baseUrl}/api/catalog`,
      method: "GET",
      timeout: 8000,
      success: (response) => {
        const projects = response && response.statusCode === 200 ? projectOptionsFromCatalog(response.data) : [];
        this.setData({ projects }, () => this.applyGroups());
      },
    });
  },

  loadProducts() {
    const app = getApp();
    const baseUrl = String(app && app.globalData && app.globalData.apiBaseUrl || "").replace(/\/$/, "");
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
        const products = response.statusCode === 200 && response.data && Array.isArray(response.data.products)
          ? response.data.products
          : null;
        if (!products) {
          this.setData({ loading: false, loadFailed: true });
          return;
        }
        this.setData({ products, loading: false, loadFailed: false }, () => this.applyGroups());
      },
      fail: () => this.setData({ loading: false, loadFailed: true }),
    });
  },

  applyGroups() {
    const projectMap = new Map(this.data.projects.map((project) => [String(project.id), project]));
    let groups = groupProducts(this.data.products, projectMap, this.data.activeProjectId, this.data.selectedProductId || this.data.packageKeyHint);
    if (this.data.packageKeyHint && !this.data.selectedProductId) {
      const group = groups.find((item) => item.packageKey === this.data.packageKeyHint);
      if (group && group.selectedVariant) this.setData({ selectedProductId: group.selectedVariant.id });
    }
    groups = groups.map((group) => ({
      ...group,
      selectedVariant: group.variants.find((variant) => variant.id === group.selectedVariantId) || group.variants[0],
    }));
    this.setData({ packageGroups: groups });
  },

  selectProject(event) {
    const activeProjectId = String(event.currentTarget.dataset.id || "");
    this.setData({ activeProjectId, selectedProductId: "" }, () => this.applyGroups());
  },

  selectVariant(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id) return;
    this.setData({ selectedProductId: id }, () => this.applyGroups());
  },

  openPurchaseNotice() {
    wx.showModal({
      title: "购买须知与退款说明",
      content: "套餐订单与赠送豆币分账，权益以支付确认页为准。微信支付通道尚未启用；启用后如需退款，请通过「帮助与反馈」联系我们。",
      showCancel: false,
      confirmText: "我知道了",
    });
  },

  startPurchase(event) {
    if (!this.data.testPurchaseEnabled || this.data.purchaseBusy) return;
    const id = String(event.currentTarget.dataset.id || this.data.selectedProductId || "");
    const product = this.data.products.find((item) => String(item.id) === id);
    if (!product) return;
    const app = getApp();
    if (app.globalData.loggedIn !== true) {
      wx.showModal({
        title: "登录后购买",
        content: "登录后，套餐权益才能同步到账号。",
        confirmText: "去登录",
        success: (result) => {
          if (result.confirm) wx.switchTab({ url: "/pages/profile/profile" });
        },
      });
      return;
    }
    wx.showModal({
      title: "确认测试订购",
      content: `${product.packageName || product.name} · ${formatDuration(product.durationDays)} · ${formatPrice(product.priceCents)}\n\n仅生成测试订单并开通权益，不会扣款。可到后台订单退款。`,
      confirmText: "测试订购",
      success: ({ confirm }) => {
        if (confirm) this.submitTestPurchase(product);
      },
    });
  },

  submitTestPurchase(product) {
    const app = getApp();
    const token = app.globalData.authToken;
    const baseUrl = String(app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    if (!token || !baseUrl) {
      wx.showToast({ title: "请重新登录后再试", icon: "none" });
      return;
    }
    const requestId = `mini-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.setData({ purchaseBusy: true });
    wx.request({
      url: `${baseUrl}/api/billing/test-purchase`,
      method: "POST",
      header: { Authorization: `Bearer ${token}` },
      data: { productId: product.id, requestId },
      timeout: 8000,
      success: (response) => {
        if (token !== app.globalData.authToken) return;
        if (response.statusCode !== 200 || !response.data || !response.data.order) {
          wx.showToast({ title: "测试订购失败，请稍后重试", icon: "none" });
          return;
        }
        app.globalData.billingAccount = response.data.account;
        wx.showModal({
          title: "测试订单已生成",
          content: `订单号：${response.data.order.id}\n在后台“订阅与豆币 → 账号权益”读取当前用户 ID：${app.globalData.userId}，即可查看订单并测试退款。`,
          showCancel: false,
        });
      },
      fail: () => wx.showToast({ title: "请求未完成，请检查订单记录", icon: "none" }),
      complete: () => this.setData({ purchaseBusy: false }),
    });
  },
});

module.exports = { formatPrice, formatDuration, projectOptionsFromCatalog, groupProducts };
