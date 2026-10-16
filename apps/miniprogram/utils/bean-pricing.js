// 豆币计价与展示的唯一维护处（小程序端）。
// 口径依据 DEC-107（产品手册 §0.4，2026-10-02）：
//   1 豆币 = 10 AI 额度；历史 1 点 AI 额度 = 0.1 豆币；「价目不调整」＝保价换算，
//   所以原来每次 1 点额度的 AI 调用，现在扣 0.1 豆币（用户价值不变）。
// 服务端对应常量：apps/api/src/billing-store.js 的 BEANS_PER_CREDIT / roundBeans。

const BEANS_PER_CREDIT = 0.1;
const BEAN_COST_PER_AI_CALL = 0.1;
const BEAN_STORAGE_KEY = "shukao_beans";
const LEGACY_CREDIT_STORAGE_KEY = "shukao_ai_credits";

function roundBeans(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function isBeanAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return Math.abs(Math.round(amount * 10) - amount * 10) < 1e-6;
}

// 展示：最多一位小数，整数不带 ".0"（2 → "2"，0.1 → "0.1"，60.6 → "60.6"）。
function formatBeans(value) {
  const amount = roundBeans(value);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
}

// 旧本地缓存（AI 额度）一次性折算；返回是否发生了折算，调用方负责写回并清掉旧键。
function migrateLegacyStoredBeans(storedCredits) {
  if (storedCredits === "" || storedCredits === null || storedCredits === undefined) return null;
  const credits = Number(storedCredits);
  if (!Number.isFinite(credits)) return null;
  return roundBeans(credits * BEANS_PER_CREDIT);
}

module.exports = {
  BEANS_PER_CREDIT,
  BEAN_COST_PER_AI_CALL,
  BEAN_STORAGE_KEY,
  LEGACY_CREDIT_STORAGE_KEY,
  formatBeans,
  isBeanAmount,
  migrateLegacyStoredBeans,
  roundBeans,
};
