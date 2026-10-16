// 应用元信息单一维护点：名称 / 版本号 / 版权行 / 品牌标语。
// 版本号目前没有构建期来源（仓库里没有 package version 注入），先在这里写死一处，发版只改这一行。
// 运营主体、营业执照与客服信息**不在这里**——它们是有法律效力的文本，由后台「平台设置」的
// `operator` 文档维护，用户端经 utils/platform-content.js 读取（DEC-110，2026-10-05）。
// 这里曾写死"教育科技有限公司"这类假主体，已随本模块删除：不留任何冒充正式主体的占位。
const APP_NAME = "薯考";
const APP_VERSION = "2.4.0";
const BRAND_SLOGAN = "为学习者提供可靠、透明的学习服务";
const COPYRIGHT = "© 2026 薯考";

module.exports = { APP_NAME, APP_VERSION, BRAND_SLOGAN, COPYRIGHT };
