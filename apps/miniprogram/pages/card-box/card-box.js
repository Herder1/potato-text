const { closeTransientLayers } = require("../../utils/page-layers");
const {
  CARD_COLORS,
  addCardToSet,
  applyRainbowSetColors,
  cardColor,
  cardColorBackground,
  cardColorEdge,
  cardId,
  createCardFolder,
  createCardSet,
  deleteCardFolder,
  deleteCardSets,
  loadActiveCardFolder,
  loadCardFolders,
  loadCardSets,
  moveCardSet,
  pinCardSets,
  renameCardFolder,
  saveActiveCardFolder,
  setSetsColor,
  updateSet,
} = require("../../utils/card-box-store");
const { cardSetDraftFromAsset, communityCardSetOptions } = require("../../utils/community-card-sets");

const ALL_FOLDERS = "全部卡集";
const DRAG_THRESHOLD = 10;
const DRAG_EDGE_ZONE = 72;
const DRAG_EDGE_BOTTOM = 96;
const DRAG_EDGE_MAX_STEP = 22;
const DRAG_EDGE_INTERVAL = 16;

function setSlotIndex(sets, pointerX, pointerY) {
  for (let position = 0; position < sets.length; position += 1) {
    const set = sets[position];
    const before = pointerY < set.top
      || (pointerY <= set.bottom && pointerX < (set.left + set.right) / 2);
    if (before) return position;
  }
  return sets.length;
}

Page({
  data: {
    sets: [],
    visibleSets: [],
    folders: [],
    query: "",
    directoryOpen: false,
    moreDrawerOpen: false,
    colorPanelOpen: false,
    importSheetOpen: false,
    importOptions: [],
    importLoading: false,
    colorMode: "uniform",
    selectedSetColor: "",
    colorScopeLabel: "",
    setColorPickerOpen: false,
    setColorPickerTop: 258,
    cardColors: CARD_COLORS,
    activeFolder: "我的卡集",
    folderActionTarget: "",
    folderInlineCreateOpen: false,
    folderEditorOpen: false,
    folderEditorMode: "create",
    folderEditorOriginal: "",
    folderEditorValue: "",
    selecting: false,
    selectedIds: [],
    selectionAlign: "left",
    dragActive: false,
    dragKey: "",
    dragGhost: null,
    dragStyle: "",
    dragIndicator: null,
    pageScrollLocked: false,
    viewportHeight: 0,
    navBottom: 0,
    contentLeft: 14,
    contentWidth: 300,
  },

  onLoad() {
    this.measureNavigation();
  },

  measureNavigation() {
    const windowInfo = typeof wx.getWindowInfo === "function"
      ? wx.getWindowInfo()
      : (typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {});
    const windowWidth = Number(windowInfo.windowWidth) || 375;
    const windowHeight = Number(windowInfo.windowHeight) || 667;
    const contentLeft = Math.round((32 / 750) * windowWidth);
    this.setData({
      viewportHeight: windowHeight,
      navBottom: Math.round((150 / 750) * windowWidth),
      contentLeft,
      contentWidth: windowWidth - contentLeft * 2,
    });
  },

  noop() {},

  handleBlankTap() {
    if (this.data.directoryOpen) {
      this.closeDirectory();
      return;
    }
    if (this.data.selecting) this.cancelSelect();
  },

  // 离开页面自动收掉所有瞬态浮层（带遮罩的长按工具栏 / 抽屉 / 菜单），避免跨页残留成隐形拦截层。
  onHide() {
    closeTransientLayers(this, ["directoryOpen","moreDrawerOpen","colorPanelOpen","setColorPickerOpen","folderInlineCreateOpen","folderEditorOpen","importSheetOpen"]);
  },

  onShow() {
    if (typeof wx.showShareMenu === "function") wx.showShareMenu({ menus: ["shareAppMessage"] });
    const folders = loadCardFolders();
    const fallbackFolder = folders[0] || "我的卡集";
    const activeFolder = loadActiveCardFolder();
    const sets = loadCardSets().map((set) => {
      const cards = (set.cards || []).filter((card) => !card.isDirectoryPlaceholder);
      const palette = cardColor(set.color);
      return {
        ...set,
        folder: set.folder || fallbackFolder,
        displayDescription: Object.prototype.hasOwnProperty.call(set, "description") ? set.description : set.subtitle,
        count: cards.length,
        learned: cards.filter((card) => card.state === "learning").length,
        colorSoft: cardColorBackground(set.color),
        colorEdge: cardColorEdge(set.color),
        colorAccent: palette ? palette.accent : "",
      };
    });
    this.setData({ folders, activeFolder, sets, folderActionTarget: "" }, () => this.applyFilter());
  },

  applyFilter() {
    const { activeFolder, query, sets } = this.data;
    const visibleSets = sets.filter((set) => (
      (activeFolder === ALL_FOLDERS || set.folder === activeFolder)
      && `${set.title}${set.displayDescription || ""}${set.author}`.includes(query)
    ));
    this.setData({ visibleSets });
  },

  toggleDirectory() {
    if (Date.now() - Number(this._folderLongPressAt || 0) < 500) return;
    const directoryOpen = !this.data.directoryOpen;
    this.setData({ directoryOpen, folderActionTarget: "", folderInlineCreateOpen: false });
  },

  closeDirectory() {
    this.setData({ directoryOpen: false, folderActionTarget: "", folderInlineCreateOpen: false });
  },

  selectFolder(e) {
    if (Date.now() - Number(this._folderLongPressAt || 0) < 500) return;
    const activeFolder = saveActiveCardFolder(e.currentTarget.dataset.folder);
    this.setData({
      activeFolder,
      directoryOpen: false,
      folderActionTarget: "",
      folderInlineCreateOpen: false,
    }, () => this.applyFilter());
  },

  openActiveFolderActions() {
    if (this.data.activeFolder === ALL_FOLDERS) {
      this.setData({ directoryOpen: true, folderActionTarget: "", folderInlineCreateOpen: false });
      return;
    }
    this._folderLongPressAt = Date.now();
    this.setData({ directoryOpen: true, folderActionTarget: this.data.activeFolder, folderInlineCreateOpen: false });
  },

  openFolderRowActions(e) {
    this._folderLongPressAt = Date.now();
    this.setData({ folderActionTarget: e.currentTarget.dataset.folder, folderInlineCreateOpen: false });
  },

  startCreateFolder() {
    this.setData({
      directoryOpen: true,
      folderActionTarget: "",
      folderInlineCreateOpen: true,
      folderEditorOpen: false,
      folderEditorMode: "create",
      folderEditorOriginal: "",
      folderEditorValue: "",
    });
  },

  startRenameFolder(e) {
    const folder = e.currentTarget.dataset.folder || this.data.folderActionTarget;
    if (!folder || folder === ALL_FOLDERS) return;
    this.setData({
      directoryOpen: false,
      folderActionTarget: "",
      folderInlineCreateOpen: false,
      folderEditorOpen: true,
      folderEditorMode: "rename",
      folderEditorOriginal: folder,
      folderEditorValue: folder,
    });
  },

  updateFolderEditor(e) {
    this.setData({ folderEditorValue: e.detail.value });
  },

  closeFolderEditor() {
    this.setData({
      folderEditorOpen: false,
      folderEditorOriginal: "",
      folderEditorValue: "",
    });
  },

  closeInlineCreate() {
    this.setData({ folderInlineCreateOpen: false, folderEditorValue: "" });
  },

  saveFolderEditor() {
    const name = this.data.folderEditorValue.trim();
    const original = this.data.folderEditorOriginal;
    if (!name) {
      wx.showToast({ title: "请输入文件夹名称", icon: "none" });
      return;
    }
    if (name === ALL_FOLDERS) {
      wx.showToast({ title: "不能使用这个名称", icon: "none" });
      return;
    }

    if (this.data.folderEditorMode === "create") {
      if (!createCardFolder(name)) {
        wx.showToast({ title: "该文件夹已存在", icon: "none" });
        return;
      }
      saveActiveCardFolder(name);
      this.setData({ activeFolder: name, folderInlineCreateOpen: false, folderEditorValue: "" });
      wx.showToast({ title: "文件夹已新建", icon: "none" });
    } else {
      if (name === original) {
        this.closeFolderEditor();
        return;
      }
      if (!renameCardFolder(original, name)) {
        wx.showToast({ title: "该文件夹已存在", icon: "none" });
        return;
      }
      if (this.data.activeFolder === original) {
        saveActiveCardFolder(name);
        this.setData({ activeFolder: name });
      }
      wx.showToast({ title: "文件夹已重命名", icon: "none" });
    }

    if (this.data.folderEditorMode === "rename") this.closeFolderEditor();
    this.onShow();
  },

  deleteFolder(e) {
    const folder = e.currentTarget.dataset.folder || this.data.folderActionTarget;
    if (!folder || folder === ALL_FOLDERS) return;
    if (this.data.folders.length < 2) {
      wx.showToast({ title: "请至少保留一个文件夹", icon: "none" });
      return;
    }
    const remaining = this.data.folders.filter((item) => item !== folder);
    const fallback = remaining.includes("我的卡集") ? "我的卡集" : remaining[0];
    const count = this.data.sets.filter((set) => set.folder === folder).length;
    wx.showModal({
      title: "删除文件夹",
      content: count ? `其中 ${count} 个卡集将移动到“${fallback}”。` : "该文件夹目前没有卡集。",
      confirmColor: "#b6534c",
      success: (result) => {
        if (!result.confirm) return;
        const deleted = deleteCardFolder(folder);
        if (!deleted) return;
        const activeFolder = this.data.activeFolder === folder
          ? saveActiveCardFolder(deleted.fallback)
          : this.data.activeFolder;
        this.setData({
          activeFolder,
          folderActionTarget: "",
        });
        this.onShow();
        wx.showToast({ title: "文件夹已删除", icon: "none" });
      },
    });
  },

  search(e) {
    this.setData({ query: e.detail.value.trim() }, () => this.applyFilter());
  },

  openSet(e) {
    wx.navigateTo({ url: `/pages/card-set/card-set?id=${e.currentTarget.dataset.id}` });
  },

  openOrToggle(e) {
    if (Date.now() - Number(this._longPressAt || 0) < 500) return;
    if (this.data.selecting) {
      this.toggleSet(e);
      return;
    }
    this.openSet(e);
  },

  goBack() {
    wx.navigateBack();
  },

  applySelection(selectedIds) {
    const sides = new Set(selectedIds
      .map((id) => this.data.visibleSets.findIndex((item) => item.id === id) % 2)
      .filter((side) => side >= 0));
    const selectionAlign = sides.size > 1 ? "center" : (sides.has(1) ? "right" : "left");
    const visibleSets = this.data.visibleSets.map((item) => ({ ...item, selected: selectedIds.includes(item.id) }));
    this.setData({
      selectedIds,
      visibleSets,
      selecting: selectedIds.length > 0,
      selectionAlign,
      directoryOpen: false,
      folderActionTarget: "",
      setColorPickerOpen: selectedIds.length ? this.data.setColorPickerOpen : false,
    });
  },

  startSelect(e) {
    this._longPressAt = Date.now();
    if (this._press && this._press.key === e.currentTarget.dataset.id) this._press.armed = true;
    this.applySelection([e.currentTarget.dataset.id]);
    this.setData({ pageScrollLocked: true });
  },

  handleSetTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this._press = { key: e.currentTarget.dataset.id, x: touch.clientX, y: touch.clientY, armed: false };
  },

  handleSetTouchMove(e) {
    const touch = e.touches && e.touches[0];
    const press = this._press;
    if (!touch) return;
    if (!this.data.dragActive) {
      if (!press || !press.armed) return;
      if (Math.abs(touch.clientY - press.y) < DRAG_THRESHOLD
        && Math.abs(touch.clientX - press.x) < DRAG_THRESHOLD) return;
      this.beginDrag(press, touch);
      return;
    }
    if (!this._drag) return;
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
      const origin = layout.sets.find((item) => item.id === press.key);
      if (!origin) return;
      this._drag = {
        key: press.key,
        origin,
        width: Number(origin.right) - Number(origin.left),
        grabX: press.x - origin.left,
        grabY: press.y - origin.top,
        pointerX: touch.clientX,
        pointerY: touch.clientY,
        startScrollTop: layout.scrollTop,
        sets: layout.sets,
        drop: null,
      };
      this._pageScrollTop = layout.scrollTop;
      this.setData({
        dragActive: true,
        dragKey: press.key,
        dragGhost: this.data.visibleSets.find((item) => item.id === press.key) || null,
      });
      this.updateDrag();
    });
  },

  measureDragLayout(callback) {
    if (typeof wx.createSelectorQuery !== "function") {
      callback({ sets: [], scrollTop: Number(this._pageScrollTop) || 0 });
      return;
    }
    const query = wx.createSelectorQuery();
    query.selectAll(".set").boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((results) => {
      const setRects = (results && results[0]) || [];
      const viewport = results && results[1];
      callback({
        sets: setRects.map((rect) => ({
          id: rect.dataset && rect.dataset.id,
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
    const drop = this.computeSetDrop(drag, scrollDelta);
    drag.drop = drop;
    this._pendingDrag = {
      dragStyle: `left: ${left}px; top: ${top}px; width: ${Math.round(drag.width)}px;`,
      dragIndicator: drop ? drop.indicator : null,
    };
    this.flushDragFrame();
    this.updateDragAutoScroll();
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

  computeSetDrop(drag, scrollDelta) {
    const sets = drag.sets.map((item) => ({
      ...item,
      top: item.top - scrollDelta,
      bottom: item.bottom - scrollDelta,
    }));
    if (!sets.length) return null;
    const index = setSlotIndex(sets, drag.pointerX, drag.pointerY);
    return { index, indicator: this.setIndicator(sets, index) };
  },

  setIndicator(sets, index) {
    const contentLeft = Number(this.data.contentLeft) || 14;
    const contentWidth = Number(this.data.contentWidth) || 300;
    if (index >= sets.length) {
      const last = sets[sets.length - 1];
      return { kind: "row", left: contentLeft, top: Math.round(last.bottom + 6), width: contentWidth, height: 4 };
    }
    const target = sets[index];
    if (index % 2 === 1) {
      const left = sets[index - 1];
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

  updateDragAutoScroll() {
    const drag = this._drag;
    if (!drag) {
      this.stopDragAutoScroll();
      return;
    }
    const navBottom = Number(this.data.navBottom) || 0;
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
      if (!this._drag || !this._dragAutoScrollDirection) {
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

  onPageScroll(event) {
    this._pageScrollTop = Number(event && event.scrollTop) || 0;
    if (this.data.dragActive) this.updateDrag();
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
    this.setData({ dragActive: false, dragKey: "", dragGhost: null, dragStyle: "", dragIndicator: null });
    if (!drag || !drop) return;

    const currentIndex = this.data.visibleSets.findIndex((item) => item.id === drag.key);
    let slot = drop.index;
    if (currentIndex >= 0 && currentIndex < slot) slot -= 1;
    const others = this.data.visibleSets.filter((item) => item.id !== drag.key);
    if (!others.length) return;
    const atEnd = slot >= others.length;
    const target = atEnd ? others[others.length - 1] : others[Math.max(0, slot)];
    const moved = moveCardSet(drag.key, target.id, atEnd ? "after" : "before");
    if (!moved) {
      wx.showToast({ title: "移动失败，请重试", icon: "none" });
      return;
    }
    this.applySelection([]);
    this.onShow();
    wx.showToast({ title: "已移动卡集", icon: "none" });
  },

  onUnload() {
    this.stopDragAutoScroll();
  },

  toggleSet(e) {
    const id = e.currentTarget.dataset.id;
    const selectedIds = this.data.selectedIds.includes(id)
      ? this.data.selectedIds.filter((item) => item !== id)
      : [...this.data.selectedIds, id];
    this.applySelection(selectedIds);
  },

  cancelSelect() {
    this.applySelection([]);
  },

  flipSet(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const visibleSets = this.data.visibleSets.map((item) => (
      item.id === id ? { ...item, flipped: !item.flipped } : item
    ));
    this.setData({ visibleSets });
  },

  // DEC-067：底栏“更多”改为从下往上滑出的抽屉，条目复用页面已有能力。
  openMoreDrawer() {
    this.closeDirectory();
    this.setData({ moreDrawerOpen: true });
  },

  closeMoreDrawer() {
    this.setData({ moreDrawerOpen: false });
  },

  drawerAction(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this.closeMoreDrawer();
    if (key === "folders") {
      this.setData({ directoryOpen: true, folderActionTarget: "", folderInlineCreateOpen: false });
      return;
    }
    if (key === "newFolder") {
      this.startCreateFolder();
      return;
    }
    if (key === "renameFolder") {
      if (this.data.activeFolder === ALL_FOLDERS) {
        wx.showToast({ title: "先进入一个文件夹再重命名", icon: "none" });
        return;
      }
      this.startRenameFolder({ currentTarget: { dataset: { folder: this.data.activeFolder } } });
      return;
    }
    if (key === "color") {
      this.openColorPanel();
      return;
    }
    wx.showToast({ title: "该功能开发中", icon: "none" });
  },

  // 卡盒颜色面板：作用范围是“当前文件夹下的所有卡盒”。
  colorScopeSetIds() {
    const { activeFolder, sets } = this.data;
    return sets
      .filter((set) => activeFolder === ALL_FOLDERS || set.folder === activeFolder)
      .map((set) => set.id);
  },

  openColorPanel() {
    const ids = this.colorScopeSetIds();
    const paletteOf = (id) => {
      const set = (this.data.sets || []).find((item) => item.id === id);
      const picked = set ? cardColor(set.color) : null;
      return picked ? picked.key : "";
    };
    const first = ids.length ? paletteOf(ids[0]) : "";
    const uniform = ids.length > 0 && ids.every((id) => paletteOf(id) === first);
    this.setData({
      colorPanelOpen: true,
      colorMode: "uniform",
      selectedSetColor: uniform ? first : "",
      colorScopeLabel: this.data.activeFolder === ALL_FOLDERS
        ? "「全部卡集」下的所有卡盒"
        : `「${this.data.activeFolder}」文件夹下的所有卡盒`,
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
    const ids = this.colorScopeSetIds();
    if (!ids.length) {
      wx.showToast({ title: "暂无可上色的卡盒", icon: "none" });
      return;
    }
    setSetsColor(ids, key);
    this.setData({ selectedSetColor: key });
    this.onShow();
    wx.showToast({ title: key ? "已统一卡盒颜色" : "已恢复默认底色", icon: "none" });
  },

  applyRainbow() {
    const ids = this.colorScopeSetIds();
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
        this.onShow();
        wx.showToast({ title: "已应用渐变色", icon: "none" });
      },
    });
  },

  organizeSets() {
    const first = this.data.visibleSets[0];
    if (!first) {
      wx.showToast({ title: "暂无可整理的卡集", icon: "none" });
      return;
    }
    this.applySelection([first.id]);
  },

  showAllFolders() {
    const activeFolder = saveActiveCardFolder(ALL_FOLDERS);
    this.setData({ activeFolder, directoryOpen: false, folderActionTarget: "", folderInlineCreateOpen: false }, () => this.applyFilter());
  },

  onShareAppMessage() {
    const folder = this.data.activeFolder;
    return {
      title: folder && folder !== ALL_FOLDERS ? `我的卡集 · ${folder}` : "我的知识卡集",
      path: "/pages/card-box/card-box",
    };
  },

  selectionAction(e) {
    const action = e.currentTarget.dataset.action;
    if (action === "edit") {
      if (this.data.selectedIds.length !== 1) {
        wx.showToast({ title: "请选择一个卡集", icon: "none" });
        return;
      }
      const id = this.data.selectedIds[0];
      this.applySelection([]);
      wx.navigateTo({ url: `/pages/card-set-editor/card-set-editor?id=${encodeURIComponent(id)}` });
      return;
    }
    if (action === "delete") {
      const ids = [...this.data.selectedIds];
      wx.showModal({
        title: "删除卡集",
        content: `确定删除 ${ids.length} 个卡集吗？`,
        confirmColor: "#b6534c",
        success: (result) => {
          if (!result.confirm) return;
          // 走 store 而不是页面直接写 Storage：删除要留墓碑，否则另一台设备上的旧副本会把它带回来（C15）。
          deleteCardSets(ids);
          this.setData({ selecting: false, selectedIds: [] }, () => this.onShow());
        },
      });
      return;
    }
    if (action === "move") {
      this.moveSelectedSets();
      return;
    }
    if (action === "color") {
      this.openSetColorPicker();
      return;
    }
    if (action === "pin") this.pinSelectedSets();
  },

  // DEC-067：选中工具栏里的「颜色」——给选中的卡盒逐个上色（与卡集页的调色板同一套色板）。
  openSetColorPicker() {
    const ids = this.data.selectedIds || [];
    if (!ids.length) return;
    this.setData({
      setColorPickerOpen: true,
      setColorPickerTop: 258,
      selectedSetColor: this.commonSetColor(ids),
    });
  },

  closeSetColorPicker() {
    if (!this.data.setColorPickerOpen) return;
    this.setData({ setColorPickerOpen: false });
  },

  commonSetColor(ids) {
    const paletteOf = (id) => {
      const set = (this.data.sets || []).find((item) => item.id === id);
      const picked = set ? cardColor(set.color) : null;
      return picked ? picked.key : "";
    };
    const first = ids.length ? paletteOf(ids[0]) : "";
    return ids.every((id) => paletteOf(id) === first) ? first : "";
  },

  selectSetColor(e) {
    const key = e.currentTarget.dataset.key || "";
    const ids = [...(this.data.selectedIds || [])];
    if (!ids.length) return;
    setSetsColor(ids, key);
    this.onShow();
    this.applySelection(ids);
    this.setData({ selectedSetColor: key });
  },

  moveSelectedSets() {
    const folders = this.data.folders;
    const applyMove = (folder) => {
      const ids = [...this.data.selectedIds];
      ids.forEach((id) => updateSet(id, (set) => ({ ...set, folder })));
      this.applySelection([]);
      this.onShow();
      wx.showToast({ title: `已移动 ${ids.length} 个卡集`, icon: "none" });
    };
    if (folders.length <= 6) {
      wx.showActionSheet({ itemList: folders, success: (result) => applyMove(folders[result.tapIndex]) });
      return;
    }
    wx.showModal({
      title: "移动到文件夹",
      editable: true,
      placeholderText: "输入已有文件夹名称",
      success: (result) => {
        if (!result.confirm) return;
        const folder = String(result.content || "").trim();
        if (!folders.includes(folder)) {
          wx.showToast({ title: "没有找到该文件夹", icon: "none" });
          return;
        }
        applyMove(folder);
      },
    });
  },

  pinSelectedSets() {
    const ids = [...this.data.selectedIds];
    pinCardSets(ids);
    this.applySelection([]);
    this.onShow();
    wx.showToast({ title: `已置顶 ${ids.length} 个卡集`, icon: "none" });
  },

  createSet() {
    const fallback = this.data.folders[0] || "我的卡集";
    const folder = this.data.activeFolder === ALL_FOLDERS ? fallback : this.data.activeFolder;
    wx.navigateTo({ url: `/pages/card-set-editor/card-set-editor?folder=${encodeURIComponent(folder)}` });
  },

  // DEC-076：底栏最左侧的「智能练习」入口先占位——按产品负责人口径只提示“功能开发中”。
  smartPractice() {
    wx.showToast({ title: "功能开发中", icon: "none" });
  },

  // DEC-079：导入卡集——来源与「题包从知识库社区收藏导入」一致（社区精选里的卡片集）。
  importCardSet() {
    this.closeMoreDrawer();
    this.refreshImportOptions();
    this.setData({ importSheetOpen: true });
  },

  closeImportSheet() {
    this.setData({ importSheetOpen: false });
  },

  refreshImportOptions() {
    const render = (remoteAssets) => {
      this._remoteCommunityAssets = Array.isArray(remoteAssets) ? remoteAssets : [];
      const titles = new Set(loadCardSets().map((set) => String(set.title || "")));
      const options = communityCardSetOptions(this._remoteCommunityAssets).map((asset) => {
        const draft = cardSetDraftFromAsset(asset);
        return {
          id: draft.sourceAssetId,
          title: draft.title,
          contributor: draft.author,
          path: String(asset.catalogPath || asset.excerpt || "").trim(),
          count: draft.cards.length,
          imported: titles.has(draft.title),
        };
      });
      this.setData({ importOptions: options, importLoading: false });
    };
    render([]);
    const baseUrl = this.apiBaseUrl();
    if (!baseUrl || typeof wx.request !== "function") return;
    this.setData({ importLoading: true });
    wx.request({
      url: `${baseUrl}/api/community/assets`,
      timeout: 7000,
      success: (response) => {
        const assets = response && response.statusCode === 200 && response.data && response.data.assets;
        render(Array.isArray(assets) ? assets : []);
      },
      fail: () => this.setData({ importLoading: false }),
    });
  },

  apiBaseUrl() {
    try {
      const app = getApp();
      const direct = String(app.globalData && app.globalData.apiBaseUrl || "").replace(/\/$/, "");
      if (direct) return direct;
      if (typeof app.apiBaseUrlCandidates === "function") return String(app.apiBaseUrlCandidates()[0] || "").replace(/\/$/, "");
    } catch (error) {
      return "";
    }
    return "";
  },

  selectImportCardSet(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const asset = communityCardSetOptions(this._remoteCommunityAssets || []).find((item) => String(item.id) === id);
    if (!asset) {
      wx.showToast({ title: "这个卡集暂时无法导入", icon: "none" });
      return;
    }
    const draft = cardSetDraftFromAsset(asset);
    const folder = this.data.activeFolder === ALL_FOLDERS
      ? (this.data.folders[0] || "我的卡集")
      : this.data.activeFolder;
    const set = createCardSet(draft.title, draft.description, folder, draft.author);
    if (!set) {
      wx.showToast({ title: "导入失败，请稍后重试", icon: "none" });
      return;
    }
    updateSet(set.id, (current) => ({ ...current, subject: draft.subject }));
    draft.cards.forEach((card) => addCardToSet(set.id, { ...card, id: cardId() }));
    this.setData({ importSheetOpen: false });
    this.onShow();
    wx.showToast({
      title: draft.cards.length ? `已导入「${draft.title}」` : `已导入「${draft.title}」（暂无卡片内容）`,
      icon: "none",
    });
  },
});
