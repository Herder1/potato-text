// 「分类管理」页（DEC-096 ⑤，2026-09-23）。
//
// 从收藏页抽屉底部的「分类管理」进来：顶层是文件夹列表（可拖拽排序、可重命名/删除/新建），
// 进入某个文件夹后管理它的**子文件夹**（子文件夹是筛收藏用的标签，两级封顶、不能再往下建）。
Page({
  data: {
    loading: true,
    error: "",
    parentId: "",
    parentName: "",
    folders: [],
    draggedId: "",
    dragActive: false,
  },

  onShow() {
    this.loadFolders();
  },

  baseUrl() {
    const application = getApp();
    return String(application.globalData.apiBaseUrl || "").replace(/\/$/, "");
  },

  headers() {
    const application = getApp();
    return typeof application.authHeader === "function" ? application.authHeader() : {};
  },

  loadFolders() {
    const baseUrl = this.baseUrl();
    if (!baseUrl) {
      this.setData({ loading: false, error: "无法连接服务器，请检查网络" });
      return;
    }
    this.setData({ loading: true, error: "" });
    wx.request({
      url: `${baseUrl}/api/favorites/folders`,
      timeout: 8000,
      header: this.headers(),
      success: (response) => {
        if (response.statusCode === 401) {
          this.setData({ loading: false, error: "登录后才能管理收藏目录" });
          return;
        }
        if (response.statusCode !== 200 || !response.data) {
          // 404＝这台后台还没加载收藏目录接口（API 只在进程启动时读一次，AGENTS §8）；
          // 说清是什么事，否则真机上只看到"加载失败"，还得靠猜。
          this.setData({
            loading: false,
            error: response.statusCode === 404
              ? "收藏目录服务未就绪（后台服务需重启后生效）"
              : "收藏目录加载失败，请稍后重试",
          });
          return;
        }
        this.organization = response.data;
        // 当前所在文件夹可能已被删除：退回顶层，不要停在一个不存在的层级。
        const folders = Array.isArray(response.data.folders) ? response.data.folders : [];
        if (this.data.parentId && !folders.some((folder) => folder.id === this.data.parentId)) {
          this.setData({ parentId: "", parentName: "" });
        }
        this.renderFolders();
      },
      fail: () => this.setData({ loading: false, error: "无法连接服务器，请检查网络" }),
    });
  },

  renderFolders() {
    const organization = this.organization || {};
    const all = Array.isArray(organization.folders) ? organization.folders : [];
    const withChildren = (organization.counts && organization.counts.withChildren) || {};
    const parentId = this.data.parentId || "";
    const folders = all
      .filter((folder) => String(folder.parentId || "") === parentId)
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        count: Number(withChildren[folder.id] || 0),
        children: all.filter((child) => child.parentId === folder.id).length,
      }));
    const parent = parentId ? all.find((folder) => folder.id === parentId) : null;
    this.setData({
      folders,
      parentName: parent ? parent.name : "",
      loading: false,
      dragActive: false,
      draggedId: "",
    });
  },

  enterFolder(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.dragActive) return;
    this.setData({ parentId: id }, () => this.renderFolders());
  },

  backToTop() {
    this.setData({ parentId: "", parentName: "" }, () => this.renderFolders());
  },

  createFolder() {
    const parentId = this.data.parentId || "";
    wx.showModal({
      title: parentId ? "新建子文件夹" : "新建文件夹",
      editable: true,
      placeholderText: "文件夹名称（最多 20 字）",
      success: (result) => {
        if (!result.confirm) return;
        const name = String(result.content || "").trim();
        if (!name) {
          wx.showToast({ title: "请输入名称", icon: "none" });
          return;
        }
        this.post("/api/favorites/folders", { name, parentId: parentId || null }, () => {
          wx.showToast({ title: "已新建", icon: "none" });
        });
      },
    });
  },

  folderMenu(event) {
    const id = event.currentTarget.dataset.id;
    const folder = (this.data.folders || []).find((item) => item.id === id);
    if (!folder) return;
    const canAddChild = !this.data.parentId;
    const items = canAddChild ? ["重命名", "新建子文件夹", "删除文件夹"] : ["重命名", "删除文件夹"];
    wx.showActionSheet({
      itemList: items,
      success: (result) => {
        const action = items[result.tapIndex];
        if (action === "重命名") this.renameFolder(folder);
        else if (action === "新建子文件夹") this.createSubFolder(folder);
        else if (action === "删除文件夹") this.confirmDelete(folder);
      },
    });
  },

  renameFolder(folder) {
    wx.showModal({
      title: "重命名文件夹",
      editable: true,
      placeholderText: folder.name,
      success: (result) => {
        if (!result.confirm) return;
        const name = String(result.content || "").trim();
        if (!name || name === folder.name) return;
        this.post(`/api/favorites/folders/${encodeURIComponent(folder.id)}`, { name }, () => {
          wx.showToast({ title: "已重命名", icon: "none" });
        }, "PATCH");
      },
    });
  },

  createSubFolder(folder) {
    wx.showModal({
      title: `在「${folder.name}」里新建子文件夹`,
      editable: true,
      placeholderText: "子文件夹名称（最多 20 字）",
      success: (result) => {
        if (!result.confirm) return;
        const name = String(result.content || "").trim();
        if (!name) {
          wx.showToast({ title: "请输入名称", icon: "none" });
          return;
        }
        this.post("/api/favorites/folders", { name, parentId: folder.id }, () => {
          wx.showToast({ title: "已新建", icon: "none" });
        });
      },
    });
  },

  // 删除文件夹连子文件夹一起删掉，但里面的收藏不会丢（退回未分类）——确认文案要把这一点说清楚。
  confirmDelete(folder) {
    const extra = folder.children ? `（含 ${folder.children} 个子文件夹）` : "";
    wx.showModal({
      title: `删除「${folder.name}」`,
      content: `删除后${extra}里面的收藏会回到「未分类」，收藏本身不会被删除。`,
      confirmText: "删除",
      confirmColor: "#d1503f",
      success: (result) => {
        if (!result.confirm) return;
        this.post(`/api/favorites/folders/${encodeURIComponent(folder.id)}`, null, () => {
          wx.showToast({ title: "已删除文件夹", icon: "none" });
        }, "DELETE");
      },
    });
  },

  // ── 拖拽排序（效果图上的 ⠿ 把手）──
  // 只改同级顺序；松手才写服务端（一次给全该层级的完整顺序，服务端缺项会拒绝）。
  startDrag(event) {
    const index = Number(event.currentTarget.dataset.index);
    const folders = this.data.folders || [];
    if (!Number.isFinite(index) || index < 0 || !folders[index]) return;
    this.dragState = { index, target: index, moved: false, listTop: 0 };
    this.setData({ dragActive: true, draggedId: folders[index].id });
    wx.createSelectorQuery()
      .select(".folder-list")
      .boundingClientRect((rect) => {
        if (rect && this.dragState) this.dragState.listTop = rect.top;
      })
      .exec();
  },

  dragMove(event) {
    if (!this.dragState || !this.data.dragActive) return;
    const touch = (event.touches && event.touches[0]) || null;
    if (!touch) return;
    const listTop = Number(this.dragState.listTop || 0);
    // 每行高度 = 112rpx ÷ 2 = 56px（与 wxss 里的 .folder-row 保持一致）。
    const ROW_HEIGHT = 56;
    const target = Math.max(0, Math.min(this.data.folders.length - 1, Math.floor((touch.clientY - listTop) / ROW_HEIGHT)));
    if (target === this.dragState.target) return;
    this.dragState.target = target;
    this.dragState.moved = true;
    const folders = (this.data.folders || []).slice();
    const [moved] = folders.splice(this.dragState.index, 1);
    folders.splice(target, 0, moved);
    this.dragState.index = target;
    this.setData({ folders });
  },

  endDrag() {
    if (!this.dragState || !this.data.dragActive) return;
    const moved = Boolean(this.dragState.moved);
    const order = (this.data.folders || []).map((folder) => folder.id);
    this.setData({ dragActive: false, draggedId: "" });
    this.dragState = null;
    // 没真的挪动就不写服务端（避免每次摸一下把手都发一次请求）。
    if (!moved) return;
    this.post("/api/favorites/folders/reorder", { parentId: this.data.parentId || null, order }, () => {
      wx.showToast({ title: "顺序已保存", icon: "none" });
    });
  },

  post(path, payload, onSuccess, method = "POST") {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    wx.request({
      url: `${baseUrl}${path}`,
      method,
      timeout: 8000,
      header: this.headers(),
      data: payload === null ? undefined : payload,
      success: (response) => {
        if (response.statusCode === 200 && response.data) {
          this.organization = response.data;
          this.renderFolders();
          if (typeof onSuccess === "function") onSuccess(response.data);
          return;
        }
        const code = String((response.data && response.data.error) || "");
        const message = code === "favorite_folder_name_duplicate" ? "同级已经有同名文件夹"
          : (code === "favorite_folder_depth_exceeded" ? "子文件夹里不能再建子文件夹"
            : (code === "favorite_folder_missing" ? "这个文件夹已经不在了"
              : (response.statusCode === 404 ? "收藏目录服务未就绪（后台服务需重启后生效）" : "操作失败，请稍后重试")));
        wx.showToast({ title: message, icon: "none" });
        this.loadFolders();
      },
      fail: () => wx.showToast({ title: "操作失败，请检查网络", icon: "none" }),
    });
  },
});
