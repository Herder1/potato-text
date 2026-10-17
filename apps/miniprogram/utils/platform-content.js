// 平台文本（用户协议 / 隐私政策 / AI 服务说明 / 退款政策 / 账号注销说明 / 运营主体与客服信息 /
// 个人信息收集清单）用户端的**唯一读取入口**——口径依据 DEC-110（产品手册 §0.4，2026-10-05）：
//   1. 正文只从服务端「已发布」版本读取，页面不写死任何法务正文；
//   2. 没有已发布版本时明确显示「尚未发布」，**绝不回落占位/示例文本**（这份文本有法律效力，
//      读不到就如实说读不到，不许伪装成正式协议）；
//   3. 后台「平台设置」是唯一维护入口（仅超级管理员），用户端只读。
// 服务端接口：GET {apiBaseUrl}/api/platform-content/:key
//   已发布 → 200 { success:true, published:true, document:{ key,title,version,effectiveDate,publishedAt,body } }
//   未发布 → 200 { success:true, published:false, status:"empty"|"draft", document:{ key,title } }（不含 body）

// 图标（2026-10-17 产品负责人指出「图标风格太乱、颜色不统一」）：
//   七份文档改用专用图标组 doc-*.svg，同一套 24 视口 / stroke-width 1.8 / 统一中性色 #474d49 /
//   round cap+join，与仓库其它线性图标一致；不再借用 list、format-magic、user-outline 这类
//   属于别的入口（未登录头像、编辑器工具栏）的图标，也不再混用品牌绿与橙色填充。
const DOCS = [
  { key: "terms", title: "用户协议", icon: "/assets/icons/doc-terms.svg", desc: "使用薯考时的权利义务" },
  { key: "privacy", title: "隐私政策", icon: "/assets/icons/doc-privacy.svg", desc: "我们如何处理你的个人信息" },
  { key: "ai-service", title: "AI 服务说明", icon: "/assets/icons/doc-ai.svg", desc: "AI 功能范围与扣费规则" },
  { key: "refund", title: "退款政策", icon: "/assets/icons/doc-refund.svg", desc: "套餐订单与豆币的退款口径" },
  { key: "account-deletion", title: "账号注销说明", icon: "/assets/icons/doc-account-deletion.svg", desc: "注销后数据的处置方式" },
  { key: "operator", title: "运营主体与客服信息", icon: "/assets/icons/doc-operator.svg", desc: "经营主体、营业执照与联系方式" },
  { key: "personal-info", title: "个人信息收集清单", icon: "/assets/icons/doc-personal-info.svg", desc: "收集了哪些信息、用来做什么" },
];

/** 未发布时的统一口径（各页共用一处文案，避免页面各写一套）。 */
const UNPUBLISHED_TITLE = "尚未发布";
const UNPUBLISHED_NOTE = "这份文本还没有发布。正式版本发布后会显示在这里；在此之前我们不会用占位或示例文字充数。";
const FAILED_NOTE = "暂时读不到这份文本，请检查网络后重试。";

/** 已发布内容的本机缓存时长：撤回发布的文本不应长期留在本机，也不该每次进页都打接口。 */
const CACHE_TTL = 5 * 60 * 1000;

const cache = Object.create(null);

function docList() {
  return DOCS.map((doc) => ({ ...doc }));
}

function findDoc(key) {
  const target = String(key || "").trim();
  return DOCS.find((doc) => doc.key === target) || null;
}

/** 纯文本正文 → 段落数组（后台正文按换行分段，空行忽略）。 */
function splitParagraphs(body) {
  return String(body == null ? "" : body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 版本行文案：「版本 1.2 · 生效 2026-10-01」；两栏都缺失时给空串（页面据此隐藏这一行）。 */
function versionLabel(document) {
  const source = document || {};
  const version = String(source.version || "").trim();
  const effectiveDate = String(source.effectiveDate || "").trim();
  if (!version && !effectiveDate) return "";
  if (version && effectiveDate) return `版本 ${version} · 生效 ${effectiveDate}`;
  return version ? `版本 ${version}` : `生效 ${effectiveDate}`;
}

/** 页面副标题：已发布显示「版本 x · 生效 y」，其余状态显示状态本身。 */
function statusLine(state, versionLabelText) {
  if (state === "published") return String(versionLabelText || "");
  if (state === "unpublished") return UNPUBLISHED_TITLE;
  if (state === "failed") return "暂时读不到";
  return "正在读取…";
}

/** 首屏（还没拿到接口回包）的占位状态：标题先用本地登记的文档名，正文一律为空。 */
function loadingViewState(key) {
  const doc = findDoc(key) || DOCS[0];
  return {
    state: "loading", key: doc.key, title: doc.title, version: "", effectiveDate: "", versionLabel: "",
    statusLine: statusLine("loading"), body: "", paragraphs: [], note: "", canRetry: false,
  };
}

/**
 * 把接口回包归一成页面直接可用的状态（纯函数，便于用例覆盖）：
 *   { state: "published" | "unpublished" | "failed", key, title, version, effectiveDate,
 *     versionLabel, statusLine, body, paragraphs, note, canRetry }
 * 只有 state === "published" 时才带正文。
 */
function documentViewState(key, response) {
  const doc = findDoc(key) || { key: String(key || ""), title: "平台文本", icon: "/assets/icons/list.svg", desc: "" };
  const failed = (note) => ({
    state: "failed", key: doc.key, title: doc.title, version: "", effectiveDate: "", versionLabel: "",
    statusLine: statusLine("failed"), body: "", paragraphs: [], note: note || FAILED_NOTE, canRetry: true,
  });
  const status = response && Number(response.statusCode);
  const payload = response && response.data;
  if (!(status >= 200 && status < 300) || !payload || payload.success !== true) return failed();
  const document = payload.document || {};
  const title = String(document.title || doc.title);
  if (payload.published !== true) {
    return {
      state: "unpublished", key: doc.key, title,
      version: "", effectiveDate: "", versionLabel: "", statusLine: statusLine("unpublished"),
      body: "", paragraphs: [], note: UNPUBLISHED_NOTE, canRetry: false,
    };
  }
  const body = String(document.body == null ? "" : document.body);
  if (!body.trim()) {
    // 服务端说已发布但没有正文：按"读不到"处理，绝不用页面文字补位。
    return failed();
  }
  const versioned = {
    key: doc.key,
    title,
    version: String(document.version || ""),
    effectiveDate: String(document.effectiveDate || ""),
  };
  return {
    state: "published",
    key: doc.key,
    title,
    version: versioned.version,
    effectiveDate: versioned.effectiveDate,
    versionLabel: versionLabel(versioned),
    statusLine: statusLine("published", versionLabel(versioned)),
    body,
    paragraphs: splitParagraphs(body),
    note: "",
    canRetry: false,
  };
}

function readCache(key) {
  const hit = cache[key];
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    delete cache[key];
    return null;
  }
  return hit.state;
}

function writeCache(key, state) {
  cache[key] = { at: Date.now(), state };
  return state;
}

function requestDocument(key) {
  return new Promise((resolve) => {
    let baseUrl = "";
    try {
      const app = getApp();
      baseUrl = String((app && app.globalData && app.globalData.apiBaseUrl) || "").replace(/\/$/, "");
    } catch (error) {
      baseUrl = "";
    }
    if (!baseUrl || typeof wx.request !== "function") {
      resolve(documentViewState(key, null));
      return;
    }
    wx.request({
      url: `${baseUrl}/api/platform-content/${encodeURIComponent(key)}`,
      method: "GET",
      timeout: 8000,
      success: (response) => resolve(documentViewState(key, response)),
      fail: () => resolve(documentViewState(key, null)),
    });
  });
}

/**
 * 读取一份平台文本；**永不 reject**，失败也回一个可渲染的状态（failed + 可重试）。
 * options.force === true 时跳过长缓存（下拉刷新/点重试用）。
 */
function loadDocument(key, options = {}) {
  const doc = findDoc(key) || findDoc("terms");
  const cacheKey = doc.key;
  if (options.force !== true) {
    const cached = readCache(cacheKey);
    if (cached) return Promise.resolve(cached);
  }
  return requestDocument(cacheKey).then((state) => (state.state === "failed" ? state : writeCache(cacheKey, state)));
}

/** 用例用：清掉本机缓存，避免用例之间互相影响。 */
function resetCache() {
  Object.keys(cache).forEach((key) => { delete cache[key]; });
}

module.exports = {
  DOCS,
  UNPUBLISHED_TITLE,
  UNPUBLISHED_NOTE,
  FAILED_NOTE,
  CACHE_TTL,
  docList,
  findDoc,
  versionLabel,
  statusLine,
  splitParagraphs,
  loadingViewState,
  documentViewState,
  loadDocument,
  resetCache,
};
