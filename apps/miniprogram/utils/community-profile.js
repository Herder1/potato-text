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

const identityLevels = [
  { id: "member", label: "社区成员", requirement: "完成首次公开投稿" },
  { id: "contributor", label: "内容贡献者", requirement: "累计公开 1 项内容" },
  { id: "builder", label: "持续共建者", requirement: "累计公开 5 项内容" },
  { id: "featured", label: "优质贡献者", requirement: "累计公开 10 项，且被导入 50 次" },
];

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
  let levelIndex = 0;
  if (stats.published >= 1) levelIndex = 1;
  if (stats.published >= 5) levelIndex = 2;
  if (stats.published >= 10 && stats.copies >= 50) levelIndex = 3;
  const current = identityLevels[levelIndex];
  const next = identityLevels[levelIndex + 1] || null;
  let progress = 100;
  let progressText = "已达到当前最高身份";
  if (levelIndex === 0) {
    progress = Math.min(100, stats.published * 100);
    progressText = `还需 ${Math.max(0, 1 - stats.published)} 项公开内容`;
  } else if (levelIndex === 1) {
    progress = Math.min(100, Math.round(stats.published / 5 * 100));
    progressText = `还需 ${Math.max(0, 5 - stats.published)} 项公开内容`;
  } else if (levelIndex === 2) {
    progress = Math.min(100, Math.round(Math.min(stats.published / 10, stats.copies / 50) * 100));
    progressText = `还需 ${Math.max(0, 10 - stats.published)} 项公开内容、${Math.max(0, 50 - stats.copies)} 次导入`;
  }
  return {
    ...stats,
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
  contributionGroup,
  formatDate,
  identityLevels,
  summarizeContributions,
};
