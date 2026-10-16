const { closeTransientLayers } = require("../../utils/page-layers");
const {
  CARD_COLORS,
  applyRainbowSetColors,
  cardColor,
  cardColorBackground,
  cardColorEdge,
  ensureCardSetMetadata,
  findSet,
  insertBlankCardInSet,
  insertDirectoryRelativeToCard,
  insertChildDirectory,
  appendBlankCardToDirectory,
  loadCardSets,
  moveCardInSet,
  moveCardsInSet,
  moveDirectoryToIndex,
  adoptCardsIntoDirectory,
  setCardColors,
  setSetsColor,
  updateSet,
} = require("../../utils/card-box-store");
// 分享与服务端同步走命名空间引入（C15）：分享快照、导入、同步都在 store 里。
const cardBoxStore = require("../../utils/card-box-store");

const FALLBACK_SECTION = "未分类";
// DEC-087：目录块「先子目录、后自己的卡片」（文件夹在前、文件在后），与题包合集页同一套。
// 卡集页的目录是「扁平顺序 + sectionLevels」，所以子级 = 紧随其后、层级更深的那一段。
function buildSectionBlocks(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const blocks = [];
  const levelOf = (section) => Math.min(3, Math.max(1, Number(section && section.level) || 1));
  const walkRange = (from, to) => {
    let index = from;
    while (index < to) {
      const section = list[index];
      const level = levelOf(section);
      let end = index + 1;
      while (end < to && levelOf(list[end]) > level) end += 1;
      blocks.push({ key: `title-${section.title}`, kind: "title", index, section });
      walkRange(index + 1, end);
      // 没有卡片的目录不产出卡片块：空 grid 会让「卡片块相邻」的间距规则失效（DEC-089）。
      if ((section.cards || []).length) blocks.push({ key: `cards-${section.title}`, kind: "cards", index, section });
      index = end;
    }
  };
  walkRange(0, list.length);
  return blocks;
}

const DRAG_THRESHOLD = 10;
const DRAG_EDGE_ZONE = 72;
const DRAG_EDGE_BOTTOM = 96;
const DRAG_EDGE_MAX_STEP = 22;
const DRAG_EDGE_INTERVAL = 16;

function cardSection(card) {
  return String(card && card.section || FALLBACK_SECTION).trim() || FALLBACK_SECTION;
}

function richAnswerText(card) {
  const deltaText = card && card.answerDelta && Array.isArray(card.answerDelta.ops)
    ? card.answerDelta.ops.map((op) => typeof op.insert === "string" ? op.insert : "").join("")
    : "";
  const htmlText = String(card && card.answerHtml || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ");
  return `${String(card && card.answer || "")} ${deltaText} ${htmlText}`.trim();
}

function hasAnswerContent(card) {
  const hasImages = Array.isArray(card && card.answerImages) && card.answerImages.length > 0;
  const hasEmbeddedDelta = Boolean(card && card.answerDelta && Array.isArray(card.answerDelta.ops)
    && card.answerDelta.ops.some((op) => op && op.insert && typeof op.insert === "object"));
  return Boolean(richAnswerText(card) || hasImages || hasEmbeddedDelta);
}

function isBlankCard(card) {
  return !String(card && card.question || "").trim() && !hasAnswerContent(card);
}

function isStudyReady(card) {
  return Boolean(String(card && card.question || "").trim()) && hasAnswerContent(card);
}

function uniqueSectionTitles(titles) {
  return [...new Set((titles || []).map((title) => String(title || "").trim()).filter(Boolean))];
}

function orderedSectionTitles(set) {
  const actual = [];
  (set.cards || []).forEach((card) => {
    const title = cardSection(card);
    if (!actual.includes(title)) actual.push(title);
  });
  const saved = Array.isArray(set.sectionOrder) ? set.sectionOrder : [];
  const leveled = Object.keys(set.sectionLevels || {});
  return uniqueSectionTitles([...saved, ...leveled, ...actual]);
}

function withSectionDisplayCounts(sections) {
  return sections.map((section, index) => {
    let displayCount = Array.isArray(section.cards) ? section.cards.length : 0;
    for (let nextIndex = index + 1; nextIndex < sections.length; nextIndex += 1) {
      const next = sections[nextIndex];
      if (next.level <= section.level) break;
      displayCount += Array.isArray(next.cards) ? next.cards.length : 0;
    }
    return { ...section, displayCount };
  });
}

function directoryForest(sections) {
  const roots = [];
  const stack = [];
  (sections || []).forEach((section) => {
    const title = String(section && section.title || "").trim();
    if (!title) return;
    const level = Math.min(3, Math.max(1, Number(section.level) || 1));
    const node = {
      key: title,
      title,
      level,
      cards: Array.isArray(section.cards) ? section.cards : [],
      children: [],
    };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}

function directoryCardTotal(node) {
  return node.cards.length + node.children.reduce((total, child) => total + directoryCardTotal(child), 0);
}

function flattenDirectoryRows(nodes, collapsed, depth, rows) {
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
      cardCount: node.cards.length,
      totalCount: directoryCardTotal(node),
    });
    if (hasChildren && expanded) flattenDirectoryRows(node.children, collapsed, depth + 1, rows);
  });
  return rows;
}

function buildDirectoryRows(sections, collapsed) {
  return flattenDirectoryRows(directoryForest(sections), collapsed || {}, 0, []);
}

function isDirectoryFullyExpanded(rows) {
  const foldable = (rows || []).filter((row) => row.hasChildren);
  return foldable.length > 0 && foldable.every((row) => row.expanded);
}

function cardSlotIndex(cards, pointerX, pointerY) {
  for (let position = 0; position < cards.length; position += 1) {
    const card = cards[position];
    const before = pointerY < card.top
      || (pointerY <= card.bottom && pointerX < (card.left + card.right) / 2);
    if (before) return position;
  }
  return cards.length;
}

function cardsInSectionOrder(cards, titles, selectedIds = []) {
  return titles.flatMap((title) => {
    const group = cards.filter((card) => cardSection(card) === title);
    if (!selectedIds.length) return group;
    return [
      ...group.filter((card) => selectedIds.includes(card.id)),
      ...group.filter((card) => !selectedIds.includes(card.id)),
    ];
  });
}

function moveTitle(titles, title, action) {
  const next = titles.filter((item) => item !== title);
  const currentIndex = titles.indexOf(title);
  let targetIndex = currentIndex;
  if (action === "top") targetIndex = 0;
  if (action === "up") targetIndex = Math.max(0, currentIndex - 1);
  if (action === "down") targetIndex = Math.min(next.length, currentIndex + 1);
  if (action === "bottom") targetIndex = next.length;
  next.splice(targetIndex, 0, title);
  return next;
}

Page({
  data: {
    navTotalHeight: 88,
    navContentHeight: 44,
    statusBarHeight: 44,
    capsuleSafeRight: 104,
    floatingTop: 96,
    contentLeft: 14,
    contentWidth: 300,
    contextToolbarTop: 96,
    contextToolbarHeight: 48,
    contextToolbarReady: true,
    viewportHeight: 0,
    set: null,
    sections: [],
    selectedIds: [],
    canEditSelected: false,
    selectionAlign: "left",
    actionMode: "",
    activeDirectory: "",
    activeDirectoryLevel: 1,
    addMenuOpen: false,
    // DEC-060：正在行内输入名称的新建目录（值为该目录当前的占位标题）。
    directoryInlineEdit: "",
    // 行内输入框的初值：新建目录为空，重命名时预填当前名称。
    directoryInlineValue: "",
    moreDrawerOpen: false,
    colorPanelOpen: false,
    colorMode: "uniform",
    selectedSetColor: "",
    colorScopeLabel: "",
    cardColors: CARD_COLORS,
    cardColorPickerOpen: false,
    cardColorPickerTop: 0,
    selectedCardColor: "",
    catalogOpen: false,
    catalogView: "directory",
    catalogRows: [],
    catalogDirectoryCount: 0,
    catalogExpandedAll: false,
    catalogSummaryTitle: "",
    catalogSummaryCards: [],
    highlightCardId: "",
    menuOpen: false,
    menuOptions: [],
    menuAlign: "left",
    menuTop: 0,
    menuMaxHeight: 420,
    dragActive: false,
    dragKind: "",
    dragKey: "",
    dragGhost: null,
    dragGroupCount: 0,
    dragStyle: "",
    dragIndicator: null,
    pageScrollLocked: false,
  },

  onLoad(options) {
    this.setId = options.id;
    // 分享链接走服务端快照（C15）：`?share=<shareId>` 是只读副本，好友点开按 id 从服务端取。
    this.sharedShareId = options.share ? String(options.share) : "";
    this.measureNavigation();
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : (typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {});
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : {};
    const hasCapsule = capsule && Number(capsule.width) > 0 && Number(capsule.height) > 0;
    const statusBarHeight = Number(windowInfo.statusBarHeight) || (hasCapsule ? Number(capsule.top) : 24);
    const capsuleTop = hasCapsule ? Number(capsule.top) : statusBarHeight + 4;
    const capsuleHeight = hasCapsule ? Number(capsule.height) : 32;
    const topGap = Math.max(4, capsuleTop - statusBarHeight);
    const navContentHeight = capsuleHeight + topGap * 2;
    const windowWidth = Number(windowInfo.windowWidth) || 375;
    const windowHeight = Number(windowInfo.windowHeight) || 667;
    const floatingTop = statusBarHeight + navContentHeight + 8;
    const contentLeft = Math.round((28 / 750) * windowWidth);
    this.setData({
      statusBarHeight,
      navContentHeight,
      navTotalHeight: statusBarHeight + navContentHeight,
      floatingTop,
      contextToolbarTop: floatingTop,
      contextToolbarHeight: Math.round((96 / 750) * windowWidth),
      viewportHeight: windowHeight,
      contentLeft,
      contentWidth: windowWidth - contentLeft * 2,
      capsuleSafeRight: hasCapsule
        ? Math.max(96, Number(windowInfo.windowWidth || 375) - Number(capsule.left) + 10)
        : 96,
    });
  },

  goBack() {
    wx.navigateBack();
  },

  stopTouchMove() {},

  noop() {},

  handleBlankTap() {
    if (this.data.menuOpen) {
      this.closeContextMenu();
      return;
    }
    if (this.data.actionMode) this.closeContextActions();
  },

  openContextMenu(options, handler) {
    if (!options || !options.length) return;
    const toolbarTop = Number(this.data.contextToolbarTop) || 0;
    const toolbarHeight = Number(this.data.contextToolbarHeight) || 48;
    const top = Math.round(toolbarTop + toolbarHeight + 10);
    const viewportHeight = Number(this.data.viewportHeight) || 0;
    this._menuHandler = handler;
    this.setData({
      menuOpen: true,
      menuOptions: options,
      menuAlign: this.data.actionMode === "directory" ? "center" : (this.data.selectionAlign || "left"),
      menuTop: top,
      menuMaxHeight: viewportHeight ? Math.max(180, viewportHeight - top - 24) : 420,
    });
  },

  closeContextMenu() {
    this._menuHandler = null;
    this.setData({ menuOpen: false, menuOptions: [] });
  },

  selectContextMenuOption(e) {
    const key = e.currentTarget.dataset.key;
    const handler = this._menuHandler;
    this.closeContextMenu();
    if (typeof handler === "function") handler(key);
  },

  openCatalog() {
    const catalogRows = buildDirectoryRows(this.data.sections, this._collapsedDirectories);
    this.setData({
      catalogOpen: true,
      catalogView: "directory",
      addMenuOpen: false,
      catalogRows,
      catalogExpandedAll: isDirectoryFullyExpanded(catalogRows),
    });
  },

  closeCatalog() {
    this.setData({ catalogOpen: false });
  },

  selectCatalogRow(e) {
    const key = e.currentTarget.dataset.key;
    const row = this.data.catalogRows.find((item) => item.key === key);
    if (!row) return;
    if (row.hasChildren) {
      const collapsed = { ...(this._collapsedDirectories || {}) };
      if (row.expanded) collapsed[row.key] = true;
      else delete collapsed[row.key];
      this.applyCatalogExpansion(collapsed);
      return;
    }
    this.openCatalogSummary(row);
  },

  toggleCatalogExpansionAll() {
    const foldable = this.data.catalogRows.filter((row) => row.hasChildren);
    if (!foldable.length) return;
    const expandAll = !isDirectoryFullyExpanded(this.data.catalogRows);
    const collapsed = { ...(this._collapsedDirectories || {}) };
    foldable.forEach((row) => {
      if (expandAll) delete collapsed[row.key];
      else collapsed[row.key] = true;
    });
    this.applyCatalogExpansion(collapsed);
  },

  applyCatalogExpansion(collapsed) {
    this._collapsedDirectories = collapsed;
    const catalogRows = buildDirectoryRows(this.data.sections, collapsed);
    this.setData({ catalogRows, catalogExpandedAll: isDirectoryFullyExpanded(catalogRows) });
  },

  openCatalogSummary(row) {
    const section = this.data.sections.find((item) => item.title === row.title);
    const cards = (section ? section.cards : []).filter((card) => !card.isDirectoryPlaceholder);
    if (!cards.length) {
      wx.showToast({ title: `${row.title}暂无卡片`, icon: "none" });
      return;
    }
    this.setData({
      catalogView: "summary",
      catalogSummaryTitle: row.title,
      catalogSummaryCards: cards.map((card, index) => ({
        id: card.id,
        summaryNumber: String(index + 1).padStart(2, "0"),
        title: card.isBlank ? "空白卡片" : (String(card.question || "").trim() || "未命名卡片"),
      })),
    });
  },

  backToCatalogDirectory() {
    this.setData({ catalogView: "directory" });
  },

  selectCatalogCard(e) {
    const cardId = e.currentTarget.dataset.id;
    const card = this.data.set && this.data.set.cards.find((item) => item.id === cardId);
    if (!card) return;
    this.setData({ catalogOpen: false, highlightCardId: cardId });
    this.scrollToCard(cardId);
    if (this._highlightTimer) clearTimeout(this._highlightTimer);
    this._highlightTimer = setTimeout(() => {
      this._highlightTimer = null;
      if (this.data.highlightCardId === cardId) this.setData({ highlightCardId: "" });
    }, 2000);
  },

  scrollToCard(cardId) {
    if (typeof wx.createSelectorQuery !== "function" || typeof wx.pageScrollTo !== "function") return;
    const query = wx.createSelectorQuery();
    query.select(`#card-anchor-${cardId}`).boundingClientRect();
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

  onUnload() {
    this.stopDragAutoScroll();
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = null;
    }
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["addMenuOpen","moreDrawerOpen","colorPanelOpen","cardColorPickerOpen","catalogOpen","menuOpen"], { actionMode: "", selectedIds: [], activeDirectory: "", pageScrollLocked: false });
  },

  onShow() {
    if (typeof wx.showShareMenu === "function") wx.showShareMenu({ menus: ["shareAppMessage"] });
    if (this.sharedShareId) {
      this.refreshFromShare();
      return;
    }
    this.refresh();
    this.prepareShareSnapshot();
  },

  /**
   * 好友点开分享链接：读服务端快照渲染成**只读**卡集（不落本地库），底部给「导入到我的卡集」。
   * 快照与分享者的卡集解耦——分享者之后怎么改，这条链接看到的内容都不变。
   */
  refreshFromShare() {
    const application = typeof getApp === "function" ? getApp() : null;
    const baseUrl = application && application.globalData ? application.globalData.apiBaseUrl : "";
    cardBoxStore.loadCardSetShare(this.sharedShareId, { baseUrl }).then((share) => {
      if (!share || !share.set) {
        this.setData({ sharedView: true, shareMissing: true });
        return;
      }
      this.sharedSnapshot = share.set;
      this.renderSet(share.set, { shared: true });
    });
  },

  /** 分享者这一侧：进页面就备好快照，保证 `onShareAppMessage`（同步返回）能带 shareId。 */
  prepareShareSnapshot() {
    const application = typeof getApp === "function" ? getApp() : null;
    const token = application && application.globalData ? application.globalData.authToken : "";
    const baseUrl = application && application.globalData ? application.globalData.apiBaseUrl : "";
    if (!token || !this.setId || typeof wx.request !== "function") return;
    cardBoxStore.createCardSetShare(this.setId, { baseUrl, token }).then((shareId) => {
      if (shareId) this.setData({ shareId });
    });
  },

  /** 导入分享快照：复制成自己的卡集（新 id、落当前文件夹），随后跳到自己那份继续编辑。 */
  importSharedSet() {
    if (!this.sharedSnapshot) return;
    const folders = cardBoxStore.loadCardFolders();
    const imported = cardBoxStore.importCardSet(this.sharedSnapshot, folders[0]);
    if (!imported) {
      wx.showToast({ title: "导入失败，请重试", icon: "none" });
      return;
    }
    wx.showToast({ title: "已导入到我的卡集", icon: "success" });
    wx.redirectTo({ url: `/pages/card-set/card-set?id=${encodeURIComponent(imported.id)}` });
  },

  refresh() {
    const set = ensureCardSetMetadata(this.setId) || findSet(this.setId);
    if (!set) return;
    this.renderSet(set, { shared: false });
  },

  renderSet(set, options = {}) {
    const titles = orderedSectionTitles(set);
    const levels = set.sectionLevels || {};
    const displayDescription = Object.prototype.hasOwnProperty.call(set, "description")
      ? set.description
      : set.subtitle;
    const sections = withSectionDisplayCounts(titles.map((title) => ({
      title,
      level: Math.min(3, Math.max(1, Number(levels[title]) || 1)),
      cards: set.cards
        .filter((card) => cardSection(card) === title)
        .map((card) => {
          const palette = cardColor(card.color);
          return {
            ...card,
            isBlank: isBlankCard(card),
            needsEditing: !isStudyReady(card),
            colorSoft: cardColorBackground(card.color),
            colorEdge: cardColorEdge(card.color),
            colorAccent: palette ? palette.accent : "",
          };
        }),
    })));
    const catalogRows = buildDirectoryRows(sections, this._collapsedDirectories);
    this.setData({
      set: { ...set, displayDescription, count: set.cards.length },
      sections,
      // DEC-087：渲染用「标题块 + 卡片块」序列（子目录在前、本目录卡片在后）
      sectionBlocks: buildSectionBlocks(sections),
      catalogRows,
      catalogDirectoryCount: sections.length,
      catalogExpandedAll: isDirectoryFullyExpanded(catalogRows),
      // 分享链接进来的这一页是只读的：底部编辑栏换成「导入到我的卡集」。
      sharedView: options.shared === true,
      shareMissing: false,
    });
    if (options.shared === true) {
      // 只读快照的兜底：把会编辑/跳转的入口在原位换成空操作（本页只允许「导入到我的卡集」这一个写动作）。
      // 快照里的卡片 id 不属于本地库，`this.setId` 为空，即使漏掉某个入口也只会 no-op、不会写坏本地数据。
      [
        "openCard", "startSelect", "openAddMenu", "openMoreDrawer", "drawerAction",
        "editDirectory", "openDirectoryActions", "selectionAction", "deleteSelected",
        "selectCatalogCard", "practice", "handleCardTouchStart", "handleTitleTouchStart",
      ].forEach((name) => { this[name] = () => {}; });
    }
  },

  openCard(e) {
    if (Date.now() - Number(this._longPressAt || 0) < 500) return;
    if (this.data.actionMode === "cards") {
      this.toggleCard(e);
      return;
    }
    this.closeContextActions();
    const cardId = e.currentTarget.dataset.id;
    const card = this.data.set.cards.find((item) => item.id === cardId);
    const page = isStudyReady(card) ? "knowledge-card/knowledge-card" : "card-editor/card-editor";
    wx.navigateTo({
      url: `/pages/${page}?setId=${encodeURIComponent(this.setId)}&cardId=${encodeURIComponent(cardId)}`,
    });
  },

  applyCardSelection(selectedIds) {
    const sides = new Set();
    const sections = this.data.sections.map((section) => ({
      ...section,
      cards: section.cards.map((card, index) => {
        const selected = selectedIds.includes(card.id);
        if (selected) sides.add(index % 2);
        return { ...card, selected };
      }),
    }));
    const selectionAlign = sides.size > 1 ? "center" : (sides.has(1) ? "right" : "left");
    this.setData({
      sections,
      selectedIds,
      canEditSelected: selectedIds.length === 1,
      selectionAlign,
      actionMode: selectedIds.length ? "cards" : "",
      activeDirectory: "",
      addMenuOpen: false,
      cardColorPickerOpen: selectedIds.length ? this.data.cardColorPickerOpen : false,
    });
  },

  startSelect(e) {
    this._longPressAt = Date.now();
    if (this._press && this._press.kind === "card" && this._press.key === e.currentTarget.dataset.id) {
      this._press.armed = true;
    }
    this.applyCardSelection([e.currentTarget.dataset.id]);
    this.setData({ contextToolbarReady: false, pageScrollLocked: true });
    this.placeContextToolbar(`#card-anchor-${e.currentTarget.dataset.id}`);
  },

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

  handleCardTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this._press = {
      kind: "card",
      key: e.currentTarget.dataset.id,
      section: e.currentTarget.dataset.section || "",
      x: touch.clientX,
      y: touch.clientY,
      armed: false,
    };
  },

  handleTitleTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this._press = {
      kind: "directory",
      key: e.currentTarget.dataset.title,
      section: "",
      x: touch.clientX,
      y: touch.clientY,
      armed: false,
    };
  },

  handleCardTouchMove(e) {
    this.trackDragTouch(e, "card");
  },

  handleTitleTouchMove(e) {
    this.trackDragTouch(e, "directory");
  },

  trackDragTouch(e, kind) {
    const touch = e.touches && e.touches[0];
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
      const origin = list.find((item) => (press.kind === "card" ? item.id : item.title) === press.key);
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
        ? this.data.sections.flatMap((section) => section.cards).find((card) => card.id === press.key) || null
        : this.data.sections.find((section) => section.title === press.key) || null;
      this._pageScrollTop = layout.scrollTop;
      const selectedNow = (this.data.selectedIds || []).map(String);
      const dragGroupCount = press.kind === "card" && selectedNow.includes(String(press.key)) && selectedNow.length > 1
        ? selectedNow.length
        : 0;
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
          id: rect.dataset && rect.dataset.id,
          section: rect.dataset && rect.dataset.section,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        })).filter((item) => item.id),
        titles: titleRects.map((rect, index) => ({
          title: (rect.dataset && rect.dataset.title) || "",
          index: Number(rect.dataset && rect.dataset.index) || index,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        })).filter((item) => item.title),
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
      this._dragAutoScrollTarget = Number(this._pageScrollTop) || 0;
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

  computeCardDrop(drag, scrollDelta) {
    const shifted = (item) => ({
      ...item,
      top: item.top - scrollDelta,
      bottom: item.bottom - scrollDelta,
    });
    const titles = drag.titles.map(shifted);
    if (!titles.length) return null;
    const cards = drag.cards.map(shifted);
    const { pointerX, pointerY } = drag;

    let target = titles.find((title, index) => (
      pointerY >= title.top && (index + 1 >= titles.length || pointerY < titles[index + 1].top)
    ));
    if (!target) target = pointerY < titles[0].top ? titles[0] : titles[titles.length - 1];

    const own = cards.filter((card) => card.section === target.title);
    if (!own.length) {
      return { section: target.title, index: 0, indicator: this.rowIndicator(target.bottom + 12) };
    }

    const index = cardSlotIndex(own, pointerX, pointerY);
    return { section: target.title, index, indicator: this.cardIndicator(own, index) };
  },

  cardIndicator(own, index) {
    const contentLeft = Number(this.data.contentLeft) || 14;
    const contentWidth = Number(this.data.contentWidth) || 300;
    if (index >= own.length) {
      const last = own[own.length - 1];
      return { kind: "row", left: contentLeft, top: Math.round(last.bottom + 6), width: contentWidth, height: 4 };
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
    return { kind: "row", left: contentLeft, top: Math.round(target.top - 6), width: contentWidth, height: 4 };
  },

  computeDirectoryDrop(drag, scrollDelta) {
    const shifted = (item) => ({
      ...item,
      top: item.top - scrollDelta,
      bottom: item.bottom - scrollDelta,
    });
    const titles = drag.titles.map(shifted);
    if (!titles.length) return null;
    const cards = drag.cards.map(shifted);
    const { pointerX, pointerY } = drag;

    let target = titles.find((title, index) => (
      pointerY >= title.top && (index + 1 >= titles.length || pointerY < titles[index + 1].top)
    ));
    if (!target) target = pointerY < titles[0].top ? titles[0] : titles[titles.length - 1];

    const own = cards.filter((card) => card.section === target.title);
    if (own.length && target.title !== drag.key && pointerY > target.bottom) {
      const index = cardSlotIndex(own, pointerX, pointerY);
      if (index < own.length) {
        return {
          mode: "takeover",
          section: target.title,
          index,
          indicator: this.cardIndicator(own, index),
        };
      }
    }

    let index = titles.length;
    for (let position = 0; position < titles.length; position += 1) {
      const title = titles[position];
      if (pointerY < (title.top + title.bottom) / 2) {
        index = position;
        break;
      }
    }
    const anchor = titles[index] || titles[titles.length - 1];
    return {
      mode: "reorder",
      index,
      indicator: this.rowIndicator(index < titles.length ? anchor.top - 6 : anchor.bottom + 6),
    };
  },

  rowIndicator(top) {
    return {
      kind: "row",
      left: Number(this.data.contentLeft) || 14,
      top: Math.max(0, Math.round(top)),
      width: Number(this.data.contentWidth) || 300,
      height: 4,
    };
  },

  finishDrag() {
    const drag = this._drag;
    const drop = drag && drag.drop;
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
      contextToolbarReady: true,
    });
    if (!drag || !drop) return;

    if (drag.kind === "card") {
      const own = (this.data.sections.find((section) => section.title === drag.section) || {}).cards || [];
      const currentIndex = own.findIndex((card) => card.id === drag.key);
      const index = drop.section === drag.section && currentIndex >= 0 && currentIndex < drop.index
        ? drop.index - 1
        : drop.index;
      // DEC-074：拖的是多选里的一张时，整组一起走（保持原有相对顺序）。
      const selected = (this.data.selectedIds || []).map(String);
      const groupIds = selected.includes(String(drag.key)) && selected.length > 1 ? selected : [];
      if (groupIds.length) {
        const grouped = moveCardsInSet(this.setId, groupIds, drop.section, index);
        if (!grouped) {
          wx.showToast({ title: "移动失败，请重试", icon: "none" });
          return;
        }
        this.closeContextActions();
        this.refresh();
        wx.showToast({ title: `已移动 ${grouped.movedCount} 张卡片`, icon: "none" });
        return;
      }
      const moved = moveCardInSet(this.setId, drag.key, drop.section, index);
      if (!moved) {
        wx.showToast({ title: "移动失败，请重试", icon: "none" });
        return;
      }
      this.closeContextActions();
      this.refresh();
      wx.showToast({ title: "已移动卡片", icon: "none" });
      return;
    }

    const fromIndex = this.data.sections.findIndex((section) => section.title === drag.key);
    if (drop.mode === "takeover") {
      const adopted = adoptCardsIntoDirectory(this.setId, drag.key, drop.section, drop.index);
      if (!adopted) {
        wx.showToast({ title: "移动失败，请重试", icon: "none" });
        return;
      }
      this.closeContextActions();
      this.refresh();
      wx.showToast({ title: `已把 ${adopted.movedCount} 张卡片划到「${adopted.directory}」`, icon: "none" });
      return;
    }
    const index = fromIndex >= 0 && fromIndex < drop.index ? drop.index - 1 : drop.index;
    const moved = moveDirectoryToIndex(this.setId, drag.key, index);
    if (!moved) {
      wx.showToast({ title: "移动失败，请重试", icon: "none" });
      return;
    }
    this.closeContextActions();
    this.refresh();
    wx.showToast({ title: "目录顺序已更新", icon: "none" });
  },

  toggleCard(e) {
    const id = e.currentTarget.dataset.id;
    const added = !this.data.selectedIds.includes(id);
    const selectedIds = added
      ? [...this.data.selectedIds, id]
      : this.data.selectedIds.filter((item) => item !== id);
    this.applyCardSelection(selectedIds);
    if (added) this.placeContextToolbar(`#card-anchor-${id}`);
  },

  cancelSelect() {
    this.applyCardSelection([]);
  },

  openDirectoryActions(e) {
    this._directoryLongPressAt = Date.now();
    const activeDirectory = e.currentTarget.dataset.title;
    if (this._press && this._press.kind === "directory" && this._press.key === activeDirectory) {
      this._press.armed = true;
    }
    const sections = this.data.sections.map((section) => ({
      ...section,
      cards: section.cards.map((card) => ({ ...card, selected: false })),
    }));
    // DEC-083：「标题级别」按钮上的角标显示**当前目录**的级别（一级 H1、二级 H2、三级 H3）。
    const activeSection = sections.find((section) => section.title === activeDirectory);
    const activeDirectoryLevel = Math.min(3, Math.max(1, Number(activeSection && activeSection.level) || 1));
    this.setData({
      sections,
      activeDirectoryLevel,
      selectedIds: [],
      canEditSelected: false,
      actionMode: "directory",
      activeDirectory,
      addMenuOpen: false,
      contextToolbarReady: false,
      pageScrollLocked: true,
    });
    const index = e.currentTarget.dataset.index;
    this.placeContextToolbar(index === undefined || index === "" ? "" : `#directory-anchor-${index}`);
  },

  closeContextActions() {
    const sections = this.data.sections.map((section) => ({
      ...section,
      cards: section.cards.map((card) => ({ ...card, selected: false })),
    }));
    this._menuHandler = null;
    this.setData({
      sections,
      selectedIds: [],
      canEditSelected: false,
      actionMode: "",
      activeDirectory: "",
      menuOpen: false,
      menuOptions: [],
      cardColorPickerOpen: false,
      selectedCardColor: "",
    });
  },

  editDirectory(e) {
    if (Date.now() - Number(this._directoryLongPressAt || 0) < 500) return;
    this.startDirectoryEdit(e.currentTarget.dataset.title);
  },

  startDirectoryEdit(title = this.data.activeDirectory) {
    if (!title) return;
    // 重命名与新建统一走行内输入，不再弹窗。
    this.setData({
      actionMode: "",
      directoryInlineEdit: title,
      directoryInlineValue: title,
    });
  },

  openAddMenu() {
    this.closeContextActions();
    this.setData({ addMenuOpen: true });
  },

  closeAddMenu() {
    this.setData({ addMenuOpen: false });
  },

  createCard() {
    wx.navigateTo({ url: `/pages/card-editor/card-editor?setId=${this.setId}&type=qa` });
    this.closeAddMenu();
  },

  // DEC-060：新建目录不再弹窗——直接建一条空白目录，就在目录行里输入名称。
  createDirectoryInline({ parentTitle = "", referenceId = "", placement = "" } = {}) {
    const existing = new Set((this.data.sections || []).map((section) => section.title));
    let placeholder = "新目录";
    let suffix = 2;
    while (existing.has(placeholder)) {
      placeholder = `新目录 ${suffix}`;
      suffix += 1;
    }
    let inserted = null;
    if (parentTitle) {
      inserted = insertChildDirectory(this.setId, parentTitle, placeholder);
    } else if (referenceId) {
      inserted = insertDirectoryRelativeToCard(this.setId, referenceId, placement, placeholder);
    } else {
      inserted = updateSet(this.setId, (set) => ({
        ...set,
        sectionOrder: [...orderedSectionTitles(set), placeholder],
        sectionLevels: { ...(set.sectionLevels || {}), [placeholder]: 1 },
      }));
    }
    this.closeAddMenu();
    this.closeContextActions();
    if (!inserted) {
      wx.showToast({ title: "添加失败，请刷新后重试", icon: "none" });
      return;
    }
    this.setData({ directoryInlineEdit: placeholder, directoryInlineValue: "" });
    this.refresh();
    this.scrollDirectoryIntoView(placeholder);
  },

  // 新建/改名的目录行只有在**真的看不见**时才滚动过去：子目录紧贴所选目录下方，
  // 本来就看得见，无条件滚动会白白"滑一下"（DEC-086）。
  scrollDirectoryIntoView(title) {
    if (typeof wx.createSelectorQuery !== "function" || typeof wx.pageScrollTo !== "function") return;
    const index = (this.data.sections || []).findIndex((section) => section.title === title);
    if (index < 0) return;
    const navBottom = Number(this.data.navTotalHeight) || 0;
    const viewportHeight = Number(this.data.viewportHeight) || 0;
    const bottomLimit = viewportHeight ? viewportHeight - 140 : 0;
    wx.createSelectorQuery()
      .select(`#directory-anchor-${index}`)
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

  // 目录行内输入完成：空值或没改就保留原名，重名则提示并放弃这次输入。
  // 行号用 dataset.title 定位（失焦提交时 data 里的 directoryInlineEdit 可能已经被下一行的点击改写）。
  commitDirectoryInline(event) {
    const target = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.title
      : "";
    const editing = target || this.data.directoryInlineEdit;
    if (!editing) return;
    const name = String(event && event.detail && event.detail.value || "").trim();
    this.setData({ directoryInlineEdit: "", directoryInlineValue: "" });
    if (!name || name === editing) {
      this.refresh();
      return;
    }
    if (this.data.sections.some((section) => section.title === name)) {
      wx.showToast({ title: "该目录已存在", icon: "none" });
      this.refresh();
      return;
    }
    updateSet(this.setId, (set) => {
      const levels = { ...(set.sectionLevels || {}) };
      const level = levels[editing] || 1;
      delete levels[editing];
      levels[name] = level;
      return {
        ...set,
        cards: set.cards.map((card) => cardSection(card) === editing ? { ...card, section: name } : card),
        sectionOrder: orderedSectionTitles(set).map((title) => title === editing ? name : title),
        sectionLevels: levels,
      };
    });
    this.refresh();
  },

  directoryAction(e) {
    const action = e.currentTarget.dataset.action;
    if (action === "edit") this.startDirectoryEdit();
    if (action === "add") this.chooseDirectoryAdd();
    if (action === "level") this.chooseDirectoryLevel();
    if (action === "move") this.chooseDirectoryMove();
    if (action === "delete") this.deleteDirectory();
  },

  chooseDirectoryAdd() {
    const title = this.data.activeDirectory;
    if (!title) return;
    this.openContextMenu([
      { key: "card", label: "插入卡片" },
      { key: "child", label: "插入子目录" },
    ], (key) => {
      if (key === "card") this.addCardToDirectory();
      if (key === "child") this.addChildDirectory();
    });
  },

  addCardToDirectory() {
    const title = this.data.activeDirectory;
    if (!title) return;
    const card = appendBlankCardToDirectory(this.setId, title);
    if (!card) {
      wx.showToast({ title: "添加失败，请刷新后重试", icon: "none" });
      return;
    }
    this.closeContextActions();
    this.refresh();
    wx.navigateTo({
      url: `/pages/card-editor/card-editor?setId=${encodeURIComponent(this.setId)}&cardId=${encodeURIComponent(card.id)}`,
    });
  },

  addChildDirectory() {
    const title = this.data.activeDirectory;
    if (!title) return;
    const section = this.data.sections.find((item) => item.title === title);
    if (!section) return;
    if (section.level >= 3) {
      wx.showToast({ title: "三级标题下不能再加子目录", icon: "none" });
      return;
    }
    this.createDirectoryInline({ parentTitle: title });
  },

  chooseDirectoryLevel() {
    const title = this.data.activeDirectory;
    if (!title) return;
    const levels = ["一级标题", "二级标题", "三级标题"];
    this.openContextMenu(levels.map((label, index) => ({ key: String(index + 1), label })), (key) => {
      const level = Number(key) || 1;
      updateSet(this.setId, (set) => ({
        ...set,
        sectionLevels: { ...(set.sectionLevels || {}), [title]: level },
      }));
      this.closeContextActions();
      this.refresh();
      wx.showToast({ title: `已设为${["一级", "二级", "三级"][level - 1]}标题`, icon: "none" });
    });
  },

  chooseDirectoryMove() {
    const title = this.data.activeDirectory;
    const titles = orderedSectionTitles(this.data.set);
    if (!title || titles.length < 2) {
      wx.showToast({ title: "当前没有可调整的目录", icon: "none" });
      return;
    }
    const actions = ["top", "up", "down", "bottom"];
    const labels = ["移到顶部", "上移一位", "下移一位", "移到底部"];
    this.openContextMenu(labels.map((label, index) => ({ key: actions[index], label })), (key) => {
      const sectionOrder = moveTitle(titles, title, key);
      updateSet(this.setId, (set) => ({
        ...set,
        sectionOrder,
        cards: cardsInSectionOrder(set.cards, sectionOrder),
      }));
      this.closeContextActions();
      this.refresh();
      wx.showToast({ title: "目录顺序已更新", icon: "none" });
    });
  },

  deleteDirectory() {
    const title = this.data.activeDirectory;
    const section = this.data.sections.find((item) => item.title === title);
    if (!title || !section) return;
    wx.showModal({
      title: "删除目录",
      content: `将同时删除目录中的 ${section.cards.length} 张卡片，是否继续？`,
      confirmColor: "#b6534c",
      success: (result) => {
        if (!result.confirm) return;
        updateSet(this.setId, (set) => {
          const levels = { ...(set.sectionLevels || {}) };
          delete levels[title];
          return {
            ...set,
            cards: set.cards.filter((card) => cardSection(card) !== title),
            sectionOrder: orderedSectionTitles(set).filter((item) => item !== title),
            sectionLevels: levels,
          };
        });
        this.closeContextActions();
        this.refresh();
      },
    });
  },

  deleteSelected() {
    const ids = this.data.selectedIds;
    if (!ids.length) return;
    wx.showModal({
      title: "删除卡片",
      content: `确定删除 ${ids.length} 张卡片吗？`,
      confirmColor: "#b6534c",
      success: (result) => {
        if (!result.confirm) return;
        updateSet(this.setId, (set) => ({ ...set, cards: set.cards.filter((card) => !ids.includes(card.id)) }));
        this.closeContextActions();
        this.refresh();
      },
    });
  },

  selectionAction(e) {
    if (!this.data.selectedIds.length) return;
    const action = e.currentTarget.dataset.action;
    if (action === "add") {
      this.chooseRelativeCardInsert();
      return;
    }
    if (action === "edit") {
      if (this.data.selectedIds.length !== 1) {
        wx.showToast({ title: "请选择一张卡片", icon: "none" });
        return;
      }
      const cardId = this.data.selectedIds[0];
      this.closeContextActions();
      wx.navigateTo({
        url: `/pages/card-editor/card-editor?setId=${encodeURIComponent(this.setId)}&cardId=${encodeURIComponent(cardId)}`,
      });
      return;
    }
    if (action === "move") this.chooseCardDestination();
    if (action === "color") this.openCardColorPicker();
  },

  chooseRelativeCardInsert() {
    if (this.data.selectedIds.length !== 1) return;
    const referenceId = this.data.selectedIds[0];
    const actions = [
      { kind: "card", placement: "before", label: "在前方添加卡片" },
      { kind: "card", placement: "after", label: "在后方添加卡片" },
      { kind: "directory", placement: "before", label: "在前方添加目录" },
      { kind: "directory", placement: "after", label: "在后方添加目录" },
    ];
    this.openContextMenu(actions.map((action) => ({
      key: `${action.kind}-${action.placement}`,
      label: action.label,
    })), (key) => {
      const action = actions.find((item) => `${item.kind}-${item.placement}` === key);
      if (!action) return;
      if (action.kind === "directory") {
        this.openRelativeDirectoryEditor(referenceId, action.placement);
        return;
      }
      const addedCard = insertBlankCardInSet(this.setId, referenceId, action.placement);
      if (!addedCard) {
        wx.showToast({ title: "添加失败，请刷新后重试", icon: "none" });
        return;
      }
      this.closeContextActions();
      this.refresh();
      wx.showToast({ title: "已添加空白卡片", icon: "none" });
    });
  },

  openRelativeDirectoryEditor(referenceId, placement) {
    const referenceCard = this.data.set.cards.find((card) => card.id === referenceId);
    const referenceTitle = referenceCard && cardSection(referenceCard);
    if (!referenceTitle || !this.data.sections.some((section) => section.title === referenceTitle)) {
      wx.showToast({ title: "参照目录已不存在，请重试", icon: "none" });
      return;
    }
    this.createDirectoryInline({ referenceId, placement });
  },

  chooseCardDestination() {
    const titles = this.data.sections.map((section) => section.title);
    const choose = (title) => {
      if (!title) return;
      const ids = [...this.data.selectedIds];
      const alreadyThere = this.data.sections
        .flatMap((section) => section.cards)
        .filter((card) => ids.includes(card.id))
        .every((card) => cardSection(card) === title);
      if (alreadyThere) {
        wx.showToast({ title: "所选卡片已在该目录", icon: "none" });
        return;
      }
      updateSet(this.setId, (set) => ({
        ...set,
        cards: set.cards.map((card) => ids.includes(card.id) ? { ...card, section: title } : card),
      }));
      this.closeContextActions();
      this.refresh();
      wx.showToast({ title: `已移动 ${ids.length} 张卡片`, icon: "none" });
    };

    this.openContextMenu(titles.map((title) => ({ key: title, label: title })), (title) => choose(title));
  },

  moreActions() {
    wx.showActionSheet({
      itemList: ["编辑卡集", "分享卡集"],
      success: (result) => {
        if (result.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/card-set-editor/card-set-editor?id=${encodeURIComponent(this.setId)}` });
          return;
        }
        if (typeof wx.showShareMenu === "function") wx.showShareMenu({ menus: ["shareAppMessage"] });
        wx.showToast({ title: "可通过右上角或底部分享卡集", icon: "none" });
      },
    });
  },

  // DEC-067：底栏“更多”改为从下往上滑出的抽屉，本轮先落视觉骨架。
  openMoreDrawer() {
    this.closeAddMenu();
    this.setData({ moreDrawerOpen: true });
  },

  closeMoreDrawer() {
    this.setData({ moreDrawerOpen: false });
  },

  drawerAction(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    if (key === "color") {
      this.closeMoreDrawer();
      this.openColorPanel();
      return;
    }
    wx.showToast({ title: "该功能开发中", icon: "none" });
  },

  // 卡盒颜色面板：统一颜色（本卡盒）与彩虹色（本卡盒所在文件夹的全部卡盒，按顺序套渐变）。
  openColorPanel() {
    const palette = cardColor(this.data.set && this.data.set.color);
    this.setData({
      colorPanelOpen: true,
      colorMode: "uniform",
      selectedSetColor: palette ? palette.key : "",
      colorScopeLabel: `《${this.data.set.title}》`,
    });
  },

  closeColorPanel() {
    this.setData({ colorPanelOpen: false });
  },

  selectColorMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!["uniform", "rainbow"].includes(mode) || mode === this.data.colorMode) return;
    this.setData({ colorMode: mode });
  },

  applyUniformColor(e) {
    const key = e.currentTarget.dataset.key || "";
    if (!this.setId) return;
    setSetsColor([this.setId], key);
    this.setData({ selectedSetColor: key });
    this.refresh();
    wx.showToast({ title: key ? "已更新卡盒颜色" : "已恢复默认底色", icon: "none" });
  },

  rainbowSetIds() {
    const set = this.data.set;
    if (!set) return [];
    const folder = set.folder;
    return loadCardSets()
      .filter((item) => item.folder === folder)
      .map((item) => item.id);
  },

  applyRainbow() {
    const ids = this.rainbowSetIds();
    if (!ids.length) {
      wx.showToast({ title: "暂无可上色的卡盒", icon: "none" });
      return;
    }
    wx.showModal({
      title: "设置彩虹色",
      content: "是否将当前文件夹下的所有卡盒按顺序应用渐变色？",
      confirmText: "确定",
      cancelText: "取消",
      success: (result) => {
        if (!result.confirm) return;
        applyRainbowSetColors(ids);
        this.closeColorPanel();
        this.refresh();
        wx.showToast({ title: "已应用渐变色", icon: "none" });
      },
    });
  },

  // 卡片调色板（DEC-067）：颜色写在卡片自己的 color 字段上，刷新后按浅色底渲染。
  openCardColorPicker() {
    const palette = cardColor(this.selectedCardColor());
    const viewportHeight = Number(this.data.viewportHeight) || 0;
    const toolbarHeight = Number(this.data.contextToolbarHeight) || 48;
    const top = Math.min(
      Number(this.data.contextToolbarTop || 0) + toolbarHeight + 10,
      viewportHeight ? viewportHeight - 220 : Number.MAX_SAFE_INTEGER,
    );
    this.setData({
      cardColorPickerOpen: true,
      cardColorPickerTop: Math.max(Number(this.data.floatingTop || 0), top),
      selectedCardColor: palette ? palette.key : "",
    });
  },

  closeCardColorPicker() {
    if (!this.data.cardColorPickerOpen) return;
    this.setData({ cardColorPickerOpen: false });
  },

  selectedCardColor() {
    const ids = this.data.selectedIds || [];
    const cards = ids
      .map((id) => this.data.set.cards.find((card) => card.id === id))
      .filter(Boolean);
    if (!cards.length) return "";
    const first = cardColor(cards[0].color);
    const key = first ? first.key : "";
    return cards.every((card) => {
      const picked = cardColor(card.color);
      return (picked ? picked.key : "") === key;
    }) ? key : "";
  },

  selectCardColor(e) {
    const key = e.currentTarget.dataset.key || "";
    if (!this.data.selectedIds.length) return;
    setCardColors(this.setId, this.data.selectedIds, key);
    this.refresh();
    this.setData({ selectedCardColor: key });
  },

  practice() {
    this.closeContextActions();
    const first = this.data.set.cards.find((card) => !card.isDirectoryPlaceholder && isStudyReady(card));
    if (first) {
      wx.navigateTo({ url: `/pages/knowledge-card/knowledge-card?setId=${this.setId}&cardId=${first.id}` });
    } else {
      wx.showToast({
        title: this.data.set.cards.length ? "先编辑一张卡片" : "先添加一张卡片",
        icon: "none",
      });
    }
  },

  onShareAppMessage() {
    const title = this.data.set ? this.data.set.title : "知识卡集";
    // C15：分享的是**服务端快照**（好友没登录、也没有我这份本地数据，只有按 id 取回的冻结副本）。
    const shareId = this.sharedShareId || this.data.shareId;
    if (shareId) return { title, path: `/pages/card-set/card-set?share=${encodeURIComponent(shareId)}` };
    // 未登录/快照还没就绪时退回旧行为（本机 id），避免分享按钮直接失败。
    return { title, path: `/pages/card-set/card-set?id=${encodeURIComponent(this.setId)}` };
  },
});
