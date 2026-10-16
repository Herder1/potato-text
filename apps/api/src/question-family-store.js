const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FAMILY_VERSION = 3;
const FAMILY_STATE_VERSION = 6;
const familyStatuses = new Set(["pending_review", "confirmed", "rejected"]);
const memberReviewStatuses = new Set(["confirmed", "pending_fit", "inactive"]);
const memberRoles = new Set(["prototype", "similar", "variant"]);
const memberCoverageRoles = new Set(["required", "reference"]);
const trainingLevels = new Set(["foundation", "advanced", "transfer"]);
const familySetMemberTypes = new Set(["family", "set"]);
const MAX_FAMILY_SET_DEPTH = 8;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/（[^）]{0,24}(?:年|大学|插本)[^）]*）/g, "")
    .replace(/\([^)]{0,24}(?:年|大学|插本)[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedKey(value) {
  return cleanText(value).toLowerCase().replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>·…—-]/g, "");
}

function normalizedRequiredNodeIds(requiredNodeIds = []) {
  return [...new Set((Array.isArray(requiredNodeIds) ? requiredNodeIds : [])
    .map((value) => String(value || ""))
    .filter(Boolean))]
    .sort((left, right) => normalizedKey(left).localeCompare(normalizedKey(right)) || left.localeCompare(right));
}

function normalizedNodeIds(nodeIds = []) {
  return [...new Set((Array.isArray(nodeIds) ? nodeIds : [])
    .map((value) => String(value || ""))
    .filter(Boolean))];
}

function stableFamilyId(bookId, primaryKnowledgePoint, focusKey, requiredNodeIds = []) {
  const digest = crypto.createHash("sha1")
    .update([
      bookId,
      primaryKnowledgePoint,
      focusKey,
      normalizedRequiredNodeIds(requiredNodeIds).map(normalizedKey).join("|"),
    ].map(normalizedKey).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `question-family-${digest}`;
}

function questionSearchText(question) {
  return cleanText([
    question.stem,
    question.referenceAnswer,
    ...(question.options || []).map((option) => option.text),
  ].join(" "));
}

const focusRules = [
  ["方言差异特征", /方言.*(?:差异|分歧|变化)|差异最大|分歧最大/],
  ["方言代表点", /方言以.*代表|以.*为代表|代表(?:方言|点)/],
  ["方言归属", /属于.*方言|方言区|分布区域|使用的方言/],
  ["共同语定义要素", /共同语|普通话以|普通话的(?:语音标准|基础方言|语法规范)|标准音.*北京|基础方言|语法规范/],
  ["现代汉语的基本特点", /现代汉语.*特点|语音.*特点|词汇.*特点|语法.*特点|类型语言/],
  ["声母发音部位", /声母.*发音部位|双唇音|唇齿音|舌尖(?:前|中|后)?音|舌面音|舌根音|翘舌音|平舌音/],
  ["声母发音方法·综合判断", /声母.*发音方法相同|发音方法相同.*声母|不送气清(?:塞|塞擦)音|送气清(?:塞|塞擦)音|舌尖(?:前|中|后)?清(?:塞|擦|塞擦)音/],
  ["声母发音方法·声带振动", /声母.*(?:清浊|浊音|清音)|清浊音顺序|浊音声母|普通话中的浊音/],
  ["声母发音方法·气流强弱", /声母.*(?:送气|不送气)|送气音和不送气音|不送气音和送气音|声母\s*[gkbpdtjqzc]+[、,，和与]+[gkpbtdqjcz]+.*区别/],
  ["声母发音方法·阻碍方式", /声母.*发音方法|发音方法.*声母|塞音|擦音|塞擦音|鼻音|边音/],
  ["零声母与隔音字母", /零声母|y、?w|y和w|隔音字母/],
  ["音素数量与构成", /几个音素|音素有|包含.*音素|构成音素/],
  ["元音发音条件", /元音.*发音|舌面元音|舌尖元音|卷舌元音|主要元音|实际读音|舌位|唇形/],
  ["韵母四呼", /开口呼|齐齿呼|合口呼|撮口呼|四呼/],
  ["韵母结构", /韵头|韵腹|韵尾|韵母.*结构/],
  ["复韵母分类", /复韵母|前响|中响|后响/],
  ["鼻韵母分类", /鼻韵母|前鼻音|后鼻音/],
  ["韵母类别辨析", /单韵母|韵母属于|韵母是|韵母的发音/],
  ["音节拼写规则", /拼写规范|拼音正确|正确拼音|隔音符号|省写|ü|孙中山|广州市/],
  ["音节结构", /音节.*结构|音节.*必不可少|音节形式|最多有.*音素|四声都有/],
  ["儿化音节", /儿化|花儿|画儿|盖儿|鸟儿/],
  ["汉语拼音方案", /拼音字母|汉语拼音方案|音位数目/],
  ["声调调值与调类", /调值|调类|阴平|阳平|上声|去声|四个声调/],
  ["一和不的变调", /“?[一不]”?.*读|不去|不好|一群|唱一唱/],
  ["语气词啊的音变", /同志啊|地方来啊|语气词.*啊|“啊”应读/],
  ["六书与汉字造字法", /六书|象形|指事|会意|形声|转注|假借|造字法/],
  ["汉字笔画与笔顺", /笔画数|多少画|几画|笔画顺序|笔顺|基本笔形/],
  ["汉字部件与结构模式", /部件|独体字|合体字|上下结构|左右结构|包围结构|形旁|声旁.*部位/],
  ["汉字形体演变", /甲骨文|金文|大篆|小篆|隶书|楷书|草书|形体演变|今隶/],
  ["规范汉字与错别字", /错别字|写法正确|没有错别字|异体字|简化字|规范.*字形|审音表|常用字表/],
  ["汉字检索与部首", /查字法|部首|拼音·?笔画序|辞书/],
  ["语素数量与识别", /语素.*个数|包含.*语素|几个语素|确定语素/],
  ["复合式构词类型", /构词方式|结构关系|复合式|联合式|偏正式|补充式|动宾式|主谓式/],
  ["派生词与附加式", /派生词|附加式|词缀/],
  ["重叠式与简缩形式", /重叠式|简化方式|简称|简缩/],
  ["单纯词与合成词", /单纯词|合成词/],
  ["词与短语的区分", /只能当作一个词|词和短语|离合词|固定短语/],
  ["外来词类型", /外来词|音译|意译|日本借来|可口可乐|托拉斯/],
  ["同义词辨析", /同义词|敏捷|敏锐|住宿|下榻/],
  ["反义词关系", /反义词|两极关系|互补关系|不能跟.*构成反义/],
  ["上下义关系", /上下义|上位词|下位词/],
  ["多义词与同音词", /多义词|单义词|同音词|本义|基本义|引申义|比喻义|泛指/],
  ["基本词汇与一般词汇", /基本词汇|一般词汇|非基本语汇|词汇包括/],
];

function questionAction(question) {
  const text = cleanText(question.stem);
  if (question.type === "material_analysis") return "材料分析";
  if (["short_answer", "term_definition"].includes(question.type)) return "组织表述";
  if (question.type === "fill_blank") return "直接回忆";
  if (/正确读音|拼音正确|应读|读音是/.test(text)) return "语音识别";
  if (/几个|多少|数目|数量|笔画数/.test(text)) return "数量判断";
  if (/错误的是|正确的是|说法|不正确|没有错/.test(text)) return "正误辨析";
  if (/属于|是\s*[（(]|指的是|构词方式|造字法|结构关系/.test(text)) return "分类判断";
  if (/下列各组|下列各项|根据|用例|句子中/.test(text)) return "例证辨析";
  return "概念识别";
}

function confirmedFingerprintFocus(fingerprint) {
  if (!fingerprint || fingerprint.status !== "confirmed" || !fingerprint.focus || typeof fingerprint.focus !== "object") return null;
  const key = cleanText(fingerprint.focus.key);
  if (!key) return null;
  return {
    key,
    label: cleanText(fingerprint.focus.label || key),
    action: cleanText(fingerprint.focus.action),
    confidence: Math.min(1, Math.max(0, Number(fingerprint.focus.confidence) || 0)),
    source: cleanText(fingerprint.focus.source || fingerprint.source || "confirmed_fingerprint"),
    reason: cleanText(fingerprint.focus.reason),
  };
}

function inferFocus(question, fingerprint = null) {
  const fingerprintFocus = confirmedFingerprintFocus(fingerprint || question?.knowledgeFingerprint);
  if (fingerprintFocus) return fingerprintFocus;
  const text = cleanText(question.stem);
  const matched = focusRules.find(([, pattern]) => pattern.test(text));
  if (matched) return { key: matched[0], label: matched[0], confidence: 0.86, source: "curated_rule" };
  const subPoint = (question.subKnowledgePoints || []).map(cleanText).filter(Boolean)[0];
  if (subPoint) {
    const action = questionAction(question);
    return {
      key: `${subPoint}｜${action}`,
      label: `${subPoint.replace(/^[一二三四五六七八九十]+[、.．\s]*/, "")}·${action}`,
      confidence: 0.68,
      source: "catalog_action_rule",
    };
  }
  return { key: "", label: "", confidence: 0, source: "unresolved" };
}

function trainingLevel(question, action) {
  const stem = cleanText(question.stem);
  if (question.type === "material_analysis" || /根据|用例|句子中|材料|分析|说明理由/.test(stem) || stem.length >= 150) return "transfer";
  if (question.type === "fill_blank" || (/^(?:现代|汉语|普通话|声调|词汇|汉字).{0,28}(?:是|以|有)/.test(stem) && stem.length <= 65)) return "foundation";
  if (["数量判断", "概念识别"].includes(action) && stem.length <= 45) return "foundation";
  return "advanced";
}

function prototypeRank(member) {
  const levelRank = { foundation: 0, advanced: 1, transfer: 2 }[member.trainingLevel] ?? 1;
  const typeRank = { fill_blank: 0, single_choice: 1, multiple_choice: 2, material_analysis: 3 }[member.question.type] ?? 2;
  return levelRank * 10000 + typeRank * 1000 + cleanText(member.question.stem).length;
}

function buildFamilyCandidates(questions = [], bookId = "modern-chinese-7-1", options = {}) {
  const fingerprintMap = options.fingerprintMap instanceof Map
    ? options.fingerprintMap
    : new Map((Array.isArray(options.fingerprints) ? options.fingerprints : []).map((item) => [item.questionId, item]));
  const nodeOrder = options.nodeOrder instanceof Map ? options.nodeOrder : new Map();
  const excludedQuestionIds = new Set((Array.isArray(options.excludedQuestionIds) ? options.excludedQuestionIds : []).map(String));
  const allEligible = (Array.isArray(questions) ? questions : [])
    .filter((question) => question && question.bookId === bookId && question.status !== "offline");
  const eligible = allEligible.filter((question) => !excludedQuestionIds.has(String(question.id)));
  const groups = new Map();
  const unresolvedQuestionIds = [];
  eligible.forEach((question) => {
    const fingerprint = fingerprintMap.get(question.id) || question.knowledgeFingerprint || null;
    const primaryKnowledgePoint = cleanText(fingerprint?.primaryKnowledgePoint || question.primaryKnowledgePoint || question.knowledgePoints?.[0]);
    const focus = inferFocus(question, fingerprint);
    if (!primaryKnowledgePoint || !focus.key) {
      unresolvedQuestionIds.push(question.id);
      return;
    }
    const knowledgeIdentity = fingerprint?.primaryNodeId || primaryKnowledgePoint;
    const requiredIdentity = normalizedRequiredNodeIds(fingerprint?.requiredNodeIds).join("|");
    const assessmentAction = focus.action || questionAction(question);
    const key = `${normalizedKey(knowledgeIdentity)}\u0000${normalizedKey(requiredIdentity)}\u0000${normalizedKey(focus.key)}\u0000${normalizedKey(assessmentAction)}`;
    const group = groups.get(key) || { primaryKnowledgePoint, focus, assessmentAction, questions: [], fingerprint };
    group.questions.push(question);
    if (focus.confidence > group.focus.confidence) group.focus = focus;
    groups.set(key, group);
  });

  const now = Date.now();
  const families = [];
  groups.forEach((group) => {
    if (group.questions.length < (options.allowSingleton === true ? 1 : 2)) {
      unresolvedQuestionIds.push(...group.questions.map((question) => question.id));
      return;
    }
    const drafts = group.questions.map((question) => {
      const fingerprint = fingerprintMap.get(question.id) || question.knowledgeFingerprint || null;
      const action = inferFocus(question, fingerprint).action || questionAction(question);
      return { question, action, trainingLevel: trainingLevel(question, action) };
    });
    drafts.sort((left, right) => prototypeRank(left) - prototypeRank(right));
    const prototype = drafts[0];
    const members = drafts.map((draft, index) => {
      const sameType = draft.question.type === prototype.question.type;
      const sameAction = draft.action === prototype.action;
      const role = index === 0 ? "prototype" : (sameType && sameAction ? "similar" : "variant");
      const variationDimensions = index === 0 ? [] : [
        !sameType && "题型",
        !sameAction && "作答动作",
        draft.trainingLevel !== prototype.trainingLevel && "认知层级",
        "题干或例证",
      ].filter(Boolean);
      return {
        questionId: draft.question.id,
        isPrimary: true,
        role,
        trainingLevel: draft.trainingLevel,
        action: draft.action,
        variationDimensions,
        confidence: Math.max(0.55, Math.min(0.95, group.focus.confidence - (role === "variant" ? 0.06 : 0))),
        reason: role === "prototype"
          ? "优先选择表述直接、训练层级较低的题目作为题族参照"
          : (role === "similar"
            ? "核心命题、题型和作答动作与原型题一致"
            : `核心命题一致，但改变了${variationDimensions.filter((item) => item !== "题干或例证").join("、") || "题干或例证"}`),
      };
    });
    const chapters = [...new Set(group.questions.map((question) => cleanText(question.chapter)).filter(Boolean))];
    const familyConfidence = Math.round(Math.min(group.focus.confidence, 0.72 + Math.min(0.16, members.length * 0.015)) * 100) / 100;
    const primaryNodeRole = group.fingerprint?.primaryNodeRole === "scope_anchor" ? "scope_anchor" : "core";
    families.push({
      id: stableFamilyId(
        bookId,
        group.fingerprint?.primaryNodeId || group.primaryKnowledgePoint,
        group.focus.key,
        group.fingerprint?.requiredNodeIds,
      ),
      version: FAMILY_VERSION,
      subjectId: group.questions[0].subjectId,
      bookId,
      chapter: chapters[0] || "未归类章节",
      primaryKnowledgePoint: group.primaryKnowledgePoint,
      knowledgeNodeId: group.fingerprint?.primaryNodeId || group.primaryKnowledgePoint,
      coreKnowledgeNodeId: group.fingerprint?.primaryNodeId || group.primaryKnowledgePoint,
      knowledgePath: group.fingerprint?.knowledgePath || chapters[0] || "",
      knowledgeLevel: Number(group.fingerprint?.knowledgeLevel) || 0,
      knowledgeSpan: group.fingerprint?.span || "single_point",
      requiredKnowledgeNodeIds: normalizedRequiredNodeIds([
        ...(primaryNodeRole === "core" ? [group.fingerprint?.primaryNodeId || group.primaryKnowledgePoint] : []),
        ...(Array.isArray(group.fingerprint?.requiredNodeIds) ? group.fingerprint.requiredNodeIds : []),
      ]),
      textbookAnchorNodeIds: normalizedNodeIds([group.fingerprint?.primaryNodeId || group.primaryKnowledgePoint]),
      assessmentAction: group.assessmentAction || prototype.action,
      inclusionBoundary: "",
      exclusionBoundary: "",
      orderIndex: Number(nodeOrder.get(group.fingerprint?.primaryNodeId)) || Number.MAX_SAFE_INTEGER,
      name: group.focus.label,
      focusKey: group.focus.key,
      status: "pending_review",
      confidence: familyConfidence,
      source: group.focus.source,
      reason: `按“核心知识点 + 具体考查命题”自动成族，共归入 ${members.length} 道题；确认前不会用于智能复习。`,
      members,
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: "",
    });
  });
  families.sort((left, right) => Number(left.orderIndex) - Number(right.orderIndex)
    || left.chapter.localeCompare(right.chapter, "zh-CN")
    || left.primaryKnowledgePoint.localeCompare(right.primaryKnowledgePoint, "zh-CN")
    || right.members.length - left.members.length);
  return {
    families,
    summary: {
      bookId,
      questionCount: allEligible.length,
      familyCount: families.length,
      groupedQuestionCount: families.reduce((total, family) => total + family.members.length, 0),
      unresolvedQuestionCount: new Set(unresolvedQuestionIds).size,
    },
    unresolvedQuestionIds: [...new Set(unresolvedQuestionIds)],
  };
}

function normalizeMember(member = {}, defaults = {}) {
  const familyStatus = typeof defaults === "string" ? defaults : defaults.familyStatus;
  const defaultReviewStatus = typeof defaults === "object" && memberReviewStatuses.has(defaults.reviewStatus)
    ? defaults.reviewStatus
    : (familyStatus === "confirmed" ? "confirmed" : "pending_fit");
  const reviewStatus = memberReviewStatuses.has(member.reviewStatus) ? member.reviewStatus : defaultReviewStatus;
  const fallbackReviewedAt = typeof defaults === "object" ? defaults.reviewedAt : null;
  const fallbackReviewedBy = typeof defaults === "object" ? defaults.reviewedBy : "";
  const isPrimary = member.isPrimary === true;
  const requestedCoverageRole = String(member.coverageRole || "");
  const coverageRole = isPrimary
    ? "required"
    : (memberCoverageRoles.has(requestedCoverageRole) ? requestedCoverageRole : "");
  return {
    questionId: String(member.questionId || ""),
    isPrimary,
    coverageRole,
    role: memberRoles.has(member.role) ? member.role : "similar",
    trainingLevel: trainingLevels.has(member.trainingLevel) ? member.trainingLevel : "advanced",
    action: cleanText(member.action).slice(0, 80),
    variationDimensions: [...new Set((Array.isArray(member.variationDimensions) ? member.variationDimensions : []).map(cleanText).filter(Boolean))].slice(0, 8),
    contributionKnowledgeNodeIds: normalizedRequiredNodeIds(member.contributionKnowledgeNodeIds),
    confidence: Math.min(1, Math.max(0, Number(member.confidence) || 0)),
    reason: cleanText(member.reason).slice(0, 500),
    reviewStatus,
    reviewedAt: reviewStatus === "confirmed"
      ? (Number(member.reviewedAt) || Number(fallbackReviewedAt) || null)
      : (member.reviewedAt ? Number(member.reviewedAt) : null),
    reviewedBy: reviewStatus === "confirmed"
      ? String(member.reviewedBy || fallbackReviewedBy || "").slice(0, 100)
      : String(member.reviewedBy || "").slice(0, 100),
    reviewInvalidationReason: String(member.reviewInvalidationReason || "").slice(0, 120),
    reviewInvalidatedBy: String(member.reviewInvalidatedBy || "").slice(0, 100),
  };
}

function normalizeMembers(members = [], defaults = {}) {
  const byQuestionId = new Map();
  (Array.isArray(members) ? members : []).forEach((source) => {
    const member = normalizeMember(source, defaults);
    if (!member.questionId) return;
    const current = byQuestionId.get(member.questionId);
    if (!current) {
      byQuestionId.set(member.questionId, member);
      return;
    }
    const roleRank = { prototype: 0, similar: 1, variant: 2 };
    const preferred = (roleRank[member.role] ?? 3) < (roleRank[current.role] ?? 3) ? member : current;
    const reviewRank = { confirmed: 0, pending_fit: 1, inactive: 2 };
    const reviewSource = (reviewRank[current.reviewStatus] ?? 3) <= (reviewRank[member.reviewStatus] ?? 3)
      ? current
      : member;
    byQuestionId.set(member.questionId, normalizeMember({
      ...preferred,
      isPrimary: current.isPrimary || member.isPrimary,
      variationDimensions: [...current.variationDimensions, ...member.variationDimensions],
      confidence: Math.max(current.confidence, member.confidence),
      reason: preferred.reason || current.reason || member.reason,
      reviewStatus: reviewSource.reviewStatus,
      reviewedAt: reviewSource.reviewedAt,
      reviewedBy: reviewSource.reviewedBy,
      reviewInvalidationReason: reviewSource.reviewInvalidationReason,
      reviewInvalidatedBy: reviewSource.reviewInvalidatedBy,
    }, defaults));
  });
  return [...byQuestionId.values()];
}

function pendingMember(member, reason, actor, now = Date.now()) {
  return normalizeMember({
    ...member,
    reviewStatus: "pending_fit",
    reviewedAt: null,
    reviewedBy: "",
    reviewInvalidationReason: String(reason || "question_membership_updated"),
    reviewInvalidatedBy: actor,
  }, { reviewStatus: "pending_fit" });
}

function confirmedMember(member, actor, now = Date.now()) {
  return normalizeMember({
    ...member,
    reviewStatus: "confirmed",
    reviewedAt: now,
    reviewedBy: actor,
    reviewInvalidationReason: "",
    reviewInvalidatedBy: "",
  }, { reviewStatus: "confirmed" });
}

function memberFitSignature(member) {
  return JSON.stringify(member ? {
    isPrimary: member.isPrimary === true,
    coverageRole: member.coverageRole,
    role: member.role,
    trainingLevel: member.trainingLevel,
    action: member.action,
    variationDimensions: normalizedNodeIds(member.variationDimensions),
    contributionKnowledgeNodeIds: normalizedRequiredNodeIds(member.contributionKnowledgeNodeIds),
  } : null);
}

function familyDefinitionSignature(family = {}) {
  return JSON.stringify({
    backendDirectoryAnchorNodeId: String(family.backendDirectoryAnchorNodeId
      || family.scopeAnchorNodeId
      || family.coreKnowledgeNodeId
      || family.knowledgeNodeId
      || ""),
    requiredKnowledgeNodeIds: normalizedRequiredNodeIds(family.requiredKnowledgeNodeIds),
    textbookAnchorNodeIds: normalizedRequiredNodeIds(family.textbookAnchorNodeIds),
    assessmentAction: cleanText(family.assessmentAction),
    inclusionBoundary: cleanText(family.inclusionBoundary),
    exclusionBoundary: cleanText(family.exclusionBoundary),
  });
}

function isConfirmedMembership(family, member) {
  return family?.status === "confirmed" && member?.reviewStatus === "confirmed";
}

function hasConfirmedPrototype(family) {
  return family?.status === "confirmed"
    && family.members.some((member) => member.role === "prototype" && member.reviewStatus === "confirmed");
}

function reconcileMembers(currentMembers = [], submittedMembers = [], reason, actor) {
  const currentByQuestionId = new Map(currentMembers.map((member) => [member.questionId, member]));
  return normalizeMembers(submittedMembers, { reviewStatus: "pending_fit" }).map((member) => {
    const current = currentByQuestionId.get(member.questionId);
    if (!current || memberFitSignature(current) !== memberFitSignature(member)) {
      return pendingMember(member, reason, actor);
    }
    return normalizeMember({
      ...member,
      reviewStatus: current.reviewStatus,
      reviewedAt: current.reviewedAt,
      reviewedBy: current.reviewedBy,
      reviewInvalidationReason: current.reviewInvalidationReason,
      reviewInvalidatedBy: current.reviewInvalidatedBy,
    }, { reviewStatus: current.reviewStatus });
  });
}

function promotePrototypeIfNeeded(members = [], reason, actor) {
  if (!members.length || members.some((member) => member.role === "prototype")) return members;
  members[0] = pendingMember({ ...members[0], role: "prototype" }, reason, actor);
  return members;
}

function normalizePrimaryMemberships(families = []) {
  const membershipsByQuestion = new Map();
  families.forEach((family, familyIndex) => {
    family.members.forEach((member, memberIndex) => {
      const memberships = membershipsByQuestion.get(member.questionId) || [];
      memberships.push({ family, familyIndex, member, memberIndex });
      membershipsByQuestion.set(member.questionId, memberships);
    });
  });
  const statusRank = { confirmed: 0, pending_review: 1, rejected: 2 };
  membershipsByQuestion.forEach((memberships) => {
    const explicit = memberships.filter(({ member }) => member.isPrimary);
    const confirmed = memberships.filter(({ family, member }) => isConfirmedMembership(family, member));
    const candidates = explicit.length ? explicit : (confirmed.length ? confirmed : memberships);
    const memberStatusRank = { confirmed: 0, pending_fit: 1, inactive: 2 };
    candidates.sort((left, right) => (statusRank[left.family.status] ?? 3) - (statusRank[right.family.status] ?? 3)
      || (memberStatusRank[left.member.reviewStatus] ?? 3) - (memberStatusRank[right.member.reviewStatus] ?? 3)
      || left.familyIndex - right.familyIndex
      || left.memberIndex - right.memberIndex);
    const primary = candidates[0];
    memberships.forEach((membership) => {
      membership.member.isPrimary = membership === primary;
      if (membership.member.isPrimary) membership.member.coverageRole = "required";
    });
  });
  return families;
}

function normalizeFamily(family = {}) {
  const now = Date.now();
  const status = familyStatuses.has(family.status) ? family.status : "pending_review";
  const members = normalizeMembers(family.members, {
    familyStatus: status,
    reviewedAt: family.reviewedAt,
    reviewedBy: family.reviewedBy,
  });
  const legacyKnowledgeNodeId = String(family.knowledgeNodeId || family.locationNodeId || "");
  const backendDirectoryAnchorNodeId = String(family.backendDirectoryAnchorNodeId
    || family.scopeAnchorNodeId
    || family.coreKnowledgeNodeId
    || legacyKnowledgeNodeId
    || "");
  const userDirectoryAnchorNodeId = String(family.userDirectoryAnchorNodeId
    || family.locationNodeId
    || legacyKnowledgeNodeId
    || "");
  const coreKnowledgeNodeId = backendDirectoryAnchorNodeId;
  const textbookAnchorNodeIds = normalizedNodeIds(
    Array.isArray(family.textbookAnchorNodeIds) && family.textbookAnchorNodeIds.length
      ? family.textbookAnchorNodeIds
      : [userDirectoryAnchorNodeId || coreKnowledgeNodeId],
  );
  const requiredKnowledgeNodeIds = normalizedRequiredNodeIds(
    Array.isArray(family.requiredKnowledgeNodeIds)
      ? family.requiredKnowledgeNodeIds
      : [coreKnowledgeNodeId],
  );
  // An explicitly stored blank is still a definition value. Adding a member
  // must not fill it implicitly; infer only for legacy records without it.
  const assessmentAction = cleanText(family.assessmentAction
    ?? (members.find((member) => member.role === "prototype")?.action
      || members[0]?.action)).slice(0, 200);
  return {
    id: String(family.id || `question-family-${crypto.randomUUID()}`),
    version: Math.max(1, Number(family.version) || FAMILY_VERSION),
    subjectId: String(family.subjectId || ""),
    bookId: String(family.bookId || ""),
    chapter: cleanText(family.chapter).slice(0, 300),
    primaryKnowledgePoint: cleanText(family.primaryKnowledgePoint).slice(0, 200),
    knowledgeNodeId: userDirectoryAnchorNodeId || textbookAnchorNodeIds[0] || coreKnowledgeNodeId,
    userDirectoryAnchorNodeId: userDirectoryAnchorNodeId || textbookAnchorNodeIds[0] || coreKnowledgeNodeId,
    coreKnowledgeNodeId,
    backendDirectoryAnchorNodeId: coreKnowledgeNodeId,
    // Legacy aliases remain in the payload so old clients and snapshots keep working.
    locationNodeId: userDirectoryAnchorNodeId || textbookAnchorNodeIds[0] || coreKnowledgeNodeId,
    scopeAnchorNodeId: coreKnowledgeNodeId,
    knowledgePath: cleanText(family.knowledgePath || family.chapter).slice(0, 800),
    knowledgeLevel: Math.max(0, Number(family.knowledgeLevel) || 0),
    knowledgeSpan: String(family.knowledgeSpan || "single_point").slice(0, 50),
    requiredKnowledgeNodeIds,
    // Explicit V3 name; requiredKnowledgeNodeIds remains a read-compatible
    // alias for historical records and blind-test snapshots.
    coverageKnowledgeNodeIds: requiredKnowledgeNodeIds,
    textbookAnchorNodeIds,
    assessmentAction,
    inclusionBoundary: cleanText(family.inclusionBoundary).slice(0, 4000),
    exclusionBoundary: cleanText(family.exclusionBoundary).slice(0, 4000),
    orderIndex: Number.isFinite(Number(family.orderIndex)) ? Number(family.orderIndex) : Number.MAX_SAFE_INTEGER,
    name: cleanText(family.name).slice(0, 200),
    focusKey: cleanText(family.focusKey).slice(0, 240),
    status,
    confidence: Math.min(1, Math.max(0, Number(family.confidence) || 0)),
    source: String(family.source || "rule_v1").slice(0, 80),
    reason: cleanText(family.reason).slice(0, 1000),
    members,
    createdAt: Number(family.createdAt) || now,
    updatedAt: Number(family.updatedAt) || now,
    reviewedAt: family.reviewedAt ? Number(family.reviewedAt) : null,
    reviewedBy: String(family.reviewedBy || "").slice(0, 100),
    reviewInvalidationReason: String(family.reviewInvalidationReason || "").slice(0, 120),
    reviewInvalidatedBy: String(family.reviewInvalidatedBy || "").slice(0, 100),
  };
}

function familyVisibleSemanticKey(family = {}) {
  const bookId = normalizedKey(family.bookId);
  const location = normalizedKey(family.knowledgePath || family.chapter || family.knowledgeNodeId);
  const name = normalizedKey(family.name);
  return bookId && location && name ? [bookId, location, name].join("\u0000") : "";
}

function canonicalFamilyRank(family = {}) {
  const status = { confirmed: 0, pending_review: 1, rejected: 2 }[family.status] ?? 3;
  const source = ["manual_family", "manual_empty_family"].includes(family.source) ? 0 : 1;
  return [source, status, Number(family.createdAt) || Number.MAX_SAFE_INTEGER, String(family.id || "")];
}

function compareCanonicalFamilies(left, right) {
  const leftRank = canonicalFamilyRank(left);
  const rightRank = canonicalFamilyRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] === rightRank[index]) continue;
    return typeof leftRank[index] === "number"
      ? leftRank[index] - rightRank[index]
      : String(leftRank[index]).localeCompare(String(rightRank[index]));
  }
  return 0;
}

function mergeVisibleDuplicateFamilies(families = [], existingAliases = {}) {
  const aliases = Object.fromEntries(Object.entries(existingAliases && typeof existingAliases === "object" ? existingAliases : {})
    .map(([aliasId, familyId]) => [String(aliasId), String(familyId)])
    .filter(([aliasId, familyId]) => aliasId && familyId && aliasId !== familyId));
  const groups = new Map();
  const passthrough = [];
  families.forEach((family) => {
    const key = familyVisibleSemanticKey(family);
    if (!key) {
      passthrough.push(family);
      return;
    }
    const group = groups.get(key) || [];
    group.push(family);
    groups.set(key, group);
  });
  const merged = [...passthrough];
  groups.forEach((group) => {
    group.sort(compareCanonicalFamilies);
    const canonical = group[0];
    if (group.length === 1) {
      merged.push(canonical);
      return;
    }
    const canonicalPrototypeId = canonical.members.find((member) => member.role === "prototype")?.questionId || "";
    let members = normalizeMembers(group.flatMap((family) => family.members));
    const prototypeId = canonicalPrototypeId || members.find((member) => member.role === "prototype")?.questionId || members[0]?.questionId || "";
    members = members.map((member) => ({
      ...member,
      role: member.questionId === prototypeId ? "prototype" : (member.role === "prototype" ? "similar" : member.role),
    }));
    const memberSignature = (items) => JSON.stringify(normalizeMembers(items).map((member) => ({
      questionId: member.questionId,
      isPrimary: member.isPrimary,
      role: member.role,
      trainingLevel: member.trainingLevel,
      action: member.action,
    })).sort((left, right) => left.questionId.localeCompare(right.questionId)));
    const semanticConflict = new Set(group.map(familyDefinitionSignature)).size > 1;
    const canonicalMembersByQuestionId = new Map(canonical.members.map((member) => [member.questionId, member]));
    const mergedMembers = members.map((member) => {
      if (semanticConflict) return pendingMember(member, "visible_duplicate_definition_conflict", "system");
      const canonicalMember = canonicalMembersByQuestionId.get(member.questionId);
      if (!canonicalMember || memberFitSignature(canonicalMember) !== memberFitSignature(member)) {
        return pendingMember(member, "visible_duplicate_member_merged", "system");
      }
      return normalizeMember({
        ...member,
        reviewStatus: canonicalMember.reviewStatus,
        reviewedAt: canonicalMember.reviewedAt,
        reviewedBy: canonicalMember.reviewedBy,
        reviewInvalidationReason: canonicalMember.reviewInvalidationReason,
        reviewInvalidatedBy: canonicalMember.reviewInvalidatedBy,
      }, { reviewStatus: canonicalMember.reviewStatus });
    });
    const reviewInvalidated = semanticConflict;
    group.slice(1).forEach((duplicate) => { aliases[duplicate.id] = canonical.id; });
    merged.push(normalizeFamily({
      ...canonical,
      members: mergedMembers,
      status: reviewInvalidated ? "pending_review" : canonical.status,
      reviewedAt: reviewInvalidated ? null : canonical.reviewedAt,
      reviewedBy: reviewInvalidated ? "" : canonical.reviewedBy,
      reviewInvalidationReason: reviewInvalidated ? "visible_duplicate_definition_conflict" : canonical.reviewInvalidationReason,
      reviewInvalidatedBy: reviewInvalidated ? "system" : canonical.reviewInvalidatedBy,
      createdAt: Math.min(...group.map((family) => Number(family.createdAt) || Date.now())),
      updatedAt: Math.max(...group.map((family) => Number(family.updatedAt) || 0)),
    }));
  });
  const canonicalIds = new Set(merged.map((family) => family.id));
  Object.keys(aliases).forEach((aliasId) => {
    const visited = new Set([aliasId]);
    let targetId = aliases[aliasId];
    while (aliases[targetId] && !visited.has(targetId)) {
      visited.add(targetId);
      targetId = aliases[targetId];
    }
    if (canonicalIds.has(targetId) && aliasId !== targetId) aliases[aliasId] = targetId;
    else delete aliases[aliasId];
  });
  return { families: merged, aliases };
}

function normalizeFamilySet(value = {}) {
  const now = Date.now();
  return {
    id: String(value.id || `question-family-set-${crypto.randomUUID()}`),
    subjectId: String(value.subjectId || ""),
    bookId: String(value.bookId || ""),
    knowledgeNodeId: String(value.knowledgeNodeId || ""),
    name: cleanText(value.name).slice(0, 200),
    description: cleanText(value.description).slice(0, 1000),
    revision: Math.max(1, Number(value.revision) || 1),
    orderIndex: Number.isFinite(Number(value.orderIndex)) ? Number(value.orderIndex) : Number.MAX_SAFE_INTEGER,
    createdAt: Number(value.createdAt) || now,
    createdBy: String(value.createdBy || "").slice(0, 100),
    updatedAt: Number(value.updatedAt) || now,
    updatedBy: String(value.updatedBy || "").slice(0, 100),
  };
}

function normalizeFamilySetLink(value = {}) {
  return {
    id: String(value.id || `question-family-set-link-${crypto.randomUUID()}`),
    setId: String(value.setId || ""),
    memberType: familySetMemberTypes.has(value.memberType) ? value.memberType : "",
    memberId: String(value.memberId || ""),
    orderIndex: Number.isFinite(Number(value.orderIndex)) ? Number(value.orderIndex) : Number.MAX_SAFE_INTEGER,
    createdAt: Number(value.createdAt) || Date.now(),
    createdBy: String(value.createdBy || "").slice(0, 100),
  };
}

function resolveFamilyId(state, value) {
  const id = String(value || "");
  const visited = new Set();
  let resolved = id;
  while (state.familyAliases?.[resolved] && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = state.familyAliases[resolved];
  }
  return resolved;
}

function familySetParentMap(links = []) {
  return new Map(links.filter((link) => link.memberType === "set").map((link) => [link.memberId, link.setId]));
}

function familySetWouldCycle(links, parentSetId, childSetId) {
  if (parentSetId === childSetId) return true;
  const parents = familySetParentMap(links);
  let current = parentSetId;
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (current === childSetId) return true;
    visited.add(current);
    current = parents.get(current) || "";
  }
  return false;
}

function familySetDepth(links, setId) {
  const parents = familySetParentMap(links);
  let depth = 1;
  let current = setId;
  const visited = new Set();
  while (parents.has(current) && !visited.has(current)) {
    visited.add(current);
    current = parents.get(current);
    depth += 1;
  }
  return depth;
}

function normalizeState(value) {
  const consolidated = mergeVisibleDuplicateFamilies(
    (Array.isArray(value?.families) ? value.families : []).map(normalizeFamily),
    value?.familyAliases,
  );
  const families = normalizePrimaryMemberships(consolidated.families);
  const familySets = (Array.isArray(value?.familySets) ? value.familySets : [])
    .map(normalizeFamilySet)
    .filter((familySet) => familySet.id && familySet.bookId && familySet.knowledgeNodeId && familySet.name);
  const familyById = new Map(families.map((family) => [family.id, family]));
  const setById = new Map(familySets.map((familySet) => [familySet.id, familySet]));
  const claimedMembers = new Set();
  const familySetLinks = [];
  (Array.isArray(value?.familySetLinks) ? value.familySetLinks : []).map(normalizeFamilySetLink).forEach((source) => {
    const set = setById.get(source.setId);
    const memberId = source.memberType === "family" ? resolveFamilyId({ familyAliases: consolidated.aliases }, source.memberId) : source.memberId;
    if (!set || !source.memberType || !memberId) return;
    const member = source.memberType === "family" ? familyById.get(memberId) : setById.get(memberId);
    if (!member || member.bookId !== set.bookId || (source.memberType === "set" && memberId === set.id)) return;
    const claimKey = `${source.memberType}\u0000${memberId}`;
    if (claimedMembers.has(claimKey)) return;
    const link = { ...source, memberId };
    if (source.memberType === "set" && familySetWouldCycle([...familySetLinks, link], set.id, memberId)) return;
    claimedMembers.add(claimKey);
    familySetLinks.push(link);
  });
  return {
    version: FAMILY_STATE_VERSION,
    families,
    familyAliases: consolidated.aliases,
    familySets,
    familySetLinks,
    // Compatibility-only field. Ungrouped questions are derived from live question/family facts.
    unresolvedByBook: {},
    generatedAtByBook: value?.generatedAtByBook && typeof value.generatedAtByBook === "object" ? clone(value.generatedAtByBook) : {},
    historyByBook: value?.historyByBook && typeof value.historyByBook === "object" ? clone(value.historyByBook) : {},
    membershipRevisionByQuestion: value?.membershipRevisionByQuestion && typeof value.membershipRevisionByQuestion === "object"
      ? Object.fromEntries(Object.entries(value.membershipRevisionByQuestion)
        .map(([questionId, revision]) => [String(questionId), Math.max(0, Number(revision) || 0)]))
      : {},
  };
}

function bumpMembershipRevisions(state, questionIds = []) {
  const revisions = state.membershipRevisionByQuestion && typeof state.membershipRevisionByQuestion === "object"
    ? state.membershipRevisionByQuestion
    : {};
  [...new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean))]
    .forEach((questionId) => { revisions[questionId] = Math.max(0, Number(revisions[questionId]) || 0) + 1; });
  state.membershipRevisionByQuestion = revisions;
}

function changedMemberQuestionIds(beforeMembers = [], afterMembers = []) {
  const signature = (member) => JSON.stringify(member ? {
    fit: memberFitSignature(member),
    reviewStatus: member.reviewStatus,
  } : null);
  const before = new Map(beforeMembers.map((member) => [member.questionId, member]));
  const after = new Map(afterMembers.map((member) => [member.questionId, member]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((questionId) => signature(before.get(questionId)) !== signature(after.get(questionId)));
}

function familySummary(families, unresolvedCount = 0) {
  return {
    total: families.length,
    pending: families.filter((family) => family.status === "pending_review").length,
    confirmed: families.filter((family) => family.status === "confirmed").length,
    rejected: families.filter((family) => family.status === "rejected").length,
    questionCount: new Set(families.flatMap((family) => family.members.map((member) => member.questionId))).size,
    unresolvedQuestionCount: unresolvedCount,
  };
}

const familySearchMetadataFields = [
  ["name", 1000],
  ["primaryKnowledgePoint", 800],
  ["knowledgePath", 750],
  ["chapter", 700],
  ["focusKey", 650],
  ["assessmentAction", 600],
  ["inclusionBoundary", 500],
  ["exclusionBoundary", 500],
  ["id", 400],
];

function questionFamilySearchMatch(family, query, matchingQuestionIds = new Set()) {
  if (!query) return null;
  const metadataMatches = familySearchMetadataFields.flatMap(([field, weight]) => {
    const value = normalizedKey(family[field]);
    if (!value.includes(query)) return [];
    const qualityBonus = value === query ? 100 : (value.startsWith(query) ? 50 : 0);
    return [{ field, score: weight + qualityBonus }];
  });
  const questionIds = family.members
    .map((member) => member.questionId)
    .filter((questionId) => normalizedKey(questionId).includes(query) || matchingQuestionIds.has(questionId));
  if (!metadataMatches.length && !questionIds.length) return null;
  const metadataFields = metadataMatches.map((match) => match.field);
  const hasNameMatch = metadataFields.includes("name");
  const hasMetadataMatch = metadataFields.length > 0;
  const hasQuestionMatch = questionIds.length > 0;
  const kind = hasMetadataMatch && hasQuestionMatch
    ? "mixed"
    : (hasNameMatch ? "family_name" : (hasMetadataMatch ? "family_metadata" : "member_question"));
  const metadataScore = metadataMatches.reduce((score, match) => Math.max(score, match.score), 0);
  const questionScore = hasQuestionMatch ? 300 + Math.min(50, questionIds.length * 5) : 0;
  return {
    kind,
    fields: [...metadataFields, ...(hasQuestionMatch ? ["memberQuestions"] : [])],
    metadataFields,
    questionIds,
    questionCount: questionIds.length,
    score: Math.max(metadataScore, questionScore) + (hasMetadataMatch && hasQuestionMatch ? 25 : 0),
  };
}

function familySemanticKey(family) {
  return [
    normalizedKey(family.bookId),
    normalizedKey(family.coreKnowledgeNodeId || family.knowledgeNodeId || family.primaryKnowledgePoint),
    normalizedRequiredNodeIds(family.requiredKnowledgeNodeIds).map(normalizedKey).join("|"),
    normalizedKey(family.assessmentAction || family.focusKey),
    normalizedKey(family.inclusionBoundary),
    normalizedKey(family.exclusionBoundary),
  ].join("\u0000");
}

function familySetSiblingParentId(state, setId) {
  return state.familySetLinks.find((link) => link.memberType === "set" && link.memberId === setId)?.setId || "";
}

function familySetNameDuplicate(state, bookId, knowledgeNodeId, parentSetId, name, excludedSetId = "") {
  const key = normalizedKey(name);
  return state.familySets.some((familySet) => familySet.id !== excludedSetId
    && familySet.bookId === bookId
    && familySet.knowledgeNodeId === String(knowledgeNodeId || "")
    && familySetSiblingParentId(state, familySet.id) === String(parentSetId || "")
    && normalizedKey(familySet.name) === key);
}

function touchFamilySets(state, setIds = [], actor = "超级管理员", now = Date.now()) {
  const wanted = new Set((Array.isArray(setIds) ? setIds : []).map(String).filter(Boolean));
  if (!wanted.size) return;
  state.familySets = state.familySets.map((familySet) => wanted.has(familySet.id)
    ? normalizeFamilySet({
      ...familySet,
      revision: familySet.revision + 1,
      updatedAt: now,
      updatedBy: actor,
    })
    : familySet);
}

function decorateFamilySet(state, familySet) {
  const directLinks = state.familySetLinks
    .filter((link) => link.setId === familySet.id)
    .sort((left, right) => Number(left.orderIndex) - Number(right.orderIndex)
      || left.memberType.localeCompare(right.memberType)
      || left.memberId.localeCompare(right.memberId));
  const directFamilyIds = directLinks.filter((link) => link.memberType === "family").map((link) => link.memberId);
  const directChildSetIds = directLinks.filter((link) => link.memberType === "set").map((link) => link.memberId);
  const descendantSetIds = [];
  const descendantFamilyIds = new Set(directFamilyIds);
  const visitedSets = new Set([familySet.id]);
  const queue = [...directChildSetIds];
  while (queue.length) {
    const setId = queue.shift();
    if (!setId || visitedSets.has(setId)) continue;
    visitedSets.add(setId);
    descendantSetIds.push(setId);
    state.familySetLinks.filter((link) => link.setId === setId).forEach((link) => {
      if (link.memberType === "family") descendantFamilyIds.add(link.memberId);
      else queue.push(link.memberId);
    });
  }
  const familyById = new Map(state.families.map((family) => [family.id, family]));
  const questionIds = new Set();
  descendantFamilyIds.forEach((familyId) => {
    familyById.get(familyId)?.members.forEach((member) => questionIds.add(member.questionId));
  });
  return {
    ...clone(familySet),
    parentSetId: familySetSiblingParentId(state, familySet.id),
    items: directLinks.map((link) => ({ type: link.memberType, id: link.memberId, orderIndex: link.orderIndex })),
    directFamilyIds,
    directChildSetIds,
    descendantFamilyIds: [...descendantFamilyIds],
    descendantSetIds,
    directFamilyCount: directFamilyIds.length,
    directSetCount: directChildSetIds.length,
    familyCount: descendantFamilyIds.size,
    setCount: descendantSetIds.length,
    questionCount: questionIds.size,
  };
}

function validateFamilySetSelectionHierarchy(state, familyIds = [], childSetIds = []) {
  const selectedFamilies = new Set((Array.isArray(familyIds) ? familyIds : []).map(String).filter(Boolean));
  const selectedSets = new Set((Array.isArray(childSetIds) ? childSetIds : []).map(String).filter(Boolean));
  for (const setId of selectedSets) {
    const familySet = state.familySets.find((item) => item.id === setId);
    if (!familySet) continue;
    const view = decorateFamilySet(state, familySet);
    if (view.descendantSetIds.some((descendantId) => selectedSets.has(descendantId))) {
      throw new Error("question_family_set_selection_overlap");
    }
    if (view.descendantFamilyIds.some((familyId) => selectedFamilies.has(familyId))) {
      throw new Error("question_family_set_selection_overlap");
    }
  }
}

function validateFamilySetTargetHierarchy(state, targetSet, familyIds = [], childSetIds = []) {
  const view = decorateFamilySet(state, targetSet);
  const directFamilies = new Set(view.directFamilyIds);
  const directSets = new Set(view.directChildSetIds);
  if ((Array.isArray(familyIds) ? familyIds : []).some((familyId) => view.descendantFamilyIds.includes(familyId) && !directFamilies.has(familyId))) {
    throw new Error("question_family_set_member_already_in_subtree");
  }
  if ((Array.isArray(childSetIds) ? childSetIds : []).some((setId) => view.descendantSetIds.includes(setId) && !directSets.has(setId))) {
    throw new Error("question_family_set_member_already_in_subtree");
  }
}

function validateFamilySetRevision(familySet, expectedRevision) {
  if (expectedRevision == null || expectedRevision === "") return;
  if (Number(expectedRevision) !== Number(familySet.revision)) throw new Error("question_family_set_revision_conflict");
}

function nextFamilySetLinkOrder(state, setId) {
  return Math.max(0, ...state.familySetLinks.filter((link) => link.setId === setId).map((link) => Number(link.orderIndex) || 0)) + 1;
}

function familySetMemberClaim(state, memberType, memberId) {
  return state.familySetLinks.find((link) => link.memberType === memberType && link.memberId === memberId) || null;
}

function validateFamilySetDepth(links, setIds = []) {
  (Array.isArray(setIds) ? setIds : []).forEach((setId) => {
    if (familySetDepth(links, setId) > MAX_FAMILY_SET_DEPTH) throw new Error("question_family_set_depth_exceeded");
  });
}

function planFamilySetMemberUpdate(state, target, payload = {}, actor = "超级管理员", initialLinks = state.familySetLinks, now = Date.now()) {
  const mode = String(payload.mode || "add");
  if (!["add", "move"].includes(mode)) throw new Error("question_family_set_member_mode_invalid");
  const familyIds = [...new Set((Array.isArray(payload.familyIds) ? payload.familyIds : [])
    .map((familyId) => resolveFamilyId(state, familyId)).filter(Boolean))];
  const childSetIds = [...new Set((Array.isArray(payload.childSetIds) ? payload.childSetIds : []).map(String).filter(Boolean))];
  if (!familyIds.length && !childSetIds.length) throw new Error("question_family_set_members_required");
  if (familyIds.length + childSetIds.length > 500) throw new Error("question_family_set_too_many_members");
  const families = familyIds.map((familyId) => state.families.find((family) => family.id === familyId));
  if (families.some((family) => !family)) throw new Error("question_family_not_found");
  if (families.some((family) => family.bookId !== target.bookId)) throw new Error("question_family_set_book_mismatch");
  if (families.some((family) => family.status === "rejected")) throw new Error("question_family_rejected");
  const childSets = childSetIds.map((setId) => state.familySets.find((familySet) => familySet.id === setId));
  if (childSets.some((familySet) => !familySet)) throw new Error("question_family_set_not_found");
  if (childSets.some((familySet) => familySet.bookId !== target.bookId)) throw new Error("question_family_set_book_mismatch");
  if (childSetIds.includes(target.id)) throw new Error("question_family_set_cycle");

  const planningState = { ...state, familySetLinks: initialLinks };
  validateFamilySetSelectionHierarchy(planningState, familyIds, childSetIds);
  validateFamilySetTargetHierarchy(planningState, target, familyIds, childSetIds);
  const selected = [
    ...familyIds.map((memberId) => ({ memberType: "family", memberId })),
    ...childSetIds.map((memberId) => ({ memberType: "set", memberId })),
  ];
  const previousClaims = selected.map((member) => ({
    ...member,
    claim: familySetMemberClaim(planningState, member.memberType, member.memberId),
  }));
  if (mode === "add" && previousClaims.some(({ claim }) => claim && claim.setId !== target.id)) {
    throw new Error("question_family_set_member_already_grouped");
  }
  const movingClaims = previousClaims.filter(({ claim }) => claim && claim.setId !== target.id);
  let links = initialLinks.filter((link) => !movingClaims.some(({ memberType, memberId }) => (
    link.memberType === memberType && link.memberId === memberId
  )));
  let orderIndex = nextFamilySetLinkOrder({ ...state, familySetLinks: links }, target.id);
  const added = [];
  previousClaims.filter(({ claim }) => !claim || claim.setId !== target.id).forEach(({ memberType, memberId }) => {
    if (memberType === "set" && familySetWouldCycle(links, target.id, memberId)) throw new Error("question_family_set_cycle");
    links.push(normalizeFamilySetLink({
      setId: target.id,
      memberType,
      memberId,
      orderIndex,
      createdAt: now,
      createdBy: actor,
    }));
    orderIndex += 1;
    added.push({ type: memberType, id: memberId });
  });
  if (!added.length) throw new Error("question_family_set_members_unchanged");
  validateFamilySetDepth(links, state.familySets.map((familySet) => familySet.id));
  const affectedSetIds = new Set([target.id]);
  movingClaims.forEach(({ memberType, memberId, claim }) => {
    affectedSetIds.add(claim.setId);
    if (memberType === "set") affectedSetIds.add(memberId);
  });
  added.filter((member) => member.type === "set").forEach((member) => affectedSetIds.add(member.id));
  return {
    links,
    added,
    movedFromSetIds: [...new Set(movingClaims.map(({ claim }) => claim.setId))],
    affectedSetIds: [...affectedSetIds],
  };
}

function createQuestionFamilyStore(adapter) {
  const read = () => normalizeState(adapter.read());
  const write = (state) => adapter.write(normalizeState(state));
  return {
    exportState: () => clone(read()),
    replaceState: (state) => { write(state); return clone(read()); },
    listSets(filters = {}) {
      const state = read();
      const query = normalizedKey(filters.query);
      const familyById = new Map(state.families.map((family) => [family.id, family]));
      const sets = state.familySets.filter((familySet) => {
        if (filters.bookId && filters.bookId !== "all" && familySet.bookId !== filters.bookId) return false;
        if (!query) return true;
        if (normalizedKey([familySet.name, familySet.description, familySet.id].join(" ")).includes(query)) return true;
        return state.familySetLinks.some((link) => link.setId === familySet.id
          && link.memberType === "family"
          && normalizedKey(familyById.get(link.memberId)?.name).includes(query));
      }).map((familySet) => decorateFamilySet(state, familySet))
        .sort((left, right) => Number(left.orderIndex) - Number(right.orderIndex)
          || left.name.localeCompare(right.name, "zh-CN"));
      const bookSets = filters.bookId && filters.bookId !== "all"
        ? state.familySets.filter((familySet) => familySet.bookId === filters.bookId)
        : state.familySets;
      const bookSetIds = new Set(bookSets.map((familySet) => familySet.id));
      const groupedFamilyIds = new Set(state.familySetLinks.filter((link) => link.memberType === "family" && bookSetIds.has(link.setId)).map((link) => link.memberId));
      const bookFamilies = filters.bookId && filters.bookId !== "all"
        ? state.families.filter((family) => family.bookId === filters.bookId)
        : state.families;
      return {
        sets: clone(sets),
        summary: {
          total: bookSets.length,
          rootCount: bookSets.filter((familySet) => !familySetSiblingParentId(state, familySet.id)).length,
          groupedFamilyCount: groupedFamilyIds.size,
          ungroupedFamilyCount: bookFamilies.filter((family) => !groupedFamilyIds.has(family.id)).length,
        },
      };
    },
    getSet(id) {
      const state = read();
      const familySet = state.familySets.find((item) => item.id === String(id || ""));
      return familySet ? clone(decorateFamilySet(state, familySet)) : null;
    },
    setsForFamily(familyId) {
      const state = read();
      const resolvedId = resolveFamilyId(state, familyId);
      const setIds = state.familySetLinks
        .filter((link) => link.memberType === "family" && link.memberId === resolvedId)
        .map((link) => link.setId);
      return clone(setIds.map((setId) => state.familySets.find((familySet) => familySet.id === setId))
        .filter(Boolean)
        .map((familySet) => decorateFamilySet(state, familySet)));
    },
    createSet(payload = {}, actor = "超级管理员") {
      const state = read();
      const bookId = String(payload.bookId || "");
      const knowledgeNodeId = String(payload.knowledgeNodeId || "");
      const name = cleanText(payload.name).slice(0, 200);
      const parentSetId = String(payload.parentSetId || "");
      if (!bookId || !knowledgeNodeId) throw new Error("question_family_set_knowledge_required");
      if (!name) throw new Error("question_family_set_name_required");
      const parent = parentSetId ? state.familySets.find((familySet) => familySet.id === parentSetId) : null;
      if (parentSetId && !parent) throw new Error("question_family_set_not_found");
      if (parent && parent.bookId !== bookId) throw new Error("question_family_set_book_mismatch");
      if (familySetNameDuplicate(state, bookId, knowledgeNodeId, parentSetId, name)) throw new Error("question_family_set_duplicate");
      const familyIds = [...new Set((Array.isArray(payload.familyIds) ? payload.familyIds : []).map((id) => resolveFamilyId(state, id)).filter(Boolean))];
      const childSetIds = [...new Set((Array.isArray(payload.childSetIds) ? payload.childSetIds : []).map(String).filter(Boolean))];
      if (familyIds.length + childSetIds.length > 500) throw new Error("question_family_set_too_many_members");
      const families = familyIds.map((familyId) => state.families.find((family) => family.id === familyId));
      if (families.some((family) => !family)) throw new Error("question_family_not_found");
      if (families.some((family) => family.bookId !== bookId)) throw new Error("question_family_set_book_mismatch");
      if (families.some((family) => family.status === "rejected")) throw new Error("question_family_rejected");
      const childSets = childSetIds.map((setId) => state.familySets.find((familySet) => familySet.id === setId));
      if (childSets.some((familySet) => !familySet)) throw new Error("question_family_set_not_found");
      if (childSets.some((familySet) => familySet.bookId !== bookId)) throw new Error("question_family_set_book_mismatch");
      validateFamilySetSelectionHierarchy(state, familyIds, childSetIds);
      const mode = String(payload.mode || "add");
      if (!["add", "move"].includes(mode)) throw new Error("question_family_set_member_mode_invalid");
      const selectedMembers = [...familyIds.map((memberId) => ({ memberType: "family", memberId })), ...childSetIds.map((memberId) => ({ memberType: "set", memberId }))];
      const previousClaims = selectedMembers.map((member) => ({ ...member, claim: familySetMemberClaim(state, member.memberType, member.memberId) }));
      if (mode === "add" && previousClaims.some(({ claim }) => claim)) throw new Error("question_family_set_member_already_grouped");
      const movingClaims = previousClaims.filter(({ claim }) => claim);

      const now = Date.now();
      const familySet = normalizeFamilySet({
        id: `question-family-set-${crypto.randomUUID()}`,
        subjectId: payload.subjectId || parent?.subjectId || families[0]?.subjectId || childSets[0]?.subjectId || "",
        bookId,
        knowledgeNodeId,
        name,
        description: payload.description,
        revision: 1,
        orderIndex: payload.orderIndex,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        updatedBy: actor,
      });
      state.familySets.push(familySet);
      const baseLinks = state.familySetLinks.filter((link) => !movingClaims.some(({ memberType, memberId }) => link.memberType === memberType && link.memberId === memberId));
      let orderIndex = nextFamilySetLinkOrder(state, familySet.id);
      const links = [];
      if (parent) {
        links.push(normalizeFamilySetLink({ setId: parent.id, memberType: "set", memberId: familySet.id, orderIndex: nextFamilySetLinkOrder({ ...state, familySetLinks: baseLinks }, parent.id), createdAt: now, createdBy: actor }));
      }
      familyIds.forEach((familyId) => {
        links.push(normalizeFamilySetLink({ setId: familySet.id, memberType: "family", memberId: familyId, orderIndex, createdAt: now, createdBy: actor }));
        orderIndex += 1;
      });
      childSetIds.forEach((childSetId) => {
        const prospective = [...baseLinks, ...links];
        if (familySetWouldCycle(prospective, familySet.id, childSetId)) throw new Error("question_family_set_cycle");
        links.push(normalizeFamilySetLink({ setId: familySet.id, memberType: "set", memberId: childSetId, orderIndex, createdAt: now, createdBy: actor }));
        orderIndex += 1;
      });
      const nextLinks = [...baseLinks, ...links];
      validateFamilySetDepth(nextLinks, state.familySets.map((item) => item.id));
      state.familySetLinks = nextLinks;
      touchFamilySets(state, [parent?.id, ...childSetIds, ...movingClaims.map(({ claim }) => claim.setId)].filter(Boolean), actor, now);
      write(state);
      return { set: this.getSet(familySet.id), movedFromSetIds: [...new Set(movingClaims.map(({ claim }) => claim.setId))], actor };
    },
    updateSet(id, payload = {}, actor = "超级管理员") {
      const state = read();
      const index = state.familySets.findIndex((familySet) => familySet.id === String(id || ""));
      if (index < 0) throw new Error("question_family_set_not_found");
      const current = state.familySets[index];
      validateFamilySetRevision(current, payload.expectedRevision);
      const name = cleanText(payload.name == null ? current.name : payload.name).slice(0, 200);
      const knowledgeNodeId = String(payload.knowledgeNodeId == null ? current.knowledgeNodeId : payload.knowledgeNodeId);
      const currentParentId = familySetSiblingParentId(state, current.id);
      const hasParentSetId = Object.prototype.hasOwnProperty.call(payload, "parentSetId");
      const parentSetId = hasParentSetId ? String(payload.parentSetId || "") : currentParentId;
      if (!name) throw new Error("question_family_set_name_required");
      if (!knowledgeNodeId) throw new Error("question_family_set_knowledge_required");
      const parent = parentSetId ? state.familySets.find((familySet) => familySet.id === parentSetId) : null;
      if (parentSetId && !parent) throw new Error("question_family_set_not_found");
      if (parent && parent.bookId !== current.bookId) throw new Error("question_family_set_book_mismatch");
      if (familySetNameDuplicate(state, current.bookId, knowledgeNodeId, parentSetId, name, current.id)) throw new Error("question_family_set_duplicate");
      const now = Date.now();
      let links = state.familySetLinks;
      if (parentSetId !== currentParentId) {
        links = state.familySetLinks.filter((link) => !(link.memberType === "set" && link.memberId === current.id));
        if (parent) {
          if (familySetWouldCycle(links, parent.id, current.id)) throw new Error("question_family_set_cycle");
          links.push(normalizeFamilySetLink({
            setId: parent.id,
            memberType: "set",
            memberId: current.id,
            orderIndex: nextFamilySetLinkOrder({ ...state, familySetLinks: links }, parent.id),
            createdAt: now,
            createdBy: actor,
          }));
        }
      }
      const requestedFamilyIds = [...new Set((Array.isArray(payload.familyIds) ? payload.familyIds : []).map(String).filter(Boolean))];
      const requestedChildSetIds = [...new Set((Array.isArray(payload.childSetIds) ? payload.childSetIds : []).map(String).filter(Boolean))];
      const hasMemberUpdate = requestedFamilyIds.length > 0 || requestedChildSetIds.length > 0;
      const memberPlan = hasMemberUpdate
        ? planFamilySetMemberUpdate(state, current, payload, actor, links, now)
        : { links, added: [], movedFromSetIds: [], affectedSetIds: [] };
      links = memberPlan.links;
      validateFamilySetDepth(links, state.familySets.map((familySet) => familySet.id));
      state.familySetLinks = links;
      state.familySets[index] = normalizeFamilySet({
        ...current,
        knowledgeNodeId,
        name,
        description: payload.description == null ? current.description : payload.description,
        orderIndex: payload.orderIndex == null ? current.orderIndex : payload.orderIndex,
        revision: current.revision + 1,
        updatedAt: now,
        updatedBy: actor,
      });
      const affectedSetIds = new Set(memberPlan.affectedSetIds);
      if (parentSetId !== currentParentId) {
        affectedSetIds.add(currentParentId);
        affectedSetIds.add(parentSetId);
      }
      affectedSetIds.delete("");
      affectedSetIds.delete(current.id);
      touchFamilySets(state, [...affectedSetIds], actor, now);
      write(state);
      return {
        set: this.getSet(current.id),
        previousParentSetId: currentParentId,
        added: memberPlan.added,
        movedFromSetIds: memberPlan.movedFromSetIds,
        actor,
      };
    },
    addSetMembers(id, payload = {}, actor = "超级管理员") {
      const state = read();
      const target = state.familySets.find((familySet) => familySet.id === String(id || ""));
      if (!target) throw new Error("question_family_set_not_found");
      validateFamilySetRevision(target, payload.expectedRevision);
      const now = Date.now();
      const memberPlan = planFamilySetMemberUpdate(state, target, payload, actor, state.familySetLinks, now);
      state.familySetLinks = memberPlan.links;
      touchFamilySets(state, memberPlan.affectedSetIds, actor, now);
      write(state);
      return {
        set: this.getSet(target.id),
        added: memberPlan.added,
        movedFromSetIds: memberPlan.movedFromSetIds,
        actor,
      };
    },
    removeSetMember(id, memberType, memberId, actor = "超级管理员", expectedRevision = null) {
      const state = read();
      const familySet = state.familySets.find((item) => item.id === String(id || ""));
      if (!familySet) throw new Error("question_family_set_not_found");
      validateFamilySetRevision(familySet, expectedRevision);
      const type = String(memberType || "");
      const resolvedMemberId = type === "family" ? resolveFamilyId(state, memberId) : String(memberId || "");
      if (!familySetMemberTypes.has(type)) throw new Error("question_family_set_member_type_invalid");
      const index = state.familySetLinks.findIndex((link) => link.setId === familySet.id && link.memberType === type && link.memberId === resolvedMemberId);
      if (index < 0) throw new Error("question_family_set_member_not_found");
      state.familySetLinks.splice(index, 1);
      touchFamilySets(state, [familySet.id, ...(type === "set" ? [resolvedMemberId] : [])], actor);
      write(state);
      return { set: this.getSet(familySet.id), removed: { type, id: resolvedMemberId }, actor };
    },
    removeSet(id, actor = "超级管理员", expectedRevision = null) {
      const state = read();
      const index = state.familySets.findIndex((familySet) => familySet.id === String(id || ""));
      if (index < 0) throw new Error("question_family_set_not_found");
      const familySet = state.familySets[index];
      validateFamilySetRevision(familySet, expectedRevision);
      const childSetIds = state.familySetLinks.filter((link) => link.setId === familySet.id && link.memberType === "set").map((link) => link.memberId);
      if (childSetIds.length) throw new Error("question_family_set_has_children");
      const detachedFamilyIds = state.familySetLinks.filter((link) => link.setId === familySet.id && link.memberType === "family").map((link) => link.memberId);
      const parentSetId = familySetSiblingParentId(state, familySet.id);
      state.familySetLinks = state.familySetLinks.filter((link) => link.setId !== familySet.id && !(link.memberType === "set" && link.memberId === familySet.id));
      state.familySets.splice(index, 1);
      touchFamilySets(state, [parentSetId].filter(Boolean), actor);
      write(state);
      return { set: clone(familySet), detachedFamilyIds, parentSetId, actor };
    },
    list(filters = {}) {
      const state = read();
      const query = normalizedKey(filters.query);
      const matchingQuestionIds = filters.matchingQuestionIds instanceof Set
        ? filters.matchingQuestionIds
        : new Set((Array.isArray(filters.matchingQuestionIds) ? filters.matchingQuestionIds : []).map(String));
      const families = state.families.flatMap((family) => {
        if (filters.bookId && filters.bookId !== "all" && family.bookId !== filters.bookId) return [];
        if (filters.status && filters.status !== "all" && family.status !== filters.status) return [];
        if (filters.knowledgeNodeIds instanceof Set && filters.knowledgeNodeIds.size) {
          const anchorNodeIds = [...new Set([
            family.knowledgeNodeId,
            ...(Array.isArray(family.textbookAnchorNodeIds) ? family.textbookAnchorNodeIds : []),
          ].map((nodeId) => String(nodeId || "")).filter(Boolean))];
          if (!anchorNodeIds.some((nodeId) => filters.knowledgeNodeIds.has(nodeId))) return [];
        }
        const searchMatch = questionFamilySearchMatch(family, query, matchingQuestionIds);
        if (query && !searchMatch) return [];
        return [{ ...family, ...(searchMatch ? { searchMatch } : {}) }];
      }).sort((left, right) => (query ? Number(right.searchMatch?.score || 0) - Number(left.searchMatch?.score || 0) : 0)
        || Number(left.orderIndex) - Number(right.orderIndex)
        || left.chapter.localeCompare(right.chapter, "zh-CN")
        || left.primaryKnowledgePoint.localeCompare(right.primaryKnowledgePoint, "zh-CN"));
      const bookFamilies = filters.bookId && filters.bookId !== "all"
        ? state.families.filter((family) => family.bookId === filters.bookId)
        : state.families;
      return { families: clone(families), summary: familySummary(bookFamilies) };
    },
    get(id) {
      const state = read();
      const family = state.families.find((item) => item.id === resolveFamilyId(state, id));
      return family ? clone(family) : null;
    },
    membershipRevisions(questionIds = []) {
      const state = read();
      return Object.fromEntries([...new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean))]
        .map((questionId) => [questionId, Math.max(0, Number(state.membershipRevisionByQuestion[questionId]) || 0)]));
    },
    create(payload = {}) {
      const state = read();
      const bookId = String(payload.bookId || "");
      const backendDirectoryAnchorNodeId = String(payload.backendDirectoryAnchorNodeId
        || payload.scopeAnchorNodeId
        || payload.coreKnowledgeNodeId
        || payload.knowledgeNodeId
        || "");
      const userDirectoryAnchorNodeId = String(payload.userDirectoryAnchorNodeId
        || payload.locationNodeId
        || payload.knowledgeNodeId
        || "");
      const coreKnowledgeNodeId = backendDirectoryAnchorNodeId;
      const textbookAnchorNodeIds = normalizedNodeIds(
        Array.isArray(payload.textbookAnchorNodeIds) && payload.textbookAnchorNodeIds.length
          ? payload.textbookAnchorNodeIds
          : [userDirectoryAnchorNodeId || coreKnowledgeNodeId],
      );
      const knowledgeNodeId = userDirectoryAnchorNodeId || textbookAnchorNodeIds[0] || coreKnowledgeNodeId;
      const name = cleanText(payload.name).slice(0, 200);
      const focusKey = cleanText(payload.focusKey || name).slice(0, 240);
      const requiredKnowledgeNodeIds = normalizedRequiredNodeIds(
        Array.isArray(payload.requiredKnowledgeNodeIds)
          ? payload.requiredKnowledgeNodeIds
          : [coreKnowledgeNodeId],
      );
      if (!bookId || !knowledgeNodeId || !coreKnowledgeNodeId) throw new Error("question_family_knowledge_required");
      if (!requiredKnowledgeNodeIds.length) throw new Error("question_family_required_knowledge_required");
      if (!name) throw new Error("question_family_name_required");
      const candidateVisibleKey = familyVisibleSemanticKey({
        bookId,
        knowledgeNodeId,
        knowledgePath: payload.knowledgePath,
        chapter: payload.chapter,
        name,
      });
      const duplicate = state.families.some((family) => family.bookId === bookId
        && ((candidateVisibleKey && familyVisibleSemanticKey(family) === candidateVisibleKey)
          || (family.knowledgeNodeId === knowledgeNodeId && normalizedKey(family.focusKey) === normalizedKey(focusKey))));
      if (duplicate) throw new Error("question_family_duplicate");
      const family = normalizeFamily({
        id: `question-family-manual-${crypto.randomUUID()}`,
        subjectId: payload.subjectId,
        bookId,
        chapter: payload.chapter,
        primaryKnowledgePoint: payload.primaryKnowledgePoint,
        knowledgeNodeId,
        userDirectoryAnchorNodeId: knowledgeNodeId,
        coreKnowledgeNodeId,
        backendDirectoryAnchorNodeId,
        scopeAnchorNodeId: backendDirectoryAnchorNodeId,
        knowledgePath: payload.knowledgePath,
        knowledgeLevel: payload.knowledgeLevel,
        knowledgeSpan: payload.knowledgeSpan || "single_point",
        requiredKnowledgeNodeIds,
        textbookAnchorNodeIds,
        assessmentAction: payload.assessmentAction,
        inclusionBoundary: payload.inclusionBoundary,
        exclusionBoundary: payload.exclusionBoundary,
        orderIndex: payload.orderIndex,
        name,
        focusKey,
        status: "pending_review",
        confidence: 1,
        source: "manual_empty_family",
        reason: payload.reason || "人工创建的空题族骨架，补充并审核题目后才会进入智能复习。",
        members: [],
      });
      state.families.push(family);
      write(state);
      return clone(family);
    },
    addMembers(id, questions = [], actor = "超级管理员", options = {}) {
      const state = read();
      const resolvedId = resolveFamilyId(state, id);
      const index = state.families.findIndex((family) => family.id === resolvedId);
      if (index < 0) throw new Error("question_family_not_found");
      const current = state.families[index];
      const existingIds = new Set(current.members.map((member) => member.questionId));
      const groupedQuestionIds = new Set(state.families.flatMap((family) => family.members.map((member) => member.questionId)));
      let prototypeAssigned = current.members.some((member) => member.role === "prototype");
      const additions = (Array.isArray(questions) ? questions : []).filter((question) => {
        if (!question?.id || existingIds.has(String(question.id))) return false;
        if (String(question.bookId || "") !== current.bookId) throw new Error("question_family_book_mismatch");
        existingIds.add(String(question.id));
        return true;
      }).map((question) => {
        const contributionKnowledgeNodeIds = normalizedRequiredNodeIds(
          options?.contributionKnowledgeNodeIdsByQuestion?.[question.id],
        );
        if (contributionKnowledgeNodeIds.some((nodeId) => !current.requiredKnowledgeNodeIds.includes(nodeId))) {
          throw new Error("question_family_member_contribution_invalid");
        }
        const action = questionAction(question);
        const role = prototypeAssigned ? "similar" : "prototype";
        const isPrimary = !groupedQuestionIds.has(String(question.id));
        const requestedCoverageRole = String(options?.coverageRoleByQuestion?.[question.id] || "");
        const coverageRole = isPrimary
          ? "required"
          : (memberCoverageRoles.has(requestedCoverageRole) ? requestedCoverageRole : "");
        if (coverageRole === "reference" && contributionKnowledgeNodeIds.length) {
          throw new Error("question_family_reference_contribution_forbidden");
        }
        prototypeAssigned = true;
        return normalizeMember({
          questionId: question.id,
          isPrimary,
          coverageRole,
          role,
          trainingLevel: trainingLevel(question, action),
          action,
          variationDimensions: role === "prototype" ? [] : ["人工加入，待审核关系"],
          contributionKnowledgeNodeIds,
          confidence: 1,
          reason: "由管理员人工加入题族，题目关系与训练层级仍可继续调整。",
          reviewStatus: "pending_fit",
          reviewedAt: null,
          reviewedBy: "",
          reviewInvalidationReason: "question_membership_added",
          reviewInvalidatedBy: actor,
        }, { reviewStatus: "pending_fit" });
      });
      if (!additions.length) throw new Error("question_family_members_unchanged");
      state.families[index] = normalizeFamily({
        ...current,
        source: options.preserveDefinition ? current.source : "manual_family",
        members: [...current.members, ...additions],
        updatedAt: Date.now(),
      });
      bumpMembershipRevisions(state, additions.map((member) => member.questionId));
      write(state);
      return { family: clone(state.families[index]), addedCount: additions.length, actor };
    },
    moveMembers(sourceId, payload = {}, questions = [], actor = "超级管理员") {
      const state = read();
      const resolvedSourceId = resolveFamilyId(state, sourceId);
      const sourceIndex = state.families.findIndex((family) => family.id === resolvedSourceId);
      if (sourceIndex < 0) throw new Error("question_family_not_found");
      const source = state.families[sourceIndex];
      const questionById = new Map((Array.isArray(questions) ? questions : [])
        .filter((question) => question?.id)
        .map((question) => [String(question.id), question]));
      const requestedIds = Array.isArray(payload.questionIds) && payload.questionIds.length
        ? payload.questionIds
        : [...questionById.keys()];
      const questionIds = [...new Set(requestedIds.map(String).filter(Boolean))];
      if (!questionIds.length) throw new Error("question_family_questions_required");
      if (questionIds.length > 100) throw new Error("question_family_move_too_many_questions");

      const sourceMemberById = new Map(source.members.map((member) => [member.questionId, member]));
      questionIds.forEach((questionId) => {
        if (!sourceMemberById.has(questionId)) throw new Error("question_family_member_not_found");
        const question = questionById.get(questionId);
        if (!question) throw new Error("question_family_question_not_found");
        if (String(question.bookId || "") !== source.bookId) throw new Error("question_family_book_mismatch");
      });

      const targetFamilyId = resolveFamilyId(state, payload.targetFamilyId);
      const targetPayload = payload.targetFamily && typeof payload.targetFamily === "object" ? payload.targetFamily : null;
      if ((!targetFamilyId && !targetPayload) || (targetFamilyId && targetPayload)) {
        throw new Error("question_family_move_target_required");
      }

      let targetIndex = -1;
      let target;
      let targetCreated = false;
      if (targetFamilyId) {
        if (targetFamilyId === source.id) throw new Error("question_family_move_target_same");
        targetIndex = state.families.findIndex((family) => family.id === targetFamilyId);
        if (targetIndex < 0) throw new Error("question_family_not_found");
        target = state.families[targetIndex];
        if (target.status === "rejected") throw new Error("question_family_rejected");
        if (target.bookId !== source.bookId) throw new Error("question_family_book_mismatch");
      } else {
        const bookId = String(targetPayload.bookId || source.bookId);
        const coreKnowledgeNodeId = String(targetPayload.coreKnowledgeNodeId || targetPayload.knowledgeNodeId || "");
        const textbookAnchorNodeIds = normalizedNodeIds(
          Array.isArray(targetPayload.textbookAnchorNodeIds) && targetPayload.textbookAnchorNodeIds.length
            ? targetPayload.textbookAnchorNodeIds
            : [targetPayload.knowledgeNodeId || coreKnowledgeNodeId],
        );
        const knowledgeNodeId = textbookAnchorNodeIds[0] || coreKnowledgeNodeId;
        const name = cleanText(targetPayload.name).slice(0, 200);
        const focusKey = cleanText(targetPayload.focusKey || name).slice(0, 240);
        const requiredKnowledgeNodeIds = normalizedRequiredNodeIds(
          Array.isArray(targetPayload.requiredKnowledgeNodeIds)
            ? targetPayload.requiredKnowledgeNodeIds
            : [coreKnowledgeNodeId],
        );
        if (bookId !== source.bookId) throw new Error("question_family_book_mismatch");
        if (!knowledgeNodeId || !coreKnowledgeNodeId) throw new Error("question_family_knowledge_required");
        if (!requiredKnowledgeNodeIds.length) throw new Error("question_family_required_knowledge_required");
        if (!name) throw new Error("question_family_name_required");
        const candidateVisibleKey = familyVisibleSemanticKey({
          bookId,
          knowledgeNodeId,
          knowledgePath: targetPayload.knowledgePath,
          chapter: targetPayload.chapter,
          name,
        });
        const duplicate = state.families.some((family) => family.bookId === bookId
          && ((candidateVisibleKey && familyVisibleSemanticKey(family) === candidateVisibleKey)
            || (family.knowledgeNodeId === knowledgeNodeId && normalizedKey(family.focusKey) === normalizedKey(focusKey))));
        if (duplicate) throw new Error("question_family_duplicate");
        target = normalizeFamily({
          id: `question-family-manual-${crypto.randomUUID()}`,
          subjectId: targetPayload.subjectId || source.subjectId,
          bookId,
          chapter: targetPayload.chapter,
          primaryKnowledgePoint: targetPayload.primaryKnowledgePoint,
          knowledgeNodeId,
          coreKnowledgeNodeId,
          knowledgePath: targetPayload.knowledgePath,
          knowledgeLevel: targetPayload.knowledgeLevel,
          knowledgeSpan: targetPayload.knowledgeSpan || "single_point",
          requiredKnowledgeNodeIds,
          textbookAnchorNodeIds,
          assessmentAction: targetPayload.assessmentAction,
          inclusionBoundary: targetPayload.inclusionBoundary,
          exclusionBoundary: targetPayload.exclusionBoundary,
          orderIndex: targetPayload.orderIndex,
          name,
          focusKey,
          status: "pending_review",
          confidence: 1,
          source: "manual_empty_family",
          reason: "人工创建的空题族骨架，补充并审核题目后才会进入智能复习。",
          members: [],
        });
        targetCreated = true;
      }

      const movingIds = new Set(questionIds);
      const movingMembers = questionIds.map((questionId) => sourceMemberById.get(questionId));
      const requestedPrototypeQuestionId = targetCreated ? String(payload.prototypeQuestionId || "") : "";
      if (requestedPrototypeQuestionId && !movingIds.has(requestedPrototypeQuestionId)) {
        throw new Error("question_family_prototype_required");
      }
      const primaryTransferredQuestionIds = movingMembers.filter((member) => member.isPrimary).map((member) => member.questionId);
      const alreadyInTargetQuestionIds = movingMembers
        .filter((member) => target.members.some((targetMember) => targetMember.questionId === member.questionId))
        .map((member) => member.questionId);
      const sourceMembers = promotePrototypeIfNeeded(
        source.members.filter((member) => !movingIds.has(member.questionId)),
        "question_family_prototype_promoted_after_move",
        actor,
      );

      const targetMembers = target.members.map((member) => ({ ...member }));
      const targetMemberIndexById = new Map(targetMembers.map((member, index) => [member.questionId, index]));
      let prototypeAssigned = targetMembers.some((member) => member.role === "prototype");
      const prototypeQuestionId = prototypeAssigned
        ? ""
        : (requestedPrototypeQuestionId
          || movingMembers.find((member) => member.role === "prototype" && !targetMemberIndexById.has(member.questionId))?.questionId
          || movingMembers.find((member) => !targetMemberIndexById.has(member.questionId))?.questionId
          || "");
      let mergedCount = 0;
      movingMembers.forEach((sourceMember) => {
        const existingIndex = targetMemberIndexById.get(sourceMember.questionId);
        if (existingIndex != null) {
          const existing = targetMembers[existingIndex];
          const merged = normalizeMember({
            ...existing,
            isPrimary: existing.isPrimary || sourceMember.isPrimary,
          });
          targetMembers[existingIndex] = memberFitSignature(existing) === memberFitSignature(merged)
            ? merged
            : pendingMember(merged, "question_membership_moved", actor);
          mergedCount += 1;
          return;
        }
        const role = !prototypeAssigned && sourceMember.questionId === prototypeQuestionId ? "prototype" : "similar";
        if (role === "prototype") prototypeAssigned = true;
        targetMembers.push(pendingMember({
          ...sourceMember,
          isPrimary: sourceMember.isPrimary,
          role,
          variationDimensions: role === "prototype" ? [] : sourceMember.variationDimensions,
          contributionKnowledgeNodeIds: [],
          confidence: 1,
          reason: `由管理员从题族“${source.name}”批量移动，题族关系与训练层级仍需人工复核。`,
        }, "question_membership_moved", actor));
      });
      if (targetMembers.length && !targetMembers.some((member) => member.role === "prototype")) {
        targetMembers[0] = pendingMember(
          { ...targetMembers[0], role: "prototype" },
          "question_family_prototype_promoted_after_move",
          actor,
        );
      }

      const now = Date.now();
      state.families[sourceIndex] = normalizeFamily({
        ...source,
        source: sourceMembers.length ? "manual_family" : "manual_empty_family",
        members: sourceMembers,
        updatedAt: now,
      });
      const nextTarget = normalizeFamily({
        ...target,
        source: "manual_family",
        members: targetMembers,
        updatedAt: now,
      });
      if (targetCreated) state.families.push(nextTarget);
      else state.families[targetIndex] = nextTarget;

      normalizePrimaryMemberships(state.families);
      bumpMembershipRevisions(state, questionIds);
      write(state);

      const persisted = read();
      return {
        sourceFamily: clone(persisted.families.find((family) => family.id === source.id)),
        targetFamily: clone(persisted.families.find((family) => family.id === nextTarget.id)),
        movedQuestionIds: questionIds,
        movedCount: questionIds.length,
        mergedCount,
        targetCreated,
        primaryTransferredQuestionIds,
        alreadyInTargetQuestionIds,
        affectedFamilyIds: [source.id, nextTarget.id],
        actor,
      };
    },
    removeMember(id, questionId, actor = "超级管理员") {
      const state = read();
      const resolvedId = resolveFamilyId(state, id);
      const index = state.families.findIndex((family) => family.id === resolvedId);
      if (index < 0) throw new Error("question_family_not_found");
      const current = state.families[index];
      const removedMember = current.members.find((member) => member.questionId === String(questionId || ""));
      const members = promotePrototypeIfNeeded(
        current.members.filter((member) => member.questionId !== String(questionId || "")),
        "question_family_prototype_promoted_after_removal",
        actor,
      );
      if (members.length === current.members.length) throw new Error("question_family_member_not_found");
      state.families[index] = normalizeFamily({
        ...current,
        source: members.length ? "manual_family" : "manual_empty_family",
        members,
        updatedAt: Date.now(),
      });
      normalizePrimaryMemberships(state.families);
      if (removedMember?.isPrimary) {
        const promoted = state.families
          .flatMap((family) => family.members.map((member) => ({ family, member })))
          .find(({ member }) => member.questionId === removedMember.questionId && member.isPrimary);
        if (promoted) {
          const promotedIndex = promoted.family.members.findIndex((member) => member.questionId === removedMember.questionId);
          promoted.family.members[promotedIndex] = pendingMember(
            promoted.member,
            "question_primary_membership_promoted_after_removal",
            actor,
          );
        }
      }
      bumpMembershipRevisions(state, changedMemberQuestionIds(current.members, state.families[index].members));
      write(state);
      return { family: clone(state.families[index]), removedQuestionId: String(questionId), actor };
    },
    detachQuestions(questionIds = [], reason = "question_deleted", actor = "超级管理员") {
      const wanted = new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean));
      if (!wanted.size) {
        return {
          affectedFamilyIds: [],
          emptiedFamilyIds: [],
          promotedPrototypeMembers: [],
          detachedQuestionIds: [],
          actor,
        };
      }
      const state = read();
      const affectedFamilyIds = [];
      const emptiedFamilyIds = [];
      const promotedPrototypeMembers = [];
      const revisionQuestionIds = new Set();
      state.families = state.families.map((family) => {
        const removedMembers = family.members.filter((member) => wanted.has(member.questionId));
        if (!removedMembers.length) return family;
        affectedFamilyIds.push(family.id);
        removedMembers.forEach((member) => revisionQuestionIds.add(member.questionId));
        const remainingMembers = family.members.filter((member) => !wanted.has(member.questionId));
        const hadPrototypeRemoved = removedMembers.some((member) => member.role === "prototype");
        const members = hadPrototypeRemoved
          ? promotePrototypeIfNeeded(
            remainingMembers,
            "question_family_prototype_promoted_after_question_detach",
            actor,
          )
          : remainingMembers;
        if (!members.length) emptiedFamilyIds.push(family.id);
        if (hadPrototypeRemoved) {
          const promoted = members.find((member) => member.role === "prototype" && member.reviewStatus === "pending_fit");
          if (promoted) {
            revisionQuestionIds.add(promoted.questionId);
            promotedPrototypeMembers.push({ familyId: family.id, questionId: promoted.questionId });
          }
        }
        return normalizeFamily({
          ...family,
          source: members.length ? "manual_family" : "manual_empty_family",
          members,
          updatedAt: Date.now(),
        });
      });
      if (!affectedFamilyIds.length) {
        return {
          affectedFamilyIds: [],
          emptiedFamilyIds: [],
          promotedPrototypeMembers: [],
          detachedQuestionIds: [],
          actor,
        };
      }
      normalizePrimaryMemberships(state.families);
      bumpMembershipRevisions(state, [...revisionQuestionIds]);
      write(state);
      return {
        affectedFamilyIds,
        emptiedFamilyIds,
        promotedPrototypeMembers,
        detachedQuestionIds: [...wanted].filter((questionId) => revisionQuestionIds.has(questionId)),
        reason: String(reason || "question_deleted"),
        actor,
      };
    },
    remove(id, actor = "超级管理员") {
      const state = read();
      const resolvedId = resolveFamilyId(state, id);
      const index = state.families.findIndex((family) => family.id === resolvedId);
      if (index < 0) throw new Error("question_family_not_found");
      const family = state.families[index];
      const removedQuestionIds = [...new Set(family.members.map((member) => member.questionId))];
      const removedPrimaryQuestionIds = new Set(family.members
        .filter((member) => member.isPrimary)
        .map((member) => member.questionId));
      state.families.splice(index, 1);
      const detachedFamilySetIds = state.familySetLinks
        .filter((link) => link.memberType === "family" && link.memberId === family.id)
        .map((link) => link.setId);
      state.familySetLinks = state.familySetLinks.filter((link) => !(link.memberType === "family" && link.memberId === family.id));
      touchFamilySets(state, detachedFamilySetIds, actor);
      Object.keys(state.familyAliases).forEach((aliasId) => {
        if (aliasId === family.id || state.familyAliases[aliasId] === family.id) delete state.familyAliases[aliasId];
      });
      normalizePrimaryMemberships(state.families);
      removedPrimaryQuestionIds.forEach((questionId) => {
        const promoted = state.families
          .flatMap((remainingFamily) => remainingFamily.members.map((member) => ({ remainingFamily, member })))
          .find(({ member }) => member.questionId === questionId && member.isPrimary);
        if (promoted) {
          promoted.member = pendingMember(
            promoted.member,
            "question_primary_membership_promoted_after_family_removal",
            actor,
          );
          const promotedIndex = promoted.remainingFamily.members.findIndex((member) => member.questionId === questionId);
          promoted.remainingFamily.members[promotedIndex] = promoted.member;
        }
      });
      const remainingMemberships = new Map();
      state.families.forEach((remainingFamily) => {
        remainingFamily.members.forEach((member) => {
          const memberships = remainingMemberships.get(member.questionId) || [];
          memberships.push({ familyId: remainingFamily.id, member });
          remainingMemberships.set(member.questionId, memberships);
        });
      });
      const ungroupedQuestionIds = [];
      const promotedPrimaryQuestionIds = [];
      removedQuestionIds.forEach((questionId) => {
        const memberships = remainingMemberships.get(questionId) || [];
        if (!memberships.length) {
          ungroupedQuestionIds.push(questionId);
          return;
        }
        if (removedPrimaryQuestionIds.has(questionId) && memberships.some(({ member }) => member.isPrimary)) {
          promotedPrimaryQuestionIds.push(questionId);
        }
      });
      bumpMembershipRevisions(state, removedQuestionIds);
      write(state);
      return {
        family: clone(family),
        removedQuestionIds,
        ungroupedQuestionIds,
        promotedPrimaryQuestionIds,
        detachedFamilySetIds,
        actor,
      };
    },
    relocate(id, payload = {}, actor = "超级管理员") {
      const state = read();
      const resolvedId = resolveFamilyId(state, id);
      const index = state.families.findIndex((family) => family.id === resolvedId);
      if (index < 0) throw new Error("question_family_not_found");
      const current = state.families[index];
      const textbookAnchorNodeIds = normalizedNodeIds(
        Array.isArray(payload.textbookAnchorNodeIds) && payload.textbookAnchorNodeIds.length
          ? payload.textbookAnchorNodeIds
          : [payload.knowledgeNodeId],
      );
      const userDirectoryAnchorNodeId = String(payload.userDirectoryAnchorNodeId
        || payload.locationNodeId
        || payload.knowledgeNodeId
        || textbookAnchorNodeIds[0]
        || current.userDirectoryAnchorNodeId
        || current.knowledgeNodeId
        || "");
      const knowledgeNodeId = userDirectoryAnchorNodeId || textbookAnchorNodeIds[0] || "";
      const backendDirectoryAnchorNodeId = String(payload.backendDirectoryAnchorNodeId
        || payload.scopeAnchorNodeId
        || payload.coreKnowledgeNodeId
        || current.backendDirectoryAnchorNodeId
        || current.coreKnowledgeNodeId
        || current.knowledgeNodeId
        || "");
      const coreKnowledgeNodeId = backendDirectoryAnchorNodeId;
      const requiredKnowledgeNodeIds = normalizedRequiredNodeIds(
        Array.isArray(payload.requiredKnowledgeNodeIds)
          ? payload.requiredKnowledgeNodeIds
          : current.requiredKnowledgeNodeIds,
      );
      const name = cleanText(payload.name == null ? current.name : payload.name).slice(0, 200);
      const members = payload.members == null
        ? current.members
        : reconcileMembers(current.members, payload.members, "question_membership_updated", actor);
      if (!knowledgeNodeId) throw new Error("question_family_knowledge_required");
      if (!requiredKnowledgeNodeIds.length) throw new Error("question_family_required_knowledge_required");
      if (!name) throw new Error("question_family_name_required");
      if (JSON.stringify(textbookAnchorNodeIds) === JSON.stringify(current.textbookAnchorNodeIds)) {
        throw new Error("question_family_location_unchanged");
      }
      const candidateVisibleKey = familyVisibleSemanticKey({
        ...current,
        knowledgeNodeId,
        knowledgePath: payload.knowledgePath,
        chapter: payload.chapter,
        name,
      });
      const duplicate = state.families.some((family, familyIndex) => familyIndex !== index
        && family.bookId === current.bookId
        && ((candidateVisibleKey && familyVisibleSemanticKey(family) === candidateVisibleKey)
          || (family.knowledgeNodeId === knowledgeNodeId && normalizedKey(family.focusKey) === normalizedKey(current.focusKey))));
      if (duplicate) throw new Error("question_family_duplicate");
      const nextDefinition = {
        ...current,
        coreKnowledgeNodeId,
        requiredKnowledgeNodeIds,
        textbookAnchorNodeIds,
        assessmentAction: payload.assessmentAction == null ? current.assessmentAction : payload.assessmentAction,
        inclusionBoundary: payload.inclusionBoundary == null ? current.inclusionBoundary : payload.inclusionBoundary,
        exclusionBoundary: payload.exclusionBoundary == null ? current.exclusionBoundary : payload.exclusionBoundary,
      };
      const definitionChanged = familyDefinitionSignature(current) !== familyDefinitionSignature(nextDefinition);
      const nextMembers = definitionChanged
        ? members.map((member) => pendingMember(member, "family_definition_updated", actor))
        : members;
      state.families[index] = normalizeFamily({
        ...current,
        name,
        members: nextMembers,
        chapter: payload.chapter,
        primaryKnowledgePoint: payload.primaryKnowledgePoint,
        knowledgeNodeId,
        userDirectoryAnchorNodeId: knowledgeNodeId,
        coreKnowledgeNodeId,
        backendDirectoryAnchorNodeId,
        scopeAnchorNodeId: backendDirectoryAnchorNodeId,
        textbookAnchorNodeIds,
        knowledgePath: payload.knowledgePath,
        knowledgeLevel: payload.knowledgeLevel,
        requiredKnowledgeNodeIds,
        assessmentAction: nextDefinition.assessmentAction,
        inclusionBoundary: nextDefinition.inclusionBoundary,
        exclusionBoundary: nextDefinition.exclusionBoundary,
        orderIndex: payload.orderIndex,
        source: nextMembers.length ? "manual_family" : "manual_empty_family",
        status: definitionChanged ? "pending_review" : current.status,
        updatedAt: Date.now(),
        reviewedAt: definitionChanged ? null : current.reviewedAt,
        reviewedBy: definitionChanged ? "" : current.reviewedBy,
        reviewInvalidationReason: definitionChanged ? "family_definition_updated" : current.reviewInvalidationReason,
        reviewInvalidatedBy: definitionChanged ? actor : current.reviewInvalidatedBy,
      });
      bumpMembershipRevisions(state, [...new Set([...current.members, ...nextMembers].map((member) => member.questionId))]);
      write(state);
      return { family: clone(state.families[index]), previousKnowledgeNodeId: current.knowledgeNodeId, actor };
    },
    markPendingForQuestions(questionIds = [], reason = "question_content_updated", actor = "超级管理员") {
      const wanted = new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean));
      if (!wanted.size) return { affectedFamilyIds: [], actor };
      const state = read();
      const affectedFamilyIds = [];
      state.families = state.families.map((family) => {
        if (!family.members.some((member) => wanted.has(member.questionId))) return family;
        affectedFamilyIds.push(family.id);
        return normalizeFamily({
          ...family,
          members: family.members.map((member) => (wanted.has(member.questionId)
            ? pendingMember(member, reason, actor)
            : member)),
          updatedAt: Date.now(),
        });
      });
      if (affectedFamilyIds.length) {
        bumpMembershipRevisions(state, [...wanted]);
        write(state);
      }
      return { affectedFamilyIds, actor };
    },
    memberships(questionIds = [], filters = {}) {
      const wanted = new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean));
      const result = Object.fromEntries([...wanted].map((questionId) => [questionId, []]));
      if (!wanted.size) return result;
      const state = read();
      state.families.forEach((family) => {
        if (filters.bookId && filters.bookId !== "all" && family.bookId !== filters.bookId) return;
        if (filters.status && filters.status !== "all" && family.status !== filters.status) return;
        family.members.forEach((member) => {
          if (!wanted.has(member.questionId)) return;
          if (filters.reviewStatus && filters.reviewStatus !== "all" && member.reviewStatus !== filters.reviewStatus) return;
          result[member.questionId].push({
            familyId: family.id,
            familyName: family.name,
            familyStatus: family.status,
            bookId: family.bookId,
            isPrimary: member.isPrimary,
            coverageRole: member.coverageRole,
            focusKey: family.focusKey,
            primaryKnowledgePoint: family.primaryKnowledgePoint,
            knowledgeNodeId: family.knowledgeNodeId,
            userDirectoryAnchorNodeId: family.userDirectoryAnchorNodeId,
            coreKnowledgeNodeId: family.coreKnowledgeNodeId,
            backendDirectoryAnchorNodeId: family.backendDirectoryAnchorNodeId,
            knowledgePath: family.knowledgePath,
            requiredKnowledgeNodeIds: family.requiredKnowledgeNodeIds,
            coverageKnowledgeNodeIds: family.requiredKnowledgeNodeIds,
            textbookAnchorNodeIds: family.textbookAnchorNodeIds,
            assessmentAction: family.assessmentAction,
            inclusionBoundary: family.inclusionBoundary,
            exclusionBoundary: family.exclusionBoundary,
            role: member.role,
            trainingLevel: member.trainingLevel,
            action: member.action,
            contributionKnowledgeNodeIds: member.contributionKnowledgeNodeIds,
            confidence: member.confidence,
            reason: member.reason,
            reviewStatus: member.reviewStatus,
            reviewedAt: member.reviewedAt,
            reviewedBy: member.reviewedBy,
            reviewInvalidationReason: member.reviewInvalidationReason,
            reviewInvalidatedBy: member.reviewInvalidatedBy,
            membershipRevision: Math.max(0, Number(state.membershipRevisionByQuestion[member.questionId]) || 0),
          });
        });
      });
      Object.values(result).forEach((memberships) => memberships.sort((left, right) => {
        const statusRank = { confirmed: 0, pending_review: 1, rejected: 2 };
        return Number(right.isPrimary) - Number(left.isPrimary)
          || (statusRank[left.familyStatus] ?? 3) - (statusRank[right.familyStatus] ?? 3)
          || left.familyName.localeCompare(right.familyName, "zh-CN");
      }));
      return clone(result);
    },
    setMemberships(question, selections = [], actor = "超级管理员") {
      const questionId = String(question?.id || "");
      const bookId = String(question?.bookId || "");
      if (!questionId || !bookId) throw new Error("question_not_found");
      const state = read();
      const requested = new Map();
      (Array.isArray(selections) ? selections : []).forEach((selection) => {
        const familyId = resolveFamilyId(state, selection?.familyId);
        if (!familyId) return;
        const isPrimary = selection?.isPrimary === true;
        const requestedCoverageRole = String(selection?.coverageRole || "");
        const coverageRole = isPrimary
          ? "required"
          : (memberCoverageRoles.has(requestedCoverageRole) ? requestedCoverageRole : "");
        requested.set(familyId, {
          familyId,
          isPrimary,
          coverageRole,
          contributionKnowledgeNodeIds: normalizedRequiredNodeIds(selection?.contributionKnowledgeNodeIds),
          hasContributionKnowledge: Object.prototype.hasOwnProperty.call(selection || {}, "contributionKnowledgeNodeIds"),
          hasCoverageRole: Object.prototype.hasOwnProperty.call(selection || {}, "coverageRole"),
        });
      });
      const primaryCount = [...requested.values()].filter((selection) => selection.isPrimary).length;
      if (requested.size && primaryCount !== 1) throw new Error("question_family_primary_required");
      requested.forEach((selection, familyId) => {
        const family = state.families.find((item) => item.id === familyId);
        if (!family) throw new Error("question_family_not_found");
        if (family.bookId !== bookId) throw new Error("question_family_book_mismatch");
        if (family.status === "rejected") throw new Error("question_family_rejected");
        if (selection.contributionKnowledgeNodeIds.some((nodeId) => !family.requiredKnowledgeNodeIds.includes(nodeId))) {
          throw new Error("question_family_member_contribution_invalid");
        }
        if (selection.coverageRole === "reference" && selection.contributionKnowledgeNodeIds.length) {
          throw new Error("question_family_reference_contribution_forbidden");
        }
      });
      const affectedFamilyIds = [];
      state.families = state.families.map((family) => {
        if (family.bookId !== bookId) return family;
        const currentMember = family.members.find((member) => member.questionId === questionId);
        const selection = requested.get(family.id);
        if (!currentMember && !selection) return family;
        let members = family.members.filter((member) => member.questionId !== questionId);
        if (selection) {
          const action = currentMember?.action || questionAction(question);
          const contributionKnowledgeNodeIds = selection.hasContributionKnowledge
            ? selection.contributionKnowledgeNodeIds
            : (currentMember?.contributionKnowledgeNodeIds || []);
          const coverageRole = selection.isPrimary
            ? "required"
            : (selection.hasCoverageRole ? selection.coverageRole : (currentMember?.coverageRole || ""));
          const candidate = normalizeMember({
            ...(currentMember || {}),
            questionId,
            isPrimary: selection.isPrimary,
            coverageRole,
            role: currentMember?.role || (members.some((member) => member.role === "prototype") ? "similar" : "prototype"),
            trainingLevel: currentMember?.trainingLevel || trainingLevel(question, action),
            action,
            contributionKnowledgeNodeIds,
            confidence: currentMember?.confidence || 1,
            reason: currentMember?.reason || "由管理员在题目编辑页加入题族，题族关系仍需人工复核。",
          }, { reviewStatus: "pending_fit" });
          members.push(currentMember && memberFitSignature(currentMember) === memberFitSignature(candidate)
            ? normalizeMember({
              ...candidate,
              reviewStatus: currentMember.reviewStatus,
              reviewedAt: currentMember.reviewedAt,
              reviewedBy: currentMember.reviewedBy,
              reviewInvalidationReason: currentMember.reviewInvalidationReason,
              reviewInvalidatedBy: currentMember.reviewInvalidatedBy,
            }, { reviewStatus: currentMember.reviewStatus })
            : pendingMember(candidate, "question_membership_updated", actor));
        }
        promotePrototypeIfNeeded(members, "question_family_prototype_promoted_after_removal", actor);
        const before = JSON.stringify(currentMember ? {
          familyId: family.id,
          isPrimary: currentMember.isPrimary,
          coverageRole: currentMember.coverageRole,
          role: currentMember.role,
          trainingLevel: currentMember.trainingLevel,
          contributionKnowledgeNodeIds: currentMember.contributionKnowledgeNodeIds,
        } : null);
        const nextMember = members.find((member) => member.questionId === questionId);
        const after = JSON.stringify(nextMember ? {
          familyId: family.id,
          isPrimary: nextMember.isPrimary,
          coverageRole: nextMember.coverageRole,
          role: nextMember.role,
          trainingLevel: nextMember.trainingLevel,
          contributionKnowledgeNodeIds: nextMember.contributionKnowledgeNodeIds,
        } : null);
        if (before === after) return family;
        affectedFamilyIds.push(family.id);
        return normalizeFamily({
          ...family,
          source: members.length ? "manual_family" : "manual_empty_family",
          members,
          updatedAt: Date.now(),
        });
      });
      if (affectedFamilyIds.length) bumpMembershipRevisions(state, [questionId]);
      write(state);
      return {
        memberships: this.memberships([questionId], { bookId, status: "all" })[questionId] || [],
        affectedFamilyIds,
        actor,
      };
    },
    generate(questions, bookId = "modern-chinese-7-1", options = {}) {
      const state = read();
      const rawGenerated = buildFamilyCandidates(questions, bookId, options);
      const consolidatedGenerated = mergeVisibleDuplicateFamilies(rawGenerated.families, state.familyAliases);
      state.familyAliases = consolidatedGenerated.aliases;
      const generated = { ...rawGenerated, families: consolidatedGenerated.families };
      const resetReviewFamilyIds = new Set((Array.isArray(options.resetReviewFamilyIds) ? options.resetReviewFamilyIds : []).map(String));
      const resetReviewQuestionIds = new Set((Array.isArray(options.resetReviewQuestionIds) ? options.resetReviewQuestionIds : []).map(String));
      const preserveFamilyIds = new Set([
        ...(Array.isArray(options.preserveFamilyIds) ? options.preserveFamilyIds : []).map(String),
        ...state.familySetLinks.filter((link) => link.memberType === "family").map((link) => link.memberId),
      ].map((familyId) => resolveFamilyId(state, familyId)));
      const previousFamilies = state.families.filter((family) => family.bookId === bookId);
      if (previousFamilies.length) {
        const history = Array.isArray(state.historyByBook[bookId]) ? state.historyByBook[bookId] : [];
        state.historyByBook[bookId] = [...history, {
          generatedAt: state.generatedAtByBook[bookId] || 0,
          archivedAt: Date.now(),
          reason: String(options.archiveReason || "regenerated"),
          families: previousFamilies,
        }].slice(-5);
      }
      const existingById = new Map(state.families.map((family) => [family.id, family]));
      const existingBySemanticKey = new Map(previousFamilies.map((family) => [familySemanticKey(family), family]));
      const existingByVisibleKey = new Map(previousFamilies.map((family) => [familyVisibleSemanticKey(family), family]).filter(([key]) => key));
      const nextFamilies = generated.families.map((family) => {
        const existing = existingById.get(family.id)
          || existingBySemanticKey.get(familySemanticKey(family))
          || existingByVisibleKey.get(familyVisibleSemanticKey(family));
        if (!existing) return family;
        if (existing.id !== family.id) state.familyAliases[family.id] = existing.id;
        if (existing.source === "manual_family") {
          return normalizeFamily({
            ...existing,
            members: existing.members.map((member) => (resetReviewQuestionIds.has(member.questionId)
              ? pendingMember(member, "question_regenerated", "system")
              : member)),
            updatedAt: existing.members.some((member) => resetReviewQuestionIds.has(member.questionId))
              ? Date.now()
              : existing.updatedAt,
          });
        }
        if (existing.source === "manual_empty_family") {
          return normalizeFamily({
            ...existing,
            source: "manual_family",
            members: reconcileMembers(existing.members, family.members, "question_membership_generated", "system"),
            updatedAt: Date.now(),
          });
        }
        const definitionUnchanged = familyDefinitionSignature(existing) === familyDefinitionSignature(family);
        const definitionInvalidated = !definitionUnchanged || resetReviewFamilyIds.has(existing.id);
        const generatedQuestionIds = new Set(family.members.map((member) => member.questionId));
        const preservedConfirmedMembers = existing.members.filter((member) => member.reviewStatus === "confirmed"
          && !generatedQuestionIds.has(member.questionId));
        let members = normalizeMembers([
          ...reconcileMembers(existing.members, family.members, "question_membership_regenerated", "system"),
          ...preservedConfirmedMembers,
        ]).map((member) => (resetReviewQuestionIds.has(member.questionId)
          ? pendingMember(member, "question_regenerated", "system")
          : member));
        const existingPrototypeId = existing.members
          .find((member) => member.role === "prototype" && member.reviewStatus === "confirmed")?.questionId;
        if (existingPrototypeId && members.some((member) => member.questionId === existingPrototypeId)) {
          members = members.map((member) => {
            const nextRole = member.questionId === existingPrototypeId
              ? "prototype"
              : (member.role === "prototype" ? "similar" : member.role);
            return nextRole === member.role
              ? member
              : pendingMember({ ...member, role: nextRole }, "question_membership_regenerated", "system");
          });
        }
        if (definitionInvalidated) {
          members = members.map((member) => pendingMember(member, "family_definition_regenerated", "system"));
        }
        return normalizeFamily({
          ...family,
          id: existing.id,
          status: definitionInvalidated ? "pending_review" : existing.status,
          members,
          createdAt: existing.createdAt,
          reviewedAt: definitionInvalidated ? null : existing.reviewedAt,
          reviewedBy: definitionInvalidated ? "" : existing.reviewedBy,
          reviewInvalidationReason: definitionInvalidated ? "family_definition_regenerated" : existing.reviewInvalidationReason,
          reviewInvalidatedBy: definitionInvalidated ? "system" : existing.reviewInvalidatedBy,
          updatedAt: Date.now(),
        });
      });
      const generatedIds = new Set(nextFamilies.map((family) => family.id));
      const preservedEmptyFamilies = previousFamilies.filter((family) => ["manual_empty_family", "manual_family"].includes(family.source)
        && !generatedIds.has(family.id)
        && !nextFamilies.some((candidate) => familySemanticKey(candidate) === familySemanticKey(family)
          || (familyVisibleSemanticKey(candidate) && familyVisibleSemanticKey(candidate) === familyVisibleSemanticKey(family))));
      const preservedReviewedFamilies = previousFamilies.filter((family) => ["confirmed", "rejected"].includes(family.status)
        && !["manual_empty_family", "manual_family"].includes(family.source)
        && !resetReviewFamilyIds.has(family.id)
        && !generatedIds.has(family.id)
        && !preservedEmptyFamilies.some((candidate) => candidate.id === family.id))
        .map((family) => normalizeFamily({
          ...family,
          members: family.members.map((member) => (resetReviewQuestionIds.has(member.questionId)
            ? pendingMember(member, "question_regenerated", "system")
            : member)),
          updatedAt: Date.now(),
        }));
      const preservedSelectedFamilies = previousFamilies.filter((family) => preserveFamilyIds.has(family.id)
        && !generatedIds.has(family.id)
        && !preservedEmptyFamilies.some((candidate) => candidate.id === family.id)
        && !preservedReviewedFamilies.some((candidate) => candidate.id === family.id));
      const mergedFamilies = [...nextFamilies, ...preservedEmptyFamilies, ...preservedReviewedFamilies, ...preservedSelectedFamilies].sort((left, right) => Number(left.orderIndex) - Number(right.orderIndex)
        || left.name.localeCompare(right.name, "zh-CN"));
      state.families = [
        ...state.families.filter((family) => family.bookId !== bookId),
        ...mergedFamilies,
      ];
      const previousById = new Map(previousFamilies.map((family) => [family.id, family]));
      const nextById = new Map(mergedFamilies.map((family) => [family.id, family]));
      const revisionQuestionIds = new Set();
      new Set([...previousById.keys(), ...nextById.keys()]).forEach((familyId) => {
        changedMemberQuestionIds(
          previousById.get(familyId)?.members || [],
          nextById.get(familyId)?.members || [],
        ).forEach((questionId) => revisionQuestionIds.add(questionId));
      });
      bumpMembershipRevisions(state, [...revisionQuestionIds]);
      state.generatedAtByBook[bookId] = Date.now();
      write(state);
      return {
        ...familySummary(mergedFamilies, generated.unresolvedQuestionIds.length),
        ...generated.summary,
        familyCount: mergedFamilies.length,
        families: clone(mergedFamilies),
      };
    },
    review(id, payload = {}, actor = "超级管理员") {
      const state = read();
      const resolvedId = resolveFamilyId(state, id);
      const index = state.families.findIndex((family) => family.id === resolvedId);
      if (index < 0) throw new Error("question_family_not_found");
      const current = state.families[index];
      const hasExplicitStatus = familyStatuses.has(payload.status);
      const explicitlyConfirmed = payload.status === "confirmed";
      let status = hasExplicitStatus ? payload.status : current.status;
      let members = payload.members == null
        ? current.members
        : reconcileMembers(current.members, payload.members, "question_membership_updated", actor);
      const name = payload.name == null ? current.name : cleanText(payload.name).slice(0, 200);
      const focusKey = payload.focusKey == null ? current.focusKey : cleanText(payload.focusKey).slice(0, 240);
      const reason = payload.reason == null ? current.reason : cleanText(payload.reason).slice(0, 1000);
      const backendDirectoryAnchorNodeId = String(payload.backendDirectoryAnchorNodeId == null
        ? (payload.scopeAnchorNodeId == null
          ? (payload.coreKnowledgeNodeId == null ? current.backendDirectoryAnchorNodeId || current.coreKnowledgeNodeId : payload.coreKnowledgeNodeId)
          : payload.scopeAnchorNodeId)
        : payload.backendDirectoryAnchorNodeId);
      const coreKnowledgeNodeId = backendDirectoryAnchorNodeId;
      const requiredKnowledgeNodeIds = normalizedRequiredNodeIds(
        payload.requiredKnowledgeNodeIds == null ? current.requiredKnowledgeNodeIds : payload.requiredKnowledgeNodeIds,
      );
      const textbookAnchorNodeIds = normalizedNodeIds(payload.textbookAnchorNodeIds == null
        ? current.textbookAnchorNodeIds
        : payload.textbookAnchorNodeIds);
      const userDirectoryAnchorNodeId = String(payload.userDirectoryAnchorNodeId == null
        ? (payload.locationNodeId == null
          ? (textbookAnchorNodeIds[0] || current.userDirectoryAnchorNodeId || current.knowledgeNodeId || "")
          : payload.locationNodeId)
        : payload.userDirectoryAnchorNodeId);
      const knowledgeNodeId = userDirectoryAnchorNodeId || textbookAnchorNodeIds[0] || "";
      const chapter = payload.chapter == null ? current.chapter : cleanText(payload.chapter).slice(0, 300);
      const primaryKnowledgePoint = payload.primaryKnowledgePoint == null
        ? current.primaryKnowledgePoint
        : cleanText(payload.primaryKnowledgePoint).slice(0, 200);
      const knowledgePath = payload.knowledgePath == null
        ? current.knowledgePath
        : cleanText(payload.knowledgePath).slice(0, 800);
      const knowledgeLevel = payload.knowledgeLevel == null
        ? current.knowledgeLevel
        : Math.max(0, Number(payload.knowledgeLevel) || 0);
      const orderIndex = payload.orderIndex == null
        ? current.orderIndex
        : (Number.isFinite(Number(payload.orderIndex)) ? Number(payload.orderIndex) : Number.MAX_SAFE_INTEGER);
      const assessmentAction = payload.assessmentAction == null
        ? current.assessmentAction
        : cleanText(payload.assessmentAction).slice(0, 200);
      const inclusionBoundary = payload.inclusionBoundary == null
        ? current.inclusionBoundary
        : cleanText(payload.inclusionBoundary).slice(0, 4000);
      const exclusionBoundary = payload.exclusionBoundary == null
        ? current.exclusionBoundary
        : cleanText(payload.exclusionBoundary).slice(0, 4000);
      if (!coreKnowledgeNodeId || !textbookAnchorNodeIds.length) throw new Error("question_family_knowledge_required");
      if (!requiredKnowledgeNodeIds.length) throw new Error("question_family_required_knowledge_required");
      const candidateVisibleKey = familyVisibleSemanticKey({
        ...current,
        name,
        knowledgeNodeId,
        knowledgePath,
        chapter,
      });
      const duplicate = state.families.some((family, familyIndex) => familyIndex !== index
        && candidateVisibleKey
        && familyVisibleSemanticKey(family) === candidateVisibleKey);
      if (duplicate) throw new Error("question_family_duplicate");
      const definitionCandidate = {
        ...current,
        coreKnowledgeNodeId,
        backendDirectoryAnchorNodeId,
        scopeAnchorNodeId: backendDirectoryAnchorNodeId,
        userDirectoryAnchorNodeId,
        requiredKnowledgeNodeIds,
        textbookAnchorNodeIds,
        assessmentAction,
        inclusionBoundary,
        exclusionBoundary,
      };
      const definitionChanged = familyDefinitionSignature(current) !== familyDefinitionSignature(definitionCandidate);
      const initialFamilyConfirmation = explicitlyConfirmed
        && current.status === "pending_review"
        && !current.reviewInvalidationReason
        && !current.reviewedAt;
      if (definitionChanged && !explicitlyConfirmed) {
        status = "pending_review";
        members = members.map((member) => pendingMember(member, "family_definition_updated", actor));
      } else if (initialFamilyConfirmation) {
        members = members.map((member) => confirmedMember(member, actor));
      } else if (definitionChanged) {
        members = members.map((member) => pendingMember(member, "family_definition_updated", actor));
      }
      if (explicitlyConfirmed) {
        if (!members.length) throw new Error("question_family_members_required");
        if (members.filter((member) => member.role === "prototype").length !== 1) throw new Error("question_family_prototype_required");
      }
      const now = Date.now();
      const reviewInvalidated = definitionChanged && !explicitlyConfirmed;
      state.families[index] = normalizeFamily({
        ...current,
        name,
        focusKey,
        reason,
        chapter,
        primaryKnowledgePoint,
        knowledgeNodeId,
        userDirectoryAnchorNodeId,
        coreKnowledgeNodeId,
        backendDirectoryAnchorNodeId,
        // Keep legacy aliases synchronized with the explicit anchors.  Without
        // this, normalizeFamily prefers the old userDirectoryAnchorNodeId
        // from `current` and a confirmed move appears to stay in its source
        // directory.
        locationNodeId: userDirectoryAnchorNodeId,
        scopeAnchorNodeId: backendDirectoryAnchorNodeId,
        knowledgePath,
        knowledgeLevel,
        requiredKnowledgeNodeIds,
        textbookAnchorNodeIds,
        assessmentAction,
        inclusionBoundary,
        exclusionBoundary,
        orderIndex,
        status,
        members,
        updatedAt: now,
        reviewedAt: reviewInvalidated
          ? null
          : (hasExplicitStatus ? (status === "pending_review" ? null : now) : current.reviewedAt),
        reviewedBy: reviewInvalidated
          ? ""
          : (hasExplicitStatus ? (status === "pending_review" ? "" : actor) : current.reviewedBy),
        reviewInvalidationReason: reviewInvalidated
          ? "family_definition_updated"
          : (explicitlyConfirmed ? "" : current.reviewInvalidationReason),
        reviewInvalidatedBy: reviewInvalidated
          ? actor
          : (explicitlyConfirmed ? "" : current.reviewInvalidatedBy),
      });
      const revisionQuestionIds = new Set(changedMemberQuestionIds(current.members, state.families[index].members));
      if (definitionChanged) {
        [...current.members, ...state.families[index].members]
          .forEach((member) => revisionQuestionIds.add(member.questionId));
      }
      bumpMembershipRevisions(state, [...revisionQuestionIds]);
      write(state);
      return clone(state.families[index]);
    },
    reviewMember(id, questionId, payload = {}, actor = "超级管理员") {
      const state = read();
      const resolvedId = resolveFamilyId(state, id);
      const index = state.families.findIndex((family) => family.id === resolvedId);
      if (index < 0) throw new Error("question_family_not_found");
      const current = state.families[index];
      const normalizedQuestionId = String(questionId || "");
      const memberIndex = current.members.findIndex((member) => member.questionId === normalizedQuestionId);
      if (memberIndex < 0) throw new Error("question_family_member_not_found");
      const decision = payload.status === "confirmed"
        ? "confirmed"
        : (payload.status === "rejected" ? "rejected" : "");
      if (!decision) throw new Error("question_family_member_review_status_invalid");
      if (payload.expectedRevision == null || payload.expectedRevision === ""
        || !Number.isInteger(Number(payload.expectedRevision)) || Number(payload.expectedRevision) < 0) {
        throw new Error("question_family_membership_revision_required");
      }
      const currentRevision = Math.max(0, Number(state.membershipRevisionByQuestion[normalizedQuestionId]) || 0);
      if (Number(payload.expectedRevision) !== currentRevision) {
        throw new Error("question_family_membership_revision_conflict");
      }
      if (decision === "confirmed" && current.status === "rejected") throw new Error("question_family_rejected");
      const previousMember = current.members[memberIndex];
      const requestedContributionKnowledgeNodeIds = payload.contributionKnowledgeNodeIds == null
        ? previousMember.contributionKnowledgeNodeIds
        : normalizedRequiredNodeIds(payload.contributionKnowledgeNodeIds);
      const requestedCoverageRole = payload.coverageRole == null
        ? previousMember.coverageRole
        : String(payload.coverageRole || "");
      const coverageRole = previousMember.isPrimary
        ? "required"
        : (memberCoverageRoles.has(requestedCoverageRole) ? requestedCoverageRole : "");
      if (payload.coverageRole != null && !coverageRole) {
        throw new Error("question_family_member_coverage_role_invalid");
      }
      if (requestedContributionKnowledgeNodeIds.some((nodeId) => !current.requiredKnowledgeNodeIds.includes(nodeId))) {
        throw new Error("question_family_member_contribution_invalid");
      }
      if (coverageRole === "reference" && requestedContributionKnowledgeNodeIds.length) {
        throw new Error("question_family_reference_contribution_forbidden");
      }
      const reviewedMember = normalizeMember({
        ...previousMember,
        coverageRole,
        contributionKnowledgeNodeIds: requestedContributionKnowledgeNodeIds,
      }, { reviewStatus: previousMember.reviewStatus });
      if (decision === "confirmed" && previousMember.reviewStatus === "confirmed"
        && memberFitSignature(previousMember) === memberFitSignature(reviewedMember)) {
        return {
          family: clone(current),
          member: clone(reviewedMember),
          previousMember: clone(previousMember),
          decision,
          removed: false,
          membershipRevision: currentRevision,
          membershipRevisions: { [normalizedQuestionId]: currentRevision },
          affectedQuestionIds: [],
          actor,
        };
      }

      let members;
      if (decision === "confirmed") {
        members = current.members.map((member, candidateIndex) => (candidateIndex === memberIndex
          ? confirmedMember(reviewedMember, actor)
          : member));
      } else {
        members = promotePrototypeIfNeeded(
          current.members.filter((member) => member.questionId !== normalizedQuestionId),
          "question_family_prototype_promoted_after_rejection",
          actor,
        );
      }
      state.families[index] = normalizeFamily({
        ...current,
        source: members.length ? "manual_family" : "manual_empty_family",
        members,
        updatedAt: Date.now(),
      });
      normalizePrimaryMemberships(state.families);
      const affectedQuestionIds = new Set([normalizedQuestionId]);
      if (decision === "rejected" && previousMember.isPrimary) {
        const promoted = state.families
          .flatMap((family) => family.members.map((member) => ({ family, member })))
          .find(({ member }) => member.questionId === normalizedQuestionId && member.isPrimary);
        if (promoted) {
          const promotedIndex = promoted.family.members.findIndex((member) => member.questionId === normalizedQuestionId);
          promoted.family.members[promotedIndex] = pendingMember(
            promoted.member,
            "question_primary_membership_promoted_after_rejection",
            actor,
          );
        }
      }
      changedMemberQuestionIds(current.members, state.families[index].members)
        .forEach((affectedQuestionId) => affectedQuestionIds.add(affectedQuestionId));
      bumpMembershipRevisions(state, [...affectedQuestionIds]);
      write(state);
      const persisted = read();
      const family = persisted.families.find((candidate) => candidate.id === current.id);
      const member = family?.members.find((candidate) => candidate.questionId === normalizedQuestionId) || null;
      const membershipRevisions = Object.fromEntries([...affectedQuestionIds]
        .map((affectedQuestionId) => [
          affectedQuestionId,
          Math.max(0, Number(persisted.membershipRevisionByQuestion[affectedQuestionId]) || 0),
        ]));
      return {
        family: clone(family),
        member: member ? clone(member) : null,
        previousMember: clone(previousMember),
        decision,
        removed: decision === "rejected",
        membershipRevision: membershipRevisions[normalizedQuestionId],
        membershipRevisions,
        affectedQuestionIds: [...affectedQuestionIds],
        actor,
      };
    },
    confirmedForQuestion(questionId) {
      return read().families
        .filter((family) => hasConfirmedPrototype(family)
          && family.members.some((member) => member.questionId === String(questionId) && member.reviewStatus === "confirmed"))
        .map((family) => clone({
          ...family,
          members: family.members.filter((member) => member.reviewStatus === "confirmed"),
        }));
    },
  };
}

function createFileQuestionFamilyStore(filePath = path.resolve(__dirname, "../../../.runtime/question-families.json")) {
  return createQuestionFamilyStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { version: FAMILY_STATE_VERSION, families: [], familySets: [], familySetLinks: [] }; }
    },
    write(value) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryQuestionFamilyStore(initialState = { version: FAMILY_STATE_VERSION, families: [], familySets: [], familySetLinks: [] }) {
  let state = clone(initialState);
  return createQuestionFamilyStore({ read: () => clone(state), write: (next) => { state = clone(next); } });
}

module.exports = {
  buildFamilyCandidates,
  createFileQuestionFamilyStore,
  createMemoryQuestionFamilyStore,
  inferFocus,
  questionAction,
  trainingLevel,
};
