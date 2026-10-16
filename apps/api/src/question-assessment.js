const trackLabels = {
  insert: "插本",
  upgrade: "专升本",
  graduate: "考研",
  unknown: "未标明",
};

const paperWeights = {
  past_paper: 1,
  official_mock: 0.4,
};

function inferExamTrack(question = {}) {
  const explicitTags = [...new Set((Array.isArray(question.examTags) ? question.examTags : [])
    .map((value) => String(value || "").trim())
    .filter((value) => Object.prototype.hasOwnProperty.call(trackLabels, value) && value !== "unknown"))];
  if (explicitTags.length) return explicitTags[0];
  const source = [question.sourceLabel, question.importBatchLabel, question.stem].join(" ");
  if (/专插本|插本/.test(source)) return "insert";
  if (/专升本|统招升本/.test(source)) return "upgrade";
  if (/考研|研究生|大学.*研/.test(source)) return "graduate";
  if (/[（(\[【]\s*[^）)\]】]{0,30}(?:大学|学院)\s*\d{4}\s*年\s*[）)\]】]/.test(source)) return "graduate";
  if (String(question.projectId || "").startsWith("gd-zsb-")) return "insert";
  return "unknown";
}

function primaryKnowledgePoint(question = {}) {
  if (String(question.primaryKnowledgePoint || "").trim()) return String(question.primaryKnowledgePoint).trim();
  const points = (Array.isArray(question.knowledgePoints) ? question.knowledgePoints : []).map((value) => String(value || "").trim()).filter(Boolean);
  // 没有知识点时返回空值，不再造「未归类知识点」占位串：
  // 占位串会冒充真实归类（产品手册 §3.5「不得为了完成流程强行选择知识点」）。
  // 「待归类」由 question-classification-state.js 现场派生，不靠占位值表达。
  if (!points.length) return "";
  const chapterParts = String(question.chapter || "").split(/[>·]/).map((value) => normalizeKnowledgePoint(value.replace(/^第[一二三四五六七八九十百\d]+[章节单元部编]\s*/, ""))).filter(Boolean);
  const conceptualPoints = points.filter((point) => !chapterParts.includes(normalizeKnowledgePoint(point)));
  return conceptualPoints[0] || points[0];
}

function knowledgeGroupKey(question, point = primaryKnowledgePoint(question)) {
  return [question.subjectId, question.bookId, normalizeKnowledgePoint(point)].map((value) => String(value || "")).join("\u0000");
}

function normalizeKnowledgeList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[，,；;\n]/);
  const seen = new Set();
  return items.map((item) => String(item || "").normalize("NFKC").trim()).filter((item) => {
    const key = normalizeKnowledgePoint(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function subKnowledgePoints(question = {}, primaryPoint = primaryKnowledgePoint(question)) {
  if (Object.prototype.hasOwnProperty.call(question, "subKnowledgePoints")) {
    return normalizeKnowledgeList(question.subKnowledgePoints);
  }
  const primary = normalizeKnowledgePoint(primaryPoint);
  const secondary = normalizeKnowledgeList(question.knowledgePoints)
    .filter((point) => normalizeKnowledgePoint(point) !== primary);
  const chapterParts = String(question.chapter || "").split(/[>·]/).map((value) => value.trim()).filter(Boolean);
  const thirdLevelHeading = chapterParts.length >= 3 ? chapterParts[chapterParts.length - 1] : "";
  if (thirdLevelHeading
    && normalizeKnowledgePoint(thirdLevelHeading) !== primary
    && !secondary.some((point) => normalizeKnowledgePoint(point) === normalizeKnowledgePoint(thirdLevelHeading))) {
    secondary.push(thirdLevelHeading);
  }
  return normalizeKnowledgeList(secondary);
}

function normalizeKnowledgeSignal(value) {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 ? Math.min(100, Math.max(1, Math.round(score))) : 0;
}

function knowledgeContentSignals(question, primaryPoint) {
  const depth = normalizeKnowledgeSignal(question.knowledgeDepthScore);
  const obscurity = normalizeKnowledgeSignal(question.contentObscurityScore);
  return {
    depth,
    obscurity,
    hasDepth: depth > 0,
    hasObscurity: obscurity > 0,
    secondaryPoints: subKnowledgePoints(question, primaryPoint),
  };
}

function knowledgeDifficultyProfiles(questions = []) {
  const profiles = new Map();
  const groups = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question, index) => {
    const knowledgePoint = primaryKnowledgePoint(question);
    const key = knowledgeGroupKey(question, knowledgePoint);
    const entry = {
      question,
      id: String(question.id || `__question_${index}`),
      knowledgePoint,
      ...knowledgeContentSignals(question, knowledgePoint),
    };
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  });

  groups.forEach((group) => {
    group.forEach((entry) => {
      entry.hasAssessment = entry.hasDepth || entry.hasObscurity;
      entry.rawScore = ((entry.hasDepth ? entry.depth : 50) + (entry.hasObscurity ? entry.obscurity : 50)) / 2;
    });

    const assessedEntries = group.filter((entry) => entry.hasAssessment);
    group.forEach((entry) => {
      const lowerCount = assessedEntries.filter((candidate) => candidate.rawScore < entry.rawScore).length;
      const tiedCount = assessedEntries.filter((candidate) => candidate.rawScore === entry.rawScore).length;
      const percentile = entry.hasAssessment && assessedEntries.length
        ? ((lowerCount + tiedCount / 2) / assessedEntries.length) * 100
        : 50;
      const score = Math.min(100, Math.max(1, Math.round(percentile)));
      const reasonParts = [`在“${entry.knowledgePoint}”知识点组内处于约第 ${score} 百分位`];
      if (entry.secondaryPoints.length) reasonParts.push(`细分内容：${entry.secondaryPoints.join("、")}`);
      if (entry.hasDepth) reasonParts.push(`知识深度 ${entry.depth}`);
      if (entry.hasObscurity) reasonParts.push(`内容偏僻度 ${entry.obscurity}`);
      if (!entry.hasAssessment) reasonParts.push("深度和偏僻度待评，暂按组内中位");
      const signalCount = Number(entry.hasDepth) + Number(entry.hasObscurity);
      const coverage = group.length ? assessedEntries.length / group.length : 0;
      profiles.set(entry.id, {
        score,
        knowledgePoint: entry.knowledgePoint,
        subKnowledgePoints: entry.secondaryPoints,
        groupSize: group.length,
        assessedGroupSize: assessedEntries.length,
        knowledgeDepthScore: entry.depth,
        knowledgeObscurityScore: entry.obscurity,
        contentObscurityScore: entry.obscurity,
        reason: reasonParts.join("；"),
        confidence: entry.hasAssessment
          ? Math.min(0.9, 0.28 + signalCount * 0.18 + Math.min(0.2, assessedEntries.length * 0.025) + coverage * 0.08)
          : Math.min(0.24, 0.1 + group.length * 0.01),
      });
    });
  });
  return profiles;
}

function estimateDifficulty(question = {}, profiles = null) {
  const id = String(question.id || "__target");
  const available = profiles && profiles.get(id);
  if (available) return available;
  return knowledgeDifficultyProfiles([{ ...question, id }]).get(id);
}

function normalizeKnowledgePoint(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^[（(]?\s*(?:[一二三四五六七八九十百]+|\d+)\s*[）).、]\s*/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function inferredPaper(question = {}) {
  const label = String(question.sourceLabel || question.importBatchLabel || "").trim();
  if (!label || /教材|正文生成|RAG|练习|辅导|题库|章节|精选|详解|笔记|讲义/.test(label)) return null;
  const normalized = label.replace(/\.(?:pdf|docx?|txt|html?)$/i, "").replace(/\s+/g, " ").trim();
  if (/模拟(?:试卷|卷)|模拟题/.test(label) && !/\d+\s*套|汇编/.test(label)) {
    return { id: `source:mock:${normalized}`, title: normalized, kind: "official_mock", track: inferExamTrack(question) };
  }
  if (/真题|考试试题|考试卷/.test(label) && /\d{4}\s*年/.test(label)) {
    return { id: `source:past:${normalized}`, title: normalized, kind: "past_paper", track: inferExamTrack(question) };
  }
  return null;
}

function paperTrack(paper, questions) {
  if (paper.examTrack && paper.examTrack !== "unknown") return paper.examTrack;
  const counts = new Map();
  questions.forEach((question) => {
    const track = inferExamTrack(question);
    if (track !== "unknown") counts.set(track, (counts.get(track) || 0) + 1);
  });
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (dominant) return dominant[0];
  return inferExamTrack({ sourceLabel: [paper.title, paper.sourceLabel, paper.description].join(" "), projectId: paper.projectId });
}

function frequencyProfiles(questions = [], papers = []) {
  const profiles = new Map();
  profiles.trackPapers = new Map();
  const questionsById = new Map(questions.map((question) => [String(question.id), question]));
  const explicitMemberships = new Map();

  const addMembership = (questionId, kind) => {
    const kinds = explicitMemberships.get(questionId) || new Set();
    kinds.add(kind);
    explicitMemberships.set(questionId, kinds);
  };

  (Array.isArray(papers) ? papers : []).forEach((paper) => {
    (paper.questionIds || []).map(String).forEach((questionId) => addMembership(questionId, paper.kind));
  });

  const registerPaper = (paper, paperQuestions) => {
    const weight = paperWeights[paper.kind];
    const track = paper.track || paperTrack(paper, paperQuestions);
    if (!weight || !paper.id || track === "unknown" || !paperQuestions.length) return;
    const trackPapers = profiles.trackPapers.get(track) || new Map();
    if (trackPapers.has(paper.id)) return;
    trackPapers.set(paper.id, { id: paper.id, kind: paper.kind, weight, title: paper.title || "" });
    profiles.trackPapers.set(track, trackPapers);

    const points = new Set(paperQuestions.flatMap((question) => (question.knowledgePoints || []).map(normalizeKnowledgePoint).filter(Boolean)));
    points.forEach((point) => {
      const key = `${track}\u0000${point}`;
      const entry = profiles.get(key) || { papers: new Map(), weight: 0 };
      entry.papers.set(paper.id, { kind: paper.kind, weight });
      entry.weight += weight;
      profiles.set(key, entry);
    });
  };

  (Array.isArray(papers) ? papers : []).forEach((paper) => {
    if (paper.status && paper.status !== "published") return;
    const paperQuestions = (paper.questionIds || []).map((id) => questionsById.get(String(id))).filter(Boolean);
    registerPaper({ ...paper, track: paperTrack(paper, paperQuestions) }, paperQuestions);
  });

  const inferred = new Map();
  questions.forEach((question) => {
    const paper = inferredPaper(question);
    if (!paper || explicitMemberships.get(String(question.id))?.has(paper.kind)) return;
    const group = inferred.get(paper.id) || { paper, questions: [] };
    group.questions.push(question);
    inferred.set(paper.id, group);
  });
  inferred.forEach(({ paper, questions: paperQuestions }) => registerPaper(paper, paperQuestions));
  return profiles;
}

function frequencyLabel(profile) {
  if (!profile || profile.totalPaperCount < 8) return "样本不足";
  if (profile.rate >= 30) return "高频";
  if (profile.rate >= 15) return "常考";
  if (profile.rate >= 5) return "偶考";
  return "低频";
}

function questionFrequency(question, profiles) {
  const track = inferExamTrack(question);
  const trackPapers = profiles.trackPapers?.get(track) || new Map();
  const entries = (question.knowledgePoints || [])
    .map((point) => profiles.get(`${track}\u0000${normalizeKnowledgePoint(point)}`))
    .filter(Boolean)
    .sort((left, right) => right.weight - left.weight);
  const best = entries[0];
  const paperList = [...trackPapers.values()];
  const totalWeight = paperList.reduce((sum, paper) => sum + paper.weight, 0);
  const totalPaperCount = paperList.length;
  const totalPastPaperCount = paperList.filter((paper) => paper.kind === "past_paper").length;
  const totalMockPaperCount = paperList.filter((paper) => paper.kind === "official_mock").length;
  const matchedPapers = [...(best?.papers?.values() || [])];
  const pastPaperCount = matchedPapers.filter((paper) => paper.kind === "past_paper").length;
  const mockPaperCount = matchedPapers.filter((paper) => paper.kind === "official_mock").length;
  const paperCount = matchedPapers.length;
  const matchedWeight = best?.weight || 0;
  const rate = totalWeight ? Math.round((matchedWeight / totalWeight) * 1000) / 10 : 0;
  const profile = { totalPaperCount, rate };
  return {
    track,
    trackLabel: trackLabels[track],
    label: frequencyLabel(profile),
    rate,
    paperCount,
    totalPaperCount,
    pastPaperCount,
    totalPastPaperCount,
    mockPaperCount,
    totalMockPaperCount,
    matchedWeight: Math.round(matchedWeight * 10) / 10,
    totalWeight: Math.round(totalWeight * 10) / 10,
    sourceCount: paperCount,
    totalSourceCount: totalPaperCount,
  };
}

module.exports = {
  trackLabels,
  paperWeights,
  inferExamTrack,
  estimateDifficulty,
  knowledgeDifficultyProfiles,
  primaryKnowledgePoint,
  subKnowledgePoints,
  frequencyProfiles,
  questionFrequency,
  normalizeKnowledgePoint,
};
