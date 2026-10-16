#!/usr/bin/env node
// 章节文本回填：把题目的 `chapter` 统一成「目录路径写法」（2026-09-27 产品负责人确认执行）。
//
// 用法：
//   node scripts/normalize-question-chapters.js            # 只读盘点（默认，不写任何东西）
//   node scripts/normalize-question-chapters.js --execute   # 真正回填
//
// 安全约束（对齐 AGENTS §3/§4/§8）：
//   · 只通过**正式 Store**（createFileQuestionStore）改数据，绝不手改 .runtime/*.json；
//   · 只用 chapter-path-normalizer 的"逐段全中、不丢段"匹配——对不上就**保持原样**，绝不降级；
//   · 默认 dry-run；`--execute` 前请确认后台空闲（Store 按 size:mtimeMs 失效缓存，写完服务端会自动读到新数据）；
//   · 每改一道走 store.update()（会 bump version、留 updatedAt/updatedBy），最后写一条操作日志。
const path = require("node:path");
const { createFileQuestionStore } = require("../apps/api/src/question-store");
const { createFileKnowledgeStructureStore } = require("../apps/api/src/knowledge-structure-store");
const { createFileAdminOperationStore } = require("../apps/api/src/admin-operation-store");
const { normalizeChapterToCatalogPath, splitChapterSegments } = require("../apps/api/src/chapter-path-normalizer");

const EXECUTE = process.argv.includes("--execute");
const ACTOR = "章节文本归一（脚本）";

async function main() {
  const questionStore = createFileQuestionStore();
  const structureStore = createFileKnowledgeStructureStore();
  const operationStore = createFileAdminOperationStore();
  const questions = questionStore.list({ library: "official", status: "all" }).questions;
  const structuresByBook = new Map();
  const nodesFor = (bookId) => {
    if (!structuresByBook.has(bookId)) {
      const record = bookId ? structureStore.get(bookId) : null;
      structuresByBook.set(bookId, record ? (record.nodes || []) : []);
    }
    return structuresByBook.get(bookId);
  };

  const plan = [];
  const stats = { total: questions.length, alreadyNormalized: 0, normalizable: 0, untouched: 0, noTree: 0, rejectedDowngrade: 0 };
  questions.forEach((question) => {
    const bookId = String(question.bookId || "").trim();
    const nodes = nodesFor(bookId);
    if (!nodes.length) { stats.noTree += 1; return; }
    let normalized = null;
    try {
      normalized = normalizeChapterToCatalogPath(question.chapter, nodes);
    } catch (error) {
      console.log(`  !! 归一失败（跳过，不改）：${question.id} ${error.message}`);
      return;
    }
    if (!normalized) { stats.untouched += 1; return; }
    if (normalized.alreadyNormalized) { stats.alreadyNormalized += 1; return; }
    // 硬不变量：归一后的层级数**不得少于**原来的段数。少了就说明发生了"降级"（丢信息），
    // 这种情况一律拒绝改（宁可保持原样，也不许把「第四章语法 > 第二节词类 > 二、实词」压成「语法」）。
    const fromDepth = splitChapterSegments(question.chapter).length;
    const toDepth = splitChapterSegments(normalized.path).length;
    if (toDepth < fromDepth) {
      stats.rejectedDowngrade += 1;
      console.log(`  !! 拒绝降级（保持原样）：${question.id} ${fromDepth} 段 → ${toDepth} 段：${question.chapter} ⇒ ${normalized.path}`);
      return;
    }
    stats.normalizable += 1;
    plan.push({ id: question.id, bookId, question, from: String(question.chapter || ""), to: normalized.path });
  });

  console.log(`题目总数 ${stats.total}｜已是目录路径 ${stats.alreadyNormalized}｜**待归一 ${stats.normalizable}**｜保持原样 ${stats.untouched}｜无知识树 ${stats.noTree}｜拒绝降级 ${stats.rejectedDowngrade}`);
  const byBook = new Map();
  plan.forEach((item) => byBook.set(item.bookId, (byBook.get(item.bookId) || 0) + 1));
  console.log("按册待改：", [...byBook.entries()].map(([bookId, count]) => `${bookId}=${count}`).join("  "));
  console.log("\n示例（最多 10 条）：");
  plan.slice(0, 10).forEach((item) => {
    console.log(`  ${item.id}`);
    console.log(`     from: ${item.from}`);
    console.log(`     to:   ${item.to}`);
  });

  if (!plan.length) {
    console.log("\n没有需要改的题，结束。");
    return;
  }
  if (!EXECUTE) {
    console.log("\n（dry-run，未写入。要真正回填请加 --execute）");
    return;
  }

  const succeeded = [];
  const failed = [];
  for (const item of plan) {
    try {
      // 整份题目对象回传，只改 chapter —— update() 内部会校验并 bump version。
      questionStore.update(item.id, { ...item.question, chapter: item.to }, ACTOR);
      succeeded.push(item);
    } catch (error) {
      failed.push({ ...item, error: error.message });
      console.log(`  !! 写入失败：${item.id} ${error.message}`);
    }
  }
  operationStore.append({
    action: "question.chapter_normalized",
    category: "question",
    targetType: "question_batch",
    targetId: "chapter-path-normalization",
    actor: ACTOR,
    summary: `章节文本归一到目录路径写法：成功 ${succeeded.length} 道、失败 ${failed.length} 道`,
    metadata: {
      byBook: Object.fromEntries(byBook),
      failedIds: failed.map((item) => item.id).slice(0, 50),
      script: "scripts/normalize-question-chapters.js",
    },
  });
  console.log(`\n已回填 ${succeeded.length} 道，失败 ${failed.length} 道；操作日志已写入。`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("脚本异常：", error);
  process.exitCode = 1;
});
