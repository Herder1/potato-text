/**
 * 题目的「人可读序号」（**派生，不落库**）——产品负责人 2026-09-25 定：
 * 检查的人需要一个能指认题目的短号；`id` 是 uuid（唯一但不可读），而题目列表按 `updatedAt` 倒序排，
 * **行号会随任何一次编辑跳动**，不能当引用号 ⇒ 用「批次内 + 入库时间(`createdAt`) 升序」现算名次。
 *
 * 口径（与产品手册 §4.6.9「平台题目＝题目单元数」一致）：
 *   · **按题目单元编号**：材料题组算 **1 道**，组内各小问共用同一个号（否则会出现"看得见 1、2、4，
 *     看不见 3"的空洞，且号数会与后台显示的题目总数对不上）；
 *   · 批次内老题的号不会被后来者改动（新增只追加到批尾）；
 *   · **不写库、不新增第二真源**（AGENTS §5：一处维护、禁止双写）——`id` 仍是唯一标识，序号只是显示派生；
 *   · 没有 `importBatchId` 的历史题归为同一组（`__legacy__`），不并进任何真实批次。
 * 本文件是序号口径的**唯一定义处**；调用方不得自己再算一套。
 */
const LEGACY_BATCH_KEY = "__legacy__";

function batchKeyOf(question = {}) {
  const batchId = String(question.importBatchId || "").trim();
  return batchId || LEGACY_BATCH_KEY;
}

/** 题目单元的键：材料题组按组算一道，其余按题目自己算一道。 */
function unitKeyOf(question = {}) {
  const groupId = String(question.questionGroupId || "").trim();
  return groupId || String(question.id || "").trim();
}

/** 单元内最早的入库时间：整组按"这一组是何时进来的"排，不因后来补了小问而改号。 */
function unitFirstCreatedAt(unit) {
  return Math.min(...unit.questions.map((question) => Number(question.createdAt) || 0));
}

function compareUnits(left, right) {
  const byCreated = unitFirstCreatedAt(left) - unitFirstCreatedAt(right);
  if (byCreated) return byCreated;
  // 同一时刻入库（批量导入常见）用单元键兜底：名次稳定、可复现，不依赖数组顺序。
  return String(left.unitKey).localeCompare(String(right.unitKey));
}

function batchSerialMap(questions = []) {
  const units = new Map();
  for (const question of questions) {
    // 没有 id 的题无法被指认，也没有可引用的序号——不参与编号（绝不编造）。
    if (!String((question && question.id) || "").trim()) continue;
    const batchKey = batchKeyOf(question);
    const unitKey = `${batchKey}::${unitKeyOf(question)}`;
    if (!units.has(unitKey)) units.set(unitKey, { unitKey, batchKey, questions: [] });
    units.get(unitKey).questions.push(question);
  }
  const byBatch = new Map();
  for (const unit of units.values()) {
    if (!byBatch.has(unit.batchKey)) byBatch.set(unit.batchKey, []);
    byBatch.get(unit.batchKey).push(unit);
  }
  const serials = new Map();
  for (const [batchKey, batchUnits] of byBatch) {
    const ordered = [...batchUnits].sort(compareUnits);
    ordered.forEach((unit, index) => {
      const batchSerial = index + 1;
      const batchSize = ordered.length;
      for (const question of unit.questions) serials.set(question.id, { batchKey, batchSerial, batchSize });
    });
  }
  return serials;
}

function withQuestionSerials(questions = []) {
  const serials = batchSerialMap(questions);
  return questions.map((question) => {
    const serial = serials.get(question.id);
    if (!serial) return question;
    return { ...question, batchKey: serial.batchKey, batchSerial: serial.batchSerial, batchSize: serial.batchSize };
  });
}

module.exports = { LEGACY_BATCH_KEY, batchKeyOf, unitKeyOf, compareUnits, batchSerialMap, withQuestionSerials };
