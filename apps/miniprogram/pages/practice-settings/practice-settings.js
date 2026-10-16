// 2026-10-02：练习设置页（产品负责人指定先占位——题目顺序 / 答题反馈 / 每日目标的口径未定，
// 这里不预设默认值，等产品负责人给规则后再实现）。
Page({
  data: {
    items: [
      { key: "order", title: "题目顺序", note: "顺序出题 / 随机出题 / 错题优先" },
      { key: "feedback", title: "答题反馈", note: "即时判定 / 答完统一判定 / 只记不判" },
      { key: "goal", title: "每日目标", note: "每日题量与提醒时间" },
    ],
  },

  notReady() {
    wx.showToast({ title: "功能开发中", icon: "none" });
  },
});
