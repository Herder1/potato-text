const contributionStatuses = new Set(["pending_review", "published", "rejected", "offline"]);

const statusLabels = {
  pending_review: "审核中",
  published: "已公开",
  rejected: "需修改",
  offline: "已下架",
};

const typeLabels = {
  question: "题目",
  question_pack: "题包",
  note: "笔记",
  card_pack: "卡片集",
};

// 六级土豆身份（2026-10-02 产品负责人确认称号、顺序与「经验值」口径；登记见 OPEN_DECISIONS §1.24）。
// 经验值 = 内容分 + 认可分。**权重与分段集中在这一个常量里**——调权重只改这里，页面与进度条形状不变。
const experienceRules = {
  contentTiers: [
    { upTo: 10, weight: 3 },          // 第 1–10 篇各 ×3
    { upTo: 30, weight: 1 },          // 第 11–30 篇各 ×1
    { upTo: Infinity, weight: 0.1 },  // 第 31 篇以上各 ×0.1（原议 ×0.3：1000 篇水文 = 341 分，会顶到第 4 档；×0.1 只有 147 分）
  ],
  // 认可分按**单篇**算，且单篇内递减、到封顶为止（2026-10-02 产品负责人定）——
  // 这样"一篇爆款直接封神"不成立：单篇 500 次收藏本来值 690 分，被 500 分封顶压回 500。
  favoriteTiers: [
    { upTo: 10, weight: 8 },          // 单篇第 1–10 次收藏各 ×8
    { upTo: 50, weight: 4 },          // 第 11–50 次各 ×4
    { upTo: Infinity, weight: 1 },    // 第 51 次以上各 ×1
  ],
  likeTiers: [
    { upTo: 20, weight: 1 },          // 单篇第 1–20 次点赞各 ×1（社区点赞尚未上线，当前恒为 0）
    { upTo: Infinity, weight: 0.5 },
  ],
  itemRecognitionCap: 500,            // 单篇认可分封顶
};

// 门槛是**经验值分值**（不是百分比，也不是"公开数/收藏数"两栏）。id 沿用旧四档、第 5/6 档新加；
// 这些 id 只在客户端渲染与 wx:key 使用，无落库、无接口返回。分值由产品负责人 2026-10-02 认可，
// 真实数据只有 3 条种子内容、无法标定，后续按实际分布校准。
const identityLevels = [
  { id: "member", label: "薯薯我呀", requirement: "注册即可（0 分）", score: 0 },
  { id: "contributor", label: "薯露头角", requirement: "经验值 10 分", score: 10 },
  { id: "builder", label: "薯能生巧", requirement: "经验值 100 分", score: 100 },
  { id: "featured", label: "薯一薯二", requirement: "经验值 800 分", score: 800 },
  { id: "veteran", label: "薯通广大", requirement: "经验值 3000 分", score: 3000 },
  { id: "legend", label: "薯界泰斗", requirement: "经验值 10000 分", score: 10000 },
];

function roundScore(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

// 通用分段计分：把 count 按 tiers 的区间逐段乘以各自权重。
function tieredScore(count, tiers) {
  const total = Math.max(0, Number(count) || 0);
  let score = 0;
  let used = 0;
  tiers.forEach((tier) => {
    const slice = Math.min(total - used, tier.upTo - used);
    if (slice > 0) {
      score += slice * tier.weight;
      used += slice;
    }
  });
  return score;
}

// 内容分：逐篇计分、分段递减。注意递减只是"减速"不是封顶：1000 篇水文在 ×0.1 下仍能拿到 147 分。
function contentScore(published) {
  return roundScore(tieredScore(published, experienceRules.contentTiers));
}

// 认可用的计数取「当前值」与「服务端历史峰值」的较大者（2026-10-02 产品负责人定：峰值放服务端）。
// 服务端 peakFavoriteCount / peakLikeCount 只增不减，所以取消收藏/点赞分不回退；
// 「同一人对同一篇只计一次」由服务端的"用户 × 内容"关系记录保证（重复收藏不计数）。
// 旧数据没有峰值字段时退回当前值，行为与改前一致。
function effectiveReactionCounts(item = {}) {
  return {
    favorites: Math.max(0, Number(item.favoriteCount) || 0, Number(item.peakFavoriteCount) || 0),
    likes: Math.max(0, Number(item.likeCount) || 0, Number(item.peakLikeCount) || 0),
  };
}

// 单篇认可分：收藏与点赞各自递减，合计到 itemRecognitionCap 封顶。
function itemRecognitionScore(item = {}) {
  const counts = effectiveReactionCounts(item);
  const raw = tieredScore(counts.favorites, experienceRules.favoriteTiers)
    + tieredScore(counts.likes, experienceRules.likeTiers);
  return roundScore(Math.min(raw, experienceRules.itemRecognitionCap));
}

// 认可分 = Σ 单篇认可分 —— 必须先逐篇再求和，不能拿总收藏数一把算（否则递减与封顶都不成立）。
function recognitionScore(items = []) {
  return roundScore(items.reduce((sum, item) => sum + itemRecognitionScore(item), 0));
}

// 经验值 = 内容分 + 认可分。
function experienceScore(stats = {}, items = []) {
  return roundScore(contentScore(stats.published) + recognitionScore(items));
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function contributionGroup(status) {
  if (status === "published") return "published";
  if (status === "pending_review") return "reviewing";
  return "attention";
}

function normalizeContribution(asset = {}, localId = "") {
  const moderationStatus = contributionStatuses.has(asset.moderationStatus) ? asset.moderationStatus : "pending_review";
  return {
    ...asset,
    id: String(asset.id || localId),
    localId: String(localId || asset.clientAssetId || ""),
    moderationStatus,
    statusLabel: statusLabels[moderationStatus] || "处理中",
    statusGroup: contributionGroup(moderationStatus),
    typeLabel: typeLabels[asset.type] || "内容",
    favoriteCount: Math.max(0, Number(asset.favoriteCount) || 0),
    copyCount: Math.max(0, Number(asset.copyCount) || Number(asset.metrics && asset.metrics.copies) || 0),
    dateText: formatDate(asset.updatedAt || asset.createdAt),
    pathText: [asset.subjectName, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" / ") || "暂未归入目录",
  };
}

function buildContributionItems(localAssets = [], remoteAssets = []) {
  const remoteByClientId = new Map();
  const remoteById = new Map();
  remoteAssets.forEach((asset) => {
    if (asset.clientAssetId) remoteByClientId.set(String(asset.clientAssetId), asset);
    if (asset.id) remoteById.set(String(asset.id), asset);
  });
  const matchedRemoteIds = new Set();
  const items = localAssets
    .filter((asset) => asset.ownership !== "collected" && contributionStatuses.has(asset.moderationStatus))
    .map((asset) => {
      const remote = remoteByClientId.get(String(asset.id)) || remoteById.get(String(asset.remoteId || ""));
      if (remote && remote.id) matchedRemoteIds.add(String(remote.id));
      return normalizeContribution({ ...asset, ...(remote || {}) }, asset.id);
    });
  remoteAssets.forEach((asset) => {
    if (!matchedRemoteIds.has(String(asset.id))) items.push(normalizeContribution(asset, asset.clientAssetId));
  });
  return items.sort((left, right) => Number(right.updatedAt || right.createdAt) - Number(left.updatedAt || left.createdAt));
}

function summarizeContributions(items = []) {
  return {
    total: items.length,
    published: items.filter((item) => item.moderationStatus === "published").length,
    reviewing: items.filter((item) => item.moderationStatus === "pending_review").length,
    attention: items.filter((item) => ["rejected", "offline"].includes(item.moderationStatus)).length,
    favorites: items.reduce((sum, item) => sum + Math.max(0, Number(item.favoriteCount) || 0), 0),
    copies: items.reduce((sum, item) => sum + Math.max(0, Number(item.copyCount) || 0), 0),
  };
}

function buildCommunityIdentity(items = []) {
  const stats = summarizeContributions(items);
  const content = contentScore(stats.published);
  const recognition = recognitionScore(items);
  const score = roundScore(content + recognition);
  // 逐档比经验值，取满足条件的最靠后一档。2026-10-02 由 if 链改为按 identityLevels 循环：
  // 旧写法把进度文案硬编码在 levelIndex 0/1/2 三个分支里，第 4 档以上一律 100% +
  // 「已达到当前最高身份」——档位一加到六档就会对那些其实没满档的人谎报满档。
  let levelIndex = 0;
  identityLevels.forEach((level, index) => {
    if (index > 0 && score >= level.score) levelIndex = index;
  });
  const current = identityLevels[levelIndex];
  const next = identityLevels[levelIndex + 1] || null;
  // progress 只是进度条的填充比例（在当前档 → 下一档的区间内插值）；对外显示的是经验值分值本身。
  const span = next ? next.score - current.score : 0;
  const progress = span > 0 ? Math.max(0, Math.min(100, Math.round((score - current.score) / span * 100))) : 100;
  const progressText = next ? `还需 ${roundScore(next.score - score)} 分` : "已达到当前最高身份";
  return {
    ...stats,
    score,
    contentScore: content,
    recognitionScore: recognition,
    current,
    next,
    progress,
    progressText,
    levels: identityLevels.map((level, index) => ({ ...level, achieved: index <= levelIndex, current: index === levelIndex })),
  };
}

module.exports = {
  buildCommunityIdentity,
  buildContributionItems,
  contentScore,
  contributionGroup,
  effectiveReactionCounts,
  experienceRules,
  experienceScore,
  formatDate,
  identityLevels,
  itemRecognitionScore,
  recognitionScore,
  summarizeContributions,
  tieredScore,
};
