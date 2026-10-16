// 一次性数据迁移（DEC-107，2026-10-02）：把历史「AI 额度」按 1 点 = 0.1 豆币折算成豆币。
//
// 默认**干跑**：只打印折算前后对照，不写盘。
// 确认后加 --write 才落盘；落盘前先在原文件旁写一份 `<文件>.bak-<时间戳>` 备份。
//
// 用法：
//   node scripts/migrate-billing-beans.js                     # 干跑 .runtime/billing.json
//   node scripts/migrate-billing-beans.js --write             # 真的迁移（先备份）
//   node scripts/migrate-billing-beans.js --file <路径> --write
//
// 说明：运行中的服务**不需要**这个脚本也能正确显示豆币——`billing-store.js` 在读取时
// 按字段形状做同样的幂等折算；本脚本只是把折算结果**落到磁盘**（运维显式动作，AGENTS §4）。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  BEANS_PER_CREDIT,
  createFileBillingStore,
  migrateLegacyState,
  formatBeans,
} = require("../apps/api/src/billing-store");

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const fileIndex = argv.indexOf("--file");
const filePath = path.resolve(fileIndex >= 0 && argv[fileIndex + 1]
  ? argv[fileIndex + 1]
  : path.resolve(__dirname, "../.runtime/billing.json"));

if (!fs.existsSync(filePath)) {
  console.log(`没有可迁移的文件：${filePath}（无需迁移）`);
  process.exit(0);
}

const raw = fs.readFileSync(filePath, "utf8");
const beforeHash = crypto.createHash("sha256").update(raw).digest("hex");
const legacy = JSON.parse(raw);
const { changed } = migrateLegacyState(JSON.parse(raw));

const legacyLots = (account) => (account.creditLots || []).reduce((total, lot) => total + Number(lot.remainingAmount || 0), 0);
const beanLots = (account) => (account.beanLots || []).reduce((total, lot) => total + Number(lot.remainingAmount || 0), 0);

console.log(`文件：${filePath}`);
console.log(`模式：${writeMode ? "写入（先备份）" : "干跑（不写盘）"}`);
if (!changed) {
  console.log("结论：已经是豆币口径（无 creditLots / bonusAiCredits / ai_credit_pack），无需迁移。");
  (legacy.accounts || []).forEach((account) => {
    console.log(`  ${account.userId}：${formatBeans(beanLots(account))} 豆币（${(account.beanLots || []).length} 个批次）`);
  });
  process.exit(0);
}

console.log("折算对照（1 点 AI 额度 = 0.1 豆币）：");
(legacy.accounts || []).forEach((account) => {
  const legacyTotal = legacyLots(account);
  console.log(`  ${account.userId}：${legacyTotal} 点额度 → ${formatBeans(legacyTotal * BEANS_PER_CREDIT)} 豆币`);
});
(legacy.products || []).forEach((product) => {
  const bonus = Number(product.bonusAiCredits || 0);
  const amount = Number(product.creditAmount || 0);
  if (product.productType === "bean_pack" || product.productType === "ai_credit_pack") {
    console.log(`  商品 ${product.id}：充值 ${amount} 点额度 → ${formatBeans(amount * BEANS_PER_CREDIT)} 豆币（价格不变）`);
  } else if (bonus) {
    console.log(`  商品 ${product.id}：赠送 ${bonus} 点额度 → ${formatBeans(bonus * BEANS_PER_CREDIT)} 豆币`);
  }
});

if (!writeMode) {
  console.log("\n未写盘。确认无误后加 --write 重跑。");
  process.exit(0);
}

const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(filePath, backupPath);
// 走 store 自己的写路径（tmp + rename，0600），不另写一套序列化逻辑。
const store = createFileBillingStore(filePath);
store.normalizeUnits();
const afterHash = crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf8")).digest("hex");
console.log(`\n已迁移：${beforeHash.slice(0, 12)}… → ${afterHash.slice(0, 12)}…`);
console.log(`备份：${backupPath}`);
console.log("提示：正在运行的 API 进程需按 AGENTS §8 由你在自己的终端重启后生效。");
