/**
 * 题目「人可读序号」回归（产品负责人 2026-09-25 定：序号是派生的，不进正式存储）。
 *
 * 口径（本文件是它的回归）：
 *   · 序号 = **批次内按题目单元**、以单元最早入库时间(`createdAt`)升序的名次；
 *   · **材料题组算 1 道**，组内各小问共用同一个号（与产品手册 §4.6.9「平台题目＝题目单元数」一致，
 *     否则会出现"看得见 1、2、4 看不见 3"的空洞）；
 *   · 同一时刻入库用单元键兜底排序 ⇒ 名次稳定、可复现，不取决于数组顺序；
 *   · 没有 `importBatchId` 的历史题归 `__legacy__` 一组，不并进真实批次；
 *   · 新增题目只追加到批尾，**已有题目的序号不变**（这是它能当引用号的前提）；
 *   · 不落库：`batchSerial`/`batchKey`/`batchSize` 只是读出时的派生字段。
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryQuestionStore } = require("../apps/api/src/question-store");
const { LEGACY_BATCH_KEY, batchSerialMap, withQuestionSerials } = require("../apps/api/src/question-serial");

const baseQuestion = {
  subjectId: "modern-chinese",
  bookId: "modern-chinese-7-1",
  chapter: "第一章 绪论",
  knowledgePoints: ["现代汉语共同语"],
  type: "short_answer",
  stem: "普通话的定义是什么？",
  referenceAnswer: "普通话是现代汉民族共同语。",
  maxScore: 4,
};

const q = (id, importBatchId, createdAt, extra = {}) => ({ ...baseQuestion, id, importBatchId, createdAt, ...extra });
const groupMember = (id, groupId, importBatchId, createdAt) => q(id, importBatchId, createdAt, { questionGroupId: groupId, groupNumber: groupId, subNumber: id, type: "material_analysis" });

test("同一批次按入库时间升序给号，批次之间互不影响", () => {
  const serials = batchSerialMap([
    q("c", "batch-a", 300),
    q("a", "batch-a", 100),
    q("b", "batch-a", 200),
    q("x", "batch-b", 500),
  ]);
  assert.equal(serials.get("a").batchSerial, 1);
  assert.equal(serials.get("b").batchSerial, 2);
  assert.equal(serials.get("c").batchSerial, 3);
  assert.equal(serials.get("x").batchSerial, 1, "另一个批次从 1 开始，不与 batch-a 连续");
  assert.equal(serials.get("x").batchKey, "batch-b");
  assert.equal(serials.get("c").batchSize, 3);
});

test("材料题组算 1 道：组内各小问共用同一个号，号连续无空洞", () => {
  const questions = [
    q("plain-1", "batch-a", 100),
    groupMember("g1-1", "mg-1", "batch-a", 200),
    groupMember("g1-2", "mg-1", "batch-a", 201),
    q("plain-2", "batch-a", 300),
  ];
  const serials = batchSerialMap(questions);
  assert.equal(serials.get("plain-1").batchSerial, 1);
  assert.equal(serials.get("g1-1").batchSerial, 2);
  assert.equal(serials.get("g1-2").batchSerial, 2, "同组小问共用组号，不各占一个号");
  assert.equal(serials.get("plain-2").batchSerial, 3, "组只占一个号 ⇒ 看不到空洞");
  assert.equal(serials.get("plain-2").batchSize, 3, "批内总数按题目单元算（4 条记录 = 3 道题）");
});

test("同一时刻入库用单元键兜底：名次稳定、与数组顺序无关", () => {
  const forward = withQuestionSerials([q("q-1", "batch-a", 100), q("q-2", "batch-a", 100)]);
  const backward = withQuestionSerials([q("q-2", "batch-a", 100), q("q-1", "batch-a", 100)]);
  assert.deepEqual(forward.map((item) => item.batchSerial), [1, 2]);
  assert.deepEqual(backward.map((item) => item.batchSerial), [2, 1], "反过来喂进去，同一道题的号不变");
});

test("缺批次的旧题归 __legacy__ 一组，不并进真实批次", () => {
  const serials = batchSerialMap([q("old-1", "", 100), q("old-2", undefined, 200), q("new-1", "batch-a", 300)]);
  assert.equal(serials.get("old-1").batchKey, LEGACY_BATCH_KEY);
  assert.equal(serials.get("old-2").batchKey, LEGACY_BATCH_KEY);
  assert.equal(serials.get("old-1").batchSerial, 1);
  assert.equal(serials.get("old-2").batchSerial, 2);
  assert.equal(serials.get("new-1").batchKey, "batch-a");
  assert.equal(serials.get("new-1").batchSerial, 1, "真实批次不跟历史题混在一起编号");
});

test("新增题目只追加到批尾，已有题目的序号不变", () => {
  const before = withQuestionSerials([q("a", "batch-a", 100), q("b", "batch-a", 200)]);
  const after = withQuestionSerials([q("a", "batch-a", 100), q("b", "batch-a", 200), q("c", "batch-a", 300)]);
  const serialOf = (list, id) => list.find((item) => item.id === id).batchSerial;
  assert.equal(serialOf(before, "a"), 1);
  assert.equal(serialOf(after, "a"), 1);
  assert.equal(serialOf(after, "b"), 2);
  assert.equal(serialOf(after, "c"), 3);
  assert.equal(after.find((item) => item.id === "a").batchSize, 3, "批内总数随新增更新");
});

test("withQuestionSerials 不丢原字段，也不会给不存在的题编造序号", () => {
  const [decorated] = withQuestionSerials([q("a", "batch-a", 100)]);
  assert.equal(decorated.stem, baseQuestion.stem);
  assert.equal(decorated.maxScore, 4);
  const [untouched] = withQuestionSerials([{ ...baseQuestion, id: "" }]);
  assert.equal(untouched.batchSerial, undefined, "没有 id 的题不参与编号");
});

test("Store 列表读出来就带序号（接线回归：序号在 list() 一处派生，不落库）", () => {
  const store = createMemoryQuestionStore([
    { ...baseQuestion, id: "later", importBatchId: "batch-a", createdAt: 200 },
    { ...baseQuestion, id: "earlier", importBatchId: "batch-a", createdAt: 100 },
  ]);
  const listed = store.list({}).questions;
  const earlier = listed.find((item) => item.id === "earlier");
  const later = listed.find((item) => item.id === "later");
  assert.equal(earlier.batchSerial, 1);
  assert.equal(later.batchSerial, 2);
  assert.equal(earlier.batchSize, 2);
  // 落库对象里没有这两个字段——证明是纯派生。
  const stored = store.get("earlier");
  assert.equal(stored.batchSerial, undefined);
  assert.equal(stored.batchKey, undefined);
});
