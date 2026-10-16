const { APP_VERSION } = require("../../utils/app-meta");

// 2026-10-02：「设备信息」页。展示的是**本机真实可读**的信息（不编造）：
// 品牌 / 型号 / 系统 / 微信版本 / 基础库 / 运行环境。
// 「登录设备列表」需要服务端支持，目前未接入，页面里如实说明（不假装有数据）。
function readDeviceInfo() {
  const wxApi = typeof wx !== "undefined" ? wx : {};
  const pick = (source, key) => String((source && source[key]) || "").trim();
  let base = {};
  try {
    if (typeof wxApi.getDeviceInfo === "function") base = { ...base, ...wxApi.getDeviceInfo() };
  } catch (error) { base = base || {}; }
  try {
    if (typeof wxApi.getAppBaseInfo === "function") base = { ...base, ...wxApi.getAppBaseInfo() };
  } catch (error) { base = base || {}; }
  try {
    if (typeof wxApi.getSystemInfoSync === "function") base = { ...base, ...wxApi.getSystemInfoSync() };
  } catch (error) { base = base || {}; }
  const envVersion = pick(base, "envVersion") || "release";
  const envLabel = envVersion === "develop" ? "开发版" : envVersion === "trial" ? "体验版" : "正式版";
  return [
    { key: "brand", label: "设备品牌", value: pick(base, "brand") || "未知" },
    { key: "model", label: "设备型号", value: pick(base, "model") || "未知" },
    { key: "system", label: "操作系统", value: pick(base, "system") || "未知" },
    { key: "platform", label: "运行平台", value: pick(base, "platform") || "未知" },
    { key: "wechat", label: "微信版本", value: pick(base, "version") || "未知" },
    { key: "lib", label: "基础库版本", value: pick(base, "SDKVersion") || "未知" },
    { key: "env", label: "小程序版本", value: envLabel },
  ];
}

Page({
  data: {
    rows: [],
    version: APP_VERSION,
  },

  onShow() {
    this.setData({ rows: readDeviceInfo() });
  },
});
