// 一次性数据迁移（2026-10-11 产品负责人确认「豆币充值合并成一个套餐组」）：
// 把散落的每条豆币充值商品收进唯一的「豆币充值」组（packageKey = bean-recharge）并统一组名。
//
// 默认**干跑**：只打印迁移前后对照，不写盘。
// 确认后加 --write 才落盘；落盘前先在原文件旁写一份 `<文件>.bak-<时间戳>` 备份。
//
// 用法：
//   node scripts/migrate-bean-recharge-group.js                          # 干跑 .runtime/billing.json
//   node scripts/migrate-bean-recharge-group.js --write                  # 真的迁移（先备份）
//   node scripts/migrate-bean-recharge-group.js --file <路径> --write
//   node scripts/migrate-bean-recharge-group.js --name 豆币充值包 --write  # 组名不用默认值
//
// 说明：走 store 自己的写路径（tmp + rename、0600），不另写一套序列化逻辑；组内每条规格的
// id、价格、豆币数量与上架状态一律不变（合并的是后台分组，不是把 5 个档位并成一个商品）。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  BEAN_RECHARGE_PACKAGE_KEY,
  BEAN_RECHARGE_PACKAGE_NAME,
  createFileBillingStore,
} = require("../apps/api/src/billing-store");

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const fileIndex = argv.indexOf("--file");
const nameIndex = argv.indexOf("--name");
const filePath = path.resolve(fileIndex >= 0 && argv[fileIndex + 1]
  ? argv[fileIndex + 1]
  : path.resolve(__dirname, "../.runtime/billing.json"));
const groupName = nameIndex >= 0 && argv[nameIndex + 1] ? String(argv[nameIndex + 1]).trim() : BEAN_RECHARGE_PACKAGE_NAME;

if (!fs.existsSync(filePath)) {
  console.log(`没有可迁移的文件：${filePath}（无需迁移）`);
  process.exit(0);
}

const raw = fs.readFileSync(filePath, "utf8");
const beforeHash = crypto.createHash("sha256").update(raw).digest("hex");
const isBean = (product) => product.productType === "bean_pack" || product.productType === "ai_credit_pack";
const beans = (state) => (state.products || []).filter(isBean);

console.log(`文件：${filePath}`);
console.log(`模式：${writeMode ? "写入（先备份）" : "干跑（不写盘）"}`);
console.log(`目标组：${BEAN_RECHARGE_PACKAGE_KEY} · ${groupName}`);
console.log("\n迁移对照（id / 规格名：原 packageKey · 原 packageName → 新 packageKey · 新 packageName）：");
const beforeState = JSON.parse(raw);
const beforeBeans = beans(beforeState);
if (!beforeBeans.length) {
  console.log("  没有豆币充值商品，无需迁移。");
  process.exit(0);
}
beforeBeans.forEach((product) => {
  console.log(`  ${product.id} / ${product.name}：${product.packageKey} · ${product.packageName} → ${BEAN_RECHARGE_PACKAGE_KEY} · ${groupName}`);
});
console.log(`  合计 ${beforeBeans.length} 条 → 1 个套餐组；价格与豆币数量不变：`
  + beforeBeans.map((product) => `${product.name}=${(product.priceCents / 100).toFixed(2)} 元/${product.beanAmount} 豆币`).join("，"));

if (!writeMode) {
  console.log("\n未写盘。确认无误后加 --write 重跑。");
  process.exit(0);
}

const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(filePath, backupPath);
const store = createFileBillingStore(filePath);
const updated = store.updatePackageGroup(BEAN_RECHARGE_PACKAGE_KEY, {
  packageName: groupName,
  productType: "bean_pack",
});
const afterHash = crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf8")).digest("hex");
const afterBeans = store.listProducts().filter(isBean);
console.log(`\n已迁移：${beforeHash.slice(0, 12)}… → ${afterHash.slice(0, 12)}…`);
console.log(`备份：${backupPath}`);
console.log(`组内规格 ${updated.length} 条，落盘后全组 packageName：${[...new Set(afterBeans.map((item) => item.packageName))].join(" / ")}`);
console.log(`全组 packageKey：${[...new Set(afterBeans.map((item) => item.packageKey))].join(" / ")}`);
console.log(`价格与豆币数量（应与迁移前一致）：${afterBeans.map((item) => `${item.name}=${(item.priceCents / 100).toFixed(2)} 元/${item.beanAmount} 豆币`).join("，")}`);
console.log("提示：`apps/api/src/**` 已改动，需按 AGENTS §8 由你在自己的终端重启 3212 进程（Agent 不代跑）。");
