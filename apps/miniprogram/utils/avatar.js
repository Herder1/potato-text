// 头像展示的唯一判断口：只认 data URL。
// 2026-09-22 之前的老账号存的是微信外链头像（thirdwx.qlogo.cn），域名早已失效，
// 直接渲染会变成灰色人像占位。凡是要展示账号头像的页面都走这里，统一回落到品牌绿「薯」。
const AVATAR_DATA_URL = /^data:image\/[a-z+]+;base64,/i;

function usableAvatarUrl(value) {
  const url = String(value == null ? "" : value);
  return AVATAR_DATA_URL.test(url) ? url : "";
}

module.exports = { usableAvatarUrl };
