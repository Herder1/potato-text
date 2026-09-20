const { loadAssets, saveAsset } = require("../../utils/asset-store");
const {
  adoptPackCardsIntoDirectory,
  addQuestionToPack,
  appendPackCard,
  applyPackCardColors,
  createPrivatePack,
  deletePackNode,
  deletePrivatePack,
  getPrivatePack,
  insertPackCardAfter,
  insertPackDirectory,
  loadPrivatePackCategories,
  loadPrivatePacks,
  movePackCardToDirectory,
  movePackCardsTo,
  movePackCardTo,
  movePackDirectoryToIndex,
  movePackDirectoryUnder,
  normalizeQuestionForPractice,
  savePrivatePack,
  setPackCardsColor,
  updatePackNode,
} = require("../../utils/private-pack-store");
const { normalizeOfficialQuestion } = require("../../utils/question-sync");
const { demoQuestions } = require("../../data/catalog");
const { cachePublicPack, getCachedPublicPack } = require("../../utils/pack-collection");
const { CARD_COLORS, cardColorBackground, cardColorEdge } = require("../../utils/card-box-store");
const { closeTransientLayers } = require("../../utils/page-layers");

function decode(value) {
  try { return decodeURIComponent(String(value || "")); } catch (error) { return String(value || ""); }
}

function cleanText(value) {
  return String(value == null ? "" : value).trim();
}

// 拖拽参数（与卡集页同一套：起手位移阈值、边缘自动滚动区间与步长）。
const DRAG_THRESHOLD = 10;
const DRAG_EDGE_ZONE = 72;
const DRAG_EDGE_BOTTOM = 96;
const DRAG_EDGE_MAX_STEP = 22;
const DRAG_EDGE_INTERVAL = 16;

// 落点是“第几格”：两列网格里，指针在某张卡片左半边之前就算落在它前面。
function cardSlotIndex(cards, pointerX, pointerY) {
  for (let position = 0; position < cards.length; position += 1) {
    const card = cards[position];
    const before = pointerY < card.top
      || (pointerY <= card.bottom && pointerX < (card.left + card.right) / 2);
    if (before) return position;
  }
  return cards.length;
}

function truncatePreview(value, maxLength = 15) {
  const text = cleanText(value).replace(/\s+/g, " ");
  const characters = Array.from(text);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join("")}…`
    : text;
}

function splitPath(value) {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(/\s*(?:\/|\\|>|＞|·|｜)\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-3);
}

function questionPath(question = {}) {
  const directPath = [question.directoryPath, question.catalogPath, question.chapterPath]
    .map(splitPath)
    .find((value) => value.length);
  const titlePath = [question.chapterTitle || question.chapter, question.sectionTitle || question.section]
    .flatMap(splitPath)
    .filter((value, index, values) => !index || value !== values[index - 1]);
  const path = (directPath || titlePath).slice(-3);
  if (path.length) return path;
  const knowledge = Array.isArray(question.knowledgePoints)
    ? question.knowledgePoints[0]
    : question.knowledgePoint;
  return splitPath(knowledge).slice(-1);
}

function questionTypeLabel(question = {}) {
  return cleanText(question.typeLabel || question.questionType || question.type || "题目") || "题目";
}

function questionStem(question = {}) {
  return cleanText(question.stem || question.question || question.title || "未命名题目") || "未命名题目";
}

function questionDisplayNumber(question = {}, index = 0) {
  const candidate = question.number ?? question.questionNumber ?? question.questionNo ?? question.seq;
  const value = cleanText(candidate);
  return value || String(index + 1);
}

function questionScore(question = {}) {
  const score = Number(question.score ?? question.maxScore);
  return Number.isFinite(score) && score > 0 ? score : 0;
}

function normalizeCollectionQuestion(question, packId, index, pathOverride = []) {
  if (!question) return null;
  const normalized = normalizeOfficialQuestion({
    ...question,
    id: String(question.id || ""),
    questionType: question.questionType || question.typeLabel,
    typeCode: question.typeCode || question.type,
    optionsText: question.optionsText || (Array.isArray(question.options)
      ? question.options.map((option) => `${option.key || ""}. ${option.text || option.value || ""}`).join("\n")
      : ""),
    score: question.score ?? question.maxScore,
  });
  const stem = questionStem(question);
  const path = pathOverride.length ? pathOverride : questionPath(question);
  return {
    ...question,
    ...normalized,
    id: String(question.id || normalized.id || `pack-question-${index + 1}`),
    packId,
    displayNumber: questionDisplayNumber(question, index),
    typeLabel: questionTypeLabel(question),
    stem,
    stemPreview: truncatePreview(stem),
    score: questionScore(question),
    path,
    pathLabel: path.join(" / "),
    available: question.status !== "offline" && question.deleted !== true,
  };
}

function createMissingQuestion(id, packId, index, path = []) {
  return {
    id: String(id || `deleted-${index + 1}`),
    packId,
    displayNumber: String(index + 1),
    typeLabel: "题目已删除",
    stem: "题目已被作者删除",
    stemPreview: "题目已被作者删除",
    score: 0,
    path,
    pathLabel: path.join(" / "),
    available: false,
    deleted: true,
  };
}

function createBlankQuestion(node, packId, index, path = []) {
  return {
    id: `blank-${String(node && node.id || index + 1)}`,
    nodeId: node && node.id || "",
    packId,
    displayNumber: String(index + 1),
    typeLabel: "待录入",
    stem: "点击录入题目",
    stemPreview: "点击录入题目",
    score: 0,
    path,
    pathLabel: path.join(" / "),
    available: false,
    isBlank: true,
    deleted: false,
  };
}

function createRemoteSections(rows) {
  const sections = [];
  const sectionMap = new Map();
  const ensureSection = (title, level, parentId) => {
    const normalizedTitle = cleanText(title) || "未分类";
    const key = `${parentId || "root"}::${normalizedTitle}`;
    if (sectionMap.has(key)) return sectionMap.get(key);
    const section = {
      id: `remote-section-${sections.length + 1}`,
      title: normalizedTitle,
      level: Math.min(3, Math.max(1, Number(level) || 1)),
      parentId: parentId || "",
      items: [],
      count: 0,
      availableCount: 0,
      hasItems: false,
    };
    sections.push(section);
    sectionMap.set(key, section);
    return section;
  };
  rows.forEach((row) => {
    const path = row.path.length ? row.path : ["未分类"];
    let parentId = "";
    path.forEach((title, pathIndex) => {
      const section = ensureSection(title, pathIndex + 1, parentId);
      section.count += 1;
      if (row.available) section.availableCount += 1;
      if (pathIndex === path.length - 1) {
        section.items.push(row);
        section.hasItems = true;
      }
      parentId = section.id;
    });
  });
  return sections;
}

// DEC-087：目录块「先子目录、后自己的卡片」（文件夹在前、文件在后）。
// 做法：把每个目录拆成「标题块」与「卡片块」两个渲染块，卡片块排在它最后一个后代之后。
// 标题块仍按节点顺序（树的先序），所以拖拽 / 长按 / 行内改名这些按标题定位的逻辑不受影响。
function buildSectionBlocks(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const idSet = new Set(list.map((section) => String(section.id)));
  const childrenOf = new Map();
  list.forEach((section) => {
    const parentId = String(section.parentId || "");
    const key = parentId && idSet.has(parentId) ? parentId : "";
    const bucket = childrenOf.get(key) || [];
    bucket.push(section);
    childrenOf.set(key, bucket);
  });
  const blocks = [];
  const walk = (section) => {
    const id = String(section.id);
    blocks.push({ key: `title-${id}`, kind: "title", section });
    (childrenOf.get(id) || []).forEach(walk);
    // 没有卡片的目录不产出卡片块：空 grid 会让「卡片块相邻」的间距规则失效（DEC-089）。
    if ((section.cards || []).length) blocks.push({ key: `cards-${id}`, kind: "cards", section });
  };
  (childrenOf.get("") || []).forEach(walk);
  return blocks;
}

function createLocalSections(pack, rows) {
  const nodes = Array.isArray(pack && pack.nodes) ? pack.nodes : [];
  const directories = nodes.filter((node) => node.type === "directory");
  if (!directories.length) return createRemoteSections(rows);
  const rowsByDirectory = new Map();
  rows.forEach((row) => {
    const list = rowsByDirectory.get(row.directoryId || "") || [];
    list.push(row);
    rowsByDirectory.set(row.directoryId || "", list);
  });
  const sections = directories.map((directory, index) => {
    const items = rowsByDirectory.get(directory.id) || [];
    return {
      id: directory.id,
      title: cleanText(directory.title) || "未命名目录",
      level: Math.min(3, Math.max(1, Number(directory.level) || 1)),
      parentId: String(directory.parentId || ""),
      items,
      count: items.length,
      availableCount: items.filter((item) => item.available).length,
      hasItems: items.length > 0,
      order: index,
    };
  });
  const sectionMap = new Map(sections.map((section) => [section.id, section]));
  rows.forEach((row) => {
    let directoryId = row.directoryId || "";
    const visited = new Set();
    while (directoryId && sectionMap.has(directoryId) && !visited.has(directoryId)) {
      visited.add(directoryId);
      const section = sectionMap.get(directoryId);
      if (directoryId !== row.directoryId) {
        section.count += 1;
        if (row.available) section.availableCount += 1;
      }
      directoryId = section.parentId;
    }
  });
  const looseItems = rows.filter((row) => !row.directoryId || !sectionMap.has(row.directoryId));
  if (looseItems.length) {
    sections.push({
      id: "loose",
      title: directories.length ? "未归档" : "题目",
      level: 1,
      parentId: "",
      items: looseItems,
      count: looseItems.length,
      availableCount: looseItems.filter((item) => item.available).length,
      hasItems: looseItems.length > 0,
      order: sections.length,
    });
  }
  return sections;
}

function buildCollection(pack, source = "public") {
  const packId = String(pack && pack.id || "");
  const assets = loadAssets();
  const assetMap = new Map(assets.filter((asset) => asset.type === "question").map((asset) => [String(asset.id), asset]));
  const rawRemoteQuestions = Array.isArray(pack && pack.questions) ? pack.questions : [];
  const hasAuthoritativeQuestionPayload = Array.isArray(pack && pack.questions);
  const remoteMap = new Map(rawRemoteQuestions.map((question) => [String(question && question.id || ""), question]));
  const packQuestionIds = new Set((Array.isArray(pack && pack.questionIds) ? pack.questionIds : rawRemoteQuestions.map((question) => question && question.id))
    .map(String)
    .filter(Boolean));
  // A server response with a `questions` array is authoritative: an omitted ID
  // may represent an offline/deleted question and must stay a placeholder.
  // Legacy cached packs without that field can still use the local question cache.
  if (!hasAuthoritativeQuestionPayload) {
    const officialQuestions = (() => {
      try {
        const app = getApp();
        return Array.isArray(app.globalData.officialQuestions) ? app.globalData.officialQuestions : [];
      } catch (error) { return []; }
    })();
    officialQuestions.forEach((question) => {
      if (question && question.id && packQuestionIds.has(String(question.id)) && !remoteMap.has(String(question.id))) {
        remoteMap.set(String(question.id), question);
      }
    });
    const cachedOfficial = wx.getStorageSync("shukao_official_questions");
    (Array.isArray(cachedOfficial) ? cachedOfficial : []).forEach((question) => {
      if (question && question.id && packQuestionIds.has(String(question.id)) && !remoteMap.has(String(question.id))) {
        remoteMap.set(String(question.id), question);
      }
    });
  }
  // The local seed pack can outlive the persisted API snapshot. Only built-in
  // demo IDs use this compatibility fallback; other missing IDs stay deleted.
  const allowBuiltInDemoFallback = !hasAuthoritativeQuestionPayload
    || (pack && pack.status === "featured" && pack.creatorType === "team");
  if (allowBuiltInDemoFallback) {
    (Array.isArray(demoQuestions) ? demoQuestions : []).forEach((question) => {
      if (question && question.id && packQuestionIds.has(String(question.id))
        && String(question.id).startsWith("demo-") && !remoteMap.has(String(question.id))) {
        remoteMap.set(String(question.id), question);
      }
    });
  }

  const directoryNodes = new Map(
    (Array.isArray(pack && pack.nodes) ? pack.nodes : [])
      .filter((node) => node && node.type === "directory" && node.id)
      .map((node) => [String(node.id), node]),
  );
  const directoryPathCache = new Map();
  const resolveDirectoryPath = (directoryId, trail = new Set()) => {
    const id = String(directoryId || "");
    if (!id || !directoryNodes.has(id) || trail.has(id)) return [];
    if (directoryPathCache.has(id)) return directoryPathCache.get(id);
    const node = directoryNodes.get(id);
    const parentPath = resolveDirectoryPath(node.parentId, new Set([...trail, id]));
    const path = [...parentPath, cleanText(node.title)].filter(Boolean).slice(-3);
    directoryPathCache.set(id, path);
    return path;
  };

  const cardNodes = Array.isArray(pack && pack.nodes)
    ? pack.nodes.filter((node) => node.type === "card")
    : [];
  const orderedIds = Array.isArray(pack && pack.questionIds)
    ? pack.questionIds.map(String)
    : rawRemoteQuestions.map((question) => String(question.id || ""));
  const ids = [...new Set(orderedIds.filter(Boolean))];
  const cardEntries = cardNodes.length
    ? cardNodes.reduce((entries, node) => {
      const id = String(node.questionId || "");
      if (!id) {
        entries.push({ id: "", node });
        return entries;
      }
      if (!entries.some((entry) => entry.id === id)) entries.push({ id, node });
      return entries;
    }, [])
    : ids.map((id) => ({ id, node: null }));
  const rows = cardEntries.map(({ id, node }, index) => {
    const question = source === "private"
      ? assetMap.get(id)
      : (remoteMap.get(id) || (!hasAuthoritativeQuestionPayload ? assetMap.get(id) : null));
    const nodePath = node && node.directoryId
      ? resolveDirectoryPath(node.directoryId)
      : (node && node.directoryTitle ? splitPath(node.directoryTitle) : []);
    const row = !id
      ? createBlankQuestion(node, packId, index, nodePath)
      : (question
        ? normalizeCollectionQuestion(question, packId, index, nodePath)
        : createMissingQuestion(id, packId, index, nodePath));
    return {
      ...row,
      nodeId: node && node.id || "",
      directoryId: node && String(node.directoryId || "") || "",
      color: String(node && node.color || ""),
    };
  });
  const sections = source === "private" ? createLocalSections(pack, rows) : createRemoteSections(rows);
  const availableRows = rows.filter((row) => row.available);
  const questionTypes = [...new Set(availableRows.map((row) => row.typeLabel).filter(Boolean))];
  const creator = pack.creator && pack.creator.nickname || pack.creatorName || pack.author || (source === "private" ? "我" : "薯考系统");
  const sourceLabel = pack.sourceLabel || (source === "private" ? "我的题包" : (pack.creatorType === "team" ? "平台题包" : "社区题包"));
  return {
    pack: {
      ...pack,
      id: packId,
      name: cleanText(pack.name || pack.title) || "未命名题包",
      description: cleanText(pack.description || pack.excerpt),
      creatorName: creator,
      sourceLabel,
      tags: Array.isArray(pack.tags) ? pack.tags : [],
      questionCount: rows.length,
      availableCount: availableRows.length,
      missingCount: rows.filter((row) => row.deleted).length,
      typeSummary: questionTypes.join("、"),
      isPrivate: source === "private",
      collected: source === "public" && loadPrivatePacks().some((item) => item.sourcePackId === packId),
    },
    rows,
    sections,
  };
}

function apiCandidates() {
  try {
    const app = getApp();
    if (typeof app.apiBaseUrlCandidates === "function") return app.apiBaseUrlCandidates();
    const base = String(app.globalData && app.globalData.apiBaseUrl || "").replace(/\/$/, "");
    return base ? [base] : [];
  } catch (error) { return []; }
}

// 把题包 sections 装饰成卡集页那种「目录行 + 双列卡片」的视图数据。
// 卡片正面＝题型标签 + 题干；背面＝参考答案摘要 + 来源目录路径 + 状态。
function decorateCollectionSections(sections, options = {}) {
  const selected = new Set((options.selectedCardIds || []).map(String));
  const colorPickerOpen = Boolean(options.cardColorPickerOpen);
  const pickedColor = String(options.selectedCardColor || "");
  const activeDirectory = String(options.activeDirectory || "");
  const inlineEdit = String(options.directoryInlineEdit || "");
  return (sections || []).map((section) => {
    const items = Array.isArray(section.items) ? section.items : [];
    return {
      ...section,
      displayCount: Number(section.count) || items.length,
      directoryActive: activeDirectory === String(section.id || ""),
      inlineEditing: inlineEdit === String(section.id || ""),
      cards: items.map((item, index) => {
        const nodeId = String(item.nodeId || "");
        const color = String(item.color || "");
        return {
          id: String(item.id || `card-${index}`),
          nodeId,
          directoryId: String(item.directoryId || ""),
          order: cleanText(item.displayNumber) || String(index + 1),
          tag: cleanText(item.typeLabel) || "题目",
          title: cleanText(item.stemPreview) || cleanText(item.stem) || "未命名题目",
          meta: cleanText(item.pathLabel),
          state: item.isBlank ? "待录入" : (item.available ? "可练习" : "已删除"),
          isBlank: Boolean(item.isBlank),
          deleted: Boolean(item.deleted),
          available: Boolean(item.available),
          color,
          colorSoft: color ? cardColorBackground(color) : "",
          colorEdge: color ? cardColorEdge(color) : "",
          selected: Boolean(nodeId) && selected.has(nodeId),
          colorPicked: color === pickedColor,
        };
      }),
      colorPickerOpen,
    };
  });
}

// 私有题包里没有归属目录的卡片（新建时没挂目录、目录被删、被移到“未归档”）单独成组，
// 否则它们不会出现在任何 section 里、等于隐身。
function collectionLooseSection(sections, rows) {
  const known = new Set((sections || []).map((section) => String(section.id || "")));
  const loose = (rows || []).filter((row) => !known.has(String(row.directoryId || "")));
  if (!loose.length) return null;
  return {
    id: "__loose__",
    title: "未归档",
    level: 1,
    parentId: "",
    count: loose.length,
    availableCount: loose.filter((row) => row.available).length,
    hasItems: true,
    items: loose,
    isLoose: true,
  };
}

// 私有题包只认真实目录节点：把 buildCollection 的兜底分组（无目录时的“未分类”）换成“未归档”。
function privateCollectionSections(sections, rows, pack) {
  const nodeIds = new Set(((pack && pack.nodes) || []).map((node) => String(node.id || "")));
  const real = (sections || []).filter((section) => nodeIds.has(String(section.id || "")));
  const loose = collectionLooseSection(real, rows);
  return loose ? [...real, loose] : real;
}

// 装饰后的目录树（抽屉用同一份数据，保持“目录行 / 抽屉行”一致）。
function collectionDirectoryForest(sections) {
  const nodes = new Map();
  const roots = [];
  (sections || []).forEach((section) => {
    const id = String(section && section.id || "");
    if (!id) return;
    nodes.set(id, {
      key: id,
      title: cleanText(section.title) || "未命名目录",
      level: Math.min(3, Math.max(1, Number(section.level) || 1)),
      parentId: String(section.parentId || ""),
      items: Array.isArray(section.items) ? section.items : [],
      ownCount: Array.isArray(section.items) ? section.items.length : 0,
      totalCount: Number(section.count) || (Array.isArray(section.items) ? section.items.length : 0),
      children: [],
    });
  });
  nodes.forEach((node) => {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  });
  return roots;
}

function flattenCollectionRows(nodes, collapsed, depth, rows) {
  nodes.forEach((node) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren ? !collapsed[node.key] : false;
    rows.push({
      key: node.key,
      title: node.title,
      level: node.level,
      depth: Math.min(2, depth),
      hasChildren,
      expanded,
      ownCount: node.ownCount,
      totalCount: node.totalCount,
    });
    if (hasChildren && expanded) flattenCollectionRows(node.children, collapsed, depth + 1, rows);
  });
  return rows;
}

function buildCollectionRows(sections, collapsed) {
  return flattenCollectionRows(collectionDirectoryForest(sections), collapsed || {}, 0, []);
}

function isCollectionFullyExpanded(rows) {
  const foldable = (rows || []).filter((row) => row.hasChildren);
  return foldable.length > 0 && foldable.every((row) => row.expanded);
}

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    pack: null,
    rows: [],
    sections: [],
    loading: true,
    loadError: "",
    moreOpen: false,
    addMenuOpen: false,
    selectedQuestionId: "",
    source: "public",
    catalogOpen: false,
    catalogView: "directory",
    catalogRows: [],
    catalogDirectoryCount: 0,
    catalogExpandedAll: true,
    catalogSummaryTitle: "",
    catalogSummaryQuestions: [],
    floatingTop: 96,
    actionMode: "",
    selectedCardIds: [],
    activeDirectory: "",
    directoryInlineEdit: "",
    directoryInlineValue: "",
    directoryInlineParent: "",
    contextToolbarTop: 0,
    contextMenuOpen: false,
    contextMenuTitle: "",
    contextMenuAlign: "center",
    contextMenuTop: 0,
    contextMenuItems: [],
    cardColors: CARD_COLORS,
    cardColorPickerOpen: false,
    cardColorPickerTop: 0,
    selectedCardColor: "",
    canEditSelected: false,
    activeDirectoryLevel: 1,
    questionImporterOpen: false,
    availableQuestions: [],
    dragGroupCount: 0,
    colorPanelOpen: false,
    colorMode: "uniform",
    selectedPackColor: "",
    packColorScopeLabel: "",
    dragActive: false,
    dragKind: "",
    dragKey: "",
    dragGhost: null,
    dragStyle: "",
    dragIndicator: null,
    pageScrollLocked: false,
    contextToolbarReady: true,
    contextToolbarHeight: 48,
    contentLeft: 14,
    contentWidth: 347,
    viewportHeight: 667,
  },

  onLoad(options = {}) {
    this.packId = decode(options.id || options.packId);
    this.source = options.source === "private" ? "private" : "public";
    this.pendingQuestionId = decode(options.questionId || "");
    // 管理题包页下线后（DEC-075），「选了题包再录题 / 把题目挂进题包」这两条入口并入本页。
    this.packIntent = decode(options.intent || "");
    this.attachQuestionId = decode(options.questionId || "");
    this.setData({ source: this.source });
    this.measureNavigation();
  },

  onShow() {
    this.loadCollection();
  },

  // 只执行一次：把题目挂进题包（attachQuestion）或新建一张卡片并直接进录入页（addQuestion）。
  applyPackIntent(collection) {
    const intent = String(this.packIntent || "");
    if (!intent) return;
    this.packIntent = "";
    const attachId = String(this.attachQuestionId || "");
    if (intent === "attachQuestion") {
      if (!attachId) return;
      const questionIds = (collection.pack && collection.pack.questionIds) || [];
      if (questionIds.map(String).includes(attachId)) return;
      addQuestionToPack(this.packId, attachId);
      this.refreshSections();
      wx.showToast({ title: "题目已加入题包", icon: "none" });
      return;
    }
    if (intent === "addQuestion") {
      const pack = getPrivatePack(this.packId);
      const fallback = pack && pack.nodes && [...pack.nodes].reverse().find((node) => node.type === "directory");
      const node = appendPackCard(this.packId, fallback ? fallback.id : "");
      this.refreshSections();
      if (node) {
        wx.navigateTo({
          url: `/pages/contribute/contribute?packId=${encodeURIComponent(this.packId)}&cardId=${encodeURIComponent(node.id)}`,
        });
      }
    }
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : {};
    const hasCapsule = capsule && capsule.width > 0 && capsule.height > 0;
    const statusBarHeight = Number(windowInfo.statusBarHeight) || (hasCapsule ? Number(capsule.top) : 24);
    const capsuleTop = hasCapsule ? Number(capsule.top) : statusBarHeight + 4;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = (hasCapsule ? Number(capsule.height) : 32) + topGap * 2;
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight: statusBarHeight + navContentHeight,
      capsuleSafeRight: hasCapsule ? Math.max(96, Number(windowInfo.windowWidth || 375) - Number(capsule.left) + 10) : 96,
      floatingTop: statusBarHeight + navContentHeight + 8,
      viewportHeight: Number(windowInfo.windowHeight) || 667,
      contentLeft: 14,
      contentWidth: Math.max(120, Number(windowInfo.windowWidth || 375) - 28),
    });
  },

  loadCollection() {
    if (!this.packId) {
      this.setData({ loading: false, loadError: "题包不存在" });
      return;
    }
    const localPack = getPrivatePack(this.packId);
    if (localPack) {
      this.applyCollection(localPack, "private");
      return;
    }
    const cached = getCachedPublicPack(this.packId);
    if (cached) this.applyCollection(cached, "public");
    this.fetchPublicPack(Boolean(cached));
  },

  applyCollection(pack, source = this.source) {
    const collection = buildCollection(pack, source);
    const sections = this.pageSections(collection);
    this.setData({
      pack: collection.pack,
      rows: collection.rows,
      sections,
      sectionBlocks: buildSectionBlocks(sections),
      loading: false,
      loadError: "",
    }, () => {
      this.applyPackIntent(collection);
      this.resolvePendingQuestion();
    });
  },

  fetchPublicPack(hasCached = false) {
    const candidates = apiCandidates();
    if (!candidates.length || typeof wx.request !== "function") {
      if (!hasCached) this.setData({ loading: false, loadError: "题包暂时无法读取" });
      return;
    }
    const requestAt = (index) => {
      const baseUrl = candidates[index];
      if (!baseUrl) {
        if (!hasCached) this.setData({ loading: false, loadError: "题包暂时无法读取" });
        return;
      }
      wx.request({
        url: `${String(baseUrl).replace(/\/$/, "")}/api/packs?query=${encodeURIComponent(this.packId)}`,
        method: "GET",
        timeout: 8000,
        success: (response) => {
          const packs = response && response.statusCode === 200 && response.data && response.data.packs;
          const pack = Array.isArray(packs) ? packs.find((item) => String(item.id) === this.packId) : null;
          if (!pack) { requestAt(index + 1); return; }
          try { getApp().globalData.apiBaseUrl = baseUrl; } catch (error) { /* noop */ }
          cachePublicPack(pack);
          this.applyCollection(pack, "public");
        },
        fail: () => requestAt(index + 1),
      });
    };
    requestAt(0);
  },

  resolvePendingQuestion() {
    if (!this.pendingQuestionId || !this.data.rows.length) return;
    const index = this.data.rows.findIndex((row) => row.id === this.pendingQuestionId);
    const pending = this.pendingQuestionId;
    this.pendingQuestionId = "";
    if (index < 0 || !this.data.rows[index].available) {
      this.handleDeletedQuestion(index < 0 ? -1 : index);
      return;
    }
    this.openPractice(this.data.rows[index]);
  },

  goBack() { wx.navigateBack(); },

  toggleAddMenu() {
    if (this.data.addMenuOpen) {
      this.closeAddMenu();
      return;
    }
    if (!this.requirePrivatePack()) return;
    this.setData({
      addMenuOpen: true,
      moreOpen: false,
      actionMode: "",
      contextMenuOpen: false,
    });
  },

  closeAddMenu() {
    this.setData({ addMenuOpen: false });
  },

  requirePrivatePack() {
    if (this.source === "private" && this.data.pack && this.data.pack.isPrivate) return true;
    wx.showToast({ title: "请先收藏到我的题包", icon: "none" });
    this.closeAddMenu();
    return false;
  },

  // ── 目录：就地新建 / 就地改名 / 层级 / 移动 / 删除（对齐 DEC-060、DEC-065）──

  pageSections(collection) {
    const sections = this.source === "private"
      ? privateCollectionSections(collection.sections, collection.rows, collection.pack)
      : collection.sections;
    return decorateCollectionSections(sections, {
      selectedCardIds: this.data.selectedCardIds,
      activeDirectory: this.data.activeDirectory,
      directoryInlineEdit: this.data.directoryInlineEdit,
      cardColorPickerOpen: this.data.cardColorPickerOpen,
      selectedCardColor: this.data.selectedCardColor,
    });
  },

  refreshSections(patch = {}) {
    const collection = buildCollection(getPrivatePack(this.packId) || this.data.pack, "private");
    const sections = decorateCollectionSections(
      privateCollectionSections(collection.sections, collection.rows, collection.pack),
      {
        selectedCardIds: patch.selectedCardIds || this.data.selectedCardIds,
        activeDirectory: patch.activeDirectory === undefined ? this.data.activeDirectory : patch.activeDirectory,
        directoryInlineEdit: patch.directoryInlineEdit === undefined ? this.data.directoryInlineEdit : patch.directoryInlineEdit,
        cardColorPickerOpen: this.data.cardColorPickerOpen,
        selectedCardColor: this.data.selectedCardColor,
      },
    );
    this.setData({
      pack: collection.pack,
      rows: collection.rows,
      sections,
      // DEC-087：渲染用「标题块 + 卡片块」序列（子目录在前、本目录卡片在后）
      sectionBlocks: buildSectionBlocks(sections),
    });
  },

  openDirectoryInline(directoryId, parentId, value) {
    this.setData({
      directoryInlineEdit: String(directoryId),
      directoryInlineValue: String(value || ""),
      directoryInlineParent: String(parentId || ""),
      actionMode: "",
      contextMenuOpen: false,
      addMenuOpen: false,
    });
    this.refreshSections();
    this.scrollDirectoryIntoView(directoryId);
  },

  // 只有在新目录行**真的看不见**时才滚动过去（子目录紧贴父目录，本来就在视野里，
  // 无条件滚动会白白"滑一下"；顶层新建在列表末尾时则确实需要带用户过去）。
  scrollDirectoryIntoView(directoryId) {
    if (typeof wx.createSelectorQuery !== "function" || typeof wx.pageScrollTo !== "function") return;
    const id = String(directoryId || "");
    if (!id) return;
    const navBottom = Number(this.data.navTotalHeight) || 0;
    const viewportHeight = Number(this.data.viewportHeight) || 0;
    const bottomLimit = viewportHeight ? viewportHeight - 160 : 0;
    wx.createSelectorQuery()
      .select(`#directory-anchor-${id}`)
      .boundingClientRect((rect) => {
        if (!rect) return;
        let delta = 0;
        if (rect.top < navBottom + 8) delta = rect.top - navBottom - 8;
        else if (bottomLimit && rect.bottom > bottomLimit) delta = rect.bottom - bottomLimit;
        if (!delta) return;
        wx.pageScrollTo({ scrollTop: Math.max(0, (Number(this._pageScrollTop) || 0) + delta), duration: 180 });
      })
      .exec();
  },

  createDirectory() {
    if (!this.requirePrivatePack()) return;
    const node = insertPackDirectory(this.packId, { parentId: "" });
    if (!node) {
      wx.showToast({ title: "新建目录失败，请稍后重试", icon: "none" });
      return;
    }
    this.closeAddMenu();
    this.openDirectoryInline(node.id, "", "");
  },

  createChildDirectory() {
    if (!this.requirePrivatePack()) return;
    const parentId = String(this.data.activeDirectory || "");
    const parent = this.data.sections.find((section) => String(section.id) === parentId);
    if (!parent) {
      wx.showToast({ title: "请先长按一个目录", icon: "none" });
      return;
    }
    if (Number(parent.level) >= 3) {
      wx.showToast({ title: "最多三级目录", icon: "none" });
      return;
    }
    const node = insertPackDirectory(this.packId, { parentId });
    if (!node) {
      wx.showToast({ title: "新建子目录失败，请稍后重试", icon: "none" });
      return;
    }
    this.openDirectoryInline(node.id, parentId, "");
  },

  editDirectory(event) {
    if (!this.requirePrivatePack()) return;
    const directoryId = String(event.currentTarget.dataset.id || "");
    const section = this.data.sections.find((item) => String(item.id) === directoryId);
    if (!section) return;
    this.openDirectoryInline(directoryId, section.parentId, section.title);
  },

  updateDirectoryInline(event) {
    this.setData({ directoryInlineValue: event.detail.value });
  },

  commitDirectoryInline(event) {
    const directoryId = String(this.data.directoryInlineEdit || "");
    if (!directoryId) return;
    const value = String(event && event.detail && event.detail.value !== undefined ? event.detail.value : this.data.directoryInlineValue).trim();
    this.setData({ directoryInlineEdit: "" });
    if (!value) {
      wx.showToast({ title: "目录名称不能为空", icon: "none" });
      return;
    }
    updatePackNode(this.packId, directoryId, { title: value });
    this.refreshSections();
  },

  // ── 卡片：新建 / 添加一张 / 移动 / 删除 ──

  createCard() {
    if (!this.requirePrivatePack()) return;
    const pack = getPrivatePack(this.packId);
    const directTarget = String(this.data.activeDirectory || "");
    const fallback = pack && pack.nodes && [...pack.nodes].reverse().find((node) => node.type === "directory");
    const directoryId = directTarget || (fallback ? fallback.id : "");
    const node = appendPackCard(this.packId, directoryId);
    this.closeAddMenu();
    if (!node) {
      wx.showToast({ title: "新建卡片失败，请稍后重试", icon: "none" });
      return;
    }
    this.refreshSections();
    wx.showToast({ title: "已添加卡片，点击卡片录入题目", icon: "none" });
  },

  // ── 卡片长按：深色操作栏（编辑 / 添加 / 删除 / 移动 / 取消）──

  // 选中态必须重新装饰一次 sections，否则卡片的 selected 标记不会更新（蓝色选中框不出现）。
  applyCardSelection(selectedIds) {
    const ids = (selectedIds || []).map(String).filter(Boolean);
    this.setData({
      sections: decorateCollectionSections(this.data.sections, {
        selectedCardIds: ids,
        activeDirectory: "",
        directoryInlineEdit: this.data.directoryInlineEdit,
        cardColorPickerOpen: this.data.cardColorPickerOpen,
        selectedCardColor: this.data.selectedCardColor,
      }),
      selectedCardIds: ids,
      canEditSelected: ids.length === 1,
      actionMode: ids.length ? "cards" : "",
      activeDirectory: "",
      contextMenuOpen: false,
      cardColorPickerOpen: ids.length ? this.data.cardColorPickerOpen : false,
    });
  },

  selectCardByNodeId(nodeId) {
    const id = String(nodeId || "");
    if (!id) return false;
    const exists = this.data.sections.some((section) => section.cards.some((card) => card.nodeId === id));
    if (!exists) return false;
    this.applyCardSelection([id]);
    this.setData({
      addMenuOpen: false,
      moreOpen: false,
      contextToolbarTop: Number(this.data.navTotalHeight) + 8,
    });
    return true;
  },

  // 选中模式下再点卡片 = 加选/取消（对齐卡集页 toggleCard）。
  toggleCardSelection(nodeId) {
    const id = String(nodeId || "");
    if (!id) return;
    const current = (this.data.selectedCardIds || []).map(String);
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    if (!next.length) {
      this.cancelSelect();
      return;
    }
    this.applyCardSelection(next);
  },

  selectedCards() {
    const ids = new Set((this.data.selectedCardIds || []).map(String));
    const cards = [];
    this.data.sections.forEach((section) => {
      section.cards.forEach((card) => {
        if (ids.has(card.nodeId)) cards.push(card);
      });
    });
    return cards;
  },

  startSelect(event) {
    if (!this.requirePrivatePack()) return;
    const nodeId = String(event.currentTarget.dataset.nodeId || "");
    if (!this.selectCardByNodeId(nodeId)) return;
    this._longPressAt = Date.now();
    if (this._press && this._press.kind === "card" && this._press.key === nodeId) this._press.armed = true;
    this.setData({ pageScrollLocked: true, contextToolbarReady: false });
    this.placeContextToolbar(`#question-anchor-${event.currentTarget.dataset.id || ""}`);
  },

  openDirectoryActions(event) {
    if (!this.requirePrivatePack()) return;
    const directoryId = String(event.currentTarget.dataset.id || "");
    if (!directoryId) return;
    this._directoryLongPressAt = Date.now();
    if (this._press && this._press.kind === "directory" && this._press.key === directoryId) this._press.armed = true;
    // DEC-083：「标题级别」按钮上的角标显示**当前目录**的级别（一级 H1、二级 H2、三级 H3）。
    const activeSection = this.data.sections.find((section) => String(section.id) === directoryId);
    const activeDirectoryLevel = Math.min(3, Math.max(1, Number(activeSection && activeSection.level) || 1));
    this.setData({
      actionMode: "directory",
      activeDirectory: directoryId,
      activeDirectoryLevel,
      selectedCardIds: [],
      contextMenuOpen: false,
      addMenuOpen: false,
      moreOpen: false,
      contextToolbarReady: false,
      pageScrollLocked: true,
    });
    this.placeContextToolbar(`#directory-anchor-${directoryId}`);
  },

  cancelSelect() {
    this.setData({
      sections: decorateCollectionSections(this.data.sections, {
        selectedCardIds: [],
        activeDirectory: "",
        directoryInlineEdit: this.data.directoryInlineEdit,
        cardColorPickerOpen: false,
        selectedCardColor: this.data.selectedCardColor,
      }),
      actionMode: "",
      selectedCardIds: [],
      canEditSelected: false,
      activeDirectory: "",
      contextMenuOpen: false,
      cardColorPickerOpen: false,
      pageScrollLocked: false,
      contextToolbarReady: true,
    });
  },

  selectionAction(event) {
    const action = String(event.currentTarget.dataset.action || "");
    const selected = (this.data.selectedCardIds || []).map(String);
    const nodeId = String(selected[0] || "");
    if (!nodeId) return;
    if (action === "edit" || action === "add") {
      if (selected.length !== 1) {
        wx.showToast({ title: "一次只能编辑或添加一张", icon: "none" });
        return;
      }
    }
    if (action === "edit") {
      const row = this.data.rows.find((item) => String(item.nodeId || "") === nodeId);
      this.cancelSelect();
      if (row) this.openQuestion({ currentTarget: { dataset: { id: row.id } } });
      return;
    }
    if (action === "add") {
      const node = insertPackCardAfter(this.packId, nodeId);
      this.cancelSelect();
      if (!node) {
        wx.showToast({ title: "添加卡片失败，请稍后重试", icon: "none" });
        return;
      }
      this.refreshSections();
      wx.showToast({ title: "已在该卡片后添加空白卡片", icon: "none" });
      return;
    }
    if (action === "color") {
      this.openCardColorPicker();
      return;
    }
    if (action === "move") {
      this.openContextMenu({
        title: selected.length > 1 ? `移动 ${selected.length} 张卡片` : "移动到目录",
        items: this.directoryMenuItems(),
        align: "right",
        kind: "moveCard",
      });
      return;
    }
    if (action === "delete") {
      if (selected.length > 1) {
        this.confirmDeleteNodes(selected, `选中的 ${selected.length} 张卡片`);
        return;
      }
      const row = this.data.rows.find((item) => String(item.nodeId || "") === nodeId);
      this.confirmDeleteNode(nodeId, row && row.isBlank ? "这张空白卡片" : "这张卡片上的题目引用");
    }
  },

  // 卡片上色（DEC-067：两排色点，第一个是“无颜色”）
  openCardColorPicker() {
    const selected = this.selectedCards();
    if (!selected.length) return;
    this.setData({
      cardColorPickerOpen: true,
      selectedCardColor: String(selected[0].color || ""),
      cardColorPickerTop: Number(this.data.contextToolbarTop || 0) + 108,
      contextMenuOpen: false,
    });
  },

  closeCardColorPicker() {
    this.setData({ cardColorPickerOpen: false });
  },

  selectCardColor(event) {
    const key = String(event.currentTarget.dataset.key || "");
    const ids = (this.data.selectedCardIds || []).map(String);
    if (!ids.length) return;
    setPackCardsColor(this.packId, ids, key);
    this.setData({ selectedCardColor: key });
    this.refreshSections();
  },

  directoryAction(event) {
    const action = String(event.currentTarget.dataset.action || "");
    const directoryId = String(this.data.activeDirectory || "");
    if (!directoryId) return;
    const isLoose = directoryId === "__loose__";
    if (isLoose && action !== "add") {
      wx.showToast({ title: "“未归档”是系统分组，不能改名或删除", icon: "none" });
      return;
    }
    if (action === "edit") {
      const section = this.data.sections.find((item) => String(item.id) === directoryId);
      this.openDirectoryInline(directoryId, section && section.parentId, section && section.title);
      return;
    }
    if (action === "add") {
      this.openContextMenu({
        title: "在目录后添加",
        items: [
          { key: "card", label: "插入卡片" },
          { key: "child", label: "插入子目录" },
        ],
        align: "center",
        kind: "addInDirectory",
      });
      return;
    }
    if (action === "level") {
      this.openContextMenu({
        title: "标题级别",
        items: [
          { key: "1", label: "一级目录" },
          { key: "2", label: "二级目录" },
          { key: "3", label: "三级目录" },
        ],
        align: "center",
        kind: "setLevel",
      });
      return;
    }
    if (action === "move") {
      this.openContextMenu({
        title: "移动到目录",
        items: this.directoryMenuItems(directoryId),
        align: "right",
        kind: "moveDirectory",
      });
      return;
    }
    if (action === "delete") {
      const section = this.data.sections.find((item) => String(item.id) === directoryId);
      this.confirmDeleteNode(directoryId, `目录「${section ? section.title : ""}」`, true);
    }
  },

  directoryMenuItems(excludeId = "") {
    const excluded = new Set([String(excludeId || "")]);
    return [
      { key: "", label: "未归档（不在任何目录）" },
      ...this.data.sections
        .filter((section) => !excluded.has(String(section.id)))
        .map((section) => ({
          key: String(section.id),
          label: `${"　".repeat(Math.max(0, Number(section.level || 1) - 1))}${section.title}`,
        })),
    ];
  },

  openContextMenu({ title, items, align, kind }) {
    this.setData({
      contextMenuOpen: true,
      contextMenuTitle: title,
      contextMenuItems: items.map((item) => ({ ...item, kind })),
      contextMenuAlign: align || "center",
      contextMenuTop: Number(this.data.contextToolbarTop || 0) + 108,
    });
  },

  closeContextMenu() {
    this.setData({ contextMenuOpen: false, contextMenuItems: [] });
  },

  selectContextMenuOption(event) {
    const key = String(event.currentTarget.dataset.key || "");
    const kind = String(event.currentTarget.dataset.kind || "");
    this.closeContextMenu();
    if (kind === "addInDirectory") {
      if (key === "card") {
        const directoryId = String(this.data.activeDirectory || "");
        const node = appendPackCard(this.packId, directoryId);
        this.cancelSelect();
        if (!node) {
          wx.showToast({ title: "新建卡片失败，请稍后重试", icon: "none" });
          return;
        }
        this.refreshSections();
        return;
      }
      this.createChildDirectory();
      return;
    }
    if (kind === "setLevel") {
      const directoryId = String(this.data.activeDirectory || "");
      updatePackNode(this.packId, directoryId, { level: Math.min(3, Math.max(1, Number(key) || 1)) });
      this.cancelSelect();
      this.refreshSections();
      return;
    }
    if (kind === "movePackCategory") {
      const pack = getPrivatePack(this.packId);
      if (pack) {
        savePrivatePack({ ...pack, categoryId: key });
        wx.showToast({ title: key ? "已移动到分类" : "已移出分类", icon: "none" });
      }
      return;
    }
    if (kind === "moveCard") {
      const ids = (this.data.selectedCardIds || []).map(String);
      ids.forEach((nodeId) => movePackCardToDirectory(this.packId, nodeId, key));
      this.cancelSelect();
      this.refreshSections();
      wx.showToast({ title: ids.length > 1 ? `已移动 ${ids.length} 张卡片` : "已移动卡片", icon: "none" });
      return;
    }
    if (kind === "moveDirectory") {
      const directoryId = String(this.data.activeDirectory || "");
      const moved = movePackDirectoryUnder(this.packId, directoryId, key);
      this.cancelSelect();
      if (!moved) {
        wx.showToast({ title: "不能移动到自己的下级目录", icon: "none" });
        return;
      }
      this.refreshSections();
      wx.showToast({ title: "已移动目录", icon: "none" });
    }
  },

  confirmDeleteNode(nodeId, label, isDirectory = false) {
    this.confirmDeleteNodes([nodeId], label, isDirectory);
  },

  confirmDeleteNodes(nodeIds, label, isDirectory = false) {
    const ids = (Array.isArray(nodeIds) ? nodeIds : [nodeIds]).map((id) => String(id || "")).filter(Boolean);
    if (!ids.length) return;
    wx.showModal({
      title: isDirectory ? "删除目录" : "删除卡片",
      content: isDirectory
        ? `删除后${label}会被移除，其中的卡片回到“未归档”（题目本身保留在“我的资产”里）。`
        : `删除后${label}会从题包移除（题目本身保留在“我的资产”里）。`,
      confirmText: "删除",
      confirmColor: "#c0392b",
      success: (result) => {
        if (!result.confirm) return;
        ids.forEach((id) => deletePackNode(this.packId, id));
        this.cancelSelect();
        this.refreshSections();
        wx.showToast({ title: isDirectory ? "已删除目录" : "已删除卡片", icon: "none" });
      },
    });
  },

  // ── 拖拽排序（对齐 DEC-052 / DEC-054）：长按选中后按住拖动，浮起幽灵卡 + 蓝色落点提示 ──

  placeContextToolbar(anchorSelector) {
    const dockedTop = Number(this.data.floatingTop) || 0;
    const fallback = () => {
      this._contextToolbarAnchorTop = null;
      this.setData({ contextToolbarTop: dockedTop, contextToolbarReady: true });
    };
    if (!anchorSelector || typeof wx.createSelectorQuery !== "function") {
      fallback();
      return;
    }
    const query = wx.createSelectorQuery();
    query.select(anchorSelector).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((results) => {
      const rect = results && results[0];
      const viewport = results && results[1];
      if (!rect) {
        fallback();
        return;
      }
      const scrollTop = Number(viewport && viewport.scrollTop) || 0;
      const toolbarHeight = Number(this.data.contextToolbarHeight) || 48;
      const viewportHeight = Number(this.data.viewportHeight) || 0;
      const maxTop = viewportHeight ? Math.max(dockedTop, viewportHeight - toolbarHeight - 20) : 0;
      let top = Number(rect.top || 0) - toolbarHeight - 12;
      if (top < dockedTop) {
        top = Number(rect.bottom || rect.top || 0) + 12;
        if (maxTop) top = Math.min(top, maxTop);
      }
      const applied = Math.max(dockedTop, Math.round(top));
      this._contextToolbarAnchorTop = applied + scrollTop;
      if (this.data.dragActive) return;
      this.setData({ contextToolbarTop: applied, contextToolbarReady: true });
    });
  },

  onPageScroll(event) {
    this._pageScrollTop = Number(event && event.scrollTop) || 0;
    if (this.data.dragActive) {
      this.updateDrag();
      return;
    }
    if (!this.data.actionMode) return;
    const anchorTop = this._contextToolbarAnchorTop;
    if (typeof anchorTop !== "number") return;
    const dockedTop = Number(this.data.floatingTop) || 0;
    const top = Math.max(dockedTop, Math.round(anchorTop - this._pageScrollTop));
    if (top !== this.data.contextToolbarTop) this.setData({ contextToolbarTop: top });
  },

  handleCardTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this._press = {
      kind: "card",
      key: String(event.currentTarget.dataset.nodeId || ""),
      section: String(event.currentTarget.dataset.section || ""),
      x: touch.clientX,
      y: touch.clientY,
      armed: false,
    };
  },

  handleTitleTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this._press = {
      kind: "directory",
      key: String(event.currentTarget.dataset.id || ""),
      section: "",
      x: touch.clientX,
      y: touch.clientY,
      armed: false,
    };
  },

  handleCardTouchMove(event) {
    this.trackDragTouch(event, "card");
  },

  handleTitleTouchMove(event) {
    this.trackDragTouch(event, "directory");
  },

  trackDragTouch(event, kind) {
    const touch = event.touches && event.touches[0];
    const press = this._press;
    if (!touch) return;
    if (!this.data.dragActive) {
      if (!press || press.kind !== kind || !press.armed) return;
      if (Math.abs(touch.clientY - press.y) < DRAG_THRESHOLD
        && Math.abs(touch.clientX - press.x) < DRAG_THRESHOLD) return;
      this.beginDrag(press, touch);
      return;
    }
    if (!this._drag || this._drag.kind !== kind) return;
    if (touch.clientX === this._drag.pointerX && touch.clientY === this._drag.pointerY) return;
    this._drag.pointerX = touch.clientX;
    this._drag.pointerY = touch.clientY;
    this.updateDrag();
  },

  handleDragTouchEnd() {
    this._press = null;
    this.stopDragAutoScroll();
    if (this.data.pageScrollLocked) this.setData({ pageScrollLocked: false });
    if (this.data.dragActive) this.finishDrag();
  },

  beginDrag(press, touch) {
    this.measureDragLayout((layout) => {
      if (this._press !== press) return;
      const list = press.kind === "card" ? layout.cards : layout.titles;
      const origin = list.find((item) => (press.kind === "card" ? item.id : item.id) === press.key);
      if (!origin) return;
      this._drag = {
        kind: press.kind,
        key: press.key,
        section: press.section,
        origin,
        width: Number(origin.right) - Number(origin.left),
        grabX: press.x - origin.left,
        grabY: press.y - origin.top,
        pointerX: touch.clientX,
        pointerY: touch.clientY,
        startScrollTop: layout.scrollTop,
        cards: layout.cards,
        titles: layout.titles,
        drop: null,
      };
      const dragGhost = press.kind === "card"
        ? this.data.sections.flatMap((section) => section.cards).find((card) => card.nodeId === press.key) || null
        : this.data.sections.find((section) => String(section.id) === press.key) || null;
      const selected = (this.data.selectedCardIds || []).map(String);
      const dragGroupCount = press.kind === "card" && selected.includes(press.key) && selected.length > 1
        ? selected.length
        : 0;
      this._pageScrollTop = layout.scrollTop;
      this.setData({
        dragActive: true,
        dragKind: press.kind,
        dragKey: press.key,
        dragGhost,
        dragGroupCount,
        contextToolbarReady: false,
      });
      this.updateDrag();
    });
  },

  measureDragLayout(callback) {
    if (typeof wx.createSelectorQuery !== "function") {
      callback({ cards: [], titles: [], scrollTop: Number(this._pageScrollTop) || 0 });
      return;
    }
    const realDirectoryIds = new Set(
      this.data.sections.filter((section) => !section.isLoose).map((section) => String(section.id)),
    );
    const query = wx.createSelectorQuery();
    query.selectAll(".study-card").boundingClientRect();
    query.selectAll(".section-title").boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((results) => {
      const cardRects = (results && results[0]) || [];
      const titleRects = (results && results[1]) || [];
      const viewport = results && results[2];
      callback({
        cards: cardRects.map((rect) => ({
          id: String(rect.dataset && rect.dataset.nodeId || ""),
          section: String(rect.dataset && rect.dataset.section || ""),
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        })).filter((item) => item.id),
        titles: titleRects.map((rect) => ({
          id: String(rect.dataset && rect.dataset.id || ""),
          title: String(rect.dataset && rect.dataset.title || ""),
          isLoose: !realDirectoryIds.has(String(rect.dataset && rect.dataset.id || "")),
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        })).filter((item) => item.id),
        scrollTop: Number(viewport && viewport.scrollTop) || 0,
      });
    });
  },

  updateDrag() {
    const drag = this._drag;
    if (!drag) return;
    const scrollDelta = (Number(this._pageScrollTop) || 0) - drag.startScrollTop;
    const left = Math.round(drag.pointerX - drag.grabX);
    const top = Math.round(drag.pointerY - drag.grabY);
    const drop = drag.kind === "card"
      ? this.computeCardDrop(drag, scrollDelta)
      : this.computeDirectoryDrop(drag, scrollDelta);
    drag.drop = drop;
    this._pendingDrag = {
      dragStyle: `left: ${left}px; top: ${top}px; width: ${Math.round(drag.width)}px;`,
      dragIndicator: drop ? drop.indicator : null,
    };
    this.flushDragFrame();
    this.updateDragAutoScroll();
  },

  updateDragAutoScroll() {
    const drag = this._drag;
    if (!drag) {
      this.stopDragAutoScroll();
      return;
    }
    const navBottom = Number(this.data.navTotalHeight) || 0;
    const viewportHeight = Number(this.data.viewportHeight) || 0;
    const bottomLimit = viewportHeight ? viewportHeight - DRAG_EDGE_BOTTOM : Number.POSITIVE_INFINITY;
    let direction = 0;
    if (drag.pointerY < navBottom + DRAG_EDGE_ZONE) direction = -1;
    else if (drag.pointerY > bottomLimit) direction = 1;

    if (!direction) {
      this._dragAutoScrollDirection = 0;
      this.stopDragAutoScroll();
      return;
    }

    this._dragAutoScrollDirection = direction;
    const depth = direction < 0
      ? Math.max(0, navBottom + DRAG_EDGE_ZONE - drag.pointerY)
      : Math.max(0, drag.pointerY - bottomLimit);
    this._dragAutoScrollStep = Math.min(DRAG_EDGE_MAX_STEP, 4 + Math.round(depth / 4));
    if (this._dragAutoScrollTimer) return;
    this._dragAutoScrollTarget = Number(this._pageScrollTop) || 0;
    this._dragAutoScrollTimer = setInterval(() => {
      const current = this._drag;
      if (!current || !this._dragAutoScrollDirection) {
        this.stopDragAutoScroll();
        return;
      }
      this._dragAutoScrollTarget = Math.max(0, this._dragAutoScrollTarget + this._dragAutoScrollDirection * this._dragAutoScrollStep);
      if (typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({ scrollTop: this._dragAutoScrollTarget, duration: 0 });
      }
    }, DRAG_EDGE_INTERVAL);
  },

  stopDragAutoScroll() {
    if (this._dragAutoScrollTimer) {
      clearInterval(this._dragAutoScrollTimer);
      this._dragAutoScrollTimer = null;
    }
  },

  flushDragFrame() {
    if (this._dragFrame) return;
    this._dragFrame = setTimeout(() => {
      this._dragFrame = null;
      const pending = this._pendingDrag;
      this._pendingDrag = null;
      if (pending && this.data.dragActive) this.setData(pending);
    }, 16);
  },

  shiftedRects(drag, scrollDelta) {
    return (drag.cards || []).map((item) => ({
      ...item,
      top: item.top - scrollDelta,
      bottom: item.bottom - scrollDelta,
    }));
  },

  shiftedTitles(drag, scrollDelta) {
    return (drag.titles || []).map((item) => ({
      ...item,
      top: item.top - scrollDelta,
      bottom: item.bottom - scrollDelta,
    }));
  },

  computeCardDrop(drag, scrollDelta) {
    const titles = this.shiftedTitles(drag, scrollDelta);
    if (!titles.length) return null;
    const cards = this.shiftedRects(drag, scrollDelta);
    const { pointerX, pointerY } = drag;

    let target = titles.find((title, index) => (
      pointerY >= title.top && (index + 1 >= titles.length || pointerY < titles[index + 1].top)
    ));
    if (!target) target = pointerY < titles[0].top ? titles[0] : titles[titles.length - 1];

    const own = cards.filter((card) => card.section === target.id);
    if (!own.length) {
      return { section: target.id, index: 0, indicator: this.rowIndicator(target.bottom + 12) };
    }
    const index = cardSlotIndex(own, pointerX, pointerY);
    return { section: target.id, index, indicator: this.cardIndicator(own, index) };
  },

  cardIndicator(own, index) {
    if (index >= own.length) {
      const last = own[own.length - 1];
      return { kind: "row", left: this.contentLeft(), top: Math.round(last.bottom + 6), width: this.contentWidth(), height: 4 };
    }
    const target = own[index];
    if (index % 2 === 1) {
      const left = own[index - 1];
      return {
        kind: "column",
        left: Math.round((left.right + target.left) / 2 - 2),
        top: Math.round(left.top),
        width: 4,
        height: Math.round(left.bottom - left.top),
      };
    }
    return { kind: "row", left: this.contentLeft(), top: Math.round(target.top - 6), width: this.contentWidth(), height: 4 };
  },

  contentLeft() {
    return Number(this.data.contentLeft) || 14;
  },

  contentWidth() {
    return Number(this.data.contentWidth) || 300;
  },

  computeDirectoryDrop(drag, scrollDelta) {
    const titles = this.shiftedTitles(drag, scrollDelta);
    if (!titles.length) return null;
    const cards = this.shiftedRects(drag, scrollDelta);
    const { pointerX, pointerY } = drag;

    let target = titles.find((title, index) => (
      pointerY >= title.top && (index + 1 >= titles.length || pointerY < titles[index + 1].top)
    ));
    if (!target) target = pointerY < titles[0].top ? titles[0] : titles[titles.length - 1];

    // 接管卡片：拖到别人卡片区里（不在自己行、且在标题下方），把从这一格起的卡片划过来。
    const own = cards.filter((card) => card.section === target.id);
    if (!target.isLoose && own.length && target.id !== drag.key && pointerY > target.bottom) {
      const index = cardSlotIndex(own, pointerX, pointerY);
      if (index < own.length) {
        return { mode: "takeover", section: target.id, index, indicator: this.cardIndicator(own, index) };
      }
    }

    const realTitles = titles.filter((title) => !title.isLoose);
    if (!realTitles.length) return null;
    let index = realTitles.length;
    for (let position = 0; position < realTitles.length; position += 1) {
      const title = realTitles[position];
      if (pointerY < (title.top + title.bottom) / 2) {
        index = position;
        break;
      }
    }
    const anchor = realTitles[index] || realTitles[realTitles.length - 1];
    return {
      mode: "reorder",
      index,
      indicator: this.rowIndicator(index < realTitles.length ? anchor.top - 6 : anchor.bottom + 6),
    };
  },

  rowIndicator(top) {
    return {
      kind: "row",
      left: this.contentLeft(),
      top: Math.max(0, Math.round(top)),
      width: this.contentWidth(),
      height: 4,
    };
  },

  finishDrag() {
    const drag = this._drag;
    const drop = drag && drag.drop;
    // 先取出来：下面的 setData 会把选中态与角标一起清掉。
    const dragGroupCount = Number(this.data.dragGroupCount) || 0;
    const dragSelectedCardIds = (this.data.selectedCardIds || []).map(String);
    this._drag = null;
    this._pendingDrag = null;
    this.stopDragAutoScroll();
    this._dragAutoScrollDirection = 0;
    if (this._dragFrame) {
      clearTimeout(this._dragFrame);
      this._dragFrame = null;
    }
    this.setData({
      dragActive: false,
      dragKind: "",
      dragKey: "",
      dragGhost: null,
      dragGroupCount: 0,
      dragStyle: "",
      dragIndicator: null,
      pageScrollLocked: false,
    });
    this.cancelSelect();
    if (!drag || !drop) return;
    if (!this.requirePrivatePack()) return;

    const targetDirectoryId = drop.section === "__loose__" ? "" : drop.section;

    if (drag.kind === "card") {
      const own = (this.data.sections.find((section) => String(section.id) === drag.section) || {}).cards || [];
      const currentIndex = own.findIndex((card) => card.nodeId === drag.key);
      const index = drag.section === drop.section && currentIndex >= 0 && currentIndex < drop.index
        ? drop.index - 1
        : drop.index;
      // DEC-074：拖的是多选里的一张时，整组一起走。
      if (dragGroupCount > 1) {
        const grouped = movePackCardsTo(this.packId, dragSelectedCardIds, targetDirectoryId, index);
        if (!grouped) {
          wx.showToast({ title: "移动失败，请重试", icon: "none" });
          return;
        }
        this.refreshSections();
        wx.showToast({ title: `已移动 ${grouped.movedCount} 张卡片`, icon: "none" });
        return;
      }
      const moved = movePackCardTo(this.packId, drag.key, targetDirectoryId, index);
      if (!moved) {
        wx.showToast({ title: "移动失败，请重试", icon: "none" });
        return;
      }
      this.refreshSections();
      wx.showToast({ title: "已移动卡片", icon: "none" });
      return;
    }

    const sourceIndex = this.data.sections.findIndex((section) => String(section.id) === drag.key);
    if (drop.mode === "takeover") {
      const adopted = adoptPackCardsIntoDirectory(this.packId, drag.key, drop.section, drop.index);
      if (!adopted) {
        wx.showToast({ title: "移动失败，请重试", icon: "none" });
        return;
      }
      this.refreshSections();
      wx.showToast({ title: `已把 ${adopted.movedCount} 张卡片划到「${adopted.directory}」`, icon: "none" });
      return;
    }
    const index = sourceIndex >= 0 && sourceIndex < drop.index ? drop.index - 1 : drop.index;
    const moved = movePackDirectoryToIndex(this.packId, drag.key, index);
    if (!moved) {
      wx.showToast({ title: "移动失败，请重试", icon: "none" });
      return;
    }
    this.refreshSections();
    wx.showToast({ title: "目录顺序已更新", icon: "none" });
  },

  handleBlankTap() {
    if (this.data.dragActive) return;
    if (this.data.contextMenuOpen) {
      this.closeContextMenu();
      return;
    }
    if (this.data.actionMode || this.data.cardColorPickerOpen) this.cancelSelect();
  },

  // 左上角目录入口：从左侧弹出目录抽屉（对齐知识卡卡集页 / 刷题页），不再滚动到页面目录区。
  openCatalog() {
    const catalogRows = buildCollectionRows(this.data.sections, this._collapsedDirectories);
    this.setData({
      catalogOpen: true,
      catalogView: "directory",
      addMenuOpen: false,
      moreOpen: false,
      catalogRows,
      catalogDirectoryCount: catalogRows.length,
      catalogExpandedAll: isCollectionFullyExpanded(catalogRows),
    });
  },

  closeCatalog() {
    this.setData({ catalogOpen: false });
  },

  findCatalogRow(key) {
    return this.data.catalogRows.find((row) => row.key === String(key || ""));
  },

  selectCatalogRow(event) {
    const row = this.findCatalogRow(event.currentTarget.dataset.key);
    if (!row) return;
    if (!row.hasChildren) {
      this.openCatalogSummary(row);
      return;
    }
    const collapsed = { ...(this._collapsedDirectories || {}) };
    if (row.expanded) collapsed[row.key] = true;
    else delete collapsed[row.key];
    this.applyCatalogExpansion(collapsed);
  },

  toggleCatalogExpansionAll() {
    const foldable = this.data.catalogRows.filter((row) => row.hasChildren);
    if (!foldable.length) return;
    const expandAll = !isCollectionFullyExpanded(this.data.catalogRows);
    const collapsed = { ...(this._collapsedDirectories || {}) };
    foldable.forEach((row) => {
      if (expandAll) delete collapsed[row.key];
      else collapsed[row.key] = true;
    });
    this.applyCatalogExpansion(collapsed);
  },

  applyCatalogExpansion(collapsed) {
    this._collapsedDirectories = collapsed;
    const catalogRows = buildCollectionRows(this.data.sections, collapsed);
    this.setData({ catalogRows, catalogExpandedAll: isCollectionFullyExpanded(catalogRows) });
  },

  // 题包目录允许“既有下级目录、又直接挂题”，所以行右侧的数量也可以点开该目录自己的题目。
  // 既支持从行点击传来 row，也支持数量胶囊的 catchtap 事件。
  openCatalogSummary(target) {
    const row = target && target.currentTarget
      ? this.findCatalogRow(target.currentTarget.dataset.key)
      : target;
    if (!row) return;
    const section = this.data.sections.find((item) => String(item.id) === row.key);
    const items = section && Array.isArray(section.items) ? section.items : [];
    if (!items.length) {
      wx.showToast({ title: `${row.title}暂无题目`, icon: "none" });
      return;
    }
    this.setData({
      catalogView: "summary",
      catalogSummaryTitle: row.title,
      catalogSummaryQuestions: items.map((item, index) => ({
        id: item.id,
        summaryNumber: cleanText(item.displayNumber) || String(index + 1).padStart(2, "0"),
        title: item.isBlank
          ? "空白卡片（进入管理题包录入）"
          : (cleanText(item.stemPreview) || "未命名题目"),
        available: item.available !== false,
      })),
    });
  },

  backToCatalogDirectory() {
    this.setData({ catalogView: "directory" });
  },

  // 点题目：关闭抽屉，把页面滚到这道题并高亮两秒（不直接打开题目，保持“定位”语义）。
  selectCatalogQuestion(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id) return;
    this.setData({ catalogOpen: false, selectedQuestionId: id });
    this.scrollToQuestion(id);
    if (this._catalogHighlightTimer) clearTimeout(this._catalogHighlightTimer);
    this._catalogHighlightTimer = setTimeout(() => {
      this._catalogHighlightTimer = null;
      if (this.data.selectedQuestionId === id) this.setData({ selectedQuestionId: "" });
    }, 2000);
  },

  scrollToQuestion(questionId) {
    if (typeof wx.createSelectorQuery !== "function" || typeof wx.pageScrollTo !== "function") return;
    const query = wx.createSelectorQuery();
    query.select(`#question-anchor-${questionId}`).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((results) => {
      const rect = results && results[0];
      const viewport = results && results[1];
      if (!rect) return;
      const currentTop = Number(viewport && viewport.scrollTop) || 0;
      const headerOffset = Number(this.data.navTotalHeight) || 0;
      wx.pageScrollTo({
        scrollTop: Math.max(0, currentTop + Number(rect.top || 0) - headerOffset - 12),
        duration: 260,
      });
    });
  },

  stopTouchMove() {},

  noop() {},

  // 离开本页时收掉所有瞬态浮层（抽屉/菜单/更多/导入/选中态）：
  // 这些层都带遮罩，跨页残留会变成“页面能滚、按钮点不动”的隐形拦截层。
  onHide() {
    this._press = null;
    this.stopDragAutoScroll();
    closeTransientLayers(this, ["catalogOpen", "contextMenuOpen", "cardColorPickerOpen", "addMenuOpen", "moreOpen", "questionImporterOpen", "colorPanelOpen"], {
      dragActive: false,
      dragGhost: null,
      dragIndicator: null,
      dragGroupCount: 0,
      dragStyle: "",
    });
    this.cancelSelect();
  },

  onUnload() {
    if (this._catalogHighlightTimer) {
      clearTimeout(this._catalogHighlightTimer);
      this._catalogHighlightTimer = null;
    }
    this.stopDragAutoScroll();
    if (this._dragFrame) {
      clearTimeout(this._dragFrame);
      this._dragFrame = null;
    }
  },

  openQuestion(event) {
    if (Date.now() - Number(this._longPressAt || 0) < 500) return;
    const id = String(event.currentTarget.dataset.id || "");
    if (this.data.actionMode === "cards") {
      this.toggleCardSelection(event.currentTarget.dataset.nodeId);
      return;
    }
    const row = this.data.rows.find((item) => item.id === id);
    if (!row) return;
    if (row.isBlank) {
      wx.navigateTo({
        url: `/pages/contribute/contribute?packId=${encodeURIComponent(this.packId)}&cardId=${encodeURIComponent(row.nodeId || "")}`,
      });
      return;
    }
    if (!row.available) {
      this.handleDeletedQuestion(this.data.rows.indexOf(row));
      return;
    }
    this.openPractice(row);
  },

  nextAvailableRow(index) {
    for (let cursor = Math.max(0, Number(index) + 1); cursor < this.data.rows.length; cursor += 1) {
      if (this.data.rows[cursor].available) return this.data.rows[cursor];
    }
    for (let cursor = Math.min(this.data.rows.length - 1, Number(index) - 1); cursor >= 0; cursor -= 1) {
      if (this.data.rows[cursor].available) return this.data.rows[cursor];
    }
    return null;
  },

  handleDeletedQuestion(index) {
    const next = this.nextAvailableRow(index);
    if (!next) {
      wx.showToast({ title: "题包中暂无可用题目", icon: "none" });
      return;
    }
    const continueToNext = () => this.openPractice(next);
    if (typeof wx.showModal === "function") {
      wx.showModal({
        title: "题目已被作者删除",
        content: "已自动定位到下一道可用题。",
        showCancel: false,
        confirmText: "继续",
        success: continueToNext,
      });
      return;
    }
    wx.showToast({ title: "题目已删除，已定位下一题", icon: "none" });
    continueToNext();
  },

  openPractice(row = null) {
    const target = row || this.data.rows.find((item) => item.available);
    if (!target || !target.available) {
      wx.showToast({ title: "题包中暂无可用题目", icon: "none" });
      return;
    }
    const availableRows = this.data.rows.filter((item) => item.available);
    const queue = availableRows.map((item, index) => normalizeQuestionForPractice({
      ...item,
      questionType: item.questionType || item.typeLabel,
      typeCode: item.typeCode || item.type,
      optionsText: item.optionsText || (Array.isArray(item.options)
        ? item.options.map((option) => `${option.key || ""}. ${option.text || option.value || ""}`).join("\n")
        : ""),
      packId: this.packId,
    }, index));
    wx.setStorageSync("shukao_active_pack_questions", queue);
    wx.setStorageSync("shukao_active_pack_name", this.data.pack.name);
    wx.setStorageSync("shukao_active_pack_id", this.packId);
    const questionQuery = row ? `&questionId=${encodeURIComponent(target.id)}` : "";
    wx.navigateTo({
      url: `/pages/practice/practice?mode=pack&packId=${encodeURIComponent(this.packId)}${questionQuery}`,
    });
  },

  startPractice() { this.openPractice(); },

  toggleMore() { this.setData({ moreOpen: !this.data.moreOpen, addMenuOpen: false, questionImporterOpen: false }); },

  closeMore() { this.setData({ moreOpen: false }); },

  // 管理题包页已下线（DEC-075）：能力并入本页，从「我的资产」挑题直接进题包。
  openQuestionImporter() {
    if (!this.requirePrivatePack()) return;
    const packQuestionIds = new Set((this.data.pack && this.data.pack.questionIds) || []);
    const availableQuestions = loadAssets()
      .filter((asset) => asset.type === "question" && !packQuestionIds.has(String(asset.id)))
      .map((asset) => ({
        id: String(asset.id || ""),
        displayTitle: cleanText(asset.stem || asset.title) || "未命名题目",
        displayPath: [asset.subjectName, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" / ") || "暂未归入教材目录",
      }));
    this.setData({ moreOpen: false, questionImporterOpen: true, availableQuestions });
  },

  closeQuestionImporter() {
    this.setData({ questionImporterOpen: false });
  },

  importExistingQuestion(event) {
    if (!this.requirePrivatePack()) return;
    const questionId = String(event.currentTarget.dataset.id || "");
    if (!questionId) return;
    addQuestionToPack(this.packId, questionId);
    this.refreshSections();
    this.openQuestionImporter();
    wx.showToast({ title: "已导入题目", icon: "none" });
  },

  sharePack() {
    this.closeMore();
    if (typeof wx.showShareMenu === "function") wx.showShareMenu({ menus: ["shareAppMessage"] });
    wx.showToast({ title: "可通过右上角分享题包", icon: "none" });
  },

  // ── 样式设置：本題包卡片的统一颜色 / 彩虹色（复用知识卡那套色板与玻璃配方）──

  packCardNodeIds() {
    const ids = [];
    (this.data.sections || []).forEach((section) => {
      (section.cards || []).forEach((card) => {
        if (card.nodeId) ids.push(String(card.nodeId));
      });
    });
    return ids;
  },

  openPackColorPanel() {
    if (!this.requirePrivatePack()) return;
    const ids = this.packCardNodeIds();
    if (!ids.length) {
      wx.showToast({ title: "题包还没有卡片", icon: "none" });
      return;
    }
    const uniform = new Set((this.data.sections || [])
      .flatMap((section) => section.cards || [])
      .filter((card) => card.nodeId)
      .map((card) => String(card.color || "")));
    this._packColorIds = ids;
    this.setData({
      moreOpen: false,
      colorPanelOpen: true,
      colorMode: "uniform",
      selectedPackColor: uniform.size === 1 ? [...uniform][0] : "",
      packColorScopeLabel: `本題包的全部 ${ids.length} 张卡片`,
    });
  },

  closePackColorPanel() {
    this.setData({ colorPanelOpen: false });
  },

  selectColorMode(event) {
    const mode = String(event.currentTarget.dataset.mode || "uniform");
    this.setData({ colorMode: mode === "rainbow" ? "rainbow" : "uniform" });
  },

  applyUniformPackColor(event) {
    const key = String(event.currentTarget.dataset.key || "");
    const ids = this._packColorIds || this.packCardNodeIds();
    if (!ids.length) return;
    setPackCardsColor(this.packId, ids, key);
    this.setData({ selectedPackColor: key });
    this.refreshSections();
    wx.showToast({ title: key ? "已更换颜色" : "已清除颜色", icon: "none" });
  },

  applyRainbowPackColor() {
    const ids = this._packColorIds || this.packCardNodeIds();
    if (!ids.length) return;
    const keys = CARD_COLORS.map((item) => item.key);
    const colorByNodeId = {};
    ids.forEach((id, index) => { colorByNodeId[id] = keys[index % keys.length]; });
    applyPackCardColors(this.packId, colorByNodeId);
    this.refreshSections();
    wx.showToast({ title: "已应用渐变色", icon: "none" });
  },

  // ── 题包管理：重命名 / 移动到分类 / 删除 ──

  packManageAction(event) {
    const key = String(event.currentTarget.dataset.key || "");
    if (key === "rename") this.renamePack();
    if (key === "category") this.openPackCategoryMenu();
    if (key === "delete") this.deletePack();
  },

  renamePack() {
    if (!this.requirePrivatePack()) return;
    const pack = getPrivatePack(this.packId);
    if (!pack) return;
    this.closeMore();
    wx.showModal({
      title: "重命名题包",
      editable: true,
      content: pack.name || "",
      placeholderText: "输入题包名称",
      success: (result) => {
        if (!result.confirm) return;
        const name = String(result.content || "").trim();
        if (!name) {
          wx.showToast({ title: "题包名称不能为空", icon: "none" });
          return;
        }
        savePrivatePack({ ...pack, name });
        this.refreshSections();
        wx.showToast({ title: "已重命名", icon: "none" });
      },
    });
  },

  openPackCategoryMenu() {
    if (!this.requirePrivatePack()) return;
    const pack = getPrivatePack(this.packId);
    if (!pack) return;
    const categories = loadPrivatePackCategories();
    this.closeMore();
    this.setData({ actionMode: "", selectedCardIds: [], activeDirectory: "" });
    this.openContextMenu({
      title: "移动到分类",
      items: [
        { key: "", label: "未分类" },
        ...categories.map((category) => ({
          key: String(category.id),
          label: `${"　".repeat(Math.max(0, Number(category.level || 1) - 1))}${category.name}`,
        })),
      ],
      align: "center",
      kind: "movePackCategory",
    });
  },

  deletePack() {
    if (!this.requirePrivatePack()) return;
    const pack = getPrivatePack(this.packId);
    if (!pack) return;
    this.closeMore();
    wx.showModal({
      title: "删除题包",
      content: `删除后「${pack.name || "该题包"}」会从我的题包移除（题目本身保留在“我的资产”里）。`,
      confirmText: "删除",
      confirmColor: "#c0392b",
      success: (result) => {
        if (!result.confirm) return;
        deletePrivatePack(this.packId);
        wx.showToast({ title: "已删除题包", icon: "none" });
        wx.navigateBack();
      },
    });
  },

  collectPack() {
    this.closeMore();
    if (this.source === "private" || !this.data.pack) return;
    const existing = loadPrivatePacks().find((item) => item.sourcePackId === this.packId);
    if (existing) {
      this.setData({ pack: { ...this.data.pack, collected: true } });
      wx.showToast({ title: "已在我的题包", icon: "none" });
      return;
    }
    const availableRows = this.data.rows.filter((row) => row.available);
    if (!availableRows.length) {
      wx.showToast({ title: "当前题包暂无可收藏题目", icon: "none" });
      return;
    }
    const questionIds = availableRows.map((question) => saveAsset({
      type: "question",
      title: question.stem.slice(0, 42),
      stem: question.stem,
      questionType: question.typeLabel,
      typeCode: question.type,
      optionsText: (question.options || []).map((option) => `${option.key}. ${option.text}`).join("\n"),
      correctAnswer: question.correctAnswer,
      referenceAnswer: question.referenceAnswer,
      scoringPoints: question.scoringPoints,
      scoringPointsText: (question.scoringPoints || []).map((point) => point.description).join("\n"),
      subjectId: question.subjectId,
      bookId: question.bookId,
      chapterTitle: question.chapter,
      knowledgePoints: question.knowledgePoints,
      tags: this.data.pack.tags,
      sourceReference: question.source || this.data.pack.sourceLabel,
      sourceAssetId: `${this.packId}:${question.id}`,
      ownership: "collected",
      originality: "collected",
      visibility: "private",
      moderationStatus: "private",
    }).id);
    const pack = createPrivatePack({
      name: this.data.pack.name,
      description: this.data.pack.description,
      tags: this.data.pack.tags,
      questionIds,
      source: "community_import",
      sourcePackId: this.packId,
      nodes: availableRows.map((question, index) => ({
        type: "card",
        questionId: questionIds[index],
        directoryId: "",
      })),
    });
    if (!pack) {
      wx.showToast({ title: "收藏失败，请稍后重试", icon: "none" });
      return;
    }
    this.setData({ pack: { ...this.data.pack, collected: true } });
    wx.showToast({ title: "已收藏到我的题包", icon: "success" });
  },

  onShareAppMessage() {
    return {
      title: this.data.pack ? this.data.pack.name : "题包",
      path: `/pages/pack-collection/pack-collection?id=${encodeURIComponent(this.packId)}&source=${encodeURIComponent(this.source)}`,
    };
  },
});

module.exports = { buildCollection, createRemoteSections, questionPath };
