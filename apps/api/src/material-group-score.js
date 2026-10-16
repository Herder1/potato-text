/**
 * 材料题组「整组取数 + 整组分值规划」—— **只读派生**（DEC-099 / 产品手册 §4.6.7）。
 *
 * 本模块回答的是「这一个材料题组现在该怎么分」：
 *   · 成员小问有哪几个、顺序如何、各自几个得分点、当前多少分；
 *   · 哪几问是**人工已改过**的（重新分配要跳过，DEC-099 ⑥/⑧）；
 *   · 该组的题组总分是多少、这个总分是哪来的（原卷／该组现有合计／科目默认兜底／根本没有）；
 *   · 按得分点数量给出的整组分配建议（含每条建议的依据 basis）。
 *
 * 边界（刻意如此）：
 *   · **分配算法不在这里**——一律调 `material-score-allocation.js#planMaterialGroupScores`
 *     （AGENTS §5 一处维护；本模块只负责"把题目数据整理成内核要的输入、把结果讲清楚"）；
 *   · **不读写任何 Store**——题目由调用方（server.js）从 questionStore 取来传进；
 *     落库、审计、清标记都在调用方的写入路径里做，本模块纯函数、可直接测。
 *   · 题组总分缺失**不猜**：先认原卷/本组合计，再认科目默认满分（DEC-099 ⑪），都没有就如实标 missing。
 */

const { declaredScoreOf, planMaterialGroupScores } = require("./material-score-allocation");
const { questionGroupId, subQuestionOrder } = require("./question-group");

// 题组总分的来源（与题目自己的 scoreBasis 不是一回事，别混用）：
//   manual   ＝ 操作者在本次请求里明确给定（人工核对后覆盖）
//   recorded ＝ **导入当时**分给这一组的总分（各小问导入时分值之和；导入时守恒 ⇒ 即原卷总分或该科目默认满分）。
//              刻意不用"各问现值之和"：那样一次人工改分就会把题组总分一起改掉，剩余分值也就凑不回原来那个总分了。
//   default  ＝ 导入当时这一组是 0 分（原稿没给总分且没兜底），退到该科目默认材料题组满分（DEC-099 ⑪）
//   missing  ＝ 连默认值都没有：不编造，标待核对
const GROUP_TOTAL_BASES = ["manual", "recorded", "default", "missing"];

function clean(value, maxLength = 240) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

/** 该小问是否"人工已改过分值"：落库的 scoreBasis=locked，或调用方显式点名 */
function isLockedMember(question, lockedIds) {
  if (lockedIds && lockedIds.has(String(question.id))) return true;
  return clean(question.scoreBasis, 20) === "locked";
}

/** 采纳后该小问是否仍需人工核对：占位/缺分值 ⇒ 是；原卷写明、按得分点分配、人工已定 ⇒ 否 */
function scoreNeedsReviewForBasis(basis) {
  return basis === "placeholder" || basis === "missing";
}

/**
 * 这问**导入当时**是多少分（回看最早的一版快照）。
 *
 * 为什么要回看：题组总分＝导入时守恒分配出去的那个总分（DEC-099 ⑤），而这个总和会被后来的
 * 人工改分改变。若拿"各问现值之和"当总分，一次人工改分就会把题组总分一起改掉——
 * 而口径要的恰恰相反：人工改过的小问要**跳过保留**、剩余分值再去凑**原来那个总分**（DEC-099 ⑥/⑧）。
 * 每一版都留着修改前的快照（`previousSnapshot`），取版本号最小的那一条即导入当时的值。
 * 版本记录最多留 50 条，久远到快照已丢失时退回现值（并在 warnings 里说明总分来源不精确）。
 */
function earliestKnownScore(question) {
  const versions = Array.isArray(question.versions) ? question.versions : [];
  const oldest = versions
    .filter((version) => version && version.previousSnapshot
      && Number.isFinite(Number(version.previousSnapshot.maxScore)))
    .reduce((best, version) => (!best || Number(version.version) < Number(best.version) ? version : best), null);
  const snapshotScore = oldest ? Number(oldest.previousSnapshot.maxScore) : NaN;
  if (Number.isFinite(snapshotScore)) return snapshotScore;
  const current = Number(question.maxScore);
  return Number.isFinite(current) ? current : 0;
}

/** 把一个材料题组的成员小问挑出来并按小问顺序排好（题目必须已经落过库/归一化） */
function materialGroupMembers(questions = [], groupId = "", lockedIds = null) {
  const id = clean(groupId, 360);
  if (!id) return [];
  return (Array.isArray(questions) ? questions : [])
    .filter((question) => questionGroupId(question) === id)
    .map((question, index) => ({ question, index }))
    .sort((left, right) => subQuestionOrder(left.question, left.index) - subQuestionOrder(right.question, right.index)
      || left.index - right.index)
    .map(({ question }, index) => {
      const scoringPoints = Array.isArray(question.scoringPoints) ? question.scoringPoints : [];
      const knowledgePoints = Array.isArray(question.knowledgePoints) ? question.knowledgePoints : [];
      const maxScore = Number(question.maxScore);
      return {
        id: clean(question.id),
        subNumber: clean(question.subNumber, 40),
        order: subQuestionOrder(question, index),
        type: clean(question.type, 60),
        typeLabel: clean(question.typeLabel, 60),
        stem: clean(question.stem, 4000),
        subjectId: clean(question.subjectId, 80),
        bookId: clean(question.bookId, 120),
        questionGroupTitle: clean(question.questionGroupTitle, 200),
        groupNumber: clean(question.groupNumber, 40),
        // 当前分值：人工已改过的那些就是"要保留的现值"
        maxScore: Number.isFinite(maxScore) ? maxScore : 0,
        currentScore: Number.isFinite(maxScore) ? maxScore : 0,
        // 导入当时的分值（题组总分由它求和得出，见 earliestKnownScore 的说明）
        recordedScore: earliestKnownScore(question),
        scoreBasis: clean(question.scoreBasis, 20),
        scoreNeedsReview: question.scoreNeedsReview === true,
        scoringPointCount: scoringPoints.length,
        knowledgePointCount: knowledgePoints.length,
        // 原卷写明的小问分值最优先（DEC-099 ①）：从题干文本里读，读不到就是 null（绝不猜）
        declaredScore: declaredScoreOf(question.stem),
        locked: isLockedMember(question, lockedIds),
      };
    });
}

/**
 * 题组总分从哪来（DEC-099 ⑪ 的兜底链）：请求显式给定 → 导入当时这一组的总分 → 该科目默认满分 → 没有。
 * @param {Array<object>} members materialGroupMembers() 的结果
 * @param {string|number} [requestedTotal] 操作者核对后覆盖的总分
 * @param {string|number} [defaultTotal]   该科目默认材料题组满分（唯一读取入口 exam-project-registry#materialGroupTotalForSubject）
 */
function resolveGroupTotal(members = [], requestedTotal, defaultTotal) {
  const requested = Number(requestedTotal);
  if (Number.isFinite(requested) && requested > 0) {
    return { total: Number(requested.toFixed(2)), basis: "manual" };
  }
  // recordedScore 是成员视图的字段；直接传题目对象进来时退回现值（不静默当 0——那会把总分算成"没有"）。
  const recorded = Number((members.reduce((sum, member) => sum
    + (Number(member.recordedScore ?? member.maxScore) || 0), 0)).toFixed(2));
  if (recorded > 0) return { total: recorded, basis: "recorded" };
  const fallback = Number(defaultTotal);
  if (Number.isFinite(fallback) && fallback > 0) return { total: Number(fallback.toFixed(2)), basis: "default" };
  return { total: 0, basis: "missing" };
}

/** 组内一致性（DEC-099 ⑨：强制同科目 + 同教材；章节与知识点允许各问不同） */
function materialGroupConsistencyIssues(members = []) {
  const issues = [];
  if (!members.length) {
    issues.push({ code: "material_group_not_found", message: "该题组下没有题目：题组号可能已失效，或这批题已被删除" });
    return issues;
  }
  const subjectIds = [...new Set(members.map((member) => String(member.subjectId || "")))];
  if (subjectIds.length > 1) {
    issues.push({
      code: "material_group_subject_mismatch",
      message: `组内小问分属不同科目（${subjectIds.map((id) => id || "（空）").join("、")}）：材料题组强制同科目，请先修正归属`,
      subjectIds,
    });
  }
  const bookIds = [...new Set(members.map((member) => String(member.bookId || "")))];
  if (bookIds.length > 1) {
    issues.push({
      code: "material_group_book_mismatch",
      message: `组内小问分属不同教材（${bookIds.map((id) => id || "（空）").join("、")}）：材料题组强制同教材，请先修正归属`,
      bookIds,
    });
  }
  return issues;
}

/**
 * 整组分值规划：成员视图 + 总分来源 + 分配建议（**只读**，不落库）。
 * @param {object} input
 * @param {string} input.groupId
 * @param {Array<object>} input.questions       该批题目（已归一化；可以是全库，本函数自己按题组挑）
 * @param {string|number} [input.groupTotal]    操作者核对后覆盖的题组总分
 * @param {number} [input.step]                 步长覆盖（默认由内核按总分定：0.5 结尾→0.5，其余→1）
 * @param {string|number} [input.defaultTotal]  该科目默认材料题组满分（缺失时的兜底）
 * @param {Array<string>} [input.lockedIds]     额外指定"人工已改过"的小问（默认看落库的 scoreBasis=locked）
 */
function buildMaterialGroupScorePlan(input = {}) {
  const groupId = clean(input.groupId, 360);
  const lockedIds = new Set((Array.isArray(input.lockedIds) ? input.lockedIds : []).map((id) => clean(id)));
  const members = materialGroupMembers(input.questions, groupId, lockedIds);
  const issues = materialGroupConsistencyIssues(members);
  const resolved = resolveGroupTotal(members, input.groupTotal, input.defaultTotal);
  const first = members[0] || {};
  const groupTitle = clean(first.questionGroupTitle, 200)
    || `第${clean(first.groupNumber, 40) || "—"}题 · 材料题组`;
  const plan = planMaterialGroupScores({
    groupTotal: resolved.total,
    step: input.step,
    items: members.map((member) => ({
      id: member.id,
      declaredScore: member.declaredScore,
      scoringPointCount: member.scoringPointCount,
      knowledgePointCount: member.knowledgePointCount,
      locked: member.locked,
      currentScore: member.currentScore,
    })),
  });
  const warnings = [];
  if (resolved.basis === "default") {
    warnings.push(`录入稿没有题组总分：按该科目默认材料题组满分 ${resolved.total} 分兜底，请核对原卷总分`);
  }
  if (resolved.basis === "missing") {
    warnings.push("录入稿没有题组总分，该科目也没有登记默认满分：分值保持待核对，不猜总分");
  }
  const lockedCount = members.filter((member) => member.locked).length;
  if (lockedCount) {
    const lockedTotal = Number(members.filter((member) => member.locked)
      .reduce((sum, member) => sum + (Number(member.currentScore) || 0), 0).toFixed(2));
    warnings.push(`已跳过 ${lockedCount} 个人工改过分值的小问（合计 ${lockedTotal} 分照现值保留），剩余分值只在其余小问之间分配`);
    if (resolved.basis === "recorded") {
      // 人工改分改变了"各问现值之和"，但题组总分仍按导入当时那个数算（DEC-099 ⑤ 守恒的对象是原卷总分）。
      // 若操作者其实是在改"卷面总分记错了"，必须在采纳时显式给定 groupTotal —— 这里如实说出来。
      warnings.push(`题组总分按导入当时的 ${resolved.total} 分计（不随人工改分变动）；若原卷总分不是这个数，请在采纳时显式给定题组总分`);
    }
  }
  warnings.push(...plan.warnings);
  return {
    groupId,
    groupTitle,
    memberCount: members.length,
    subjectId: clean(first.subjectId, 80),
    bookId: clean(first.bookId, 120),
    members,
    issues,
    groupTotal: resolved.total,
    groupTotalBasis: resolved.basis,
    step: plan.step,
    plan,
    allocatedTotal: plan.allocatedTotal,
    conserved: plan.conserved,
    placeholder: plan.placeholder,
    needsReview: plan.needsReview,
    // 未采纳前就把"会写什么"讲清楚：每条 = 小问 + 分值 + 依据 + 是否仍需人工核对
    allocations: plan.allocations.map((allocation) => ({
      id: allocation.id,
      score: allocation.score,
      basis: allocation.basis,
      scoreNeedsReview: scoreNeedsReviewForBasis(allocation.basis),
      keepCurrent: allocation.basis === "locked",
    })),
    warnings,
  };
}

module.exports = {
  GROUP_TOTAL_BASES,
  buildMaterialGroupScorePlan,
  earliestKnownScore,
  isLockedMember,
  materialGroupConsistencyIssues,
  materialGroupMembers,
  resolveGroupTotal,
  scoreNeedsReviewForBasis,
};
