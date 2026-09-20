// 金标 optionKnowledge 回填 · 只读 dry-run
// 目的：把金标审核条目里"人工确认过的" optionKnowledge 回填到题目正式指纹。
// 本脚本默认只读：生成报告到 tmp/backfill-option-knowledge-report.json，不修改任何数据。
// 用法：node scripts/backfill-gold-option-knowledge.js            （dry-run，只出报告）
//       node scripts/backfill-gold-option-knowledge.js --execute  （执行；先自动备份）
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const runtimeDir = path.join(root, ".runtime");
const goldPath = path.join(runtimeDir, "classification-gold-reviews.json");
const structurePath = path.join(runtimeDir, "knowledge-structures.json");
const reportPath = path.join(root, "tmp", "backfill-option-knowledge-report.json");
const execute = process.argv.includes("--execute");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// 1) 收集金标里人工确认过的 optionKnowledge（同一题若出现在多个批次，取最后写入的那份）
const gold = readJson(goldPath);
const goldByQuestion = new Map();
for (const batch of gold.batches || []) {
  for (const item of batch.items || []) {
    const rows = item?.humanGold?.answerKnowledge?.optionKnowledge;
    if (!Array.isArray(rows) || !rows.length) continue;
    const previous = goldByQuestion.get(item.questionId);
    const stamp = Number(item.updatedAt || item.revision || 0);
    if (!previous || stamp >= previous.stamp) {
      goldByQuestion.set(item.questionId, {
        stamp,
        batchId: batch.id,
        batchStatus: batch.status,
        rows,
      });
    }
  }
}

// 2) 读出正式指纹现状
const structure = readJson(structurePath);
const records = structure.records || [];
const fingerprintIndex = [];
records.forEach((record, recordIndex) => {
  (record.fingerprints || []).forEach((fingerprint, entryIndex) => {
    fingerprintIndex.push({ recordIndex, entryIndex, bookId: record.bookId, fingerprint });
  });
});
const byQuestion = new Map(fingerprintIndex.map((entry) => [entry.fingerprint.questionId, entry]));

// 3) 生成逐题 diff
const plan = [];
const summary = { goldQuestions: goldByQuestion.size, matched: 0, missingFingerprint: 0, alreadySame: 0, wouldChange: 0 };
for (const [questionId, entry] of goldByQuestion) {
  const target = byQuestion.get(questionId);
  if (!target) {
    summary.missingFingerprint += 1;
    plan.push({ questionId, status: "no_formal_fingerprint", batchId: entry.batchId, incomingOptions: entry.rows.length });
    continue;
  }
  summary.matched += 1;
  const current = Array.isArray(target.fingerprint.optionKnowledge) ? target.fingerprint.optionKnowledge : [];
  const currentKeys = current.map((row) => `${row.key}:${row.knowledgeRelation}:${(row.knowledgeNodeIds || []).length}`).sort();
  const incomingKeys = entry.rows.map((row) => `${row.key}:${row.knowledgeRelation}:${(row.knowledgeNodeIds || []).length}`).sort();
  const same = currentKeys.length === incomingKeys.length && currentKeys.every((key, index) => key === incomingKeys[index]);
  if (same) {
    summary.alreadySame += 1;
    plan.push({ questionId, status: "already_same", batchId: entry.batchId, count: current.length });
    continue;
  }
  summary.wouldChange += 1;
  plan.push({
    questionId,
    status: current.length ? "overwrite" : "fill",
    bookId: target.bookId,
    batchId: entry.batchId,
    currentCount: current.length,
    incomingCount: entry.rows.length,
    currentKeys,
    incomingKeys,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: execute ? "execute" : "dry-run",
  summary,
  plan,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

// 4) 执行：先备份，再按与 knowledge-structure-store 相同的归一化写入
if (execute) {
  const backupPath = path.join(root, "tmp", `knowledge-structures.backup-${Date.now()}.json`);
  fs.copyFileSync(structurePath, backupPath);
  console.log("已备份原文件 →", path.relative(root, backupPath));

  const RELATIONS = new Set(["question_only", "option_specific", "undetermined", "unreviewed"]);
  const ROLES = new Set(["answer", "distractor", "neutral", "unreviewed"]);
  // 与 normalizeFingerprintOptionKnowledge 保持一致：非 option_specific 清空节点与标签
  const normalize = (rows) => (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const key = String(row.key || "").trim().slice(0, 4).toUpperCase();
    if (!key) return [];
    const relation = RELATIONS.has(String(row.knowledgeRelation)) ? String(row.knowledgeRelation) : "unreviewed";
    const keep = relation === "option_specific";
    return [{
      key,
      text: String(row.text || "").slice(0, 500),
      protocolVersion: "option-knowledge-v2",
      knowledgeRelation: relation,
      knowledgeNodeIds: keep ? [...new Set((row.knowledgeNodeIds || []).map(String).filter(Boolean))].slice(0, 20) : [],
      knowledgeLabels: keep ? [...new Set((row.knowledgeLabels || []).map(String).filter(Boolean))].slice(0, 20) : [],
      role: ROLES.has(String(row.role)) ? String(row.role) : "unreviewed",
      basis: String(row.basis || "").slice(0, 1000),
      uncertaintyNote: String(row.uncertaintyNote || "").slice(0, 1000),
      provenance: String(row.provenance || "human_gold_review").slice(0, 80),
    }];
  }).slice(0, 26);

  let written = 0;
  for (const entry of plan) {
    if (entry.status !== "fill" && entry.status !== "overwrite") continue;
    const target = byQuestion.get(entry.questionId);
    const source = goldByQuestion.get(entry.questionId);
    if (!target || !source) continue;
    target.fingerprint.optionKnowledge = normalize(source.rows);
    written += 1;
  }
  fs.writeFileSync(structurePath, JSON.stringify(structure), "utf8");
  console.log("已写入指纹数:", written);
  console.log("（已备份；如需回滚，用上面那份备份覆盖 knowledge-structures.json）");
}

console.log("模式:", report.mode);
console.log("金标含人工选项知识的题:", summary.goldQuestions);
console.log("  其中正式指纹存在:", summary.matched, "｜ 不存在:", summary.missingFingerprint);
console.log("  已是同样内容（无需动）:", summary.alreadySame);
console.log("  **将会变更**:", summary.wouldChange);
console.log("报告已写入:", path.relative(root, reportPath));
