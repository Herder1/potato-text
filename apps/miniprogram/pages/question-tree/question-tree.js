const PACKS = [
  {
    id: "probability",
    title: "概率与统计",
    category: "数学",
    color: "#c65e46",
    count: 8,
    difficulty: "中等",
    summary: "从随机事件到分布的基础训练，适合梳理统计直觉与计算方法。",
    questions: [
      { number: "01", question: "独立重复试验的概率如何计算？", tag: "概率基础" },
      { number: "02", question: "样本方差为什么要除以 n - 1？", tag: "统计推断" },
      { number: "03", question: "正态分布的三个关键特征是什么？", tag: "分布模型" }
    ]
  },
  {
    id: "mechanics",
    title: "经典力学",
    category: "物理",
    color: "#6d9eaa",
    count: 5,
    difficulty: "进阶",
    summary: "把受力分析、动量守恒和能量视角串成一条可复用的解题路径。",
    questions: [
      { number: "01", question: "如何选择合适的惯性参考系？", tag: "受力分析" },
      { number: "02", question: "碰撞问题中动量和能量分别何时守恒？", tag: "守恒定律" },
      { number: "03", question: "简谐运动的相位差如何判断？", tag: "振动" }
    ]
  },
  {
    id: "ancient",
    title: "先秦思想",
    category: "语文",
    color: "#e2bd4d",
    count: 6,
    difficulty: "基础",
    summary: "围绕诸子百家的核心概念，建立文本、时代和观点之间的联系。",
    questions: [
      { number: "01", question: "《论语》中“学”与“思”的关系是什么？", tag: "儒家" },
      { number: "02", question: "庄子寓言常用什么方式表达观点？", tag: "道家" },
      { number: "03", question: "墨家“兼爱”与儒家仁爱有何异同？", tag: "诸子" }
    ]
  },
  {
    id: "cell",
    title: "细胞生物学",
    category: "生物",
    color: "#889d68",
    count: 7,
    difficulty: "中等",
    summary: "从细胞结构切入，串联膜运输、能量转换与遗传信息表达。",
    questions: [
      { number: "01", question: "细胞膜的流动镶嵌模型解释了什么？", tag: "细胞结构" },
      { number: "02", question: "线粒体如何参与 ATP 合成？", tag: "能量代谢" },
      { number: "03", question: "转录和翻译发生在哪里？", tag: "基因表达" }
    ]
  },
  {
    id: "writing",
    title: "议论文写作",
    category: "表达",
    color: "#b87955",
    count: 4,
    difficulty: "进阶",
    summary: "练习从立意、论证到段落节奏，让观点变得清晰且有说服力。",
    questions: [
      { number: "01", question: "中心论点如何避免变成口号？", tag: "立意" },
      { number: "02", question: "事实论据和道理论据怎样互相支撑？", tag: "论证" },
      { number: "03", question: "如何处理反方观点？", tag: "结构" }
    ]
  },
  {
    id: "algebra",
    title: "代数结构",
    category: "数学",
    color: "#8f7d9a",
    count: 9,
    difficulty: "挑战",
    summary: "用结构化视角整理方程、函数与不等式，减少重复试错。",
    questions: [
      { number: "01", question: "函数单调性与导数符号有什么关系？", tag: "函数" },
      { number: "02", question: "参数范围题的关键边界在哪里？", tag: "不等式" },
      { number: "03", question: "如何判断一个变换是否保持结构？", tag: "映射" }
    ]
  }
];

const BRANCHES = [
  { start: [0, 1.2, 0], end: [-3.3, 3.1, .15], width: .23 },
  { start: [0, .65, .02], end: [3.45, 2.9, -.35], width: .21 },
  { start: [.08, -.05, .04], end: [-2.9, .52, -.42], width: .24 },
  { start: [.1, -.8, .05], end: [3.15, -.05, .42], width: .2 },
  { start: [.04, 1.8, 0], end: [1.3, 4.35, .18], width: .16 },
  { start: [-.1, 1.5, .03], end: [-1.2, 4.48, -.2], width: .16 },
  { start: [-.05, 1.95, .02], end: [-2.25, 3.8, .38], width: .13 },
  { start: [.02, 2.1, -.02], end: [2.35, 3.75, -.35], width: .13 },
  { start: [-.06, 1.12, .02], end: [-1.55, 2.35, .62], width: .11 },
  { start: [.08, 1.32, -.02], end: [1.75, 2.25, -.62], width: .11 }
];

const PACK_POSITIONS = [
  [-2.62, 2.72, 1.05], [2.72, 2.52, 1.08], [-2.32, 1.32, .92],
  [2.34, 1.18, 1.02], [1.05, 3.72, 1.08], [-1.12, 3.78, 1.02]
];

const DETAIL_TAG_POSITIONS = [
  [-3.05, 2.34, 1.16], [-2.05, 2.1, 1.22], [-1.72, 3.22, 1.24],
  [-.42, 2.74, 1.28], [.3, 3.06, 1.26], [1.76, 2.72, 1.2],
  [2.72, 1.82, 1.22], [1.4, 1.62, 1.25], [.65, 4.0, 1.2],
  [-.4, 4.2, 1.18], [-1.9, 3.88, 1.2], [-2.9, 1.55, 1.16]
];
const EXTRA_TAG_POSITIONS = DETAIL_TAG_POSITIONS.slice(0, 12);

const CANOPY_CLUSTERS = [
  { point: [-2.25, 3.08, .18], scale: 1.16, color: "#173d24" },
  { point: [-.78, 3.65, -.28], scale: 1.2, color: "#1e512b" },
  { point: [.72, 3.62, .18], scale: 1.2, color: "#2a6331" },
  { point: [2.12, 3.12, -.18], scale: 1.08, color: "#173d24" },
  { point: [-2.55, 2.02, -.22], scale: 1.12, color: "#2a6331" },
  { point: [-.88, 2.28, .35], scale: 1.25, color: "#36743a" },
  { point: [.86, 2.18, -.25], scale: 1.18, color: "#1e512b" },
  { point: [2.52, 2.08, .18], scale: 1.05, color: "#2a6331" },
  { point: [-.04, 4.18, -.08], scale: 1.02, color: "#173d24" },
  { point: [1.65, 4.0, .1], scale: .82, color: "#36743a" },
  { point: [-1.55, 4.1, -.1], scale: .82, color: "#2a6331" }
];

Page({
  data: {
    selectedPack: null,
    statusText: "18 个题包 · 72 道题目"
  },

  onLoad() {
    this.yaw = -0.34;
    this.zoom = 1;
    this.canvas = null;
    this.ctx = null;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.lastTouches = [];
    this.lastPinchDistance = 0;
    this.dragMoved = false;
    this.hitBoxes = [];
    this.initCanvas();
  },

  onShareAppMessage() {
    return {
      title: "来看看我的题林：把零散题目长成一棵树。",
      path: "/pages/question-tree/question-tree"
    };
  },

  initCanvas() {
    wx.createSelectorQuery()
      .select("#questionTreeCanvas")
      .fields({ node: true, size: true })
      .exec((result) => {
        const target = result && result[0];
        if (!target || !target.node) return;
        const { node, width, height } = target;
        const pixelRatio = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio;
        this.canvas = node;
        this.ctx = node.getContext("2d");
        this.canvasWidth = width;
        this.canvasHeight = height;
        node.width = Math.round(width * pixelRatio);
        node.height = Math.round(height * pixelRatio);
        this.ctx.scale(pixelRatio, pixelRatio);
        this.drawScene();
      });
  },

  project(point) {
    const [x, y, z] = point;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const rotatedX = x * cos - z * sin;
    const rotatedZ = x * sin + z * cos;
    const depth = 1 + (rotatedZ + 7) * .035;
    const scale = 34 * this.zoom / Math.max(depth, .68);
    return {
      x: this.canvasWidth / 2 + rotatedX * scale,
      y: this.canvasHeight * .56 - y * scale + rotatedZ * 2.5,
      scale,
      depth: rotatedZ
    };
  },

  drawScene() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f4f2ec";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.fillStyle = "#e4e5d8";
    ctx.beginPath();
    ctx.ellipse(width / 2, height * .78, Math.min(width * .58, 280), 88, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const drawBranch = (start, end, branchWidth) => {
      const a = this.project(start);
      const b = this.project(end);
      const control = {
        x: (a.x + b.x) / 2 + (b.y - a.y) * .08,
        y: (a.y + b.y) / 2 - Math.abs(b.x - a.x) * .06
      };
      ctx.save();
      ctx.strokeStyle = "#68452f";
      ctx.lineCap = "round";
      ctx.lineWidth = branchWidth * this.zoom * 28;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(control.x, control.y, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };

    drawBranch([0, -2.2, 0], [.1, 2.5, 0], .5);
    BRANCHES.forEach((branch) => drawBranch(branch.start, branch.end, branch.width));

    const drawCanopyCluster = (cluster) => {
      const projected = this.project(cluster.point);
      const radius = 36 * cluster.scale * this.zoom;
      ctx.save();
      for (let index = 0; index < 7; index += 1) {
        const angle = index * 1.72;
        const shade = index % 3 === 0 ? cluster.color : index % 3 === 1 ? "#24592d" : "#2e6b35";
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.ellipse(
          projected.x + Math.cos(angle) * radius * .52,
          projected.y + Math.sin(angle * 1.2) * radius * .28,
          radius * (.58 + (index % 2) * .08),
          radius * (.42 + (index % 3) * .04),
          angle * .16,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      ctx.restore();
    };

    CANOPY_CLUSTERS.forEach(drawCanopyCluster);

    this.hitBoxes = [];
    PACKS.forEach((pack, index) => {
      const position = PACK_POSITIONS[index];
      const projected = this.project(position);
      const cardWidth = 28 * this.zoom / Math.max(projected.depth * .02 + 1.1, .85);
      const cardHeight = 48 * this.zoom / Math.max(projected.depth * .02 + 1.1, .85);
      this.hitBoxes.push({
        pack,
        left: projected.x - cardWidth / 2,
        right: projected.x + cardWidth / 2,
        top: projected.y - cardHeight / 2,
        bottom: projected.y + cardHeight / 2
      });
      this.drawPackTag(pack, projected, cardWidth, cardHeight, index);
    });
    EXTRA_TAG_POSITIONS.forEach((position, index) => {
      const pack = PACKS[index % PACKS.length];
      const projected = this.project(position);
      const cardWidth = 28 * this.zoom / Math.max(projected.depth * .02 + 1.1, .85);
      const cardHeight = 48 * this.zoom / Math.max(projected.depth * .02 + 1.1, .85);
      this.hitBoxes.push({
        pack,
        left: projected.x - cardWidth / 2,
        right: projected.x + cardWidth / 2,
        top: projected.y - cardHeight / 2,
        bottom: projected.y + cardHeight / 2
      });
      this.drawPackTag(pack, projected, cardWidth, cardHeight, index + PACKS.length);
    });
    if (this.zoom > 1.08) {
      DETAIL_TAG_POSITIONS.forEach((position, index) => {
        const pack = PACKS[index % PACKS.length];
        const projected = this.project(position);
        const reveal = Math.min(1, (this.zoom - 1.08) / .22);
        const cardWidth = 21 * reveal * this.zoom / Math.max(projected.depth * .02 + 1.1, .85);
        const cardHeight = 36 * reveal * this.zoom / Math.max(projected.depth * .02 + 1.1, .85);
        this.hitBoxes.push({
          pack,
          left: projected.x - cardWidth / 2,
          right: projected.x + cardWidth / 2,
          top: projected.y - cardHeight / 2,
          bottom: projected.y + cardHeight / 2
        });
        this.drawPackTag(pack, projected, cardWidth, cardHeight, index + PACKS.length, true);
      });
    }
  },

  drawPackTag(pack, projected, cardWidth, cardHeight, index, isDetail = false) {
    const ctx = this.ctx;
    const width = cardWidth;
    const height = cardHeight;
    const left = projected.x - width / 2;
    const top = projected.y - height / 2;
    ctx.save();
    ctx.strokeStyle = "#473b2e";
    ctx.lineWidth = Math.max(1, this.zoom);
    ctx.beginPath();
    ctx.moveTo(projected.x, top - (isDetail ? 10 : 14) * this.zoom);
    ctx.lineTo(projected.x, top);
    ctx.stroke();
    ctx.fillStyle = index % 3 === 1 ? "#fffdf5" : "#f0524b";
    ctx.shadowColor = "rgba(31, 36, 26, .2)";
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
    ctx.fillRect(left, top, width, height);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = index % 3 === 1 ? "#9b4d3b" : "#fffdf5";
    ctx.font = `700 ${isDetail ? 6 : 8}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(pack.title.slice(0, 2), projected.x, top + height * .58);
    ctx.textAlign = "start";
    ctx.restore();
  },

  handleTouchStart(event) {
    this.lastTouches = event.touches || [];
    this.dragMoved = false;
    if (this.lastTouches.length === 2) {
      this.lastPinchDistance = this.distance(this.lastTouches[0], this.lastTouches[1]);
    }
  },

  handleTouchMove(event) {
    const touches = event.touches || [];
    if (touches.length === 1 && this.lastTouches.length === 1) {
      const deltaX = touches[0].x - this.lastTouches[0].x;
      if (Math.abs(deltaX) > 1) {
        this.yaw += deltaX * .009;
        this.dragMoved = true;
        this.drawScene();
        this.updateZoomStatus();
      }
    } else if (touches.length === 2) {
      const distance = this.distance(touches[0], touches[1]);
      if (this.lastPinchDistance > 0) {
        this.zoom = Math.max(.74, Math.min(1.42, this.zoom * distance / this.lastPinchDistance));
        this.drawScene();
        this.updateZoomStatus();
      }
      this.lastPinchDistance = distance;
    }
    this.lastTouches = touches;
  },

  handleTouchEnd(event) {
    const changed = event.changedTouches && event.changedTouches[0];
    if (changed && !this.dragMoved && this.lastTouches.length <= 1) {
      const hit = this.hitBoxes.find((box) => (
        changed.x >= box.left && changed.x <= box.right &&
        changed.y >= box.top && changed.y <= box.bottom
      ));
      if (hit) this.openPackDetail(hit.pack);
    }
    this.lastTouches = [];
    this.lastPinchDistance = 0;
  },

  handleTouchCancel() {
    this.lastTouches = [];
    this.lastPinchDistance = 0;
  },

  distance(first, second) {
    const dx = first.x - second.x;
    const dy = first.y - second.y;
    return Math.sqrt(dx * dx + dy * dy);
  },

  openPackDetail(pack) {
    this.setData({
      selectedPack: pack,
      statusText: `${pack.count} 道题目 · ${pack.category}`
    });
  },

  closePack() {
    this.setData({
      selectedPack: null
    });
    this.updateZoomStatus();
  },

  openPack() {
    const title = this.data.selectedPack && this.data.selectedPack.title;
    if (title) wx.showToast({ title: `已准备打开「${title}」`, icon: "none" });
  },

  resetView() {
    this.yaw = -.34;
    this.zoom = 1;
    this.drawScene();
    this.updateZoomStatus();
  },

  updateZoomStatus() {
    if (this.data.selectedPack) return;
    const detailCount = this.zoom > 1.08 ? Math.round(Math.min(1, (this.zoom - 1.08) / .22) * DETAIL_TAG_POSITIONS.length) : 0;
    const packCount = PACKS.length + EXTRA_TAG_POSITIONS.length + detailCount;
    this.setData({ statusText: `${packCount} 个题包 · ${packCount * 4} 道题目` });
  },

  showAllPacks() {
    this.closePack();
    wx.showToast({ title: "题包节点已全部展开", icon: "none" });
  },

  showAbout() {
    wx.showToast({ title: "单指旋转 · 双指缩放 · 点击题包", icon: "none" });
  }
});
