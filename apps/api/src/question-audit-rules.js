/**
 * AI 巡检的**确定性体检规则**（DEC-100，产品负责人 2026-09-26 确认；正文见产品手册 §4.6.12）。
 *
 * 分工：巡检只诊断、不改库。能确定性判定的（分值缺失／异常、题干选项残缺、事实相同的重复题、
 * 教材依据取不到）走本模块——免费、可全量、可重复跑；需要语义判断的（答案与依据冲突、错别字、
 * 跨知识点、结论不确定）走 AI 巡检。**两类在清单里必须能区分来源**，所以每条发现都带 source。
 *
 * 本模块是纯函数、只读：不写任何 Store，不做任何字段补齐（DEC-099 的兜底发生在导入/完善环节）。
 */
const { questionFingerprint } = require("./question-store");
const { materialGroupConsistencyIssues, materialGroupMembers, resolveGroupTotal } = require("./material-group-score");

/**
 * 体检项词汇：kind=规则项（本模块）／AI 项（归类产线产出）／结论项（通过与否）。一处维护。
 *
 * **这是全仓唯一一份体检项中文词表**（AGENTS §5「一处维护、其余引用」）：
 * 列表接口的 `issueLabel` 与 `ruleFindings[].title` 都取自这里，前端只认 code、显示后端给的 title，
 * 不再自己维护第二份 map。`suggestion` 是给界面用的处置建议（"该做点什么"一句话），同样只在这里写一份。
 */
const AUDIT_ISSUE_LABELS = {
  // 规则项（source: rule）
  score_abnormal: { title: "分值缺失或异常", source: "rule", severity: "high", suggestion: "补上有效分值（正数）；材料题组还要保证组内总分与卷面一致。" },
  content_defect: { title: "题干／选项残缺", source: "rule", severity: "high", suggestion: "补齐题干与选项：客观题至少两个选项、选项文本不重复、正确答案要指向存在的选项。" },
  near_duplicate: { title: "近似重复题", source: "rule", severity: "medium", suggestion: "与提示的题目逐项比对，确属重复就合并保留一道；不重复的补上区分特征。" },
  evidence_missing: { title: "教材依据缺失", source: "rule", severity: "medium", suggestion: "确认教材归属与目录节点：教材正文要已生成，且章节／知识点能落到目录节点上。" },
  // AI 项（source: ai，由归类产线给出结论，本模块只做词汇归一）
  moved: { title: "建议调整归属", source: "ai", severity: "medium", suggestion: "按建议的知识路径复核归属，采纳前先看清调整理由。" },
  answer_conflict: { title: "答案与已核验依据冲突", source: "ai", severity: "high", suggestion: "核对结构化答案与已核验依据，改到一致后重新巡检。" },
  previous_level_wrong: { title: "原层级／知识归属判断错误", source: "ai", severity: "high", suggestion: "复看上一层节点是否选错，必要时改章节／知识点后重新巡检。" },
  cross_knowledge: { title: "跨知识点题目", source: "ai", severity: "medium", suggestion: "确认是否需要拆分或补挂第二个知识点，避免只挂一个主节点。" },
  missing_node: { title: "缺少合适的知识节点", source: "ai", severity: "medium", suggestion: "在教材目录里补建缺失的节点，或把题目挂到最接近的上级节点。" },
  uncertain: { title: "结论不确定", source: "ai", severity: "low", suggestion: "人工判读题干与教材正文后再定归属；定不了的先留在待复核。" },
  failed: { title: "巡检失败", source: "ai", severity: "high", suggestion: "查看巡检错误信息（多为模型路由或题目数据异常），修好后重新巡检。" },
  stale: { title: "结论已过期", source: "ai", severity: "low", suggestion: "题目或知识树已变更，重新巡检后再看结论。" },
  // 结论项
  confirmed: { title: "归为通过", source: "ai", severity: "none", suggestion: "无需处理；复核状态不受这条结论影响。" },
};

/** 结果状态机里的「通过」：通过也是结论，需要留档作复查基线。 */
const AUDIT_PASS_CODE = "confirmed";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, none: 3 };

function label(code) {
  return AUDIT_ISSUE_LABELS[code] || { title: code, source: "rule", severity: "medium" };
}

function finding(code, detail, evidence = {}) {
  const meta = label(code);
  return { code, title: meta.title, source: meta.source, severity: meta.severity, detail, evidence };
}

/**
 * 体检项的展示行（API 输出形状的唯一实现处）：`code/title/source/severity/detail/evidence/suggestion`。
 * 按严重度排序（high → medium → low → none），同级保持原顺序。
 * `source === "rule"` 的调用方只要再加 `.filter((row) => row.source === "rule")`，不必自己拼字段。
 */
function formatAuditFindings(findings = []) {
  return (Array.isArray(findings) ? findings : []).filter(Boolean).map((item) => {
    const meta = label(item.code);
    return {
      code: String(item.code || ""),
      title: item.title || meta.title || String(item.code || ""),
      source: item.source || meta.source,
      severity: item.severity || meta.severity,
      detail: String(item.detail || ""),
      evidence: item.evidence && typeof item.evidence === "object" ? item.evidence : {},
      suggestion: meta.suggestion || "",
    };
  }).sort((left, right) => (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9));
}

/** 巡检结论的中文标签（AI 项与规则项同一张表）：查不到就原样回 code，界面不至于显示空。 */
function auditIssueTitle(code) {
  const key = String(code || "").trim();
  if (!key) return "";
  return AUDIT_ISSUE_LABELS[key]?.title || key;
}

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function optionTexts(question) {
  return (Array.isArray(question?.options) ? question.options : [])
    .map((option) => clean(option?.text || option))
    .filter(Boolean);
}

function answerKeys(question) {
  const answer = question?.correctAnswer;
  const list = Array.isArray(answer) ? answer : (answer == null || answer === "" ? [] : [answer]);
  return list.map((item) => clean(item).toUpperCase()).filter(Boolean);
}

/**
 * 题干／选项残缺：只判**确定性**的残缺（空题干、选项不足、选项文本重复、客观题没有正确答案、材料缺失）。
 * 错别字之类需要语义判断的留给 AI 项，不在这里猜。
 */
function contentDefectFindings(question) {
  const findings = [];
  const stem = clean(question?.stem);
  if (!stem) {
    findings.push(finding("content_defect", "题干为空", { field: "stem" }));
  } else if (stem.length < 6) {
    findings.push(finding("content_defect", `题干过短（${stem.length} 字），疑似残缺`, { field: "stem", length: stem.length }));
  }
  const texts = optionTexts(question);
  const objectivTypes = new Set(["single_choice", "multiple_choice", "judge"]);
  if (objectivTypes.has(question?.type)) {
    if (texts.length < 2) {
      findings.push(finding("content_defect", `客观题只有 ${texts.length} 个选项`, { field: "options", optionCount: texts.length }));
    }
    const duplicated = texts.filter((text, index) => texts.indexOf(text) !== index);
    if (duplicated.length) {
      findings.push(finding("content_defect", `选项文本重复：${[...new Set(duplicated)].join("、")}`, { field: "options", duplicated: [...new Set(duplicated)] }));
    }
    const keys = answerKeys(question);
    if (!keys.length) {
      findings.push(finding("content_defect", "客观题没有正确答案", { field: "correctAnswer" }));
    } else {
      const optionKeys = new Set((Array.isArray(question?.options) ? question.options : []).map((option) => clean(option?.key).toUpperCase()).filter(Boolean));
      const orphans = keys.filter((key) => optionKeys.size && !optionKeys.has(key));
      if (orphans.length) {
        findings.push(finding("content_defect", `正确答案指向不存在的选项：${orphans.join("、")}`, { field: "correctAnswer", orphans }));
      }
      if (question?.type === "single_choice" && keys.length > 1) {
        findings.push(finding("content_defect", `单选题给了 ${keys.length} 个正确答案（${keys.join("、")}）`, { field: "correctAnswer", keys }));
      }
    }
  }
  if (question?.usesSharedMaterial === true && !clean(question?.material)) {
    findings.push(finding("content_defect", "标注了共用材料，但材料正文为空", { field: "material" }));
  }
  return findings;
}

/**
 * 分值缺失或异常：0 分／负分／无分值，以及材料题组总分取不到或组内不一致。
 * `members` 传入该题所在题组的全部小问（不传就只判单题分值与题组存在性）。
 */
function scoreDefectFindings(question, context = {}) {
  const findings = [];
  const score = Number(question?.maxScore);
  if (!Number.isFinite(score) || score <= 0) {
    findings.push(finding("score_abnormal", `当前分值为 ${question?.maxScore == null || question?.maxScore === "" ? "空" : question.maxScore}，未给出有效分值（DEC-099 兜底之外的题会被拦下）`, { field: "maxScore", maxScore: question?.maxScore ?? null }));
  }
  const groupId = clean(question?.materialGroupId || question?.questionGroupId);
  if (!groupId) return findings;
  const members = Array.isArray(context.members) && context.members.length
    ? context.members
    : materialGroupMembers(context.questions || [question], groupId);
  if (members.length < 2) {
    findings.push(finding("score_abnormal", `题组 ${groupId} 找不到其他小问（题组号可能已失效或小问被删）`, { field: "materialGroupId", groupId, memberCount: members.length }));
    return findings;
  }
  materialGroupConsistencyIssues(members).forEach((issue) => {
    findings.push(finding("score_abnormal", issue.message, { field: "materialGroupId", groupId, code: issue.code }));
  });
  const resolved = resolveGroupTotal(members, context.groupTotal, context.defaultGroupTotal);
  if (resolved.basis === "missing") {
    findings.push(finding("score_abnormal", `题组 ${groupId} 的总分取不到（卷面未写、组内小问也没有分值、科目默认满分不可用）`, { field: "materialGroupId", groupId, basis: resolved.basis }));
  }
  return findings;
}

/**
 * 教材依据缺失：**只查"拿不到依据的客观条件"**，不判断"依据与教材不一致"（那是 AI 项）。
 * 三个条件任一不成立即报：① 题目有教材归属；② 该教材已生成可检索的知识结构／正文；③ 题目知识锚点能落到目录节点。
 */
function evidenceDefectFindings(question, context = {}) {
  const missing = [];
  // 逐题锚点优先（全库体检时每道题的归属不同），退回到整批共用的 anchorResolved。
  const perQuestion = context.anchorResolvedByQuestion;
  const anchorResolved = perQuestion && question?.id != null && Object.prototype.hasOwnProperty.call(perQuestion, question.id)
    ? perQuestion[question.id]
    : context.anchorResolved;
  if (!clean(question?.bookId)) missing.push("题目没有教材归属");
  if (context.textbookReady !== true) missing.push("该教材还没有可检索的正文／知识结构（或未传上下文）");
  if (anchorResolved === false) missing.push("现有知识归属解析不到教材目录节点");
  if (context.evidenceExpected === false) return [];
  if (!missing.length) return [];
  return [finding("evidence_missing", `教材依据取不到：${missing.join("；")}`, {
    field: "textbookEvidence",
    bookId: question?.bookId || "",
    textbookReady: context.textbookReady === true,
    anchorResolved: anchorResolved !== false,
  })];
}

/**
 * 指纹索引：全库体检时一次算好，避免"每道题都和全库比一遍"退化成 O(n²) 重复归一化。
 * 一处定义（`questionFingerprint`）＋一次索引，界面不另写一套判据。
 */
function buildFingerprintIndex(questions = []) {
  const byQuestion = new Map();
  const byFingerprint = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question) => {
    const id = String(question?.id || "");
    if (!id) return;
    const fingerprint = questionFingerprint(question);
    byQuestion.set(id, fingerprint);
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, []);
    byFingerprint.get(fingerprint).push(id);
  });
  return { byQuestion, byFingerprint };
}

/**
 * 近似重复：**事实相同**用与 Store 同源的 `questionFingerprint`（一处定义，不在界面重写一套）；
 * 疑似重复（改数字、换选项顺序之类）由调用方注入 `context.similarMatcher(question, other)`，
 * 复用导入查重那条口径，本模块不自己发明相似度算法。
 * 传了 `context.fingerprintIndex`（`buildFingerprintIndex` 的产物）就走索引，不再逐题重算。
 */
function duplicateFindings(question, context = {}) {
  const index = context.fingerprintIndex;
  const own = index?.byQuestion?.get(String(question?.id || "")) ?? questionFingerprint(question);
  const others = (Array.isArray(context.others) ? context.others : [])
    .filter((other) => other && String(other.id) !== String(question?.id));
  const findings = [];
  if (index?.byFingerprint) {
    const sameIds = (index.byFingerprint.get(own) || []).filter((id) => id !== String(question?.id || ""));
    if (sameIds.length) {
      findings.push(finding("near_duplicate", `与 ${sameIds.length} 道题事实相同（题型＋材料＋题干＋选项归一化后一致）：${sameIds.slice(0, 5).join("、")}`, {
        field: "fingerprint",
        questionIds: sameIds,
        sameFacts: true,
      }));
    }
  } else if (others.length) {
    const identical = others.filter((other) => questionFingerprint(other) === own);
    if (identical.length) {
      findings.push(finding("near_duplicate", `与 ${identical.length} 道题事实相同（题型＋材料＋题干＋选项归一化后一致）：${identical.slice(0, 5).map((item) => item.id).join("、")}`, {
        field: "fingerprint",
        questionIds: identical.map((item) => item.id),
        sameFacts: true,
      }));
    }
  }
  const sameFactsIds = new Set(findings.flatMap((row) => row.evidence.questionIds || []));
  const matcher = context.similarMatcher;
  if (typeof matcher === "function" && others.length) {
    const similar = others.filter((other) => !sameFactsIds.has(String(other.id)) && matcher(question, other));
    if (similar.length) {
      findings.push(finding("near_duplicate", `疑似与 ${similar.length} 道题重复：${similar.slice(0, 5).map((item) => item.id).join("、")}`, {
        field: "similarity",
        questionIds: similar.map((item) => item.id),
        sameFacts: false,
      }));
    }
  }
  return findings;
}

/**
 * 单题体检：返回**全部**发现（可能为空 = 通过）。
 * @param {object} question 已归一化的题目
 * @param {object} [context] { questions, members, groupTotal, defaultGroupTotal, textbookReady, anchorResolved, others, similarMatcher }
 */
function auditQuestion(question, context = {}) {
  return [
    ...contentDefectFindings(question),
    ...scoreDefectFindings(question, context),
    ...evidenceDefectFindings(question, context),
    ...duplicateFindings(question, context),
  ].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || left.code.localeCompare(right.code));
}

/**
 * 全库／整批体检：**通过也要留档**（DEC-100 体检项 10）。
 * @returns {{ findings: Array, passed: Array<string>, byQuestion: object, summary: object }}
 */
function auditQuestions(questions = [], context = {}) {
  const list = (Array.isArray(questions) ? questions : []).filter(Boolean);
  const perQuestion = list.map((question) => ({
    questionId: String(question.id || ""),
    findings: auditQuestion(question, { ...context, others: context.others || list }),
  }));
  const findings = perQuestion.flatMap((item) => item.findings.map((item2) => ({ ...item2, questionId: item.questionId })));
  const passed = perQuestion.filter((item) => !item.findings.length).map((item) => item.questionId);
  const byCode = {};
  findings.forEach((item) => { byCode[item.code] = (byCode[item.code] || 0) + 1; });
  return {
    findings,
    passed,
    byQuestion: Object.fromEntries(perQuestion.map((item) => [item.questionId, item.findings])),
    summary: {
      total: list.length,
      passed: passed.length,
      failed: list.length - passed.length,
      byCode,
      bySource: {
        rule: findings.filter((item) => item.source === "rule").length,
        ai: findings.filter((item) => item.source === "ai").length,
      },
    },
  };
}

module.exports = {
  AUDIT_ISSUE_LABELS,
  AUDIT_PASS_CODE,
  auditIssueTitle,
  auditQuestion,
  auditQuestions,
  buildFingerprintIndex,
  contentDefectFindings,
  duplicateFindings,
  evidenceDefectFindings,
  formatAuditFindings,
  scoreDefectFindings,
};
