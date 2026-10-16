const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { examProject, subjects, books } = require("../../../packages/domain/catalog");
const { demoQuestions } = require("../../miniprogram/data/catalog");
const { normalizeQuestionType, normalizeQuestionTypeFields } = require("../../miniprogram/utils/question-type");
const { scoringPointStructure } = require("./scoring-point-structure");
const { normalizeClassicalWordStem } = require("./classical-word-marker");
const { normalizeMaterialMarks } = require("./material-mark");
const { countQuestionUnits, decorateQuestionGroups, questionGroupId } = require("./question-group");
const { withQuestionSerials } = require("./question-serial");
// 分值来源词汇（scoreBasis）的值域只由分配内核定义一处（AGENTS §5），Store 只做归一化，不另立一套。
const { normalizeScoreBasis } = require("./material-score-allocation");
const { estimateDifficulty, inferExamTrack, knowledgeDifficultyProfiles, primaryKnowledgePoint, subKnowledgePoints, frequencyProfiles, questionFrequency } = require("./question-assessment");
const { questionClassificationState, questionNeedsClassification, questionClassificationComplete } = require("./question-classification-state");

// 教材筛选的「未指定教材」哨兵值：只有它能把「教材为空」表达成一个可筛选的取值——
// 空字符串在筛选里等价于「不过滤」，无法单独筛出待归类的题目。
// 2026-10-12：后台「完善题目」筛选行不再提供这个选项（改用「缺什么 → 归属 → 待定教材」），
// 但接口层继续接受它（题库列表与历史链接在用），所以匹配逻辑仍留在这一处。
const UNASSIGNED_BOOK_FILTER = "__unassigned__";

// 教材多选匹配（Store 与「完善题目」列表共用一处）：勾了多本就是"命中任一"，
// 哨兵值表示"教材为空"。空选择＝不筛。
function matchesBookSelection(question = {}, bookIds = []) {
  const selected = (Array.isArray(bookIds) ? bookIds : [bookIds]).map(String).filter(Boolean);
  if (!selected.length) return true;
  const bookId = String(question.bookId || "").trim();
  const wantsUnassigned = selected.includes(UNASSIGNED_BOOK_FILTER);
  const realBookIds = selected.filter((id) => id !== UNASSIGNED_BOOK_FILTER);
  if (bookId && realBookIds.includes(bookId)) return true;
  return !bookId && wantsUnassigned;
}

const questionTypes = [
  ["single_choice", "单选题"],
  ["multiple_choice", "多选题"],
  ["true_false", "判断题"],
  ["fill_blank", "填空题"],
  ["punctuation", "断句题"],
  ["classical_word_explanation", "加点字词解释"],
  ["translation", "古文翻译"],
  ["short_answer", "简答题"],
  ["term_definition", "名词解释"],
  ["material_analysis", "材料分析题"],
  ["essay", "论述题"],
];
const typeLabels = Object.fromEntries(questionTypes);
const choiceTypes = new Set(["single_choice", "multiple_choice"]);
const answerSources = new Set(["pdf_answer", "team_verified", "ai_supplement", "community_consensus", "missing"]);
const answerVariantKeys = new Set(["official", "ai", "community"]);
const allowedStatuses = new Set(["official", "pending_review", "public", "featured", "offline"]);
const answerReviewStatuses = new Set(["unreviewed", "doubtful", "verified"]);
const examTagValues = new Set(["insert", "graduate"]);

function normalizeExamTagValue(value) {
  const tag = String(value || "").trim();
  return tag === "upgrade" ? "insert" : tag;
}

function normalizeExamTags(value, fallbackQuestion = {}) {
  if (value !== undefined && value !== null) {
    return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[，,、\s]+/))
      .map(normalizeExamTagValue)
      .filter((item) => examTagValues.has(item)))];
  }
  const legacyTrack = normalizeExamTagValue(fallbackQuestion.examTrack || inferExamTrack(fallbackQuestion));
  return examTagValues.has(legacyTrack) ? [legacyTrack] : [];
}

function normalizeDifficultyScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(100, Math.max(1, Math.round(score))) : 50;
}

function difficultyStars(value) {
  return Math.min(5, Math.max(1, Math.ceil(normalizeDifficultyScore(value) / 20)));
}

function normalizeKnowledgeSignal(value) {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 ? Math.min(100, Math.max(1, Math.round(score))) : 0;
}

function normalizeDifficultyAssessment(value, score) {
  const assessment = value && typeof value === "object" ? value : {};
  const status = ["unassessed", "suggested", "confirmed"].includes(assessment.status) ? assessment.status : "unassessed";
  return {
    status,
    source: ["manual", "rule", "knowledge_rule", "ai", "performance"].includes(assessment.source) ? assessment.source : "",
    confidence: Math.min(1, Math.max(0, Number(assessment.confidence) || 0)),
    reason: String(assessment.reason || "").trim().slice(0, 1000),
    assessedAt: Number(assessment.assessedAt) || 0,
    score: normalizeDifficultyScore(score),
    groupSize: Math.max(0, Number(assessment.groupSize) || 0),
    knowledgeDepthScore: normalizeKnowledgeSignal(assessment.knowledgeDepthScore),
    knowledgeObscurityScore: normalizeKnowledgeSignal(assessment.contentObscurityScore ?? assessment.knowledgeObscurityScore),
    contentObscurityScore: normalizeKnowledgeSignal(assessment.contentObscurityScore ?? assessment.knowledgeObscurityScore),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergedQuestionTargetId(question) {
  return String(question?.mergedIntoQuestionId || question?.merge?.targetQuestionId || "").trim();
}

function assertQuestionNotMergedSource(question) {
  if (mergedQuestionTargetId(question)) throw new Error("question_merged_source_read_only");
}

function normalizeSubNumber(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^[\s(\[【]+/, "")
    .replace(/[\s)\]】]+$/, "")
    .slice(0, 40);
}

function normalizeAnswerReviewStatus(value, answerSource) {
  if (["team_verified", "community_consensus"].includes(answerSource)) return "verified";
  if (answerReviewStatuses.has(value && value.answerReviewStatus)) return value.answerReviewStatus;
  if (value && value.answerVerified === true) return "verified";
  return ["pdf_answer", "ai_supplement"].includes(answerSource) ? "unreviewed" : "verified";
}

function questionSnapshot(question) {
  const { versions, ...snapshot } = question;
  return clone(snapshot);
}

function seedQuestions() {
  const now = Date.now();
  return demoQuestions.map((question, index) => {
    const bookId = question.breadcrumb.includes("下册") ? "modern-chinese-7-2" : "modern-chinese-7-1";
    return {
      id: question.id,
      projectId: examProject.id,
      library: "official",
      status: "official",
      subjectId: "modern-chinese",
      bookId,
      chapter: question.breadcrumb.split(" · ").pop() || "未归类章节",
      knowledgePoints: [question.knowledgePoint],
      type: question.type,
      typeLabel: question.typeLabel || typeLabels[question.type] || question.type,
      stem: question.stem,
      options: clone(question.options || []),
      correctAnswer: clone(question.correctAnswer || []),
      referenceAnswer: question.referenceAnswer,
      scoringPoints: (question.scoringPoints || []).map((point) => ({
        id: point.id,
        description: point.description,
        score: Number(point.score),
        evidenceGroups: clone(point.evidenceGroups || []),
        textbookPage: String(point.textbookPage || ""),
        pageBasis: String(point.pageBasis || ""),
        sourceNote: String(point.sourceNote || ""),
      })),
      contradictionRules: clone(question.contradictionRules || []),
      maxScore: Number(question.score) || 1,
      sourceLabel: question.source,
      sourcePage: "",
      freePreview: { question: index < 2, answer: index === 0, analysis: false },
      contributor: null,
      metrics: { helpful: 0, unhelpful: 0, favorites: 0, comments: 0, reports: 0 },
      version: 1,
      versions: [{ version: 1, updatedAt: now, updatedBy: "系统种子数据", changeNote: "导入首批演示题目" }],
      createdAt: now,
      updatedAt: now,
      createdBy: "系统种子数据",
      updatedBy: "系统种子数据",
    };
  });
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option, index) => ({
    key: String(option && option.key || String.fromCharCode(65 + index)).trim().toUpperCase(),
    text: String(option && option.text || "").trim(),
  })).filter((option) => option.key && option.text).slice(0, 12);
}

function normalizeChoiceCorrectAnswer(answer) {
  const values = Array.isArray(answer) ? answer : String(answer || "").split(/[，,、\s]/);
  return values.flatMap((value) => {
    const matches = String(value || "").normalize("NFKC").toUpperCase().match(/[A-L]/g);
    return matches || [];
  }).filter(Boolean);
}

function choiceValidationDetails(payload) {
  return {
    optionKeys: normalizeOptions(payload && payload.options).map((option) => option.key),
    correctAnswer: [...new Set(normalizeChoiceCorrectAnswer(payload && payload.correctAnswer))],
  };
}

function requiredFieldDetails(payload) {
  return {
    missingFields: [
      !String(payload && payload.subjectId || "").trim() && "科目",
      !String(payload && payload.stem || "").trim() && "题干",
    ].filter(Boolean),
  };
}

// 待归类提示（不是结构错误）：教材 / 章节 / 知识点允许暂缺，
// 缺什么就在这里如实报什么，供导入预览与题目列表派生「待归类」筛选。
// 标签映射统一在 question-classification-state.js（「待归类」派生状态的唯一定义处），这里不再另存一份。
function classificationHint(payload) {
  const state = questionClassificationState(payload);
  return state.complete ? null : { missing: state.missing, missingLabels: state.missingLabels };
}

function normalizeScoringPoints(points) {
  if (!Array.isArray(points)) return [];
  return points.map((point) => ({
    id: String(point && point.id || crypto.randomUUID()),
    description: String(point && point.description || "").trim(),
    score: Number(point && point.score),
    evidenceGroups: Array.isArray(point && point.evidenceGroups) ? clone(point.evidenceGroups).slice(0, 20) : [],
    textbookPage: String(point && (point.textbookPage || point.textbookPages) || "").trim().slice(0, 100),
    pageBasis: ["confirmed_catalog", "textbook_text", "manual"].includes(point && point.pageBasis) ? point.pageBasis : "",
    sourceNote: String(point && point.sourceNote || "").trim().slice(0, 500),
  })).filter((point) => point.description && Number.isFinite(point.score) && point.score > 0).slice(0, 30);
}

function normalizeScoringPolicy(value, type, maxScore) {
  const modes = ["double_choice_partial", "double_choice_no_partial"];
  if (!value || !modes.includes(value.mode) || type !== "multiple_choice") return null;
  return {
    mode: value.mode,
    oneCorrectScore: value.mode === "double_choice_partial" ? Math.max(0, Number(value.oneCorrectScore) || 0) : 0,
    allCorrectScore: Math.max(0, Number(value.allCorrectScore) || maxScore),
    extraOptionScore: Math.max(0, Number(value.extraOptionScore) || 0),
    emptyScore: Math.max(0, Number(value.emptyScore) || 0),
  };
}

function normalizeAnswerVariants(value, referenceAnswer, answerSource) {
  const variants = value && typeof value === "object" ? value : {};
  return {
    official: String(variants.official || (["pdf_answer", "team_verified"].includes(answerSource) ? referenceAnswer : "")).trim().slice(0, 20000),
    ai: String(variants.ai || (answerSource === "ai_supplement" ? referenceAnswer : "")).trim().slice(0, 20000),
    community: String(variants.community || (answerSource === "community_consensus" ? referenceAnswer : "")).trim().slice(0, 20000),
  };
}

function normalizeHiddenAnswerVariants(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((item) => answerVariantKeys.has(item)))];
}

function normalizeFingerprintText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    // 标点等价：NFKC 会把全角「，。！？；：」转成半角，因此剥离表必须同时列半角形态，
    // 否则原表里那些全角字符在 NFKC 之后一个也匹配不到（实测：题库「下列音节中.韵母属于开口呼的是」
    // 与导入稿「下列音节中,韵母属于开口呼的是」只差一个 OCR 变体标点，本该判同一道题却判不出来）。
    .replace(/[，。！？；：、“”‘’（）()【】\[\]《》<>·…—-]|[,.!?;:'"]/g, "")
    // 来源标注（产品负责人 2026-09-22）：同一道题被不同考次重复收录时，只有「（插本22年）」这类
    // 考次标注不同，不该算两道题——真实录入稿实测有 6 行是这种情况（如 #13 与题库「（插本22年）关于
    // 汉字的特点…」选项、答案完全一致）。**只剥明确的「插本NN年」**，不动题干里可能表意的年份
    // （历史题里的「1949年」等照旧参与身份判定）。
    .replace(/插本\d{2,4}年/g, "");
}

// 删除投影：给一批 id，算出"实际会被删掉的题目"——单个小问被点到时同组材料题整组连带。
// deleteMany（真删）与 deletionImpact（删前盘点）共用这一处，避免"盘点说删 3 道、实际删 5 道"的漂移。
function projectDeletion(questions, requestedIds) {
  const requested = new Set(requestedIds);
  const requestedGroups = new Set(questions
    .filter((question) => requested.has(question.id))
    .map((question) => questionGroupId(question))
    .filter(Boolean));
  const deleted = questions.filter((question) => requested.has(question.id) || requestedGroups.has(questionGroupId(question)));
  return { deleted, deletedIds: new Set(deleted.map((question) => question.id)) };
}

function questionFingerprint(question) {
  const optionText = choiceTypes.has(question.type)
    ? normalizeOptions(question.options).map((option) => `${option.key}:${normalizeFingerprintText(option.text)}`).join("|")
    : "";
  return crypto.createHash("sha256").update([
    normalizeQuestionType(question.type),
    normalizeFingerprintText(question.material),
    normalizeFingerprintText(question.stem),
    optionText,
  ].join("\n")).digest("hex");
}

// 事实相同＝完整指纹一致（questionFingerprint）才判重；DEC-094 禁止只凭题干判重，
// 因此不再保留「仅题型＋材料＋题干」的兜底指纹（它是"题干相同、选项不同"误判的根因）。

// ── 疑似重复（DEC-094）──────────────────────────────────────────────────────
// 事实相同＝完整指纹一致（上面的 questionFingerprint）；达不到但"很像"的行只提示、不阻断。
// 相似度＝归一化「材料＋题干」的字符双字组 Dice 系数，阈值见 SUSPICION_THRESHOLD。
const SUSPICION_THRESHOLD = 0.85;
// 选择题的**选项重合门槛**（产品负责人 2026-09-22）：通用题干（如"下列成语中,结构类型全部相同的一项是"）
// 会被大量互不相同的题目共用，只按题干算相似度会把"选项完全不重合"的不同题报成「疑似重复 100%」
// （真实录入稿实测 7 条这种噪音）。选择题必须在选项上有实质重合才算疑似；非选择题没有选项，照旧只按题干判定。
const SUSPICION_OPTION_OVERLAP = 0.5;
// 参与疑似比对的最短文本（材料＋题干，归一化后）：太短区分度低，但**不是**不比对——
// 原门槛 6 字把「d、t、n、l 是」（归一化后 5 字）整行跳过，导致它与题库里
// 「（插本23年）d、 t、 n、 l 是（ ）」这组真重复完全没提示（产品负责人 2026-09-22 截图反馈）。
const SUSPICION_MIN_TEXT_LENGTH = 4;
// 「选项与答案完全一致」这条强证据要求的最短连续公共片段（产品负责人 2026-09-22 第二次报漏报：
// 「客家方言以( )为代表」与库内「（插本2022年）客家方言以（ ）代表」只差一个「为」字、
// 「符合"广州市"拼音字母拼写规则的是」与库内「（插本22年）下列"广州市"拼音正确是（ ）」整句改写，
// 两者选项集合与正确答案完全相同，但题干字面相似度只有 0.77 / 0.36，卡在 0.85 阈值下**毫无提示**）。
// 实测（题库 1269 道内部 + 真实录入稿 417 行）：「选项集合完全相同」单独用会炸出模板题噪音
// （造字法：象形/指事/会意/形声 被 10 道不同题共用），加上"答案一致 + ≥5 字连续公共片段"后
// 库内只剩 10 对、录入稿只新增 3 条，且经逐条目视**全部是真重复**。
const SUSPICION_COMMON_RUN = 5;
// 光有"≥5 字连续公共片段"还不够：两个长句里偶然撞上 8 个字很容易（实测真实录入稿 #344
// 「《哭小弟》中写道…」与库内另一道修辞手法题撞了 8 字，而通用选项模板（比喻/比拟/借代/夸张）
// 又刚好一样 → 13% 相似度也被提示）。因此公共片段还必须**占较短一版的 ≥40%**：
// 真重复是"整句几乎一样只差几字"或"整句改写但核心词相同"，靠模板共用的题达不到这个比例。
const SUSPICION_COMMON_RUN_RATIO = 0.4;
const fpNormalize = (value) => normalizeFingerprintText(value);
// 选项身份集合：选择题才用于选项重合判定（键＝归一化后的选项文本，与判重同源）
const optionIdentityKeys = (question) => (choiceTypes.has(question.type)
  ? new Set(normalizeOptions(question.options).map((option) => normalizeFingerprintText(option.text)).filter(Boolean))
  : null);
function gramSet(text) {
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}
function triGrams(text) {
  const grams = [];
  for (let index = 0; index < text.length - 2; index += 1) grams.push(text.slice(index, index + 3));
  return grams;
}
function diceSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

// ── 「选项与答案完全一致」这条强证据（2026-09-22 第二次口径修订）────────────────
// 来源标注必须在**原始文本**上剥：normalizeFingerprintText 会把括号当标点删掉，之后再匹配括号就晚了。
// 它只用于"连续公共片段"这条辅助证据，**不参与判重指纹**（指纹口径未动，DEC-094 ①）。
const SOURCE_ANNOTATION_PATTERNS = [
  /[（(［\[][^（()）［\[\]］]{0,24}?\d{2,4}\s*年[^（()）［\[\]］]{0,12}?[）)］\]]/g, // 「（北京大学2015年）」「［北京大学 2010 年研］」
  /[（(［\[][^（()）［\[\]］]{0,12}?年研[）)］\]]/g,                              // 「（2011年研）」
  /插本\d{2,4}年/g,                                                              // 「（插本22年）」剥括号后剩下的部分
];
function stripSourceAnnotations(value) {
  let text = String(value || "");
  for (const pattern of SOURCE_ANNOTATION_PATTERNS) text = text.replace(pattern, "");
  return text;
}
// 朴素题干：剥来源标注后再归一化——比"连续公共片段"时用，避免「大学2015年」这种标注自己凑出长片段
const plainFingerprintText = (question) => normalizeFingerprintText(stripSourceAnnotations(`${question.material || ""}${question.stem || ""}`));
// 选项集合签名：选择题才有的"选项完全相同"证据（与判重同一套归一化）
function optionSignature(question) {
  const keys = optionIdentityKeys(question);
  return keys && keys.size ? [...keys].sort().join("\u0001") : null;
}
// 正确答案指向的选项文本（选择题）：两版答案一致才承认是同一道题的改写
function answerIdentity(question) {
  if (!choiceTypes.has(question.type)) return null;
  const options = normalizeOptions(question.options);
  const keys = String(question.correctAnswer || "").split(/[,，、\s]+/).filter(Boolean);
  if (!keys.length) return null;
  return keys
    .map((key) => normalizeFingerprintText((options.find((option) => option.key === key) || {}).text || key))
    .sort()
    .join("+");
}
// 最长连续公共片段（滚动一行 DP；题干都在几百字内，实际只跑"选项签名相同的少数候选"）
function longestCommonRun(left, right) {
  let best = "";
  const row = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = left[i - 1] === right[j - 1] ? previous + 1 : 0;
      if (row[j] > best.length) best = left.slice(i - row[j], i);
      previous = current;
    }
  }
  return best;
}

// 「选项与答案完全一致 ＋ 题干有足够长的连续公共片段」这条强证据的**唯一判据**（2026-09-22）。
// 两个地方必须用同一个判断，所以抽在这里，禁止各写一份（AGENTS §5）：
//   ① 导入预览里的疑似提示（nearestExisting 的强证据分支）——它是"提示"；
//   ② 人工在对比弹窗里点「确认是同一道题」之后的写入授权（fillMissingFields）——它是"授权"。
// 判据（缺一不可）：题型相同 ／ 归一化后的选项集合完全相同 ／ 正确答案指向的选项文本相同 ／
// 两版题干（**先剥来源标注**）有 ≥ SUSPICION_COMMON_RUN 字连续公共片段且占较短一版 ≥ 40% ／
// 两版材料不相同（同一材料题组里的小问共用整段材料，公共片段必然很长，它们不是重复题）。
// 返回 `{ score, commonRun }`（score＝归一化"材料＋题干"的双字组 Dice 相似度，只用于展示与排序）。
function strongEvidenceBetween(left, right) {
  if (!left || !right || left.type !== right.type) return null;
  const signature = optionSignature(left);
  if (!signature || signature !== optionSignature(right)) return null;
  const answer = answerIdentity(left);
  if (!answer || answer !== answerIdentity(right)) return null;
  const material = fpNormalize(left.material);
  if (material && material === fpNormalize(right.material)) return null;
  const plain = plainFingerprintText(left);
  const peerPlain = plainFingerprintText(right);
  const run = longestCommonRun(plain, peerPlain);
  if (run.length < SUSPICION_COMMON_RUN) return null;
  if (run.length * 10 < Math.min(plain.length, peerPlain.length) * (SUSPICION_COMMON_RUN_RATIO * 10)) return null;
  const score = diceSimilarity(
    gramSet(fpNormalize(`${left.material || ""}${left.stem || ""}`)),
    gramSet(fpNormalize(`${right.material || ""}${right.stem || ""}`)),
  );
  return { score, commonRun: run.length };
}

// 疑似比对的比对文本：材料 + 题干（不含选项，选项另走 optionIdentityKeys 的"实质重合"判据）。
const suspiciousText = (question) => fpNormalize(`${question.material || ""}${question.stem || ""}`);

// 「题干字面相似度 ≥ SUSPICION_THRESHOLD ＋ 选择题选项有实质重合（≥ SUSPICION_OPTION_OVERLAP）」
// 这条**模糊路径**判据的唯一实现（2026-09-23 抽出，禁止各写一份 AGENTS §5）：
//   ① 导入预览的疑似提示（previewImport 的 ② 分支）——它是"提示"；
//   ② 人工在对比弹窗里点过「确认是同一道题」之后**只补空缺**的写入授权——它是"授权"。
// 与 strongEvidenceBetween 的分工：强证据证明"这就是同一道题的改写（题型、选项集合、答案指向都对得上）"；
// 模糊判据只证明"这两版确实像到会被查重提示"，对**不覆盖任何内容**的动作（只补空缺）已经足够——而它
// 正好覆盖"两版选项文字略有出入"这类最常见的疑似改写（强证据的「选项集合完全相同」在它们身上天然不成立，
// 2026-09-23 真机报错 question_merge_requires_identical 即此）。覆盖非空字段仍然只认强证据。
// 返回 `{ score, reason }`；不成立返回 null。
function fuzzySuspicionBetween(left, right) {
  if (!left || !right || left.type !== right.type) return null;
  const leftText = suspiciousText(left);
  const rightText = suspiciousText(right);
  if (leftText.length < SUSPICION_MIN_TEXT_LENGTH || rightText.length < SUSPICION_MIN_TEXT_LENGTH) return null;
  const leftOptions = optionIdentityKeys(left);
  if (leftOptions) {
    const rightOptions = optionIdentityKeys(right);
    if (!rightOptions || !rightOptions.size) return null;
    let shared = 0;
    for (const key of leftOptions) if (rightOptions.has(key)) shared += 1;
    if (shared / Math.min(leftOptions.size, rightOptions.size) < SUSPICION_OPTION_OVERLAP) return null;
  }
  const score = diceSimilarity(gramSet(leftText), gramSet(rightText));
  if (score < SUSPICION_THRESHOLD) return null;
  return { score, reason: "stem_similarity" };
}

function validateQuestionPayload(payload, existing = null) {
  // 科目必填；教材、章节、知识点允许暂缺（产品口径：只确定科目的题目可以先录入）。
  // 「允许暂缺」不等于「允许假值」：
  //   1) 一旦提供教材，就必须是本科目下真实存在的教材（不得用假 id / 跨科目教材绕过）；
  //   2) 章节与知识点是教材的下级，教材为空时不允许单独存在；
  //   3) 切换科目或教材时，不残留原教材的下级关联（由本次请求显式重填才生效）。
  const subjectId = String(payload.subjectId ?? existing?.subjectId ?? "").trim();
  const type = normalizeQuestionType(payload.type || existing?.type);
  const subject = subjects.find((item) => item.id === subjectId);
  if (!subject) throw new Error("question_subject_required");
  const bookId = String((payload.bookId !== undefined ? payload.bookId : existing?.bookId) ?? "").trim();
  const book = bookId ? books.find((item) => item.id === bookId && item.subjectId === subjectId) : null;
  if (bookId && !book) throw new Error("question_book_invalid");
  if (!typeLabels[type]) throw new Error("question_type_invalid");
  const catalogChanged = Boolean(existing)
    && (String(existing.subjectId || "").trim() !== subjectId || String(existing.bookId || "").trim() !== bookId);
  const keepLowerLevels = Boolean(book) && !catalogChanged;
  const chapter = String(payload.chapter !== undefined ? payload.chapter : (keepLowerLevels ? existing?.chapter : "")).trim();
  const knowledgePointSource = payload.knowledgePoints !== undefined
    ? payload.knowledgePoints
    : (keepLowerLevels ? existing?.knowledgePoints : []);
  const knowledgePoints = (Array.isArray(knowledgePointSource) ? knowledgePointSource : String(knowledgePointSource || "").split(/[，,\n]/))
    .map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
  if (!bookId && (chapter || knowledgePoints.length)) throw new Error("question_classification_requires_book");
  const explicitPrimaryKnowledgePoint = String(payload.primaryKnowledgePoint ?? (keepLowerLevels ? existing?.primaryKnowledgePoint : "") ?? "").trim().slice(0, 200);
  const resolvedPrimaryKnowledgePoint = explicitPrimaryKnowledgePoint || primaryKnowledgePoint({ chapter, knowledgePoints });
  const subKnowledgePointSource = payload.subKnowledgePoints ?? (keepLowerLevels ? existing?.subKnowledgePoints : undefined);
  const resolvedSubKnowledgePoints = subKnowledgePointSource == null
    ? subKnowledgePoints({ chapter, knowledgePoints, primaryKnowledgePoint: resolvedPrimaryKnowledgePoint }, resolvedPrimaryKnowledgePoint)
    : subKnowledgePoints({ subKnowledgePoints: subKnowledgePointSource }, resolvedPrimaryKnowledgePoint);
  const knowledgeDepthScore = normalizeKnowledgeSignal(payload.knowledgeDepthScore ?? existing?.knowledgeDepthScore);
  const contentObscurityScore = normalizeKnowledgeSignal(payload.contentObscurityScore ?? existing?.contentObscurityScore);
  const rawStem = String(payload.stem ?? existing?.stem ?? "").trim();
  const referenceAnswer = String(payload.referenceAnswer ?? existing?.referenceAnswer ?? "").trim();
  const classicalWord = type === "classical_word_explanation"
    ? normalizeClassicalWordStem({
      stem: rawStem,
      annotationText: payload.annotationText ?? existing?.annotationText,
      referenceAnswer,
    })
    : null;
  const stem = classicalWord?.stem ?? rawStem;
  const maxScore = Number(payload.maxScore ?? existing?.maxScore);
  // 结构必填只剩「题干」：章节、知识点、参考答案都可以暂缺。
  // 但「没有答案」不是分类问题——它会让题目无法判分，因此下面单独处理：
  // 无作答内容时强制 answerReviewStatus = "unreviewed"，题目只能停在待处理态。
  if (!stem) throw new Error("question_required_fields_missing");
  if (type === "fill_blank" && !/(?:_{2,}|＿{2,}|□{2,}|\(\s*\)|（\s*）)/u.test(stem)) {
    throw new Error("question_fill_blank_position_missing");
  }
  if (stem.length > 12000 || referenceAnswer.length > 20000) throw new Error("question_content_too_large");
  if (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100) throw new Error("question_score_invalid");
  // 材料题组分值（DEC-099 / 产品手册 §4.6.7）：
  //   ① 「人工改过分值」＝这条题的分值已由人定过，之后整组重新分配要**跳过**它（DEC-099 ⑥/⑧）；
  //   ② 只有数值真的变了才算改动——编辑题干时表单会把同一个分值一起提交回来，
  //      若把重提交当成"人工改过"，整组会在一次无关编辑后集体变成 locked、再也不会被重新分配；
  //   ③ 分值由人定过就不再是「待核对」。
  const scoreChanged = Boolean(existing)
    && Object.prototype.hasOwnProperty.call(payload, "maxScore")
    && Math.abs(maxScore - Number(existing.maxScore)) > 1e-9;
  const options = normalizeOptions(payload.options ?? existing?.options);
  const rawCorrectAnswer = payload.correctAnswer ?? existing?.correctAnswer;
  const correctAnswer = choiceTypes.has(type)
    ? normalizeChoiceCorrectAnswer(rawCorrectAnswer)
    : (Array.isArray(rawCorrectAnswer) ? rawCorrectAnswer : String(rawCorrectAnswer || "").split(/[，,、\n]/))
      .map((item) => String(item).trim()).filter(Boolean);
  if (choiceTypes.has(type)) {
    if (options.length < 2 || !correctAnswer.length || correctAnswer.some((answer) => !options.some((option) => option.key === answer))) {
      throw new Error("question_choice_answer_invalid");
    }
    if (type === "single_choice" && correctAnswer.length !== 1) throw new Error("question_choice_answer_invalid");
  }
  const scoringPoints = normalizeScoringPoints(payload.scoringPoints ?? existing?.scoringPoints);
  const scoringStructure = scoringPointStructure(type, referenceAnswer, scoringPoints, maxScore);
  const answerSource = answerSources.has(payload.answerSource ?? existing?.answerSource)
    ? (payload.answerSource ?? existing.answerSource)
    : "team_verified";
  // 没有任何作答内容（既无参考答案文本，选择题也没有正确答案）时不可能「已核对」，
  // 一律回落 unreviewed：既不冒充已审核，也不会被自动发布到用户端。
  const hasAnswerMaterial = Boolean(referenceAnswer) || correctAnswer.length > 0;
  const answerReviewStatus = !hasAnswerMaterial
    ? "unreviewed"
    : (classicalWord?.needsReview
      ? "doubtful"
      : normalizeAnswerReviewStatus(payload.answerReviewStatus != null || payload.answerVerified != null ? payload : existing, answerSource));
  const answerVerified = answerReviewStatus === "verified";
  if (answerSource === "missing" && (referenceAnswer || correctAnswer.length)) throw new Error("question_answer_source_required");
  const answerVariants = normalizeAnswerVariants(payload.answerVariants ?? existing?.answerVariants, referenceAnswer, answerSource);
  const hiddenAnswerVariants = normalizeHiddenAnswerVariants(payload.hiddenAnswerVariants ?? existing?.hiddenAnswerVariants);
  return {
    subjectId,
    bookId,
    chapter,
    knowledgePoints,
    primaryKnowledgePoint: resolvedPrimaryKnowledgePoint,
    subKnowledgePoints: resolvedSubKnowledgePoints,
    knowledgeDepthScore,
    contentObscurityScore,
    type,
    typeLabel: typeLabels[type],
    stem,
    options: choiceTypes.has(type) ? options : [],
    correctAnswer: choiceTypes.has(type) ? [...new Set(correctAnswer)] : correctAnswer,
    referenceAnswer,
    answerVariants,
    hiddenAnswerVariants,
    scoringPoints,
    scoringPointStatus: scoringStructure.status,
    scoringPointCandidates: scoringStructure.candidates,
    scoringPolicy: normalizeScoringPolicy(payload.scoringPolicy ?? existing?.scoringPolicy, type, maxScore),
    maxScore,
    // 分值来源（declared/locked/points/placeholder/missing，值域定义在 material-score-allocation.js）
    // 与「分值待核对」标记：两个都是**新增字段**，旧题读到 scoreBasis=""、scoreNeedsReview=false，
    // 不改变任何既有字段语义；显式传值优先（整组采纳会明确写 basis），否则按上面的口径推导。
    scoreBasis: Object.prototype.hasOwnProperty.call(payload, "scoreBasis")
      ? normalizeScoreBasis(payload.scoreBasis)
      : (scoreChanged ? "locked" : normalizeScoreBasis(existing?.scoreBasis)),
    scoreNeedsReview: Object.prototype.hasOwnProperty.call(payload, "scoreNeedsReview")
      ? payload.scoreNeedsReview === true
      : (scoreChanged ? false : existing?.scoreNeedsReview === true),
    material: String(payload.material ?? existing?.material ?? "").trim().slice(0, 20000),
    materialMarks: normalizeMaterialMarks(payload.materialMarks ?? existing?.materialMarks),
    materialGroupId: String(payload.materialGroupId ?? existing?.materialGroupId ?? "").trim().slice(0, 120),
    questionGroupId: String(payload.questionGroupId ?? existing?.questionGroupId ?? "").trim().slice(0, 360),
    questionGroupTitle: String(payload.questionGroupTitle ?? existing?.questionGroupTitle ?? "").trim().slice(0, 200),
    groupOrder: Math.max(0, Math.min(1000, Number(payload.groupOrder ?? existing?.groupOrder) || 0)),
    usesSharedMaterial: payload.usesSharedMaterial ?? existing?.usesSharedMaterial ?? true,
    groupNumber: String(payload.groupNumber ?? existing?.groupNumber ?? "").trim().slice(0, 40),
    subNumber: normalizeSubNumber(payload.subNumber ?? existing?.subNumber),
    // 作答方式 2026-10-10 起统一为「文字作答」：产品负责人确认下线「原文标记」作答方式，
    // 这里作为唯一归一点，任何来源（后台编辑器、试卷导入、历史数据）传进来的 annotation 都按 text 落库。
    // 字段名保留，避免读取方（小程序 question-sync / 后台接口）因为字段消失而拿不到值。
    responseMode: "text",
    annotationText: String(payload.annotationText ?? existing?.annotationText ?? "").trim().slice(0, 12000),
    answerSource,
    answerReviewStatus,
    answerVerified,
    sourceLabel: String(payload.sourceLabel ?? existing?.sourceLabel ?? "").trim().slice(0, 1000),
    sourcePage: String(payload.sourcePage ?? existing?.sourcePage ?? "").trim().slice(0, 100),
    freePreview: {
      question: (payload.freePreview ?? existing?.freePreview)?.question === true,
      answer: (payload.freePreview ?? existing?.freePreview)?.answer === true,
      analysis: (payload.freePreview ?? existing?.freePreview)?.analysis === true,
    },
    difficultyScore: normalizeDifficultyScore(payload.difficultyScore ?? existing?.difficultyScore),
    difficultyStars: difficultyStars(payload.difficultyScore ?? existing?.difficultyScore),
    difficultyAssessment: normalizeDifficultyAssessment(
      payload.difficultyAssessment ?? (payload.difficultyScore != null && existing
        && normalizeDifficultyScore(payload.difficultyScore) !== normalizeDifficultyScore(existing.difficultyScore)
        ? { status: "confirmed", source: "manual", confidence: 1, reason: "管理员调整知识点难度", assessedAt: Date.now() }
        : existing?.difficultyAssessment),
      payload.difficultyScore ?? existing?.difficultyScore,
    ),
    examTags: normalizeExamTags(
      Object.prototype.hasOwnProperty.call(payload, "examTags") ? payload.examTags : existing?.examTags,
      existing || payload,
    ),
  };
}

// 已存在题目的状态重算：与新建同一口径——答案已核对 + 归类完整才能是 official。
// 唯一的兼容让步：已经是 official 的历史题目，只要这次修改没把归类掏空，就保持不变，
// 避免历史数据（例如早就缺章节的题）因为一次无关编辑被无谓降级、从用户端消失。
function deriveQuestionStatus(current, normalized) {
  if (current.library !== "official" || current.status === "offline") return current.status;
  if (normalized.answerReviewStatus !== "verified") return "pending_review";
  if (questionClassificationComplete(normalized)) return "official";
  return questionClassificationComplete(current) ? "pending_review" : current.status;
}

function buildNewQuestion(payload, actor, now = Date.now()) {
  const normalized = validateQuestionPayload(payload);
  const library = payload.library === "public" ? "public" : "official";
  // 自动进入 official 需要同时满足：答案已核对通过 + 归类完整（教材/章节/知识点）。
  // 「分类缺失」不是结构错误，但也不得因此自动审核通过或发布——
  // 缺归类的题目一律停在 pending_review，只在平台题目管理里可见，不进入用户端。
  const autoOfficial = normalized.answerReviewStatus === "verified" && questionClassificationComplete(normalized);
  const status = library === "official"
    ? (autoOfficial ? "official" : "pending_review")
    : (allowedStatuses.has(payload.status) ? payload.status : "pending_review");
  return {
    id: String(payload.id || `question-${crypto.randomUUID()}`),
    projectId: examProject.id,
    importBatchId: String(payload.importBatchId || "").trim().slice(0, 120),
    importBatchLabel: String(payload.importBatchLabel || "").trim().slice(0, 200),
    library,
    status,
    ...normalized,
    contributor: library === "public" && payload.contributor ? {
      id: String(payload.contributor.id || ""),
      nickname: String(payload.contributor.nickname || "用户贡献者").slice(0, 40),
    } : null,
    metrics: { helpful: 0, unhelpful: 0, favorites: 0, comments: 0, reports: 0, ...(payload.metrics || {}) },
    version: 1,
    versions: [{ version: 1, updatedAt: now, updatedBy: actor, changeNote: String(payload.changeNote || "首次录入") }],
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  };
}

function assignLegacyImportBatches(items) {
  const assignments = new Map();
  const legacy = items.filter((question) => !question.importBatchId && (question.versions || []).some((version) => version.changeNote === "批量文本导入"))
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const firstCreatedAt = Math.min(...group.map((question) => Number(question.createdAt || 0)));
    const batchId = `legacy-question-import-${firstCreatedAt}`;
    group.forEach((question) => assignments.set(question.id, batchId));
    group = [];
  };
  legacy.forEach((question) => {
    const previous = group[group.length - 1];
    if (previous && Number(question.createdAt || 0) - Number(previous.createdAt || 0) > 5000) flush();
    group.push(question);
  });
  flush();
  return assignments;
}

function summarizeImportBatches(questions) {
  const grouped = new Map();
  questions.filter((question) => question.importBatchId).forEach((question) => {
    if (!grouped.has(question.importBatchId)) grouped.set(question.importBatchId, []);
    grouped.get(question.importBatchId).push(question);
  });
  return [...grouped.entries()].map(([id, items]) => {
    const subjectIds = [...new Set(items.map((item) => item.subjectId).filter(Boolean))];
    const bookIds = [...new Set(items.map((item) => item.bookId).filter(Boolean))];
    const sources = items.map((item) => String(item.sourceLabel || "").trim()).filter(Boolean);
    const sourceLabel = sources.sort((left, right) => sources.filter((item) => item === right).length - sources.filter((item) => item === left).length)[0] || "";
    return {
      id,
      label: items.find((item) => item.importBatchLabel)?.importBatchLabel || sourceLabel || "批量文本导入",
      count: items.length,
      createdAt: Math.min(...items.map((item) => Number(item.createdAt || 0))),
      updatedAt: Math.max(...items.map((item) => Number(item.updatedAt || 0))),
      subjectId: subjectIds.length === 1 ? subjectIds[0] : "mixed",
      bookId: bookIds.length === 1 ? bookIds[0] : "mixed",
      subjectIds,
      bookIds,
    };
  }).sort((left, right) => right.createdAt - left.createdAt);
}

function createQuestionStore(adapter) {
  let frequencyPaperProvider = () => [];
  const read = () => {
    const rawItems = adapter.read();
    const legacyAssignments = assignLegacyImportBatches(rawItems);
    const normalized = rawItems.map((question) => {
    const item = normalizeQuestionTypeFields(clone(question));
    const answerSource = answerSources.has(item.answerSource) ? item.answerSource : "team_verified";
    const answerReviewStatus = normalizeAnswerReviewStatus(item, answerSource);
    const structure = scoringPointStructure(item.type, item.referenceAnswer, item.scoringPoints, item.maxScore);
    const storedAssessment = normalizeDifficultyAssessment(item.difficultyAssessment, item.difficultyScore);
    const resolvedPrimaryKnowledgePoint = String(item.primaryKnowledgePoint || "").trim() || primaryKnowledgePoint(item);
    return {
      ...item,
      primaryKnowledgePoint: resolvedPrimaryKnowledgePoint,
      subKnowledgePoints: Object.prototype.hasOwnProperty.call(item, "subKnowledgePoints")
        ? subKnowledgePoints(item, resolvedPrimaryKnowledgePoint)
        : subKnowledgePoints({ ...item, primaryKnowledgePoint: resolvedPrimaryKnowledgePoint }, resolvedPrimaryKnowledgePoint),
      knowledgeDepthScore: normalizeKnowledgeSignal(item.knowledgeDepthScore),
      contentObscurityScore: normalizeKnowledgeSignal(item.contentObscurityScore),
      answerSource,
      hiddenAnswerVariants: normalizeHiddenAnswerVariants(item.hiddenAnswerVariants),
      answerReviewStatus,
      answerVerified: answerReviewStatus === "verified",
      scoringPointStatus: structure.status,
      scoringPointCandidates: structure.candidates,
      // 材料题组分值来源与「分值待核对」（DEC-099）：读出来一律是合法类型——
      // 旧题（没有这两个字段）得到 scoreBasis="" / scoreNeedsReview=false，管理端不必再判 undefined。
      scoreBasis: normalizeScoreBasis(item.scoreBasis),
      scoreNeedsReview: item.scoreNeedsReview === true,
      importBatchId: item.importBatchId || legacyAssignments.get(item.id) || "",
      difficultyScore: normalizeDifficultyScore(item.difficultyScore),
      difficultyStars: difficultyStars(item.difficultyScore),
      difficultyAssessment: storedAssessment,
      examTags: normalizeExamTags(item.examTags, item),
    };
    });
    const difficultyProfiles = knowledgeDifficultyProfiles(normalized);
    const assessed = normalized.map((question) => {
      const assessment = estimateDifficulty(question, difficultyProfiles);
      const usesManualDifficulty = question.difficultyAssessment.source === "manual" && question.difficultyAssessment.status === "confirmed";
      const hasKnowledgeAssessment = assessment.knowledgeDepthScore > 0 || assessment.contentObscurityScore > 0;
      const resolvedDifficultyScore = usesManualDifficulty ? normalizeDifficultyScore(question.difficultyScore) : assessment.score;
      return {
        ...question,
        primaryKnowledgePoint: assessment.knowledgePoint,
        difficultyScore: resolvedDifficultyScore,
        difficultyStars: difficultyStars(resolvedDifficultyScore),
        difficultyAssessment: usesManualDifficulty ? question.difficultyAssessment : {
          status: hasKnowledgeAssessment ? "suggested" : "unassessed",
          source: hasKnowledgeAssessment ? "knowledge_rule" : "",
          confidence: assessment.confidence,
          reason: assessment.reason,
          assessedAt: question.difficultyAssessment.assessedAt,
          score: resolvedDifficultyScore,
          groupSize: assessment.groupSize,
          knowledgeDepthScore: assessment.knowledgeDepthScore,
          knowledgeObscurityScore: assessment.knowledgeObscurityScore,
          contentObscurityScore: assessment.contentObscurityScore,
        },
      };
    });
    let frequencyPapers = [];
    try {
      frequencyPapers = frequencyPaperProvider();
    } catch (_error) {
      frequencyPapers = [];
    }
    const profiles = frequencyProfiles(assessed, frequencyPapers);
    const withFrequency = assessed.map((question) => ({
      ...question,
      examTrack: inferExamTrack(question),
      frequency: questionFrequency(question, profiles),
    }));
    return decorateQuestionGroups(withFrequency);
  };
  const write = (questions) => {
    const originals = new Map(adapter.read().map((question) => [question.id, question]));
    adapter.write(questions.map((question) => {
      const item = clone(question);
      const original = originals.get(item.id);
      // Read compatibility must not migrate untouched rows during another question's save.
      if (original && original.type !== normalizeQuestionType(original.type)
        && item.type === normalizeQuestionType(original.type) && item.version === original.version) {
        item.type = original.type;
        if (Object.prototype.hasOwnProperty.call(original, "typeLabel")) item.typeLabel = original.typeLabel;
        else delete item.typeLabel;
      }
      return item;
    }));
  };
  return {
    setFrequencyPaperProvider(provider) {
      frequencyPaperProvider = typeof provider === "function" ? provider : (() => []);
    },
    exportState: () => clone(adapter.read()),
    replaceState(state) {
      if (!Array.isArray(state)) throw new Error("question_state_invalid");
      adapter.write(state.map(clone));
      return clone(adapter.read());
    },
    backfillDifficultyScores() {
      const raw = adapter.read();
      const missing = raw.filter((question) => !Number.isFinite(Number(question.difficultyScore)));
      if (!missing.length) return 0;
      write(raw.map((question) => ({
        ...question,
        difficultyScore: normalizeDifficultyScore(question.difficultyScore),
        difficultyStars: difficultyStars(question.difficultyScore),
      })));
      return missing.length;
    },
    catalog() {
      return { project: examProject, subjects: clone(subjects), books: clone(books), questionTypes: questionTypes.map(([id, label]) => ({ id, label })) };
    },
    list(filters = {}) {
      const query = String(filters.query || "").trim().toLowerCase();
      const all = read();
      const listed = filters.includeMergedSources === true
        ? all
        : all.filter((question) => !mergedQuestionTargetId(question));
      const listedWithSerials = withQuestionSerials(listed);
      const questions = listedWithSerials.filter((question) => {
        if (filters.library && question.library !== filters.library) return false;
        if (filters.status && filters.status !== "all" && question.status !== filters.status) return false;
        if (filters.subjectId && filters.subjectId !== "all" && question.subjectId !== filters.subjectId) return false;
        if (Array.isArray(filters.subjectIds) && filters.subjectIds.length && !filters.subjectIds.includes(question.subjectId)) return false;
        if (filters.bookId === UNASSIGNED_BOOK_FILTER) {
          if (String(question.bookId || "").trim()) return false;
        } else if (filters.bookId && filters.bookId !== "all" && question.bookId !== filters.bookId) return false;
        if (Array.isArray(filters.bookIds) && filters.bookIds.length && !matchesBookSelection(question, filters.bookIds)) return false;
        if (Array.isArray(filters.types) && filters.types.length && !filters.types.map(normalizeQuestionType).includes(question.type)) return false;
        if (Array.isArray(filters.importBatchIds) && filters.importBatchIds.length && !filters.importBatchIds.includes(question.importBatchId)) return false;
        if (filters.chapter && filters.chapter !== "all" && question.chapter !== filters.chapter) return false;
        // 「待归类」筛选由缺失字段现场派生，不依赖任何存储状态位。
        if (filters.classification && filters.classification !== "all") {
          const needsClassification = questionNeedsClassification(question);
          if (filters.classification === "pending" && !needsClassification) return false;
          if (filters.classification === "assigned" && needsClassification) return false;
        }
        if (filters.type && filters.type !== "all" && question.type !== normalizeQuestionType(filters.type)) return false;
        if (filters.importBatchId && filters.importBatchId !== "all" && question.importBatchId !== filters.importBatchId) return false;
        if (Array.isArray(filters.difficultyStars) && filters.difficultyStars.length && !filters.difficultyStars.includes(question.difficultyStars)) return false;
        if (query && ![
          question.stem,
          question.chapter,
          ...(question.knowledgePoints || []),
          ...(question.subKnowledgePoints || []),
          ...(question.options || []).flatMap((option) => [option.key, option.text]),
          question.referenceAnswer,
          question.sourceLabel,
          question.id,
        ]
          .join(" ").toLowerCase().includes(query)) return false;
        return true;
      }).sort((left, right) => right.updatedAt - left.updatedAt);
      return {
        questions,
        counts: {
          official: countQuestionUnits(listed.filter((item) => item.library === "official")),
          pendingOfficial: countQuestionUnits(listed.filter((item) => item.library === "official" && item.status === "pending_review")),
          unreviewed: countQuestionUnits(listed.filter((item) => item.library === "official" && item.answerReviewStatus === "unreviewed")),
          doubtful: countQuestionUnits(listed.filter((item) => item.library === "official" && item.answerReviewStatus === "doubtful")),
          public: countQuestionUnits(listed.filter((item) => item.library === "public" && item.status === "public")),
          featured: countQuestionUnits(listed.filter((item) => item.library === "public" && item.status === "featured")),
          pending: countQuestionUnits(listed.filter((item) => item.library === "public" && item.status === "pending_review")),
          offline: countQuestionUnits(listed.filter((item) => item.status === "offline")),
        },
      };
    },
    get(id) {
      const question = read().find((item) => item.id === id);
      return question ? clone(question) : null;
    },
    getMany(ids) {
      const requestedIds = (Array.isArray(ids) ? ids : []).map((id) => String(id));
      if (!requestedIds.length) return [];
      const requested = new Set(requestedIds);
      const byId = new Map(read()
        .filter((question) => requested.has(String(question.id)))
        .map((question) => [String(question.id), question]));
      return requestedIds.map((id) => byId.has(id) ? clone(byId.get(id)) : null);
    },
    importBatches() {
      return summarizeImportBatches(read());
    },
    deleteMany(ids) {
      // 这里**不能**对 id 列表做 slice 截断：2026-09-22 实测过一次 501 个 id 的调用——
      // 旧实现 `.slice(0, 500)` 把第 501 个（真实存在的题）静默丢掉，接口回 200、不报错、
      // 界面照样提示"已删除"，于是"撤销一整个导入批次"会删不干净且没人知道。
      // 语义改成"请求多少就处理多少"：守卫在所有目标上先算完再落一次写，保持全有或全无。
      // 请求体本身有 512KB 上限（server.js readJsonBody），upside 已被输入大小兜住。
      const requestedIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
      if (!requestedIds.length) throw new Error("question_delete_empty");
      const questions = read();
      const { deleted, deletedIds } = projectDeletion(questions, requestedIds);
      if (deleted.some((question) => mergedQuestionTargetId(question))) {
        throw new Error("question_merged_source_read_only");
      }
      if (questions.some((question) => mergedQuestionTargetId(question) && deletedIds.has(mergedQuestionTargetId(question)))) {
        throw new Error("question_merge_target_delete_forbidden");
      }
      if (deleted.length) write(questions.filter((question) => !deletedIds.has(question.id)));
      return {
        deleted: deleted.map(clone),
        notFoundIds: requestedIds.filter((id) => !deletedIds.has(id)),
      };
    },
    // 只读影响面盘点：回答"删这一批会发生什么"，供删除前确认框使用（DEC-094 形态 A）。
    // 与 deleteMany 共用 projectDeletion，保证"盘点说会删的"和"真删的"是同一批（不会漂移）。
    deletionImpact(ids) {
      const requestedIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))];
      if (!requestedIds.length) throw new Error("question_delete_empty");
      const questions = read();
      const { deleted, deletedIds } = projectDeletion(questions, requestedIds);
      const groupIds = new Set(deleted.map((question) => questionGroupId(question)).filter(Boolean));
      const unitKeys = new Set(deleted.map((question) => questionGroupId(question) || `question:${question.id}`));
      const mergedSourceIds = deleted.filter((question) => mergedQuestionTargetId(question)).map((question) => question.id);
      // 「被别的题合并进来」的目标：盘点里要报**目标题自己**（它是阻止整批删除的原因），
      // 判定条件与 deleteMany 的 question_merge_target_delete_forbidden 守卫完全一致。
      const mergedTargetIds = deleted
        .filter((question) => questions.some((other) => mergedQuestionTargetId(other) === question.id))
        .map((question) => question.id);
      return {
        requestedCount: requestedIds.length,
        notFoundIds: requestedIds.filter((id) => !deletedIds.has(id)),
        deletedCount: deleted.length,
        unitCount: unitKeys.size,
        materialGroupCount: groupIds.size,
        offlineCount: deleted.filter((question) => question.status === "offline").length,
        ids: deleted.map((question) => question.id),
        mergedSourceIds,
        mergedTargetIds,
        deleteBlocked: mergedSourceIds.length > 0 || mergedTargetIds.length > 0,
      };
    },
    create(payload, actor = "超级管理员") {
      const questions = read();
      const question = buildNewQuestion(payload, actor);
      if (questions.some((item) => item.id === question.id)) throw new Error("question_id_exists");
      write([question, ...questions]);
      return clone(question);
    },
    previewImport(payloads, actor = "超级管理员") {
      if (!Array.isArray(payloads) || !payloads.length) throw new Error("question_import_empty");
      const existingQuestions = read();
      const persistedIds = new Set(existingQuestions.map((question) => question.id));
      const persistedById = new Map(existingQuestions.map((question) => [question.id, question]));
      const canonicalQuestion = (question) => persistedById.get(mergedQuestionTargetId(question)) || question;
      const existingIds = new Set(persistedIds);
      const questionOwners = new Map();
      const questionOwnerIndexes = new Map();
      const fingerprintOwners = new Map();
      // 「疑似重复」用的倒排索引：3 字组 → 既有题 id。相似度只在同题型、长度相近的候选里算，
      // 靠倒排索引先筛掉绝大多数不可能相似的题对，避免 1268×N 的全量两两比较。
      const suspiciousGramIndex = new Map();
      // 「选项与答案完全一致」这条强证据专用索引：选项集合签名 → 既有题条目。
      // 这条规则完全不看题干相似度，所以**不能**挂在 3 字组倒排索引下——改写过的题干可能一个 3 字组都不共享
      // （实测「下列选项中, 符合"广州市"拼音字母拼写规则的是」与库内「…下列"广州市"拼音正确是（ ）」
      //  3 字组只共享 5 个），必须用"选项签名"这个独立入口来找候选。
      const optionSignatureIndex = new Map();
      const suspiciousItems = [];
      // 「题干字面相似度 ≥ 阈值 ＋ 选择题选项有实质重合（≥ 一半）」这条**模糊路径**判据的唯一实现
      // （2026-09-23 抽到模块作用域，供 previewImport 与 fillMissingFields 共用，禁止各写一份 AGENTS §5）。
      const registerSuspiciousItem = (question, id, stored) => {
        const text = suspiciousText(question);
        // 太短的题干（如「音位是」）区分度低，但不等于不该提示：仍然参与比对，
        // 只把明显无意义的（不足 SUSPICION_MIN_TEXT_LENGTH 个字符）排除，避免索引爆炸。
        if (text.length < SUSPICION_MIN_TEXT_LENGTH) return null;
        const item = {
          id,
          type: question.type,
          stored,
          materialGroupId: question.materialGroupId || null,
          text,
          grams: gramSet(text),
          optionKeys: optionIdentityKeys(question),
          label: String(question.stem || "").replace(/\s+/g, " ").slice(0, 60),
          signature: optionSignature(question),
          // 强证据判据统一走 strongEvidenceBetween（唯一实现）：这里只留题目对象本身。
          question,
        };
        suspiciousItems.push(item);
        for (const gram of triGrams(text)) {
          if (!suspiciousGramIndex.has(gram)) suspiciousGramIndex.set(gram, []);
          suspiciousGramIndex.get(gram).push(item);
        }
        if (item.signature) {
          if (!optionSignatureIndex.has(item.signature)) optionSignatureIndex.set(item.signature, []);
          optionSignatureIndex.get(item.signature).push(item);
        }
        return item;
      };
      existingQuestions.forEach((question) => {
        const owner = canonicalQuestion(question);
        questionOwners.set(question.id, owner);
        questionOwners.set(owner.id, owner);
        fingerprintOwners.set(questionFingerprint(question), owner.id);
        registerSuspiciousItem(question, owner.id, true);
      });
      const nearestExisting = (question) => {
        const text = suspiciousText(question);
        if (text.length < SUSPICION_MIN_TEXT_LENGTH) return null;
        const grams = gramSet(text);
        // ① 先看"选项与答案完全一致"这条强证据：题型相同 + 选项集合完全相同 + 正确答案指向同一选项文本 +
        //    两版题干（剥来源标注后）有 ≥ SUSPICION_COMMON_RUN 字连续公共片段。命中就优先展示它
        //    （它比"字面相似度"更能说明这是同一道题的改写/异文）。
        const signature = optionSignature(question);
        let strong = null;
        if (signature) {
          const grams = gramSet(text);
          for (const item of optionSignatureIndex.get(signature) || []) {
            if (item.stored === false && item.materialGroupId && item.materialGroupId === (question.materialGroupId || null)) continue;
            const evidence = strongEvidenceBetween(question, item.question);
            if (!evidence) continue;
            const score = diceSimilarity(grams, item.grams);
            if (!strong || score > strong.score) strong = { score, item, reason: "options_answer", commonRun: evidence.commonRun };
          }
        }
        if (strong) return strong;
        // ② 再看原本的"题干字面相似度 ≥ 阈值 + 选项有实质重合"路径。
        const counts = new Map();
        for (const gram of new Set(triGrams(text))) {
          const bucket = suspiciousGramIndex.get(gram);
          if (!bucket) continue;
          for (const item of bucket) counts.set(item, (counts.get(item) || 0) + 1);
        }
        let best = null;
        for (const [item, sharedTri] of counts) {
          if (item.type !== question.type) continue;
          // 同一材料题组内的小问共用整段材料，按构造天然高度相似（实测真实录入稿 56 条提示里
          // 45 条是这种"小问互指"），把它们报成"疑似重复"等于把正常的拆分结果说成重复稿。
          // 只跳过**本批内**的兄弟小问：题库里已有的同组题仍照常提示（那可能是上次导入的同一批）。
          if (!item.stored && item.materialGroupId && item.materialGroupId === (question.materialGroupId || null)) continue;
          if (item.grams.size > grams.size * 2.5 || grams.size > item.grams.size * 2.5) continue;
          if (sharedTri * 3 < Math.min(grams.size, item.grams.size) * 0.55) continue; // 粗筛：共同 3 字组太少
          // 判据本身（题型＋选项实质重合＋字面相似度阈值）统一走 fuzzySuspicionBetween（唯一实现），
          // 与"人工确认后的补空缺授权"共用同一个函数。
          const fuzzy = fuzzySuspicionBetween(question, item.question);
          if (fuzzy && (!best || fuzzy.score > best.score)) best = { score: fuzzy.score, item, reason: "stem_similarity", commonRun: null };
        }
        return best;
      };
      return payloads.map((payload, index) => {
        const sourceRange = payload && payload.sourceRange
          && Number.isInteger(payload.sourceRange.start)
          && Number.isInteger(payload.sourceRange.end)
          ? { start: payload.sourceRange.start, end: payload.sourceRange.end }
          : null;
        try {
          const question = buildNewQuestion({ ...payload, library: "official", changeNote: "批量文本导入" }, actor, Date.now() + index);
          if (existingIds.has(question.id)) throw new Error("question_id_exists");
          const fingerprint = questionFingerprint(question);
          // 事实相同＝归一化后「题型＋材料＋题干＋选项」全部一致，只认完整指纹。
          // 不得用「题干相同」单独判重：通用题干（如"下列选项中正确的一项是"）会被大量不同题目共用，
          // DEC-094 明确禁止这种误判；相似但不同的行改走「疑似重复」提示（只提示、不阻断）。
          const duplicateOf = fingerprintOwners.get(fingerprint);
          if (duplicateOf) {
            const existingQuestion = questionOwners.has(duplicateOf) ? clone(questionOwners.get(duplicateOf)) : null;
            const duplicateScope = persistedIds.has(duplicateOf) ? "stored" : "batch";
            return {
              index,
              valid: false,
              duplicate: true,
              duplicateOf,
              duplicateScope,
              duplicateIndex: duplicateScope === "batch" ? questionOwnerIndexes.get(duplicateOf) : null,
              error: "question_duplicate",
              sourceRange,
              source: { stem: question.stem.slice(0, 200) },
              question,
              existingQuestion,
            };
          }
          const nearest = nearestExisting(question);
          existingIds.add(question.id);
          questionOwners.set(question.id, question);
          questionOwnerIndexes.set(question.id, index);
          fingerprintOwners.set(fingerprint, question.id);
          // 本批内后出现的行也要能被后面的行当作「疑似重复」参照（批内相似同样要提示）
          registerSuspiciousItem(question, question.id, false);
          // 可导入的行还要区分「已归类」与「待归类」：缺教材/章节/知识点不是结构错误，
          // 只是提示，导入后仍可保存，并可在批次里后补归属。
          const classification = classificationHint(question);
          return {
            index,
            valid: true,
            needsClassification: Boolean(classification),
            classification,
            // 疑似重复：相似度达标但未达「事实相同」——只提示、不阻断（DEC-094）。
            // questionIndex 只对「本批」有意义：预览接口不下发整题对象（见 server.js 的 items 裁剪），
            // 前端只有靠这个序号才能从色片跳到本批里相似的那一行（DEC-094 ② 的定位入口）。
            suspicion: nearest ? {
              score: Number(nearest.score.toFixed(3)),
              questionId: nearest.item.id,
              scope: nearest.item.stored ? "stored" : "batch",
              questionIndex: nearest.item.stored ? null : (questionOwnerIndexes.get(nearest.item.id) ?? null),
              stem: String(nearest.item.label || "").slice(0, 120),
              // 提示依据：stem_similarity＝题干字面相似度达标；options_answer＝选项集合与正确答案完全一致
              // 且题干有 ≥5 字连续公共片段（2026-09-22 第二次口径修订）——后者的相似度可能远低于阈值，
              // 所以必须把依据下发，前台才能把「为什么提示」说清楚（否则界面显示「重复 36%」很费解）。
              reason: nearest.reason || "stem_similarity",
              commonRun: nearest.commonRun ?? null,
            } : null,
            question,
            sourceRange,
          };
        } catch (error) {
          return {
            index,
            valid: false,
            error: error.message,
            details: error.message === "question_choice_answer_invalid"
              ? choiceValidationDetails(payload)
              : (error.message === "question_required_fields_missing" ? requiredFieldDetails(payload) : undefined),
            sourceRange,
            source: { stem: String(payload && payload.stem || "").slice(0, 200) },
          };
        }
      });
    },
    // `options.decisions` ＝ 操作者在预览里做的人工裁决（产品负责人 2026-09-22 定稿）：
    //   ① `confirmedDuplicateIndexes`：「确认是同一道题」——该行按判重处理，**不重复入库**（DEC-094 ①）；
    //   ② `dismissedSuspicionIndexes`：「确认不是重复」——只影响预览里的提示显示，入库行为不变，但留痕。
    // **只认服务端自己标过疑似的行**：下标若不在 `valid && suspicion` 里一律忽略（否则一个错误下标
    // 就能把一道正常题目悄悄挡在库外）；被忽略的下标原样回报，便于排查前端状态错位。
    importMany(payloads, actor = "超级管理员", options = {}) {
      const batchId = `question-import-${crypto.randomUUID()}`;
      const batchLabel = String(payloads.find((payload) => payload && payload.sourceLabel)?.sourceLabel || "批量文本导入").trim().slice(0, 200);
      const batchedPayloads = payloads.map((payload) => ({ ...payload, importBatchId: batchId, importBatchLabel: batchLabel }));
      const preview = this.previewImport(batchedPayloads, actor);
      const toIndexSet = (value) => new Set((Array.isArray(value) ? value : []).map((item) => Number(item)).filter((item) => Number.isInteger(item)));
      const requested = options.decisions && typeof options.decisions === "object" ? options.decisions : {};
      const suspectIndexes = new Set(preview.filter((item) => item.valid && item.suspicion).map((item) => item.index));
      const confirmedIndexes = toIndexSet(requested.confirmedDuplicateIndexes);
      const dismissedIndexes = toIndexSet(requested.dismissedSuspicionIndexes);
      const confirmed = [...confirmedIndexes].filter((index) => suspectIndexes.has(index)).sort((left, right) => left - right);
      const dismissed = [...dismissedIndexes].filter((index) => suspectIndexes.has(index)).sort((left, right) => left - right);
      const ignoredIndexes = [...confirmedIndexes, ...dismissedIndexes].filter((index) => !suspectIndexes.has(index)).sort((left, right) => left - right);
      const confirmedSet = new Set(confirmed);
      const verdictOf = (index, verdict) => {
        const item = preview.find((entry) => entry.index === index);
        return {
          index,
          verdict,
          questionId: item.question.id,
          stem: String(item.question.stem || "").slice(0, 120),
          ...item.suspicion,
        };
      };
      const questions = read();
      const created = preview.filter((item) => item.valid && !confirmedSet.has(item.index)).map((item) => item.question);
      if (created.length) write([...created.reverse(), ...questions]);
      return {
        created: created.map(clone),
        duplicates: preview.filter((item) => item.duplicate).map(({ question, existingQuestion, ...item }) => item),
        errors: preview.filter((item) => !item.valid && !item.duplicate).map(({ question, ...item }) => item),
        pendingClassification: preview.filter((item) => item.valid && item.needsClassification && !confirmedSet.has(item.index)).map((item) => ({
          index: item.index,
          questionId: item.question.id,
          missing: item.classification.missing,
          missingLabels: item.classification.missingLabels,
        })),
        // 疑似重复（只提示、不阻断）：已导入的行同样回报，便于导入后回看。
        // 「确认是同一道题」的行已经不算可导入，从疑似里移出、另走 confirmedDuplicates。
        suspected: preview.filter((item) => item.valid && item.suspicion && !confirmedSet.has(item.index)).map((item) => ({
          index: item.index,
          questionId: item.question.id,
          stem: String(item.question.stem || "").slice(0, 120),
          ...item.suspicion,
        })),
        // 人工裁决留痕：确认重复（未入库）／确认不是重复（照常入库，仅记录判定）
        confirmedDuplicates: confirmed.map((index) => verdictOf(index, "confirmed_duplicate")),
        dismissedSuspicions: dismissed.map((index) => verdictOf(index, "dismissed_suspicion")),
        ignoredDecisionIndexes: ignoredIndexes,
        total: preview.length,
        batchId,
      };
    },
    // 批次补充归属：可以只给科目（教材留空），也可以只改教材（章节/知识点由下层规则自动清理），
    // 还可以顺带指定章节与知识点。永远更新原题并追加版本，不新建题、不丢来源与审核记录。
    updateImportBatch(batchId, payload, actor = "超级管理员") {
      const subjectId = String(payload && payload.subjectId || "");
      const bookId = String(payload && payload.bookId || "");
      const questions = read();
      const indexes = questions.map((question, index) => question.importBatchId === batchId ? index : -1).filter((index) => index >= 0);
      if (!indexes.length) throw new Error("question_import_batch_not_found");
      indexes.forEach((index) => assertQuestionNotMergedSource(questions[index]));
      const patch = {
        subjectId,
        bookId,
        ...(payload && payload.chapter !== undefined ? { chapter: payload.chapter } : {}),
        ...(payload && payload.knowledgePoints !== undefined ? { knowledgePoints: payload.knowledgePoints } : {}),
      };
      const now = Date.now();
      indexes.forEach((index, offset) => {
        const current = questions[index];
        const normalized = validateQuestionPayload(patch, current);
        const nextVersion = Number(current.version || 1) + 1;
        questions[index] = {
          ...current,
          ...normalized,
          status: deriveQuestionStatus(current, normalized),
          importBatchId: batchId,
          version: nextVersion,
          updatedAt: now + offset,
          updatedBy: actor,
          versions: [{
            version: nextVersion,
            updatedAt: now + offset,
            updatedBy: actor,
            changeNote: String(payload && payload.changeNote || "批次补充归属（科目／教材／章节／知识点）"),
            previousSnapshot: questionSnapshot(current),
          }, ...(current.versions || [])].slice(0, 50),
        };
      });
      write(questions);
      const updated = indexes.map((index) => questions[index]);
      return {
        batch: summarizeImportBatches(questions).find((batch) => batch.id === batchId),
        updated: updated.map(clone),
        // 补完归属后仍有待归类题的条数：批次补充归属是一等入口，UI 要能如实告知结果。
        pendingClassificationCount: updated.filter((question) => questionNeedsClassification(question)).length,
      };
    },
    update(id, payload, actor = "超级管理员") {
      const questions = read();
      const index = questions.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("question_not_found");
      const current = questions[index];
      assertQuestionNotMergedSource(current);
      const normalized = validateQuestionPayload(payload, current);
      const nextVersion = Number(current.version || 1) + 1;
      const now = Date.now();
      questions[index] = {
        ...current,
        ...normalized,
        status: deriveQuestionStatus(current, normalized),
        version: nextVersion,
        updatedAt: now,
        updatedBy: actor,
        versions: [{
          version: nextVersion,
          updatedAt: now,
          updatedBy: actor,
          changeNote: String(payload.changeNote || "编辑题目"),
          previousSnapshot: questionSnapshot(current),
        }, ...(current.versions || [])].slice(0, 50),
      };
      write(questions);
      return clone(questions[index]);
    },
    // 择优补充（DEC-094 ③ / §4.6.2 第 478 行）：事实相同的重复稿**不新建题**，只把既有题
    // 「空缺」的字段补进**同一道题**——新增版本、保留原答案分层与审核记录、不覆盖任何非空字段
    // （尤其不覆盖已人工审核的答案）。归属（教材/章节/知识点）**不在这里补**：它会改变题目的
    // 可见状态，必须走 DEC-093 的「批次补充归属」或「完善题目」，否则导入会绕过归类门槛。
    fillMissingFields(existingId, candidate, actor = "超级管理员", options = {}) {
      const questions = read();
      const current = questions.find((item) => item.id === existingId);
      if (!current) throw new Error("question_not_found");
      assertQuestionNotMergedSource(current);
      const incoming = buildNewQuestion({ ...candidate, library: "official", changeNote: "导入择优补充校验" }, actor, Date.now());
      // 服务端是唯一判据：默认只接受事实相同的稿（完整指纹一致），不信任前端传来的"是重复"。
      // 例外（产品负责人 2026-09-22 第三次口径，正文见 产品手册 §4.6.4「择优补充…」末句：「疑似重复
      // 默认不提供择优补充：必须先由人工在对比弹窗里确认『就是同一道题』，确认后才可『只补空缺』」）：
      // 改写型疑似（题干不同 → 完整指纹天然不同）在人工确认后允许**补空缺**。授权的边界有三条：
      //   ① 不能只信前端的"我确认过了"——必须带 `operatorConfirmedSuspicion` 标记（那是操作者在对比
      //      弹窗里点过「确认是同一道题」的凭据），没带一律照旧 422；
      //   ② 仍然只走「择优补充」的全部安全约束：只填空缺、绝不覆盖任何非空字段、答案状态降级待核对、
      //      归属不在这里改——**因此这条授权不会覆盖任何已审核内容**；
      //   ③ 要**覆盖非空字段**（含已审核答案）是另一条更严的路：必须两版事实相同，或人工确认**且**
      //      服务端用 strongEvidenceBetween() 重算强证据成立，走 absorbComparisonFields。
      // 【2026-09-23 00:2x 修正（产品负责人真机报「写入既有题失败：question_merge_requires_identical」）】：
      //   此前这里对"人工确认的疑似"也要求 strongEvidenceBetween() 成立，而该判据含「选项集合完全
      //   相同」——恰恰把**疑似改写型里最常见的一类**（两版选项文字略有出入，例如"现代汉语是现代汉民族
      //   的语言" vs "…所使用的语言"）全挡在门外，确认了也一个字写不进去；产品手册那条口径没有这道
      //   门槛（覆盖非空才有），且补空缺本来就不动任何既有内容，所以按手册放开标记这一关。
      const operatorConfirmed = options.operatorConfirmedSuspicion != null && options.operatorConfirmedSuspicion !== false;
      let authorization = "identical_fingerprint";
      let evidence = null;
      if (questionFingerprint(incoming) !== questionFingerprint(current)) {
        if (!operatorConfirmed) throw new Error("question_merge_requires_identical");
        // 服务端自己重算"这两版确实像到会被查重提示"——强证据（选项与答案都对得上）或模糊判据
        // （字面相似度 + 选项实质重合）任一成立即可；两者都不成立说明这个标记是伪造的（或根本不是
        // 同一道题），照旧 422。这一关挡的是"乱盖确认章"，不是"选项文字略有出入"。
        evidence = strongEvidenceBetween(current, incoming) || fuzzySuspicionBetween(current, incoming);
        if (!evidence) throw new Error("question_merge_requires_identical");
        authorization = "operator_confirmed_suspicion";
      }
      const isEmpty = (value) => value == null || (Array.isArray(value) ? !value.length : String(value).trim() === "");
      const patch = {};
      const filled = [];
      const conflicts = [];
      const take = (field, value) => {
        if (isEmpty(value)) return;
        if (isEmpty(current[field])) { patch[field] = value; filled.push(field); return; }
        if (JSON.stringify(current[field]) !== JSON.stringify(value)) conflicts.push(field);
      };
      take("referenceAnswer", incoming.referenceAnswer);
      take("sourceLabel", incoming.sourceLabel);
      take("sourcePage", incoming.sourcePage);
      // 答案分层：逐层补空缺（official / ai / community），已有内容的层不动、只记冲突。
      // 取值与写入路径一致地走 normalizeAnswerVariants：official 层会按答案来源从参考答案派生，
      // 因此这里报出的 filled/conflicts 就是这次版本真正会写进去的内容。
      const explicitVariants = incoming.answerVariants && typeof incoming.answerVariants === "object"
        ? incoming.answerVariants
        : {};
      const expectedVariants = normalizeAnswerVariants(explicitVariants, incoming.referenceAnswer, incoming.answerSource);
      const variantPatch = {};
      for (const key of ["official", "ai", "community"]) {
        const value = expectedVariants[key];
        if (isEmpty(value)) continue;
        const currentValue = current.answerVariants && current.answerVariants[key];
        if (isEmpty(currentValue)) { variantPatch[key] = value; filled.push(`answerVariants.${key}`); }
        else if (String(currentValue) !== String(value)) conflicts.push(`answerVariants.${key}`);
      }
      if (Object.keys(variantPatch).length) patch.answerVariants = { ...(current.answerVariants || {}), ...variantPatch };
      // 补了答案文本、而原题的答案来源是 missing 时，必须同时给出真实来源，否则会被来源校验拦下。
      // 这里只采信新稿**明确声明**的来源；没有声明就按「资料答案（pdf_answer）」记录——
      // 绝不能沿用导入默认的 team_verified：normalizeAnswerReviewStatus 会把 team_verified 直接
      // 视为"已核对"，而"已核对"是题目转 official（对用户可见）的前置条件，
      // 等于让一次导入静默把没人核对过的答案标成已核对。
      if (patch.referenceAnswer && current.answerSource === "missing") {
        patch.answerSource = answerSources.has(candidate.answerSource) && candidate.answerSource !== "missing"
          ? candidate.answerSource
          : "pdf_answer";
        filled.push("answerSource");
      }
      if (!Object.keys(patch).length) {
        return { updated: false, filled: [], conflicts, authorization, evidence, question: clone(current), version: current.version };
      }
      // 版本说明要能区分"两版事实相同"与"人工确认的改写型疑似"——否则日后回看版本历史，
      // 会以为当初是靠指纹判定的（AGENTS §6：「已确认 / 已实现 / 已验证」必须分开写）。
      patch.changeNote = authorization === "operator_confirmed_suspicion"
        ? "导入择优补充（人工确认的疑似重复：只补空缺，未覆盖任何非空字段）"
        : "导入择优补充（事实相同的重复稿）";
      const updated = this.update(existingId, patch, actor);
      return { updated: true, filled, conflicts, authorization, evidence, question: updated, version: updated.version };
    },
    // 对比处置（产品负责人 2026-09-22 定稿）：两道**事实相同**的题在对比弹窗里发现同一字段两版不同
    // （如参考答案一版更全、单选答案一版对），由操作者显式点名"这几个字段用导入稿这版"或"把两版参考
    // 答案合并"。与「择优补充」的分工：择优补充＝导入时自动补空缺（非空一律不动）；本方法＝对比后由人
    // 处置冲突（可以覆盖非空），是"这一版更好，用它"的唯一入口。
    // 不可逾越的边界：
    //   1) 只对**同一道题**的两版开放：事实相同（服务端重算指纹），或人工在对比弹窗里点过「确认是同一道题」
    //      且服务端能重算出"这两版像到会被查重提示"（不信前端传来的"是重复"；2026-09-23 起对人工确认行
    //      不再要求"选项逐字相同"——产品负责人：不能靠文字一模一样来辨别是否是同一道题）；
    //   2) 覆盖必须逐字段点名，没有"整题覆盖"入口；
    //   3) 动了答案 → 版本 +1、答案审核状态降级 unreviewed（待核对）、answerSource 采信导入稿声明
    //      （没声明就记 pdf_answer）——绝不让一次导入把没人核对过的答案留成"已核对"；
    //   4) 归属（教材/章节/知识点）不在这里改：走 DEC-093 的「批次补充归属」或「完善题目」。
    absorbComparisonFields(existingId, candidate, options = {}, actor = "超级管理员") {
      const questions = read();
      const current = questions.find((item) => item.id === existingId);
      if (!current) throw new Error("question_not_found");
      assertQuestionNotMergedSource(current);
      const incoming = buildNewQuestion({ ...candidate, library: "official", changeNote: "导入对比处置校验" }, actor, Date.now());
      // 授权两条路（产品负责人 2026-09-22 第五次口径修订；2026-09-23 00:5x 按他真机反馈放宽②）：
      //   ① identical_fingerprint ＝ 两版事实相同（原口径）；
      //   ② operator_confirmed_suspicion ＝ 人工在对比弹窗里点过「确认是同一道题」的疑似行
      //      （题干不同 → 完整指纹天然不同）。**服务端不只信前端的布尔标记**：自己重算"这两版确实像到
      //      会被查重提示"——强证据（题型＋选项集合＋答案指向＋连续片段）**或**模糊判据（字面相似度＋选项
      //      实质重合）任一成立即可，两者都不成立（伪造标记、或根本不是同一道题）一律
      //      question_merge_requires_identical。
      // 【2026-09-23 00:5x 产品负责人原话：「不能靠文字一模一样来辨别是否是同一道题」——此前这里只认
      //   strongEvidenceBetween()，而它含「选项集合完全相同」，把"两版措辞不同但意思相同"的同一道题全挡
      //   在门外（他真机上那条正是这一类）。判"是不是同一道题"的依据是**人工确认**，这里的重算只是一道
      //   "别把内容写到无关题目上"的兜底，因此改用与预览提示同一个模糊判据，而不是逐字比较。】
      const operatorConfirmed = options.operatorConfirmedSuspicion != null && options.operatorConfirmedSuspicion !== false;
      let authorization = "identical_fingerprint";
      let evidence = null;
      if (questionFingerprint(incoming) !== questionFingerprint(current)) {
        if (!operatorConfirmed) throw new Error("question_merge_requires_identical");
        evidence = strongEvidenceBetween(current, incoming) || fuzzySuspicionBetween(current, incoming);
        if (!evidence) throw new Error("question_merge_requires_identical");
        authorization = "operator_confirmed_suspicion";
      }
      const allowedFields = new Set(["correctAnswer", "referenceAnswer", "sourceLabel", "sourcePage"]);
      const requested = [...new Set((Array.isArray(options.fields) ? options.fields : []).map((value) => String(value)))];
      if (!requested.length) throw new Error("question_absorb_fields_required");
      if (requested.some((field) => !allowedFields.has(field))) throw new Error("question_absorb_field_invalid");
      const isBlank = (value) => value == null || (Array.isArray(value) ? !value.length : String(value).trim() === "");
      const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const patch = {};
      const filled = [];
      const overwritten = [];
      const unchanged = [];
      const applyField = (field, nextValue) => {
        if (isBlank(nextValue) || sameValue(current[field], nextValue)) { unchanged.push(field); return; }
        patch[field] = nextValue;
        if (isBlank(current[field])) filled.push(field); else overwritten.push(field);
      };
      requested.forEach((field) => {
        if (field === "referenceAnswer") {
          const currentText = String(current.referenceAnswer || "").trim();
          const nextText = String(incoming.referenceAnswer || "").trim();
          // 合并两版：既有那版原样保留，导入稿那版另起一段并注明出处，人工后续清理。
          if (options.mergeReferenceAnswer === true && currentText && nextText && currentText !== nextText) {
            patch.referenceAnswer = `${currentText}\n\n【导入稿同题另版参考答案】${nextText}`.slice(0, 20000);
            overwritten.push("referenceAnswer(合并两版)");
            return;
          }
          applyField("referenceAnswer", nextText || undefined);
          return;
        }
        applyField(field, field === "correctAnswer" ? [...new Set(incoming.correctAnswer || [])] : incoming[field]);
      });
      if (!Object.keys(patch).length) {
        return { updated: false, filled, overwritten, unchanged, conflicts: [], authorization, evidence, question: clone(current), version: current.version };
      }
      // 答案相关字段被改写 → 降级为"待核对"，并让答案分层与来源跟着走（见方法头注释第 3 条）。
      const answerTouched = Object.prototype.hasOwnProperty.call(patch, "referenceAnswer")
        || Object.prototype.hasOwnProperty.call(patch, "correctAnswer");
      if (answerTouched) {
        const declaredSource = answerSources.has(candidate.answerSource) && candidate.answerSource !== "missing"
          ? candidate.answerSource
          : "pdf_answer";
        const nextReference = String(patch.referenceAnswer || current.referenceAnswer || "").trim();
        const variants = normalizeAnswerVariants(
          candidate.answerVariants && typeof candidate.answerVariants === "object" ? candidate.answerVariants : {},
          nextReference,
          declaredSource,
        );
        patch.answerSource = declaredSource;
        patch.answerVariants = {
          ...(current.answerVariants || {}),
          official: variants.official || nextReference || (current.answerVariants || {}).official || "",
        };
        patch.answerReviewStatus = "unreviewed";
      }
      // 版本说明要能区分两条授权来源——否则日后回看版本历史，会以为当初是靠指纹判定的事实相同
      // （AGENTS §6：「已确认 / 已实现 / 已验证」必须分开写）。
      patch.changeNote = authorization === "operator_confirmed_suspicion"
        ? `导入对比处置（人工确认的疑似重复：逐字段点名覆盖）${overwritten.concat(filled).join("、")}`
        : `导入对比处置：用导入稿覆盖 ${overwritten.concat(filled).join("、")}`;
      const updated = this.update(existingId, patch, actor);
      return {
        updated: true,
        filled,
        overwritten,
        unchanged,
        conflicts: [],
        authorization,
        evidence,
        answerReviewStatus: updated.answerReviewStatus,
        question: updated,
        version: updated.version,
      };
    },
    transition(id, action, actor = "超级管理员") {
      const questions = read();
      const index = questions.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("question_not_found");
      const current = questions[index];
      assertQuestionNotMergedSource(current);
      if (action === "promote_official" && current.answerReviewStatus !== "verified") throw new Error("question_answer_review_required");
      const transitions = {
        publish: { library: "public", status: "public", note: "通过审核，进入公共题库" },
        feature: { library: "public", status: "featured", note: "进入公共精选题库" },
        offline: { status: "offline", note: "内容下架" },
        // 恢复必须走与新录入/编辑完全相同的口径：答案已核对 + 归类完整才回到 official，
        // 否则一道待归类题只要「下架再恢复」就能绕过归类门槛出现在用户端。
        restore: {
          status: current.library === "official"
            ? (current.answerReviewStatus === "verified" && questionClassificationComplete(current) ? "official" : "pending_review")
            : "public",
          note: "恢复题目",
        },
        promote_official: { library: "official", status: "official", note: "从公共题库转入平台题库" },
      };
      const transition = transitions[action];
      if (!transition) throw new Error("question_transition_invalid");
      const now = Date.now();
      const nextVersion = Number(current.version || 1) + 1;
      questions[index] = {
        ...current,
        ...transition,
        version: nextVersion,
        updatedAt: now,
        updatedBy: actor,
        versions: [{ version: nextVersion, updatedAt: now, updatedBy: actor, changeNote: transition.note }, ...(current.versions || [])].slice(0, 50),
      };
      delete questions[index].note;
      write(questions);
      return clone(questions[index]);
    },
    transitionMany(ids, action, actor = "超级管理员") {
      if (!["offline", "restore"].includes(action)) throw new Error("question_transition_invalid");
      const requested = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
      if (!requested.size) throw new Error("question_transition_empty");
      const questions = read();
      const requestedGroups = new Set(questions
        .filter((question) => requested.has(question.id))
        .map((question) => questionGroupId(question))
        .filter(Boolean));
      const targets = questions.filter((question) => requested.has(question.id) || requestedGroups.has(questionGroupId(question)));
      if (!targets.length) throw new Error("question_not_found");
      targets.forEach(assertQuestionNotMergedSource);
      targets.forEach((question) => this.transition(question.id, action, actor));
      return targets.map((question) => this.get(question.id));
    },
  };
}

function createFileQuestionStore(filePath = path.resolve(__dirname, "../../../.runtime/questions.json"), options = {}) {
  let cachedQuestions = null;
  let cachedSignature = "";
  return createQuestionStore({
    read() {
      try {
        const stats = fs.statSync(filePath);
        const signature = `${stats.size}:${stats.mtimeMs}`;
        if (cachedQuestions && cachedSignature === signature) return cachedQuestions;
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (options.requireExisting && !Array.isArray(value)) throw new Error("question_store_invalid");
        cachedQuestions = Array.isArray(value) ? value : seedQuestions();
        cachedSignature = signature;
        return cachedQuestions;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (options.requireExisting) throw new Error("new_library_questions_missing");
        if (!cachedQuestions) cachedQuestions = seedQuestions();
        return cachedQuestions;
      }
    },
    write(questions) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(questions, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      const stats = fs.statSync(filePath);
      cachedQuestions = questions;
      cachedSignature = `${stats.size}:${stats.mtimeMs}`;
    },
  });
}

function createMemoryQuestionStore(initialQuestions = seedQuestions()) {
  let questions = clone(initialQuestions);
  return createQuestionStore({ read: () => clone(questions), write: (next) => { questions = clone(next); } });
}

module.exports = {
  createFileQuestionStore,
  createMemoryQuestionStore,
  questionTypes,
  normalizeDifficultyScore,
  difficultyStars,
  normalizeExamTags,
  // 「事实相同」的唯一定义（题型＋材料＋题干＋选项的归一化指纹）：
  // 后台预览要判断"这一行能不能择优补充到既有题"，判据必须和 Store 完全同源，
  // 不能在界面里自己再写一套字段比较——否则会出现"Store 认定事实相同、界面却判有差异"
  // 的分裂（2026-09-22 实测：既有题题干没有「（　）。」、导入稿有，归一化后其实一致）。
  questionFingerprint,
  UNASSIGNED_BOOK_FILTER,
  // 教材多选匹配（含哨兵语义）——「完善题目」列表的多选筛选与 Store 共用这一处判定。
  matchesBookSelection,
};
