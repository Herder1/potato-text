// 已下线（DEC-075，2026-09-20）：管理题包的能力已并入题包合集页 pages/pack-collection，
// 本页已从 app.json 移除、全仓库不再有任何 navigateTo 指向它（project.config.json 的
// ignoreUploadUnusedFiles 为 true，未引用的页面不会被打包上传）。
// 文件按“可恢复”方式保留：确认长期不需要后再物理删除。
const { loadAssets, releaseAssetsFromPack } = require("../../utils/asset-store");
const {
  addQuestionToPack,
  addPackNode,
  attachQuestionToCard,
  deletePackNode,
  deletePrivatePack,
  duplicatePackNode,
  getPrivatePack,
  loadPrivatePacks,
  movePackNode,
  movePackNodeToPack,
  normalizeQuestionForPractice,
  savePrivatePack,
  updatePackNode,
} = require("../../utils/private-pack-store");

function decorateCard(node, assetMap, index) {
  const question = node.questionId ? assetMap.get(node.questionId) : null;
  return {
    ...node,
    order: index + 1,
    question,
    hasQuestion: !!question,
    broken: !!node.questionId && !question,
    displayTitle: question && (question.stem || question.title) || node.title || "点击录入题目",
    typeLabel: question && question.questionType || "待录入",
    knowledgeLabel: question && (question.knowledgePoints || [])[0] || "",
  };
}

// 目录抽屉：目录树 + 每个目录自己的卡片 + 末尾的“未归档”（与卡集页 / 题包合集页同一套抽屉）。
function packDirectoryForest(sections, looseCards) {
  const nodes = new Map();
  const roots = [];
  (sections || []).forEach((section) => {
    const id = String(section && section.id || "");
    if (!id) return;
    const cards = Array.isArray(section.cards) ? section.cards : [];
    nodes.set(id, {
      key: id,
      title: String(section.displayTitle || section.title || "").trim() || "未命名目录",
      level: Math.min(3, Math.max(1, Number(section.level) || 1)),
      parentId: String(section.parentId || ""),
      cards,
      ownCount: cards.length,
      children: [],
    });
  });
  nodes.forEach((node) => {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  });
  if (Array.isArray(looseCards) && looseCards.length) {
    roots.push({
      key: "loose",
      title: "未归档",
      level: 1,
      parentId: "",
      cards: looseCards,
      ownCount: looseCards.length,
      children: [],
    });
  }
  return roots;
}

function packDirectoryTotal(node) {
  return node.ownCount + node.children.reduce((total, child) => total + packDirectoryTotal(child), 0);
}

function flattenPackRows(nodes, collapsed, depth, rows) {
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
      totalCount: packDirectoryTotal(node),
    });
    if (hasChildren && expanded) flattenPackRows(node.children, collapsed, depth + 1, rows);
  });
  return rows;
}

function buildPackRows(sections, looseCards, collapsed) {
  return flattenPackRows(packDirectoryForest(sections, looseCards), collapsed || {}, 0, []);
}

function isPackFullyExpanded(rows) {
  const foldable = (rows || []).filter((row) => row.hasChildren);
  return foldable.length > 0 && foldable.every((row) => row.expanded);
}

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    windowHeight: 667,
    packId: "",
    intent: "",
    attachQuestionId: "",
    pack: null,
    questions: [],
    sections: [],
    looseCards: [],
    directoryOptions: [],
    actionDirectoryOptions: [],
    otherPackOptions: [],
    totalCards: 0,
    completedCards: 0,
    blankCards: 0,
    progressPercent: 0,
    learnedCount: 0,
    reviewCount: 0,
    unlearnedCount: 0,
    menuOpen: false,
    editingNodeId: "",
    editingTitle: "",
    actionNode: null,
    nodeActionsOpen: false,
    levelActionsOpen: false,
    moreActionsOpen: false,
    questionImporterOpen: false,
    availableQuestions: [],
    importTargetCardId: "",
    actionPanelTop: 240,
    catalogOpen: false,
    catalogView: "directory",
    catalogRows: [],
    catalogDirectoryCount: 0,
    catalogExpandedAll: true,
    catalogSummaryTitle: "",
    catalogSummaryCards: [],
    catalogFlashNodeId: "",
    floatingTop: 96,
    levelOptions: [
      { level: 1, label: "一级目录" },
      { level: 2, label: "二级目录" },
      { level: 3, label: "三级目录" },
    ],
  },

  onLoad(options = {}) {
    this.setData({
      packId: decodeURIComponent(options.id || ""),
      intent: options.intent || "",
      attachQuestionId: decodeURIComponent(options.questionId || ""),
    });
    this.measureNavigation();
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = wx.getMenuButtonBoundingClientRect();
    const hasCapsuleMetrics = capsule && capsule.width > 0 && capsule.height > 0;
    const statusBarHeight = windowInfo.statusBarHeight || (hasCapsuleMetrics ? capsule.top : 24);
    const capsuleTop = hasCapsuleMetrics ? capsule.top : statusBarHeight + 4;
    const capsuleHeight = hasCapsuleMetrics ? capsule.height : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = capsuleHeight + topGap * 2;
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight: statusBarHeight + navContentHeight,
      capsuleSafeRight: hasCapsuleMetrics ? Math.max(96, windowInfo.windowWidth - capsule.left + 10) : 96,
      windowHeight: windowInfo.windowHeight || 667,
      floatingTop: statusBarHeight + navContentHeight + 8,
    });
  },

  goBack() {
    wx.navigateBack();
  },

  // 顶部左二「目录」与学习区「导图」都改为从左侧弹出目录抽屉（对齐卡集页 / 题包合集页）。
  openCatalog() {
    const catalogRows = buildPackRows(this.data.sections, this.data.looseCards, this._collapsedDirectories);
    this.setData({
      catalogOpen: true,
      catalogView: "directory",
      menuOpen: false,
      nodeActionsOpen: false,
      levelActionsOpen: false,
      moreActionsOpen: false,
      catalogRows,
      catalogDirectoryCount: catalogRows.length,
      catalogExpandedAll: isPackFullyExpanded(catalogRows),
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
    const expandAll = !isPackFullyExpanded(this.data.catalogRows);
    const collapsed = { ...(this._collapsedDirectories || {}) };
    foldable.forEach((row) => {
      if (expandAll) delete collapsed[row.key];
      else collapsed[row.key] = true;
    });
    this.applyCatalogExpansion(collapsed);
  },

  applyCatalogExpansion(collapsed) {
    this._collapsedDirectories = collapsed;
    const catalogRows = buildPackRows(this.data.sections, this.data.looseCards, collapsed);
    this.setData({ catalogRows, catalogExpandedAll: isPackFullyExpanded(catalogRows) });
  },

  // 目录可以既有下级目录、又直接挂卡片，所以行右侧的数量也能点开该目录自己的卡片。
  openCatalogSummary(target) {
    const row = target && target.currentTarget
      ? this.findCatalogRow(target.currentTarget.dataset.key)
      : target;
    if (!row) return;
    const cards = row.key === "loose"
      ? (this.data.looseCards || [])
      : ((this.data.sections.find((section) => String(section.id) === row.key) || {}).cards || []);
    if (!cards.length) {
      wx.showToast({ title: `${row.title}暂无卡片`, icon: "none" });
      return;
    }
    this.setData({
      catalogView: "summary",
      catalogSummaryTitle: row.title,
      catalogSummaryCards: cards.map((card, index) => ({
        id: card.id,
        summaryNumber: String(card.order || index + 1).padStart(2, "0"),
        title: card.hasQuestion ? (String(card.displayTitle || "").trim() || "未命名卡片") : "空白卡片（点击录入题目）",
      })),
    });
  },

  backToCatalogDirectory() {
    this.setData({ catalogView: "directory" });
  },

  // 点卡片：关闭抽屉，滚到这张卡片并高亮两秒（只定位，不打开卡片）。
  selectCatalogCard(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id) return;
    this.setData({ catalogOpen: false, catalogFlashNodeId: id });
    this.scrollToNode(id);
    if (this._catalogHighlightTimer) clearTimeout(this._catalogHighlightTimer);
    this._catalogHighlightTimer = setTimeout(() => {
      this._catalogHighlightTimer = null;
      if (this.data.catalogFlashNodeId === id) this.setData({ catalogFlashNodeId: "" });
    }, 2000);
  },

  scrollToNode(nodeId) {
    if (typeof wx.createSelectorQuery !== "function" || typeof wx.pageScrollTo !== "function") return;
    const query = wx.createSelectorQuery();
    query.select(`#pack-node-${nodeId}`).boundingClientRect();
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

  onUnload() {
    if (this._catalogHighlightTimer) {
      clearTimeout(this._catalogHighlightTimer);
      this._catalogHighlightTimer = null;
    }
  },

  searchPack() {
    wx.showModal({
      title: "搜索题包内容",
      editable: true,
      placeholderText: "输入目录名、题干或知识点",
      success: (result) => {
        const query = String(result.content || "").trim().toLowerCase();
        if (!result.confirm || !query) return;
        const directory = this.data.sections.find((item) => String(item.displayTitle).toLowerCase().includes(query));
        const card = [...this.data.looseCards, ...this.data.sections.flatMap((item) => item.cards)]
          .find((item) => [item.displayTitle, item.typeLabel, item.knowledgeLabel].join(" ").toLowerCase().includes(query));
        wx.showToast({ title: directory || card ? `找到：${directory ? directory.displayTitle : card.displayTitle.slice(0, 12)}` : "没有找到相关内容", icon: "none" });
      },
    });
  },

  sharePack() {
    if (typeof wx.showShareMenu === "function") wx.showShareMenu({ menus: ["shareAppMessage"] });
    wx.showToast({ title: "可通过右上角分享题包", icon: "none" });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    let pack = getPrivatePack(this.data.packId);
    if (!pack) {
      wx.showToast({ title: "题包不存在", icon: "none" });
      wx.navigateBack();
      return;
    }
    const questionAssets = loadAssets().filter((asset) => asset.type === "question");
    if (this.data.intent === "attachQuestion" && this.data.attachQuestionId) {
      const assetExists = questionAssets.some((asset) => asset.id === this.data.attachQuestionId);
      if (assetExists && !pack.questionIds.includes(this.data.attachQuestionId)) {
        pack = addQuestionToPack(pack.id, this.data.attachQuestionId) || pack;
        wx.showToast({ title: "题目已加入新题包", icon: "none" });
      }
      this.setData({ intent: "", attachQuestionId: "" });
    }
    const assetMap = new Map(questionAssets.map((asset) => [asset.id, asset]));
    let cardIndex = 0;
    const cardNodes = pack.nodes.filter((node) => node.type === "card").map((node) => decorateCard(node, assetMap, cardIndex++));
    const directoryNodes = pack.nodes.filter((node) => node.type === "directory");
    const sections = directoryNodes.map((directory) => ({
      ...directory,
      displayTitle: directory.title || "未命名目录",
      cards: cardNodes.filter((card) => card.directoryId === directory.id),
    }));
    const looseCards = cardNodes.filter((card) => !card.directoryId);
    const questions = cardNodes.map((card) => card.question).filter(Boolean);
    const totalCards = cardNodes.length;
    const completedCards = questions.length;
    const learnedCount = questions.filter((question) => wx.getStorageSync(`shukao_mastery_${question.id}`) === "familiar").length;
    const reviewCount = questions.filter((question) => ["fuzzy", "unknown"].includes(wx.getStorageSync(`shukao_mastery_${question.id}`))).length;
    const progressPercent = questions.length ? Math.round((learnedCount / questions.length) * 100) : 0;
    this.setData({
      pack,
      questions,
      sections,
      looseCards,
      directoryOptions: [{ id: "", title: "未归档" }, ...directoryNodes.map((node) => ({ id: node.id, title: node.title || "未命名目录" }))],
      otherPackOptions: loadPrivatePacks().filter((item) => item.id !== pack.id).map((item) => ({ id: item.id, name: item.name })),
      totalCards,
      completedCards,
      blankCards: totalCards - completedCards,
      progressPercent,
      learnedCount,
      reviewCount,
      unlearnedCount: Math.max(0, questions.length - learnedCount),
    });
    if (this.data.intent === "addQuestion") {
      this.setData({ intent: "" });
      this.createCard();
    }
  },

  createDirectory(event) {
    const afterNodeId = event && event.currentTarget.dataset.after || "";
    const node = addPackNode(this.data.packId, { type: "directory", title: "", level: 1 }, afterNodeId);
    this.closeNodeActions();
    this.refresh();
    if (node) this.setData({ editingNodeId: node.id, editingTitle: "" });
  },

  createCard(event) {
    const afterNodeId = event && event.currentTarget.dataset.after || "";
    const target = afterNodeId && this.data.pack.nodes.find((node) => node.id === afterNodeId);
    const directories = this.data.pack.nodes.filter((node) => node.type === "directory");
    const directoryId = target
      ? (target.type === "directory" ? target.id : target.directoryId)
      : (directories.length ? directories[directories.length - 1].id : "");
    addPackNode(this.data.packId, { type: "card", title: "", directoryId, questionId: "" }, afterNodeId);
    this.closeNodeActions();
    this.refresh();
    wx.showToast({ title: "已新建卡片，点击录入题目", icon: "none" });
  },

  openQuestionImporter(event) {
    const importTargetCardId = event && event.currentTarget.dataset.cardId || "";
    const packQuestionIds = new Set(this.data.pack.questionIds || []);
    const availableQuestions = loadAssets()
      .filter((asset) => asset.type === "question" && !packQuestionIds.has(asset.id))
      .map((asset) => ({
        ...asset,
        displayTitle: asset.stem || asset.title || "未命名题目",
        displayPath: [asset.subjectName, asset.chapterTitle, asset.sectionTitle].filter(Boolean).join(" / ") || "暂未归入教材目录",
      }));
    this.setData({
      menuOpen: false,
      questionImporterOpen: true,
      availableQuestions,
      importTargetCardId,
    });
  },

  closeQuestionImporter() {
    this.setData({ questionImporterOpen: false, importTargetCardId: "" });
  },

  importExistingQuestion(event) {
    const questionId = event.currentTarget.dataset.id;
    if (!questionId) return;
    if (this.data.importTargetCardId) attachQuestionToCard(this.data.packId, this.data.importTargetCardId, questionId);
    else addQuestionToPack(this.data.packId, questionId);
    this.refresh();
    wx.showToast({ title: "已导入题目", icon: "none" });
    if (this.data.importTargetCardId) this.closeQuestionImporter();
    else this.openQuestionImporter();
  },

  openCard(event) {
    if (this._longPressAt && Date.now() - this._longPressAt < 500) return;
    const cardId = event.currentTarget.dataset.id;
    const card = this.data.pack.nodes.find((node) => node.id === cardId);
    if (!card) return;
    this.navigateToCard(card);
  },

  navigateToCard(card) {
    const assetExists = card.questionId && this.data.questions.some((question) => question.id === card.questionId);
    const questionParam = assetExists ? `&questionId=${encodeURIComponent(card.questionId)}` : "";
    wx.navigateTo({ url: `/pages/contribute/contribute?packId=${encodeURIComponent(this.data.packId)}&cardId=${encodeURIComponent(card.id)}${questionParam}` });
  },

  openNodeActions(event) {
    const nodeId = event.currentTarget.dataset.id;
    let node = this.data.pack.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (this.data.editingNodeId === nodeId) {
      const title = String(this.data.editingTitle || "").trim() || "未命名目录";
      updatePackNode(this.data.packId, nodeId, { title });
      node = { ...node, title };
      this.setData({ editingNodeId: "", editingTitle: "" });
      this.refresh();
    }
    this._longPressAt = Date.now();
    const touch = event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0];
    const clientY = touch ? Number(touch.clientY) : this.data.windowHeight * 0.58;
    const actionPanelTop = Math.max(this.data.navTotalHeight + 8, Math.min(clientY - 44, this.data.windowHeight - 390));
    const blockedDirectoryIds = new Set([node.id]);
    if (node.type === "directory") {
      let discovered = true;
      while (discovered) {
        discovered = false;
        this.data.pack.nodes.forEach((item) => {
          if (item.type === "directory" && blockedDirectoryIds.has(item.parentId) && !blockedDirectoryIds.has(item.id)) {
            blockedDirectoryIds.add(item.id);
            discovered = true;
          }
        });
      }
    }
    const actionDirectoryOptions = [{ id: "", title: "设为一级目录" }, ...this.data.directoryOptions.filter((item) => item.id && !blockedDirectoryIds.has(item.id))];
    this.setData({ actionNode: node, actionDirectoryOptions, actionPanelTop, nodeActionsOpen: true, levelActionsOpen: false, moreActionsOpen: false }, () => {
      this.positionNodeActions(node.id, actionPanelTop);
    });
  },

  positionNodeActions(nodeId, fallbackTop) {
    if (typeof wx.createSelectorQuery !== "function") return;
    const query = wx.createSelectorQuery();
    query.select(`#pack-node-${nodeId}`).boundingClientRect();
    query.select(".node-action-panel").boundingClientRect();
    query.exec((results = []) => {
      const rect = results[0];
      const panelRect = results[1];
      if (!rect) return;
      const panelHeight = panelRect && panelRect.height || 72;
      const gap = 8;
      const preferredTop = rect.top - panelHeight - gap;
      const belowTop = rect.bottom + gap;
      const actionPanelTop = preferredTop > this.data.navTotalHeight + 6
        ? preferredTop
        : Math.min(belowTop, this.data.windowHeight - panelHeight - 16);
      this.setData({ actionPanelTop: Number.isFinite(actionPanelTop) ? actionPanelTop : fallbackTop });
    });
  },

  editDirectory(event) {
    if (this._longPressAt && Date.now() - this._longPressAt < 500) return;
    const nodeId = event.currentTarget.dataset.id;
    const node = this.data.pack.nodes.find((item) => item.id === nodeId && item.type === "directory");
    if (!node) return;
    this.setData({ editingNodeId: node.id, editingTitle: node.title || "" });
  },

  closeNodeActions() {
    this.setData({ actionNode: null, nodeActionsOpen: false, levelActionsOpen: false, moreActionsOpen: false });
  },

  startEditNode() {
    const node = this.data.actionNode;
    if (!node) return;
    if (node.type === "card") {
      this.closeNodeActions();
      this.navigateToCard(node);
      return;
    }
    this.setData({ editingNodeId: node.id, editingTitle: node.title || "", nodeActionsOpen: false, levelActionsOpen: false, moreActionsOpen: false, actionNode: null });
  },

  updateEditingTitle(event) {
    this.setData({ editingTitle: event.detail.value });
  },

  finishEditNode() {
    if (!this.data.editingNodeId) return;
    const title = String(this.data.editingTitle || "").trim() || "未命名目录";
    updatePackNode(this.data.packId, this.data.editingNodeId, { title });
    this.setData({ editingNodeId: "", editingTitle: "" });
    this.refresh();
  },

  changeDirectoryLevel(event) {
    if (!this.data.actionNode || this.data.actionNode.type !== "directory") return;
    const selectedLevel = Number(event.currentTarget && event.currentTarget.dataset.level);
    const level = selectedLevel || Number(event.detail.value) + 1;
    updatePackNode(this.data.packId, this.data.actionNode.id, { level, parentId: level === 1 ? "" : this.data.actionNode.parentId });
    this.closeNodeActions();
    this.refresh();
  },

  toggleLevelActions() {
    this.setData({ levelActionsOpen: !this.data.levelActionsOpen, moreActionsOpen: false });
  },

  changeCardDirectory(event) {
    if (!this.data.actionNode || this.data.actionNode.type !== "card") return;
    const option = this.data.directoryOptions[Number(event.detail.value)];
    updatePackNode(this.data.packId, this.data.actionNode.id, { directoryId: option ? option.id : "" });
    this.closeNodeActions();
    this.refresh();
  },

  changeDirectoryParent(event) {
    if (!this.data.actionNode || this.data.actionNode.type !== "directory") return;
    const option = this.data.actionDirectoryOptions[Number(event.detail.value)];
    const parent = option && this.data.pack.nodes.find((node) => node.id === option.id);
    const movedNode = {
      ...this.data.actionNode,
      parentId: parent ? parent.id : "",
      level: parent ? Math.min(3, (Number(parent.level) || 1) + 1) : 1,
    };
    const nodes = this.data.pack.nodes.filter((node) => node.id !== movedNode.id);
    if (parent) {
      const parentIndex = nodes.findIndex((node) => node.id === parent.id);
      nodes.splice(parentIndex + 1, 0, movedNode);
    } else {
      nodes.push(movedNode);
    }
    savePrivatePack({ ...this.data.pack, nodes });
    this.closeNodeActions();
    this.refresh();
  },

  moveNodeToPack(event) {
    if (!this.data.actionNode) return;
    const target = this.data.otherPackOptions[Number(event.detail.value)];
    if (!target) return;
    movePackNodeToPack(this.data.packId, this.data.actionNode.id, target.id);
    this.closeNodeActions();
    this.refresh();
    wx.showToast({ title: `已移动到“${target.name}”`, icon: "none" });
  },

  toggleMoreActions() {
    this.setData({ moreActionsOpen: !this.data.moreActionsOpen, levelActionsOpen: false });
  },

  duplicateNode() {
    if (!this.data.actionNode) return;
    duplicatePackNode(this.data.packId, this.data.actionNode.id);
    this.closeNodeActions();
    this.refresh();
  },

  moveNode(event) {
    if (!this.data.actionNode) return;
    movePackNode(this.data.packId, this.data.actionNode.id, event.currentTarget.dataset.direction);
    this.closeNodeActions();
    this.refresh();
  },

  removeNode() {
    const node = this.data.actionNode;
    if (!node) return;
    wx.showModal({
      title: node.type === "directory" ? "删除目录" : "删除卡片",
      content: node.type === "directory"
        ? "目录下的卡片会移到“未归档”，题目不会被删除。"
        : "题目资产仍保留在“我的资产”中，只删除当前卡片。",
      confirmColor: "#9b463f",
      success: (result) => {
        if (!result.confirm) return;
        deletePackNode(this.data.packId, node.id);
        this.closeNodeActions();
        this.refresh();
      },
    });
  },

  startPractice() {
    if (!this.data.questions.length) {
      wx.showToast({ title: "请先在卡片中录入题目", icon: "none" });
      return;
    }
    const queue = this.data.questions.map((question, index) => normalizeQuestionForPractice({ ...question, packId: this.data.packId }, index));
    wx.setStorageSync("shukao_active_pack_questions", queue);
    wx.setStorageSync("shukao_active_pack_name", this.data.pack.name);
    wx.navigateTo({ url: `/pages/practice/practice?mode=pack&packId=${encodeURIComponent(this.data.packId)}` });
  },

  startTest() {
    if (!this.data.questions.length) {
      wx.showToast({ title: "请先录入题目", icon: "none" });
      return;
    }
    const queue = this.data.questions
      .map((question, index) => normalizeQuestionForPractice({ ...question, packId: this.data.packId }, index))
      .sort(() => Math.random() - 0.5);
    wx.setStorageSync("shukao_active_pack_questions", queue);
    wx.setStorageSync("shukao_active_pack_name", `${this.data.pack.name} · 测试`);
    wx.navigateTo({ url: `/pages/practice/practice?mode=pack&packId=${encodeURIComponent(this.data.packId)}` });
  },

  onShareAppMessage() {
    return { title: this.data.pack ? this.data.pack.name : "私人题包", path: `/pages/pack-detail/pack-detail?id=${encodeURIComponent(this.data.packId)}` };
  },

  editPack() {
    this.setData({ menuOpen: false });
    wx.showModal({
      title: "修改题包名称",
      editable: true,
      content: this.data.pack.name,
      placeholderText: "输入题包名称",
      success: (result) => {
        const name = String(result.content || "").trim();
        if (!result.confirm || !name) return;
        savePrivatePack({ ...this.data.pack, name });
        this.refresh();
      },
    });
  },

  toggleMenu() {
    this.setData({ menuOpen: !this.data.menuOpen });
  },

  deletePack() {
    this.setData({ menuOpen: false });
    wx.showModal({
      title: "删除题包",
      content: "题目资产不会被删除，但该题包的目录与卡片关系将无法恢复。",
      confirmColor: "#9b463f",
      success: (result) => {
        if (!result.confirm) return;
        deletePrivatePack(this.data.packId);
        releaseAssetsFromPack(this.data.packId);
        wx.navigateBack();
      },
    });
  },
});
