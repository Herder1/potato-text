/**
 * 消息中心（产品负责人 2026-09-23 04:9x：「做一个消息中心页面，效果图是图2，入口在绿框图3」）
 * 效果图＝ tmp/verify-out/ref-04-Ax-messages.png：按天分组（居中小灰字）＋ 每张白卡＝标题 / 正文 /
 * 右下角「#类型」标签与「点击查看>>」，未读在卡片左侧留白处点一颗橙点（#fe6900）。
 * 数据与已读规则见 utils/message-center.js（公告 + 当前账号的反馈通知）。
 */
const { loadMessages, buildMessageGroups, flattenGroups, markMessageRead, syncUnreadBadge, messageSession } = require("../../utils/message-center");

Page({
  data: {
    groups: [],
    total: 0,
    unread: 0,
    expandedId: "",
    loading: true,
    loadError: "",
  },

  onLoad() {
    this.messages = [];
  },

  onShow() {
    return this.refresh();
  },

  onPullDownRefresh() {
    return this.refresh().then(() => {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    });
  },

  refresh() {
    const requestId = this.requestId = (this.requestId || 0) + 1;
    if (this.session !== messageSession()) {
      this.messages = [];
      this.session = messageSession();
      this.setData({ groups: [], total: 0, unread: 0, expandedId: "" });
    }
    this.setData({ loading: true });
    return loadMessages().then((result) => {
      if (requestId !== this.requestId || result.stale || this.session !== messageSession()) return;
      this.setData({ loadError: result.error || "" });
      this.messages = result.messages;
      this.present();
    });
  },

  /** 把原始消息列表 → 分组 + 未读标记 + 展开标记；顺手把未读数写回我的页铃铛用的键 */
  present() {
    const expandedId = this.data.expandedId;
    const groups = buildMessageGroups(this.messages, Date.now()).map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, expanded: item.id === expandedId })),
    }));
    const items = flattenGroups(groups);
    this.setData({
      groups,
      total: items.length,
      unread: items.filter((item) => item.unread).length,
      loading: false,
    });
    if (!this.data.loadError) syncUnreadBadge(this.messages);
    return groups;
  },

  /** 点卡片＝展开/收起全文；展开即视为已读（效果图里那颗橙点就是未读） */
  toggleMessage(event) {
    if (this.session !== messageSession()) { this.refresh(); return; }
    const id = String((event.currentTarget.dataset || {}).messageId || "");
    if (!id) return;
    const expandedId = this.data.expandedId === id ? "" : id;
    if (expandedId) markMessageRead(id);
    this.setData({ expandedId }, () => this.present());
  },

  openFeedback(event) {
    if (this.session !== messageSession()) { this.refresh(); return; }
    const id = String(event.currentTarget.dataset.messageId || "");
    const message = this.messages.find((item) => item.id === id);
    if (!message || !message.feedbackId) return;
    markMessageRead(id);
    this.present();
    wx.navigateTo({ url: `/pages/help-feedback/help-feedback?tab=history&feedbackId=${encodeURIComponent(message.feedbackId)}` });
  },
});
