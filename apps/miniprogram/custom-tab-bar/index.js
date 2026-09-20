// 底部自定义 tab 栏。
// 选中态以「当前路由」为准：各页面 onShow 里那次 setData 只是加速，不能当唯一来源——
// 只要有一次没写到（组件还没就绪、页面被复用、启动页直达），高亮就会停在默认值（复习）上。
const TAB_ROUTES = [
  "pages/library/library",
  "pages/knowledge/knowledge",
  "pages/review/review",
  "pages/home/home",
  "pages/profile/profile",
];

Component({
  data: {
    // 仅兜底首帧渲染，真实选中态由 syncSelectedFromRoute() 从路由算出。
    selected: 2,
  },

  lifetimes: {
    attached() {
      this.syncSelectedFromRoute();
    },
  },

  pageLifetimes: {
    // 宿主页面每次 show 都重算一次：任何页面忘了写 selected 也会自愈。
    show() {
      this.syncSelectedFromRoute();
    },
  },

  methods: {
    syncSelectedFromRoute() {
      let route = "";
      try {
        const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
        const current = pages && pages.length ? pages[pages.length - 1] : null;
        route = String(current && current.route || "");
      } catch (error) {
        route = "";
      }
      const index = TAB_ROUTES.indexOf(route);
      if (index >= 0 && index !== this.data.selected) this.setData({ selected: index });
    },

    switchTab(event) {
      const path = event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.path
        : "";
      if (!path) return;
      // 不再用 selected 做“已经在目标页”的早退：那是渲染态，可能是旧的，
      // 会让“点那个高亮显示错的标签”彻底没反应；切到当前页本身就是无操作。
      wx.switchTab({ url: path });
    },
  },
});
