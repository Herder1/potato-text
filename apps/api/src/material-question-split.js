/**
 * 材料题（组合题）拆分 —— **唯一定义处**（AGENTS §5 一处维护；DEC-094 ⑤）。
 *
 * 试卷导入（`exam-import-store.js`）与文本导入（`question-text-import.js`）都从这里取同一套规则，
 * 不得各自实现一份。规则：
 *   1) 材料正文与「(1)(2)(3)…」小问分开：材料进 `material`，每个小问成为**独立作答项**；
 *   2) 各小问共享同一个 `materialGroupId`，各自保留 `subNumber`（小问号），大题号留在 `groupNumber`；
 *   3) 参考答案与答案分层（official / ai / community）按同样的编号切开，分别落到各小问；
 *   4) 分值：**原卷（录入稿）写明的小问分值最优先**，原样保留；原卷没写时按产品手册 §4.6.7 / DEC-099
 *      的口径分配——1 分步长（题组总分 0.5 结尾时退回 0.5）、各小问之和严格等于题组总分；
 *      **本链路（导入）此时还没有得分点**，因此给出的是"均分占位 + 待核对"标记，
 *      正式分配发生在完善环节（按题组、以得分点数量为主依据）；
 *      **没有**原稿总分时**不得凭空编造**——各小问沿用 `emptyScoreFallback`（文本导入传 0，
 *      即保持"缺分值"这一真实状态，交由校验与人工补），并给出可读 warning。
 *      分配算法唯一定义在 `apps/api/src/material-score-allocation.js`，本文件不另写一份。
 *
 * 只在"看起来确实是一道未拆的材料题"时才拆：已有 material/materialGroupId、或不足两个编号小问、
 * 或切不出材料正文，都原样返回 `{ split: false }`，由调用方保持原题不动。
 */

const { declaredScoreOf, planMaterialGroupScores, stepForTotal } = require("./material-score-allocation");

// OCR 常见形近字：录入稿里「（1）」常被识别成「（l)」「（I)」「（|)」，个位数也可能被认成 O/S/Z/B/G。
// 不做这层容错，(1) 那行会被并进材料正文、它的答案会被静默丢弃（2026-09-21 实例：18 组材料题里 8 组第一问丢失）。
const OCR_DIGIT_MAP = {
  l: "1", L: "1", I: "1", i: "1", "|": "1", "!": "1", "｜": "1", "1": "1",
  // 本语料实测：第 1 问的编号被认成「（D」两次（材料 360/371），这里按"数字 1"处理；
  // 误判风险由下面的编号/答案归位提示兜住（发现异常会要求人工核对）。
  D: "1",
  O: "0", o: "0", Q: "0", "0": "0",
  S: "5", s: "5", Z: "2", z: "2", B: "8", G: "6",
};

function numberToken(raw) {
  const token = String(raw || "").trim().normalize("NFKC");
  if (!token) return null;
  if (/^\d+$/.test(token)) return token;
  const mapped = token.split("").map((char) => OCR_DIGIT_MAP[char] ?? "").join("");
  return /^\d+$/.test(mapped) ? mapped : null;
}

/**
 * 把「(1) xxx (2) yyy」切成条目；返回前导文本（第一个编号之前的内容）与条目列表。
 * 编号无法识别为数字的括号片段不算编号（例如「（略）」「（A）」），避免误切。
 * 三种容错（都来自本语料的实测 OCR 变体）：
 *   ① 形近字编号：「（l)」「（I）」「（D」；
 *   ② 缺右括号：「（D材料中…」；
 *   ③ 答案侧裸编号：「01）古代知识分子…」（(4) 被识别成 01），只在 allowBareClosingParen 时启用——
 *      材料正文里可能真的有「1）」这种列表行，材料/题干侧不允许裸编号。
 */
function splitNumberedText(value, options = {}) {
  const text = String(value || "").trim();
  const branches = [
    "(?:^|\\n)[ \\t\\u3000]*[（(][ \\t\\u3000]*([0-9]+|[lLIiD|!｜OoQSsZzBG])[ \\t\\u3000]*[）)]",
    "(?:^|\\n)[ \\t\\u3000]*[（(][ \\t\\u3000]*([lLIiD|])[ \\t\\u3000]*(?=[\\u4e00-\\u9fa5])",
  ];
  if (options.allowBareClosingParen) {
    branches.push("(?:^|\\n)[ \\t\\u3000]*([0-9]{1,2})[ \\t\\u3000]*[）)]");
  }
  const pattern = new RegExp(branches.join("|"), "g");
  const markers = [];
  let match = pattern.exec(text);
  while (match) {
    const number = numberToken(match[1] ?? match[2] ?? match[3]);
    if (number) markers.push({ number, start: match.index, contentStart: pattern.lastIndex });
    match = pattern.exec(text);
  }
  // 编号单调修复：OCR 形近字会让编号回退（「（D）」在第 4 位其实是 4、「01）」其实是 4）。
  // 小问编号天然递增，因此"不递增就按上一个编号 +1"比相信那个形近字更可靠；修复过就要求人工核对。
  let numberingRepaired = false;
  const items = markers
    .map((marker, index) => ({
      number: marker.number,
      text: text.slice(marker.contentStart, markers[index + 1]?.start ?? text.length).trim(),
    }))
    .filter((item) => item.text);
  items.forEach((item, index) => {
    const previous = index ? Number(items[index - 1].number) : 0;
    if (!Number.isFinite(Number(item.number)) || Number(item.number) <= previous) {
      item.number = String(previous + 1);
      numberingRepaired = true;
    }
  });
  return {
    preamble: markers.length ? text.slice(0, markers[0].start).trim() : text.trim(),
    items,
    numberingRepaired,
    firstMarkerStart: markers.length ? markers[0].start : -1,
  };
}

function numberedItems(value) {
  return splitNumberedText(value).items;
}

/**
 * 小问与答案配对：先按编号配；编号因 OCR 有缺口时，按位置把「前导答案文本」与「没配上的条目」
 * 依次补进空缺的小问（并声明需要人工核对）。宁可补位也不静默丢内容。
 */
function pairAnswers(subNumbers, parsed) {
  const byNumber = new Map(parsed.items.map((item) => [item.number, item.text]));
  const values = subNumbers.map((number) => byNumber.get(number) || "");
  const gaps = values.map((text, index) => (text ? -1 : index)).filter((index) => index >= 0);
  const leftovers = [
    ...(parsed.preamble ? [parsed.preamble] : []),
    ...parsed.items.filter((item) => !subNumbers.includes(item.number)).map((item) => item.text),
  ];
  let repaired = false;
  gaps.forEach((gapIndex, order) => {
    if (order >= leftovers.length) return;
    values[gapIndex] = leftovers[order];
    repaired = true;
  });
  return { values, repaired };
}

/**
 * @param {object} input
 * @param {string} input.stem              原题干（未拆，材料与小问混在一起）
 * @param {string} [input.material]        已有材料正文（非空即视为已拆，不再处理）
 * @param {string} [input.materialGroupId] 已有题组 id（非空即视为已拆，不再处理）
 * @param {string|number} [input.maxScore] 原题总分
 * @param {string} [input.referenceAnswer] 参考答案（含 (1)(2)(3) 编号）
 * @param {object} [input.answerVariants]  { official, ai, community }
 * @param {string} [input.groupNumber]     大题号（小问共享）
 * @param {number} [input.emptyScoreFallback=0] 无原始总分时各小问的分值占位
 * @param {number} [input.minimumSubScore=0.5]  均分时的最小分值
 * @returns {{split:false} | {split:true, material:string, warning:string, subQuestions:Array}}
 */
function splitMaterialQuestion(input = {}) {
  const stem = String(input.stem || "");
  if (!stem) return { split: false };
  if (String(input.material || "").trim()) return { split: false };
  if (String(input.materialGroupId || "").trim()) return { split: false };
  const promptMarker = stem.match(/(?:^|\n)\s*(?:请回答|问题)\s*[：:]?\s*/);
  const questionPart = promptMarker && promptMarker.index != null
    ? stem.slice(promptMarker.index + promptMarker[0].length)
    : stem;
  const stemParts = splitNumberedText(questionPart);
  const subQuestions = stemParts.items;
  if (subQuestions.length < 2) return { split: false };
  // 材料正文＝第一个编号小问之前的全部内容（questionPart 与 stem 之间的偏移要补回来）。
  // 若有「请回答／问题：」这类提示语，优先切在提示语之前——提示语属于作答要求，不属于材料。
  const questionPartOffset = stem.length - questionPart.length;
  const firstMarkerInStem = stemParts.firstMarkerStart >= 0 ? questionPartOffset + stemParts.firstMarkerStart : -1;
  const promptIndex = promptMarker?.index ?? -1;
  const materialEnd = promptIndex >= 0 && (firstMarkerInStem < 0 || promptIndex <= firstMarkerInStem)
    ? promptIndex
    : firstMarkerInStem;
  const material = materialEnd >= 0 ? stem.slice(0, materialEnd).trim() : "";
  if (!material) return { split: false };

  const subNumbers = subQuestions.map((item) => item.number);
  const answerPair = pairAnswers(subNumbers, splitNumberedText(input.referenceAnswer, { allowBareClosingParen: true }));
  const variantPairs = {};
  for (const key of ["official", "ai", "community"]) {
    variantPairs[key] = pairAnswers(subNumbers, splitNumberedText(input.answerVariants && input.answerVariants[key], { allowBareClosingParen: true }));
  }
  const numberingRepaired = stemParts.numberingRepaired || stemParts.items.map((item) => item.number).join(",") !==
    stemParts.items.map((_, index) => String(index + 1)).join(",");
  const answersRepaired = answerPair.repaired || Object.values(variantPairs).some((pair) => pair.repaired)
    || (splitNumberedText(input.referenceAnswer, { allowBareClosingParen: true }).numberingRepaired);
  const total = Number(input.maxScore);
  const hasTotal = Number.isFinite(total) && total > 0;
  // 原卷没写题组总分时的兜底＝**该科目的默认题组满分**（产品负责人 2026-09-25 确认：现代汉语 14 分、
  // 其余四科 20 分；口径见产品手册 §4.6.7 / DEC-099 修订）。原卷写了就以原卷为准，这里不覆盖。
  const defaultGroupTotal = Number(input.defaultGroupTotal);
  const hasDefaultTotal = !hasTotal && Number.isFinite(defaultGroupTotal) && defaultGroupTotal > 0;
  const groupTotal = hasTotal ? total : (hasDefaultTotal ? defaultGroupTotal : 0);
  const totalBasis = hasTotal ? "source" : (hasDefaultTotal ? "default" : "missing");
  const emptyScoreFallback = Number.isFinite(Number(input.emptyScoreFallback)) ? Number(input.emptyScoreFallback) : 0;
  const minimumSubScore = Number.isFinite(Number(input.minimumSubScore)) && Number(input.minimumSubScore) > 0
    ? Number(input.minimumSubScore)
    : 0.5;
  // 分值口径见产品手册 §4.6.7 / DEC-099（产品负责人 2026-09-25 确认）：
  //   原卷写明的小问分值最优先（不再被均分覆盖）→ 缺了才由 AI 按得分点数分配（发生在完善环节）→
  //   此刻既没原卷分值也没得分点时就**按题组总分均分占位并标记待核对**，绝不假装已定分值；
  //   题组总分本身来源有三档：卷面写的（source）／科目默认满分兜底（default）／都没有（missing，各问 0 分）。
  const allocation = planMaterialGroupScores({
    groupTotal,
    step: Math.max(stepForTotal(groupTotal), minimumSubScore),
    items: subQuestions.map((item, index) => ({
      id: String(item.number || index + 1),
      declaredScore: declaredScoreOf(item.text),
      scoringPointCount: 0,
    })),
  });
  const allocationWarnings = allocation.warnings.filter(Boolean);
  const placeholderScore = groupTotal > 0 ? 0 : emptyScoreFallback;
  const warning = groupTotal > 0
    ? (allocation.placeholder
      ? (hasDefaultTotal
        ? `已自动拆分共享材料与小问：原稿没有题组总分，已按该科目默认材料题组满分 ${groupTotal} 分均分占位并标记「分值待核对」，请核对总分、完善得分点后按要点分配`
        : "已自动拆分共享材料与小问：原卷未写明每问分值、也还没有得分点，分值按均分占位并标记「分值待核对」，请完善得分点后按要点分配")
      : "已自动拆分共享材料与小问：已按原卷写明的小问分值保留（各问之和已核对等于题组总分），请核对答案和得分点")
    : "已自动拆分共享材料与小问，但原稿没有分值：请补每问分值后再导入";
  const repairWarning = "小问编号疑似有识别偏差，已按位置归位答案，请核对每问对应关系";
  const withAllocationWarnings = (base) => {
    const extra = allocationWarnings.filter((line) => !base.includes(line));
    return extra.length ? `${base}；${extra.join("；")}` : base;
  };
  return {
    split: true,
    material,
    groupNumber: String(input.groupNumber ?? ""),
    warning: numberingRepaired || answersRepaired ? withAllocationWarnings(`${warning}；${repairWarning}`) : withAllocationWarnings(warning),
    scoreDivided: hasTotal,
    scoreAllocation: {
      step: allocation.step,
      groupTotal: allocation.groupTotal,
      totalBasis,
      allocatedTotal: allocation.allocatedTotal,
      conserved: allocation.conserved,
      placeholder: allocation.placeholder,
      needsReview: allocation.needsReview,
      basis: allocation.basis,
    },
    subQuestions: subQuestions.map((item, index) => {
      const planned = allocation.allocations[index];
      return {
        subNumber: String(item.number || index + 1),
        stem: item.text,
        referenceAnswer: answerPair.values[index] || "",
        answerVariants: {
          official: variantPairs.official.values[index] || "",
          ai: variantPairs.ai.values[index] || "",
          community: variantPairs.community.values[index] || "",
        },
        maxScore: groupTotal > 0 ? planned.score : placeholderScore,
        scoreBasis: groupTotal > 0 ? planned.basis : "missing",
      };
    }),
  };
}

module.exports = { numberedItems, splitMaterialQuestion };
