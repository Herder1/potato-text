// 社区互动「只增不减」峰值记录（2026-10-02 产品负责人定）：
// 同一个人对同一篇内容的收藏 / 点赞**只加分一次**——取消收藏或点赞分不回退，之后再收藏/点赞也不再加分。
// 做法：记每篇内容的**历史最高收藏/点赞数**，算分时取 max(当前, 历史峰值)。
// ⚠️ 峰值存在本机（wx.setStorageSync）：换设备或清缓存会丢峰值，分值会回退。
// 要做到跨设备稳定的"只增不减"，峰值必须放服务端（属新增字段/数据归属，需产品负责人排期；见 OPEN_DECISIONS §1.24）。
const STORAGE_KEY = "shukao_community_reaction_peak";

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function readPeaks() {
  try {
    if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return {};
    const stored = wx.getStorageSync(STORAGE_KEY);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return stored;
  } catch (error) {
    return {};
  }
}

function writePeaks(peaks) {
  try {
    if (typeof wx === "undefined" || typeof wx.setStorageSync !== "function") return;
    wx.setStorageSync(STORAGE_KEY, peaks || {});
  } catch (error) {
    // 落盘失败不影响本次算分
  }
}

function peakKey(item = {}) {
  return String(item.id || item.localId || item.clientAssetId || "");
}

function peakRecord(peaks, item) {
  const key = peakKey(item);
  const record = key ? peaks[key] : null;
  return record && typeof record === "object" ? record : {};
}

// 把峰值抬到当前值（只升不降）。全 0 的条目不落盘，避免为每篇内容建空记录。
function raisePeaks(items = [], peaks = {}) {
  const next = { ...peaks };
  let changed = false;
  items.forEach((item) => {
    const key = peakKey(item);
    if (!key) return;
    const record = peakRecord(next, item);
    const favorites = Math.max(normalizeCount(record.favorites), normalizeCount(item.favoriteCount));
    const likes = Math.max(normalizeCount(record.likes), normalizeCount(item.likeCount));
    if (!favorites && !likes) return;
    if (favorites !== normalizeCount(record.favorites) || likes !== normalizeCount(record.likes)) {
      next[key] = { favorites, likes };
      changed = true;
    }
  });
  return { peaks: next, changed };
}

// 算分用的条目：当前收藏/点赞被历史峰值抬起 —— 取消不回退，再互动也不再加分。
function applyPeaks(items = [], peaks = {}) {
  return items.map((item) => {
    const record = peakRecord(peaks, item);
    return {
      ...item,
      favoriteCount: Math.max(normalizeCount(item.favoriteCount), normalizeCount(record.favorites)),
      likeCount: Math.max(normalizeCount(item.likeCount), normalizeCount(record.likes)),
    };
  });
}

// 页面入口：先抬峰值（必要时落盘），再返回用于算分的条目。
function trackReactionPeaks(items = []) {
  const raised = raisePeaks(items, readPeaks());
  if (raised.changed) writePeaks(raised.peaks);
  return { items: applyPeaks(items, raised.peaks), peaks: raised.peaks };
}

module.exports = {
  STORAGE_KEY,
  applyPeaks,
  peakKey,
  raisePeaks,
  readPeaks,
  trackReactionPeaks,
  writePeaks,
};
