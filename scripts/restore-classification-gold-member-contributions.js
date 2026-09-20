// 一次性维护脚本：补齐修订草稿中丢失的逐成员贡献知识
//
// 背景：2026-09-16 之前，`revisionItemFromFrozenSnapshot` 在派生修订草稿时用“当前正式
// 题族事实”整体替换了冻结快照里的题族副本。正式题族库不保存“本题在该题族中的逐成员
// 贡献知识”，导致人工在父版本金标里确认过的贡献被清空。代码已修复，但修复前生成的
// 草稿不会自动恢复，本脚本用同一个 `inheritFrozenMembership` 把父快照里的人工事实补回。
//
// 只恢复贡献知识，不改题族定义、状态、审核结论或题目版本；已冻结批次拒绝执行。
//
// 用法：
//   node scripts/restore-classification-gold-member-contributions.js            # 预演
//   node scripts/restore-classification-gold-member-contributions.js --apply    # 写入（先自动备份）
//   node scripts/restore-classification-gold-member-contributions.js --batch <批次ID> [--apply]
const fs = require("node:fs");
const path = require("node:path");

const {
  inheritFrozenMembership,
  readFrozenGoldSnapshot,
  validateGoldReviewBatchFamilySemantics,
} = require("../apps/api/src/classification-gold-review-store");

const root = path.resolve(__dirname, "..");
const statePath = path.join(root, ".runtime", "classification-gold-reviews.json");
const backupDir = path.join(root, ".runtime", "maintenance-backups");

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const batchIdArg = (() => {
  const index = argv.indexOf("--batch");
  return index >= 0 ? String(argv[index + 1] || "") : "";
})();

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const batches = Array.isArray(state.batches) ? state.batches : [];
const batch = batchIdArg
  ? batches.find((entry) => entry.id === batchIdArg)
  : batches.find((entry) => entry.status !== "frozen");
if (!batch) {
  console.error(batchIdArg ? `找不到批次 ${batchIdArg}` : "找不到处于审核中的批次");
  process.exit(1);
}
if (batch.status === "frozen") {
  console.error(`批次 ${batch.id} 已冻结，拒绝就地修改`);
  process.exit(1);
}

const parentBatchId = String(batch.source?.parentReviewBatchId || "");
const parent = batches.find((entry) => entry.id === parentBatchId);
if (!parent || !parent.snapshot?.filePath) {
  console.error(`批次 ${batch.id} 的父版本 ${parentBatchId || "(缺失)"} 没有冻结快照`);
  process.exit(1);
}
const loaded = readFrozenGoldSnapshot(parent.snapshot.filePath, { requireSidecar: true });
if (loaded.fileSha256 !== parent.snapshot.fileSha256
  || loaded.contentSha256 !== parent.snapshot.contentSha256
  || loaded.snapshot.snapshotId !== parent.snapshot.snapshotId) {
  console.error("父快照哈希与批次记录不一致，拒绝继续");
  process.exit(1);
}

const frozenByQuestionId = new Map((loaded.snapshot.items || [])
  .map((item) => [String(item.questionId || ""), item]));
const contributionIds = (membership = {}) => [...new Set([
  ...(Array.isArray(membership.contributionKnowledgeNodeIds) ? membership.contributionKnowledgeNodeIds : []),
  ...(Array.isArray(membership.contributionKnowledge)
    ? membership.contributionKnowledge.map((node) => node?.id || node?.nodeId) : []),
].filter(Boolean))];
// 草稿里本题已有的贡献知识：membership 与 members 行任一处非空都视为人工已经填过。
const draftContributionIds = (family = {}, questionId = "") => {
  const membership = family.membership
    && (!family.membership.questionId || family.membership.questionId === questionId)
    ? family.membership : null;
  const member = (family.members || []).find((entry) => String(entry.questionId || "") === String(questionId));
  return [...new Set([...contributionIds(membership || {}), ...contributionIds(member || {})])];
};

console.log(`批次      : ${batch.id}（${batch.version}，${batch.status}）`);
console.log(`父快照    : ${parent.id}（${loaded.snapshot.version}）`);
console.log(`父文件SHA256: ${loaded.fileSha256}`);
console.log(`模式      : ${apply ? "写入" : "预演（不写入）"}`);
console.log("-".repeat(96));

const repaired = [];
let skippedBecauseDraftHasValues = 0;
for (const item of batch.items || []) {
  const frozenItem = frozenByQuestionId.get(String(item.questionId || ""));
  if (!frozenItem) continue;
  const draftFamilies = item.humanGold?.familyGold?.families;
  if (!Array.isArray(draftFamilies)) continue;
  const frozenFamilies = new Map((frozenItem.familyGold?.families || [])
    .map((family) => [String(family.id || ""), family]));
  let changed = false;
  const nextFamilies = draftFamilies.map((family) => {
    const frozenFamily = frozenFamilies.get(String(family.id || ""));
    if (!frozenFamily) return family;
    // 只补空值：草稿里已经有人工填写的贡献知识时绝不覆盖，避免用旧快照回退新修改。
    if (draftContributionIds(family, item.questionId).length) {
      skippedBecauseDraftHasValues += 1;
      return family;
    }
    const inherited = inheritFrozenMembership(family, frozenFamily, item.questionId);
    const restored = contributionIds(inherited.membership || {});
    if (!restored.length) return family;
    changed = true;
    repaired.push({
      order: item.order,
      questionId: item.questionId,
      familyName: inherited.name || family.name,
      restored,
    });
    return inherited;
  });
  if (changed) item.humanGold.familyGold = { ...item.humanGold.familyGold, families: nextFamilies };
}

if (!repaired.length) {
  console.log("没有需要补齐的逐成员贡献知识。");
  console.log(`（另有 ${skippedBecauseDraftHasValues} 处题族关系在草稿中已有人工值，未改动）`);
  process.exit(0);
}
for (const entry of repaired) {
  console.log(`#${String(entry.order).padStart(2)} ${entry.questionId}`);
  console.log(`    题族「${entry.familyName}」补回 ${entry.restored.length} 个贡献节点：${entry.restored.join(", ")}`);
}
const repairedQuestions = [...new Set(repaired.map((entry) => entry.order))];
console.log("-".repeat(96));
console.log(`共 ${repairedQuestions.length} 题被补齐：#${repairedQuestions.join(", #")}`);
console.log(`另有 ${skippedBecauseDraftHasValues} 处题族关系在草稿中已有人工值，未改动`);

const afterValidation = validateGoldReviewBatchFamilySemantics(batch);
const blockedQuestions = [...new Set(afterValidation.issues
  .filter((issue) => issue.questionId).map((issue) => issue.questionId))];
console.log(`补齐后该批次门禁阻断 ${blockedQuestions.length} 题`);
for (const questionId of blockedQuestions) {
  const item = (batch.items || []).find((entry) => entry.questionId === questionId);
  const codes = [...new Set(afterValidation.issues
    .filter((issue) => issue.questionId === questionId).map((issue) => issue.code))];
  console.log(`    #${String(item?.order).padStart(2)} ${questionId}: ${codes.join(", ")}`);
}
if (afterValidation.issues.some((issue) => !issue.questionId)) {
  console.log("    另有批次级问题：" + [...new Set(afterValidation.issues
    .filter((issue) => !issue.questionId).map((issue) => issue.code))].join(", "));
}

if (!apply) {
  console.log("\n预演结束，未写入。确认无误后加 --apply 执行。");
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `classification-gold-reviews-${stamp}.json`);
fs.copyFileSync(statePath, backupPath);
const temporaryPath = `${statePath}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, statePath);
console.log(`\n已写入。备份：${backupPath}`);
