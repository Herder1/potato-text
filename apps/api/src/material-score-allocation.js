/**
 * 材料题组分值分配 —— **唯一定义处**（AGENTS §5 一处维护；口径正文＝产品手册 §4.6.7 / DEC-099）。
 *
 * 口径（产品负责人 2026-09-25 逐条确认）：
 *   1) 分值真源两个、顺序固定：**原卷（录入稿）写明的小问分值最优先**，缺了才由 AI 按内容分配；
 *      不得用"总分 ÷ 小问数"的均分去覆盖原卷分值；
 *   2) 分配依据：**答案要点（得分点）数量为主**，知识点数量与题型作修正；
 *   3) 步长：**1 分**；题组总分是 0.5 结尾（如 13.5）时该组**退回 0.5 步长**（整数之和凑不出 .5）；
 *   4) 守恒：各小问分值之和**严格等于题组总分**；
 *   5) 没有得分点时**不得凭空编造**：均分占位 + 标记"分值待核对"，不阻断入库（占位不是正式分值）；
 *   6) 重新分配时**跳过人工已改过的小问**，AI 只在剩余小问之间分配剩余分值。
 *
 * 本模块只做计算与报错，不读写任何 Store；调用方（导入链路、完善链路、后台界面）自行落库。
 */

const WHOLE_STEP = 1;
const HALF_STEP = 0.5;

// 分值来源词汇（题目落库字段 `scoreBasis`）的**唯一定义处**（AGENTS §5）：分配内核、题目 Store、
// 后台标记共用这一套。值域与含义：
//   declared    ＝ 原卷（录入稿）写明的小问分值（最优先，DEC-099 ①）
//   locked      ＝ 人工已改过该小问分值（重新分配时跳过，DEC-099 ⑥/⑧）
//   points      ＝ 按答案要点（得分点）数量分配得出（主依据，DEC-099 ②）
//   placeholder ＝ 均分占位（还没有得分点，标「分值待核对」，DEC-099 ⑤/⑦）
//   missing     ＝ 原稿没给分值、也没兜底（保持"缺分值"这一真实状态）
// 空串＝非材料题组题或旧数据（向后兼容：旧题 scoreBasis 为空串）。
const SCORE_BASES = ["declared", "locked", "points", "placeholder", "missing"];

/** 把任意输入归一化成合法 scoreBasis；不认识的一律空串（不猜、不编造） */
function normalizeScoreBasis(value) {
  const basis = String(value == null ? "" : value).trim();
  return SCORE_BASES.includes(basis) ? basis : "";
}

/** 分值是否是 0.5 结尾的（13.5 → true；14 → false） */
function endsWithHalf(total) {
  const value = Number(total);
  if (!Number.isFinite(value)) return false;
  return Math.abs(value - Math.round(value)) > 1e-9;
}

/** 依据总分定步长：0.5 结尾退回 0.5，其余一律 1 分（DEC-099 ③） */
function stepForTotal(total) {
  return endsWithHalf(total) ? HALF_STEP : WHOLE_STEP;
}

/** 把 step 的整数倍数量换算成分值（step ∈ {0.5,1}，二进制可精确表示，不存在浮点误差累积） */
function unitsToScore(units, step) {
  return Number((units * step).toFixed(2));
}

const SCORE_UNIT = "[0-9]+(?:\\.[0-9])?";
// 原卷里小问分值的常见写法：（3分）(3 分)［3分］【3分】3分 （本题 3 分） （本小题 3 分）
const DECLARED_SCORE_PATTERNS = [
  new RegExp(`[（(【\\[［]\\s*(?:本题|本小题|每小题|每问)?\\s*(${SCORE_UNIT})\\s*分\\s*[)）】\\]］]`),
  new RegExp(`(?:本题|本小题|每小题|每问)\\s*(${SCORE_UNIT})\\s*分`),
  new RegExp(`(?:^|[\\s，。；;、])(${SCORE_UNIT})\\s*分\\s*[。；;]?$`),
];

/**
 * 从**单个小问的题干文本**里读出原卷写明的小问分值。
 * @returns {number|null} 读不到返回 null（绝不猜）
 */
function declaredScoreOf(text) {
  const source = String(text || "");
  if (!source) return null;
  for (const pattern of DECLARED_SCORE_PATTERNS) {
    const match = source.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/** 题干里是否写明了分值（供界面/提示用，不改变题目文本） */
function hasDeclaredScore(text) {
  return declaredScoreOf(text) != null;
}

/**
 * 按"最大余额法"把 `units` 个步长单位分配到各小问，权重＝得分点数（缺则用知识点数，再缺视为 1）。
 * 返回值之和**严格等于** units（整数运算，无舍入漂移），且每问至少 1 个单位（够分时）。
 */
function distributeUnits(units, weights) {
  const count = weights.length;
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || count;
  const exact = weights.map((weight) => (units * weight) / totalWeight);
  const floors = exact.map((value) => Math.floor(value));
  let assigned = floors.reduce((sum, value) => sum + value, 0);
  const remainders = exact
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((left, right) => (right.fraction - left.fraction) || (weights[right.index] - weights[left.index]) || (left.index - right.index));
  const result = floors.slice();
  for (let cursor = 0; assigned < units; cursor += 1) {
    const target = remainders[cursor % remainders.length].index;
    result[target] += 1;
    assigned += 1;
  }
  // 每问至少一个单位：不够分时从当前最大的那问匀（并如实报冲突，由调用方提示人工）
  for (let index = 0; index < count && units >= count; index += 1) {
    while (result[index] < 1) {
      let donor = 0;
      for (let scan = 1; scan < count; scan += 1) if (result[scan] > result[donor]) donor = scan;
      if (result[donor] <= 1) break;
      result[donor] -= 1;
      result[index] += 1;
    }
  }
  return result;
}

/**
 * 为一个材料题组规划各小问分值。
 *
 * @param {object} input
 * @param {string|number} input.groupTotal        题组总分（原卷该大题的总分）
 * @param {number} [input.step]                   步长覆盖（默认按总分自定：0.5 结尾→0.5，其余→1）
 * @param {Array<object>} input.items             各小问（顺序即小问顺序）
 * @param {string} [input.items[].id]             小问标识（默认用下标）
 * @param {string|number} [input.items[].declaredScore]   原卷写明的小问分值（最优先）
 * @param {number} [input.items[].scoringPointCount]      该小问的得分点数量（主依据）
 * @param {number} [input.items[].knowledgePointCount]    知识点数量（次依据）
 * @param {boolean} [input.items[].locked]        人工已改过该小问分值 ⇒ 跳过重算（DEC-099 ⑥）
 * @param {string|number} [input.items[].currentScore]    locked 时保留的现值
 * @returns {{
 *   ok:boolean, step:number, groupTotal:number, allocatedTotal:number, conserved:boolean,
 *   placeholder:boolean, needsReview:boolean, basis:"declared"|"points"|"placeholder"|"mixed",
 *   allocations:Array<{id:string, score:number, basis:string}>, warnings:string[]
 * }}
 */
function planMaterialGroupScores(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const warnings = [];
  const total = Number(input.groupTotal);
  const requestedStep = Number(input.step);
  const step = Number.isFinite(requestedStep) && requestedStep > 0 ? requestedStep : stepForTotal(total);
  const hasTotal = Number.isFinite(total) && total > 0;
  const minimum = step;

  // 无总分：不编造，各小问保持现值（调用方多半给 0）并标记待核对
  if (!hasTotal || items.length === 0) {
    return {
      ok: false,
      step,
      groupTotal: hasTotal ? total : 0,
      allocatedTotal: 0,
      conserved: false,
      placeholder: true,
      needsReview: true,
      basis: "placeholder",
      allocations: items.map((item, index) => ({
        id: String(item.id ?? index + 1),
        score: Number(item.locked ? (Number(item.currentScore) || 0) : 0),
        basis: item.locked ? "locked" : "placeholder",
      })),
      warnings: [hasTotal ? "题组里没有小问，分值未分配" : "原稿没有题组总分：各小问分值保持待核对，不猜分值"],
    };
  }

  const allocations = items.map(() => ({ id: "", score: 0, basis: "" }));
  const openIndexes = [];
  let fixedTotal = 0;

  items.forEach((item, index) => {
    const declared = Number(item.declaredScore);
    const locked = item.locked === true;
    const current = Number(item.currentScore);
    allocations[index].id = String(item.id ?? index + 1);
    if (locked && Number.isFinite(current)) {
      allocations[index].score = current;
      allocations[index].basis = "locked";
      fixedTotal += current;
      return;
    }
    if (Number.isFinite(declared) && declared > 0) {
      allocations[index].score = declared;
      allocations[index].basis = "declared";
      fixedTotal += declared;
      return;
    }
    openIndexes.push(index);
  });

  const remaining = Number((total - fixedTotal).toFixed(2));
  const declaredCount = allocations.filter((item) => item.basis === "declared").length;
  const lockedCount = allocations.filter((item) => item.basis === "locked").length;
  let placeholder = false;

  if (openIndexes.length > 0) {
    if (remaining <= 0) {
      warnings.push("原卷标注/人工确认的分值之和已达到题组总分，其余小问只能记 0 分：请人工核对原卷分值");
      openIndexes.forEach((index) => {
        allocations[index].score = 0;
        allocations[index].basis = "placeholder";
      });
      placeholder = true;
    } else {
      const unitsTotal = Math.round(remaining / step);
      if (Math.abs(unitsTotal * step - remaining) > 1e-9) {
        warnings.push(`剩余分值 ${remaining} 不是 ${step} 分的整数倍，已按最接近的 ${step} 分整数倍分配，请核对`);
      }
      if (unitsTotal < openIndexes.length) {
        warnings.push(`剩余分值不够每个小问至少 ${step} 分（${remaining} 分 / ${openIndexes.length} 个小问），已按每问 ${step} 分给出并请人工核对总分`);
      }
      const weights = openIndexes.map((index) => {
        const points = Number(items[index].scoringPointCount);
        if (Number.isFinite(points) && points > 0) return points;
        const knowledge = Number(items[index].knowledgePointCount);
        if (Number.isFinite(knowledge) && knowledge > 0) return knowledge;
        return 1;
      });
      const hasPointBasis = openIndexes.some((index) => {
        const points = Number(items[index].scoringPointCount);
        return Number.isFinite(points) && points > 0;
      });
      if (!hasPointBasis) {
        placeholder = true;
        warnings.push("各小问都还没有得分点：分值按均分占位，待完善得分点后重新分配");
      }
      const units = distributeUnits(unitsTotal, weights);
      openIndexes.forEach((index, position) => {
        allocations[index].score = unitsToScore(units[position], step);
        allocations[index].basis = hasPointBasis ? "points" : "placeholder";
      });
    }
  }

  const allocatedTotal = Number(allocations.reduce((sum, item) => sum + item.score, 0).toFixed(2));
  const conserved = Math.abs(allocatedTotal - total) < 1e-9;
  if (!conserved) warnings.push(`各小问分值之和 ${allocatedTotal} 与题组总分 ${total} 不一致，请人工核对`);

  const bases = new Set(allocations.map((item) => item.basis));
  const basis = bases.size === 1 ? [...bases][0] : (declaredCount > 0 || lockedCount > 0 ? "mixed" : "points");

  return {
    ok: conserved,
    step,
    groupTotal: total,
    allocatedTotal,
    conserved,
    placeholder,
    needsReview: placeholder || !conserved,
    basis,
    allocations,
    warnings,
  };
}

module.exports = {
  WHOLE_STEP,
  HALF_STEP,
  SCORE_BASES,
  normalizeScoreBasis,
  endsWithHalf,
  stepForTotal,
  declaredScoreOf,
  hasDeclaredScore,
  distributeUnits,
  planMaterialGroupScores,
};
