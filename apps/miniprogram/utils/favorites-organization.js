/**
 * 「我的收藏」新版的视图模型（DEC-096，2026-09-23）。
 *
 * 纯函数、不碰 wx.*：页面只负责取数与 setData，算数都在这里，便于用 node 测试直接盯口径。
 *
 * 口径（与产品手册 §0.4 DEC-096 对齐）：
 * - 「全部收藏」＝社区收藏（知识卡 / 共享笔记 / 卡片集）+ 题目收藏，**合并进同一张列表**；
 * - 点文件夹＝看该文件夹的全部收藏（含子文件夹里的），上方给出**子文件夹标签**筛子集；
 * - 卡片上的彩色小标签＝它所在的**子文件夹名**（没进任何子文件夹时显示「未分类」）；
 * - **置顶是全局的**：同一条收藏在任何文件夹里都排最前，其次按收藏时间倒序；
 * - 右下角日期＝**收藏时间**（不是内容创建时间）。
 */

const COMMUNITY_KIND = "community";
const QUESTION_KIND = "question";
const UNFILED_TAG = "未分类";

function refKey(kind, refId) {
  return `${kind}:${refId}`;
}

function toTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 收藏时间 → 「今天 / 昨天 / 9 月 18 日」；没有时间就返回空串（页面据此不显示日期）。 */
function formatFavoriteDate(timestamp, now = Date.now()) {
  const value = toTimestamp(timestamp);
  if (!value) return "";
  const date = new Date(value);
  const startOfDay = (target) => new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function buildCommunityEntry(asset, state) {
  const refId = String(asset.id || "");
  const catalogPath = [asset.subjectName, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" · ");
  return {
    kind: COMMUNITY_KIND,
    refId,
    title: asset.title || "未命名内容",
    excerpt: asset.excerpt || "",
    type: asset.type || "",
    typeLabel: asset.typeLabel || "社区内容",
    sourceLine: [asset.typeLabel || "社区内容", catalogPath].filter(Boolean).join(" · "),
    statusLabel: asset.statusLabel || "",
    available: asset.available !== false,
    contributor: asset.contributor || "",
  };
}

function buildQuestionEntry(question, state) {
  const refId = String(question.id || "");
  return {
    kind: QUESTION_KIND,
    refId,
    title: question.stem || "未命名题目",
    excerpt: "",
    typeLabel: "题目",
    sourceLine: ["题目", question.breadcrumb || question.knowledgePoint || ""].filter(Boolean).join(" · "),
    statusLabel: "",
    available: true,
    contributor: "",
  };
}

/**
 * @param {object} input
 * @param {Array} input.communityItems 社区收藏（buildCommunityFavoriteItems 的结果）
 * @param {Array} input.questionItems  题目收藏（buildFavoriteQuestionItems 的结果）
 * @param {object} input.organization  服务端组织数据（folders / counts / membership / pins / favoritedAt / totals）
 * @param {string} input.activeFolderId 当前文件夹（空＝「全部收藏」）
 * @param {string} input.activeSubFolderId 当前子文件夹标签（空＝该文件夹全部）
 * @param {string} input.order 排序方向（recent＝收藏时间倒序，默认；oldest＝最早收藏在前）；置顶恒在最前
 * @param {string} input.keyword 搜索词（按标题 / 摘要 / 标签 / 出处 / 作者匹配，忽略大小写与首尾空格）
 * @param {string} input.typeFilter 类型筛选（空＝全部；取值＝条目自己的 typeLabel，如「题目」「卡片集」）
 * @param {number} input.now 注入当前时间，便于测试
 */
function buildFavoriteOrganization({
  communityItems = [],
  questionItems = [],
  organization = {},
  activeFolderId = "",
  activeSubFolderId = "",
  order = "recent",
  keyword = "",
  typeFilter = "",
  now = Date.now(),
} = {}) {
  const folders = (Array.isArray(organization.folders) ? organization.folders : []).filter((folder) => folder && folder.id);
  const membership = organization.membership || {};
  const favoritedAt = organization.favoritedAt || {};
  const counts = organization.counts || {};
  const withChildren = counts.withChildren || {};
  const totals = organization.totals || {};
  const pinKeys = new Set((Array.isArray(organization.pins) ? organization.pins : [])
    .map((pin) => refKey(pin.kind, pin.refId)));

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const topFolders = folders.filter((folder) => !folder.parentId);
  const childrenOf = (parentId) => folders.filter((folder) => folder.parentId === parentId);

  const entries = [
    ...communityItems.map((item) => buildCommunityEntry(item)),
    ...questionItems.map((item) => buildQuestionEntry(item)),
  ].filter((entry) => entry.refId);

  const decorated = entries.map((entry) => {
    const key = refKey(entry.kind, entry.refId);
    const folderId = membership[key] || "";
    const folder = folderId ? folderById.get(folderId) : null;
    const parentFolder = folder && folder.parentId ? folderById.get(folder.parentId) : null;
    return {
      ...entry,
      key,
      kind: entry.kind,
      type: entry.type || "",
      folderId,
      subFolderId: folder && folder.parentId ? folder.id : "",
      tag: folder ? folder.name : UNFILED_TAG,
      pinned: pinKeys.has(key),
      dateLabel: formatFavoriteDate(favoritedAt[key], now),
      favoritedAt: toTimestamp(favoritedAt[key]),
    };
  });

  const activeFolder = activeFolderId ? folderById.get(activeFolderId) : null;
  // 选中文件夹时＝它自己 + 它的子文件夹里的收藏；选中「全部收藏」时＝全部。
  const inActiveFolder = (item) => {
    if (!activeFolder) return true;
    if (item.folderId === activeFolder.id) return true;
    const folder = folderById.get(item.folderId);
    return Boolean(folder && folder.parentId === activeFolder.id);
  };

  const subFolders = activeFolder ? childrenOf(activeFolder.id) : [];
  const chips = activeFolder
    ? [{ id: "", label: "全部", count: Number(withChildren[activeFolder.id] || 0), active: !activeSubFolderId }]
      .concat(subFolders.map((folder) => ({
        id: folder.id,
        label: folder.name,
        count: Number(withChildren[folder.id] || 0),
        active: folder.id === activeSubFolderId,
      })))
    : [];

  const inFolderScope = decorated
    .filter(inActiveFolder)
    .filter((item) => !activeSubFolderId || item.subFolderId === activeSubFolderId || item.folderId === activeSubFolderId);

  // 搜索框 + 「筛选」（产品负责人 2026-09-23 04:4x：搜索框在图 2「全部收藏」上面，右边依次是筛选、排序）。
  // 筛选选项**从当前范围内的数据里长出来**，不写死词表——服务端加了新的内容类型，这里自动多一行。
  const needle = String(keyword || "").trim().toLowerCase();
  const matchesKeyword = (item) => {
    if (!needle) return true;
    return [item.title, item.excerpt, item.tag, item.sourceLine, item.statusLabel, item.contributor]
      .some((field) => String(field || "").toLowerCase().includes(needle));
  };
  const typeLabelOf = (item) => item.typeLabel || "社区内容";
  const typeCounts = new Map();
  inFolderScope.forEach((item) => {
    const label = typeLabelOf(item);
    typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
  });
  const activeType = typeFilter && typeCounts.has(typeFilter) ? typeFilter : "";
  const typeOptions = inFolderScope.length
    ? [{ value: "", label: "全部", count: inFolderScope.length, active: !activeType }].concat(
      [...typeCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([label, count]) => ({ value: label, label, count, active: label === activeType })),
    )
    : [];

  const visible = inFolderScope
    .filter(matchesKeyword)
    .filter((item) => !activeType || typeLabelOf(item) === activeType)
    .sort((left, right) => {
      // 置顶恒在最前（DEC-096 ④：全局置顶）；其余按收藏时间，方向由 ⇅ 决定。
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      if (left.favoritedAt !== right.favoritedAt) {
        return order === "oldest" ? left.favoritedAt - right.favoritedAt : right.favoritedAt - left.favoritedAt;
      }
      return String(left.title).localeCompare(String(right.title));
    });

  const hasFilter = Boolean(needle || activeType);
  const scopedCount = inFolderScope.length;
  const baseCountLabel = `${Number(activeFolder ? (withChildren[activeFolder.id] || 0) : (totals.all || entries.length))} 条收藏`;

  return {
    totalCount: Number(totals.all || entries.length),
    unfiledCount: Number(totals.unfiled || 0),
    directorySubtitle: `${topFolders.length + folders.filter((folder) => folder.parentId).length} 个文件夹 · ${Number(totals.all || entries.length)} 条收藏`,
    folders: topFolders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      icon: folder.icon || "",
      count: Number(withChildren[folder.id] || 0),
      active: folder.id === activeFolderId,
    })),
    allFolder: { active: !activeFolderId, count: Number(totals.all || entries.length) },
    activeFolderId: activeFolder ? activeFolder.id : "",
    folderTitle: activeFolder ? activeFolder.name : "全部收藏",
    // 有搜索/筛选时把「筛出几条」写在副标题里，用户才知道列表为什么短了。
    folderCountLabel: hasFilter ? `${baseCountLabel} · 筛出 ${visible.length} 条` : baseCountLabel,
    chips,
    activeSubFolderId: activeSubFolderId || "",
    items: visible,
    // 空态文案分三种：加载失败（页面覆盖）> 有筛选没匹配 > 这个文件夹真的空
    emptyLabel: hasFilter
      ? (needle ? `没有匹配「${String(keyword).trim()}」的收藏` : "这个类型下还没有收藏")
      : (activeFolder ? "这个文件夹还没有收藏" : "还没有收藏"),
    keyword: String(keyword || ""),
    typeFilter: activeType,
    typeOptions,
    hasFilter,
    scopedCount,
  };
}

module.exports = {
  buildFavoriteOrganization,
  formatFavoriteDate,
  refKey,
  COMMUNITY_KIND,
  QUESTION_KIND,
  UNFILED_TAG,
};
