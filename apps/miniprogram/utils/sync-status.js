/**
 * 同步状态标记（2026-10-03，产品负责人 9 条口径第 4 条：**服务端不可达时保留本地快照并标记为待同步，
 * 不得伪装成已同步**）。
 *
 * 定位：这是**设备级**的同步簿记，不属于任何账号的数据（所以不进账号命名空间、也不随退出登录清掉）；
 * 只回答一个问题——"本机这几条链路现在有没有没送上去的东西"。
 * 三个通道分开记：学习状态（learning-state）、个人资产（personal-cloud）、卡集（card-library）。
 * 任一通道处于 pending，界面就不得显示"已同步"。
 */
const STORAGE_KEY = "shukao_sync_status_v1";
const CHANNELS = ["learning", "assets", "cards"];
const CHANNEL_LABELS = { learning: "学习记录", assets: "个人资产", cards: "卡集" };

function createSyncStatus({ storage, now = Date.now }) {
  function read() {
    const raw = storage && typeof storage.getStorageSync === "function" ? storage.getStorageSync(STORAGE_KEY) : null;
    const value = raw && typeof raw === "object" ? raw : {};
    return { ...value };
  }
  function write(value) {
    if (storage && typeof storage.setStorageSync === "function") storage.setStorageSync(STORAGE_KEY, value);
    return value;
  }
  /** 标记某通道有待同步内容：reason 只用于诊断展示，不代表已送达。 */
  function markPending(channel, reason = "") {
    if (!CHANNELS.includes(channel)) return read();
    const value = read();
    value[channel] = { pending: true, reason: String(reason || ""), at: now() };
    return write(value);
  }
  /** 标记某通道已同步成功——只有真的收到服务端成功响应时才调用。 */
  function markSynced(channel) {
    if (!CHANNELS.includes(channel)) return read();
    const value = read();
    delete value[channel];
    return write(value);
  }
  function summary() {
    const value = read();
    const pendingChannels = CHANNELS.filter((channel) => value[channel] && value[channel].pending);
    return {
      pending: pendingChannels.length > 0,
      pendingChannels,
      labels: pendingChannels.map((channel) => CHANNEL_LABELS[channel]),
      reason: pendingChannels.length ? String(value[pendingChannels[0]].reason || "") : "",
      // 界面只认这个：有 pending 就不许说"已同步"
      label: pendingChannels.length ? `${pendingChannels.map((channel) => CHANNEL_LABELS[channel]).join("、")}待同步` : "已同步",
    };
  }
  return { markPending, markSynced, summary, storageKey: STORAGE_KEY };
}

/** 小程序运行时用 wx 作为存储；测试可传自己的桩。 */
function syncStatus(storage) {
  const target = storage || (typeof wx === "undefined" ? null : wx);
  return createSyncStatus({ storage: target });
}

module.exports = { createSyncStatus, syncStatus, CHANNELS, CHANNEL_LABELS, SYNC_STATUS_STORAGE_KEY: STORAGE_KEY };
