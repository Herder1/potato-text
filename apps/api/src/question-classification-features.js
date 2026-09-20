function cleanText(value, limit = 1000) {
  return String(value || "").normalize("NFKC").trim().slice(0, limit);
}

function uniqueStrings(value, limit = 50) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 240)).filter(Boolean))].slice(0, limit);
}

const OPTION_KNOWLEDGE_PROTOCOL_VERSION = "option-knowledge-v2";
const OPTION_KNOWLEDGE_RELATIONS = new Set(["question_only", "option_specific", "undetermined"]);
const STORED_OPTION_KNOWLEDGE_RELATIONS = new Set(["unreviewed", ...OPTION_KNOWLEDGE_RELATIONS]);
const CHOICE_STRUCTURES = new Set(["direct_options", "composed_options"]);

function normalizedItemKey(value) {
  return String(value || "").trim().slice(0, 40).toUpperCase();
}

function normalizedKnowledgeRelation(value, fallback = "unreviewed") {
  const relation = cleanText(value, 40);
  return STORED_OPTION_KNOWLEDGE_RELATIONS.has(relation) ? relation : fallback;
}

function normalizeAtomicStatements(value, fallback = []) {
  const fallbackByKey = new Map((Array.isArray(fallback) ? fallback : [])
    .map((item) => [normalizedItemKey(item?.key), item]));
  return (Array.isArray(value) ? value : fallback || []).map((item, index) => {
    const key = normalizedItemKey(item?.key || fallback?.[index]?.key);
    const previous = fallbackByKey.get(key) || fallback?.[index] || {};
    const relation = normalizedKnowledgeRelation(
      Object.prototype.hasOwnProperty.call(item || {}, "knowledgeRelation")
        ? item.knowledgeRelation : previous.knowledgeRelation,
    );
    const rawHints = uniqueStrings(item?.knowledgeHints?.length ? item.knowledgeHints : previous.knowledgeHints, 20);
    return {
      key,
      text: cleanText(item?.text || previous.text, 1200),
      knowledgeRelation: relation,
      knowledgeHints: relation === "option_specific" ? rawHints : [],
      legacyKnowledgeHints: relation === "unreviewed"
        ? uniqueStrings(item?.legacyKnowledgeHints?.length ? item.legacyKnowledgeHints : rawHints, 20)
        : uniqueStrings(item?.legacyKnowledgeHints, 20),
      matchedNodeIds: relation === "option_specific"
        ? uniqueStrings(item?.matchedNodeIds?.length ? item.matchedNodeIds : previous.matchedNodeIds, 20)
        : [],
      uncertaintyNote: relation === "undetermined"
        ? cleanText(item?.uncertaintyNote || previous.uncertaintyNote, 1000) : "",
      verdict: ["true", "false", "unknown"].includes(item?.verdict)
        ? item.verdict : (["true", "false", "unknown"].includes(previous.verdict) ? previous.verdict : "unknown"),
      basis: cleanText(item?.basis || previous.basis, 1000),
    };
  }).filter((item) => item.key || item.text).slice(0, 24);
}

function normalizeOptionComposition(value, fallback = []) {
  return (Array.isArray(value) ? value : fallback || []).map((item, index) => ({
    optionKey: normalizedItemKey(item?.optionKey || item?.key || fallback?.[index]?.optionKey),
    atomicKeys: [...new Set((Array.isArray(item?.atomicKeys) && item.atomicKeys.length
      ? item.atomicKeys : (fallback?.[index]?.atomicKeys || [])).map(normalizedItemKey).filter(Boolean))].slice(0, 24),
  })).filter((item) => item.optionKey).slice(0, 12);
}

function featureProfileContractViolations(profile = {}, question = {}) {
  const violations = [];
  const add = (code, detail = "") => violations.push({ code, detail: cleanText(detail, 500) });
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    add("feature_profile_invalid");
    return violations;
  }
  if (profile.optionKnowledgeProtocolVersion !== OPTION_KNOWLEDGE_PROTOCOL_VERSION) {
    add("protocol_version_invalid", `expected=${OPTION_KNOWLEDGE_PROTOCOL_VERSION}`);
  }
  const choiceStructure = cleanText(profile.choiceStructure, 40);
  if (!CHOICE_STRUCTURES.has(choiceStructure)) add("choice_structure_invalid", choiceStructure);

  const expectedOptionKeys = (Array.isArray(question.options) ? question.options : [])
    .map((option) => normalizedItemKey(option?.key)).filter(Boolean);
  const rawOptions = Array.isArray(profile.optionFeatures) ? profile.optionFeatures : [];
  const returnedOptionKeys = rawOptions.map((option) => normalizedItemKey(option?.key)).filter(Boolean);
  const returnedOptionSet = new Set(returnedOptionKeys);
  if (returnedOptionKeys.length !== returnedOptionSet.size) add("option_keys_duplicate");
  if (rawOptions.length !== expectedOptionKeys.length
    || expectedOptionKeys.some((key) => !returnedOptionSet.has(key))
    || returnedOptionKeys.some((key) => !expectedOptionKeys.includes(key))) {
    add("option_keys_mismatch", `expected=${expectedOptionKeys.join(",")};returned=${returnedOptionKeys.join(",")}`);
  }

  const validateKnowledgeItem = (item, key, scope) => {
    const relation = cleanText(item?.knowledgeRelation, 40);
    const hints = uniqueStrings(item?.knowledgeHints, 20);
    const uncertaintyNote = cleanText(item?.uncertaintyNote, 1000);
    if (!OPTION_KNOWLEDGE_RELATIONS.has(relation)) {
      add(`${scope}_relation_invalid`, key);
      return;
    }
    if (relation === "option_specific" && !hints.length) add(`${scope}_knowledge_required`, key);
    if (relation !== "option_specific" && hints.length) add(`${scope}_knowledge_forbidden`, key);
    if (relation === "undetermined" && !uncertaintyNote) add(`${scope}_uncertainty_required`, key);
    if (relation !== "undetermined" && uncertaintyNote) add(`${scope}_uncertainty_forbidden`, key);
    if (!cleanText(item?.basis, 1000)) add(`${scope}_basis_required`, key);
  };

  if (choiceStructure === "direct_options") {
    rawOptions.forEach((item) => validateKnowledgeItem(item, normalizedItemKey(item?.key), "option"));
    if ((Array.isArray(profile.atomicStatements) && profile.atomicStatements.length)
      || (Array.isArray(profile.optionComposition) && profile.optionComposition.length)) {
      add("direct_options_composition_forbidden");
    }
  }

  if (choiceStructure === "composed_options") {
    rawOptions.forEach((item) => {
      if (Object.prototype.hasOwnProperty.call(item || {}, "knowledgeRelation")
        || uniqueStrings(item?.knowledgeHints, 20).length) add("composed_option_knowledge_forbidden", normalizedItemKey(item?.key));
    });
    const statements = Array.isArray(profile.atomicStatements) ? profile.atomicStatements : [];
    if (!statements.length) add("atomic_statements_required");
    const atomicKeys = statements.map((item) => normalizedItemKey(item?.key)).filter(Boolean);
    const atomicSet = new Set(atomicKeys);
    if (atomicKeys.length !== statements.length || atomicSet.size !== atomicKeys.length) add("atomic_keys_invalid");
    statements.forEach((item) => {
      const key = normalizedItemKey(item?.key);
      if (!cleanText(item?.text, 1200)) add("atomic_text_required", key);
      validateKnowledgeItem(item, key, "atomic");
    });
    const composition = Array.isArray(profile.optionComposition) ? profile.optionComposition : [];
    const compositionKeys = composition.map((item) => normalizedItemKey(item?.optionKey || item?.key)).filter(Boolean);
    const compositionSet = new Set(compositionKeys);
    if (composition.length !== expectedOptionKeys.length || compositionKeys.length !== compositionSet.size
      || expectedOptionKeys.some((key) => !compositionSet.has(key))) add("option_composition_mismatch");
    const referenced = new Set();
    composition.forEach((item) => {
      const optionKey = normalizedItemKey(item?.optionKey || item?.key);
      const refs = [...new Set((Array.isArray(item?.atomicKeys) ? item.atomicKeys : [])
        .map(normalizedItemKey).filter(Boolean))].slice(0, 24);
      if (!refs.length || refs.some((key) => !atomicSet.has(key))) add("option_composition_reference_invalid", optionKey);
      refs.forEach((key) => referenced.add(key));
    });
    if ([...atomicSet].some((key) => !referenced.has(key))) add("atomic_statement_unreferenced");
  }
  return violations;
}

function validateFeatureProfileContract(profile, question = {}) {
  const violations = featureProfileContractViolations(profile, question);
  if (violations.length) {
    const error = new Error("knowledge_feature_extraction_contract_invalid");
    error.contractViolations = violations;
    throw error;
  }
  return profile;
}

function normalizedKnowledgeTitle(node = {}) {
  return cleanText(node.displayTitle || node.title, 120)
    .replace(/^[（(]?[一二三四五六七八九十\d]+[)）、.．\s]+/u, "")
    .replace(/^(?:看|按|从)(?=.{2,})/u, "")
    .trim();
}

function matchingKnowledgeNodes(text, nodes) {
  const normalized = cleanText(text, 12000).toLocaleLowerCase("zh-CN");
  return (Array.isArray(nodes) ? nodes : []).filter((node) => {
    if (node.kind && node.kind !== "knowledge") return false;
    const title = normalizedKnowledgeTitle(node).toLocaleLowerCase("zh-CN");
    return title.length >= 2 && normalized.includes(title);
  });
}

function lexicalKeywords(text, knowledgeTitles = []) {
  const source = cleanText(text, 12000);
  const quoted = [...source.matchAll(/[“‘"']([^”’"']{1,24})[”’"']/gu)].map((match) => match[1]);
  const concepts = source.match(/[\u3400-\u9fff]{2,8}(?:方法|特点|结构|意义|种类|关系|规律|单位|音位|音素|音节|声母|韵母|元音|辅音|词汇|语法)/gu) || [];
  return uniqueStrings([...knowledgeTitles, ...quoted, ...concepts], 24);
}

function normalizeFeatureProfile(input = {}, fallback = {}) {
  const choiceStructure = CHOICE_STRUCTURES.has(input.choiceStructure)
    ? input.choiceStructure : (CHOICE_STRUCTURES.has(fallback.choiceStructure) ? fallback.choiceStructure : "direct_options");
  const optionFeatures = (Array.isArray(input.optionFeatures) ? input.optionFeatures : fallback.optionFeatures || []).map((item, index) => {
    const previous = fallback.optionFeatures?.[index] || {};
    const relation = normalizedKnowledgeRelation(
      Object.prototype.hasOwnProperty.call(item || {}, "knowledgeRelation")
        ? item.knowledgeRelation : previous.knowledgeRelation,
    );
    const rawKnowledgeHints = uniqueStrings(item?.knowledgeHints?.length ? item.knowledgeHints : previous.knowledgeHints, 20);
    const normalized = {
      key: normalizedItemKey(item?.key || previous.key),
      text: cleanText(item?.text || previous.text, 800),
      keywords: uniqueStrings(item?.keywords?.length ? item.keywords : previous.keywords, 20),
      isCorrect: item?.isCorrect === true || previous.isCorrect === true,
      role: ["answer", "distractor", "statement"].includes(item?.role) ? item.role : (previous.role || "statement"),
      weight: Math.min(1, Math.max(0, Number(item?.weight ?? previous.weight) || 0)),
      decisionRole: ["supports_answer", "required_for_elimination", "incidental", "unknown"].includes(item?.decisionRole)
        ? item.decisionRole : (previous.decisionRole || "unknown"),
      requiredForDecision: item?.requiredForDecision === true
        || (item?.requiredForDecision === undefined && previous.requiredForDecision === true),
      basis: cleanText(item?.basis || previous.basis, 800),
    };
    if (choiceStructure === "composed_options") return normalized;
    return {
      ...normalized,
      knowledgeRelation: relation,
      knowledgeHints: relation === "option_specific" ? rawKnowledgeHints : [],
      legacyKnowledgeHints: relation === "unreviewed"
        ? uniqueStrings(item?.legacyKnowledgeHints?.length ? item.legacyKnowledgeHints : rawKnowledgeHints, 20)
        : uniqueStrings(item?.legacyKnowledgeHints, 20),
      matchedNodeIds: relation === "option_specific"
        ? uniqueStrings(item?.matchedNodeIds?.length ? item.matchedNodeIds : previous.matchedNodeIds, 20)
        : [],
      uncertaintyNote: relation === "undetermined"
        ? cleanText(item?.uncertaintyNote || previous.uncertaintyNote, 1000) : "",
    };
  }).filter((item) => item.key || item.text).slice(0, 12);
  const atomicStatements = choiceStructure === "composed_options"
    ? normalizeAtomicStatements(input.atomicStatements, fallback.atomicStatements) : [];
  const optionComposition = choiceStructure === "composed_options"
    ? normalizeOptionComposition(input.optionComposition, fallback.optionComposition) : [];
  const dependencySteps = (Array.isArray(input.dependencySteps) ? input.dependencySteps : fallback.dependencySteps || []).map((step, index) => {
    const necessity = ["core", "required", "secondary", "incidental"].includes(step?.necessity) ? step.necessity : "required";
    const dependencyRole = ["independent_required", "input_descriptor", "terminology_only", "absorbed_by_core", "incidental"].includes(step?.dependencyRole)
      ? step.dependencyRole
      : (necessity === "incidental" ? "incidental" : (["core", "required"].includes(necessity) ? "independent_required" : "input_descriptor"));
    return {
      ref: `dep-${index + 1}`,
      order: Math.max(1, Number(step?.order) || index + 1),
      label: cleanText(step?.label || step?.knowledge || step, 240),
      nodeIds: uniqueStrings(step?.nodeIds, 20),
      source: ["stem", "option", "material", "answer", "bridge"].includes(step?.source) ? step.source : "stem",
      necessity,
      dependencyRole,
      coveredByStepRef: cleanText(step?.coveredByStepRef, 40),
      basis: cleanText(step?.basis, 800),
    };
  }).filter((step) => step.label || step.nodeIds.length).slice(0, 12);
  const dependencyRefs = new Set(dependencySteps.map((step) => step.ref));
  dependencySteps.forEach((step) => {
    if (!dependencyRefs.has(step.coveredByStepRef) || step.coveredByStepRef === step.ref) step.coveredByStepRef = "";
  });
  const inferredCoreNodeIds = uniqueStrings(input.coreKnowledgeNodeIds?.length
    ? input.coreKnowledgeNodeIds
    : (fallback.coreKnowledgeNodeIds?.length ? fallback.coreKnowledgeNodeIds : dependencySteps.filter((step) => step.necessity === "core").flatMap((step) => step.nodeIds)), 20);
  const inferredRequiredNodeIds = uniqueStrings(input.requiredKnowledgeNodeIds?.length
    ? input.requiredKnowledgeNodeIds
    : (fallback.requiredKnowledgeNodeIds?.length ? fallback.requiredKnowledgeNodeIds : dependencySteps
      .filter((step) => ["core", "required", "secondary"].includes(step.necessity)).flatMap((step) => step.nodeIds)), 20);
  return {
    optionKnowledgeProtocolVersion: input.optionKnowledgeProtocolVersion === OPTION_KNOWLEDGE_PROTOCOL_VERSION
      ? OPTION_KNOWLEDGE_PROTOCOL_VERSION
      : (fallback.optionKnowledgeProtocolVersion === OPTION_KNOWLEDGE_PROTOCOL_VERSION
        ? OPTION_KNOWLEDGE_PROTOCOL_VERSION : "legacy"),
    choiceStructure,
    questionMode: ["stem_direct", "option_judgement", "material_analysis", "composite"].includes(input.questionMode)
      ? input.questionMode : (fallback.questionMode || "stem_direct"),
    stemKeywords: uniqueStrings(input.stemKeywords?.length ? input.stemKeywords : fallback.stemKeywords, 30),
    coreKeywords: uniqueStrings(input.coreKeywords?.length ? input.coreKeywords : (fallback.coreKeywords?.length ? fallback.coreKeywords : input.stemKeywords || fallback.stemKeywords), 30),
    stemKnowledgeHints: uniqueStrings(input.stemKnowledgeHints?.length ? input.stemKnowledgeHints : fallback.stemKnowledgeHints, 20),
    stemMatchedNodeIds: uniqueStrings(input.stemMatchedNodeIds?.length ? input.stemMatchedNodeIds : fallback.stemMatchedNodeIds, 20),
    optionFeatures,
    atomicStatements,
    optionComposition,
    primaryKnowledgeHints: uniqueStrings(input.primaryKnowledgeHints?.length ? input.primaryKnowledgeHints : fallback.primaryKnowledgeHints, 20),
    secondaryKnowledgeHints: uniqueStrings(input.secondaryKnowledgeHints?.length ? input.secondaryKnowledgeHints : fallback.secondaryKnowledgeHints, 30),
    coreKnowledgeNodeIds: inferredCoreNodeIds,
    requiredKnowledgeNodeIds: uniqueStrings([...inferredCoreNodeIds, ...inferredRequiredNodeIds], 20),
    dependencySteps,
    knowledgePriorities: (Array.isArray(input.knowledgePriorities) ? input.knowledgePriorities : fallback.knowledgePriorities || []).map((item) => ({
      label: cleanText(item?.label || item?.knowledge, 240),
      nodeIds: uniqueStrings(item?.nodeIds, 20),
      role: ["primary", "secondary"].includes(item?.role) ? item.role : "secondary",
      weight: Math.min(1, Math.max(0, Number(item?.weight) || 0)),
      basis: cleanText(item?.basis, 800),
    })).filter((item) => item.label || item.nodeIds.length).slice(0, 20),
    primaryBasis: cleanText(input.primaryBasis || fallback.primaryBasis, 1200),
    crossFamilyProbability: Math.min(1, Math.max(0, Number(input.crossFamilyProbability ?? fallback.crossFamilyProbability) || 0)),
    callDepth: Math.min(20, Math.max(1, Number(input.callDepth ?? fallback.callDepth) || 1)),
    extractionSource: input.extractionSource === "model" ? "model" : (fallback.extractionSource || "heuristic"),
  };
}

function extractQuestionClassificationFeatures(question = {}, structure = {}) {
  const nodes = (structure.nodes || []).filter((node) => !node.kind || node.kind === "knowledge");
  const stemText = [question.material, question.stem].filter(Boolean).join("\n");
  const stemNodes = matchingKnowledgeNodes(stemText, nodes);
  const correctAnswers = new Set((question.correctAnswer || []).map((key) => cleanText(key, 20).toUpperCase()));
  const optionDriven = /(?:下列|以下|哪个|哪项|正确的是|错误的是|不正确|不属于|属于的是|说法)/u.test(question.stem || "");
  const options = Array.isArray(question.options) ? question.options : [];
  const correctCount = Math.max(1, options.filter((option) => correctAnswers.has(cleanText(option.key, 20).toUpperCase())).length);
  const distractorCount = Math.max(1, options.length - correctCount);
  const optionFeatures = options.map((option) => {
    const nodesForOption = matchingKnowledgeNodes(option.text, nodes);
    const isCorrect = correctAnswers.has(cleanText(option.key, 20).toUpperCase());
    const weight = optionDriven ? (isCorrect ? 0.4 / correctCount : 0.6 / distractorCount) : (isCorrect ? 0.65 / correctCount : 0.35 / distractorCount);
    return {
      key: cleanText(option.key, 20),
      text: cleanText(option.text, 800),
      keywords: lexicalKeywords(option.text, nodesForOption.map(normalizedKnowledgeTitle)),
      knowledgeRelation: "unreviewed",
      knowledgeHints: [],
      legacyKnowledgeHints: uniqueStrings(nodesForOption.map(normalizedKnowledgeTitle), 20),
      matchedNodeIds: uniqueStrings(nodesForOption.map((node) => node.id), 20),
      isCorrect,
      role: isCorrect ? "answer" : "distractor",
      weight,
      decisionRole: isCorrect ? "supports_answer" : (optionDriven ? "required_for_elimination" : "incidental"),
      requiredForDecision: false,
      basis: isCorrect
        ? "启发式只能识别答案角色，是否需要独立选项知识仍待 Agent 1 按删除检验判断。"
        : (optionDriven ? "题干要求逐项判断，但该项是否需要独立知识仍待删除检验，不能因题型句式自动纳入。" : "题干已有明确考查对象，该选项知识不自动进入最小充分知识集。"),
    };
  });
  const distractors = optionFeatures.filter((option) => !option.isCorrect && option.matchedNodeIds.length);
  const sharedDistractorNodeIds = distractors.length > 1
    ? distractors[0].matchedNodeIds.filter((id) => distractors.every((option) => option.matchedNodeIds.includes(id)))
    : [];
  const answerNodeIds = new Set(optionFeatures.filter((option) => option.isCorrect).flatMap((option) => option.matchedNodeIds));
  const distractorDominant = optionDriven && sharedDistractorNodeIds.some((id) => !answerNodeIds.has(id));
  const primaryNodeIds = stemNodes.length ? stemNodes.map((node) => node.id)
    : (distractorDominant ? sharedDistractorNodeIds : [...answerNodeIds]);
  const allNodeIds = uniqueStrings([
    ...primaryNodeIds,
    ...optionFeatures.flatMap((option) => option.matchedNodeIds),
  ], 40);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const primaryHints = primaryNodeIds.map((id) => normalizedKnowledgeTitle(nodeMap.get(id))).filter(Boolean);
  const secondaryHints = allNodeIds.filter((id) => !primaryNodeIds.includes(id)).map((id) => normalizedKnowledgeTitle(nodeMap.get(id))).filter(Boolean);
  const fallbackHints = uniqueStrings([question.primaryKnowledgePoint, ...(question.knowledgePoints || [])], 20);
  const dependencyNodeIds = uniqueStrings([...primaryNodeIds, ...allNodeIds.filter((id) => !primaryNodeIds.includes(id))], 20);
  const dependencySteps = dependencyNodeIds.map((id, index) => ({
    order: index + 1,
    label: normalizedKnowledgeTitle(nodeMap.get(id)) || id,
    nodeIds: [id],
    source: primaryNodeIds.includes(id) ? "stem" : "option",
    necessity: primaryNodeIds.includes(id) ? "core" : "incidental",
    dependencyRole: primaryNodeIds.includes(id) ? "independent_required" : (optionDriven ? "input_descriptor" : "incidental"),
    coveredByStepRef: primaryNodeIds.includes(id) ? "" : (primaryNodeIds.length ? "dep-1" : ""),
    basis: primaryNodeIds.includes(id)
      ? "题干或答案方向直接指向该知识。"
      : (optionDriven ? "该知识用于判断或排除选项，作为低权重作答依赖候选。" : "仅在选项中出现，暂不视为作答必需知识。"),
  }));
  const distinctBranches = new Set(allNodeIds);
  const crossFamilyProbability = Math.min(0.95, distinctBranches.size <= 1 ? 0.15 : 0.45 + (distinctBranches.size - 2) * 0.15);
  return normalizeFeatureProfile({
    optionKnowledgeProtocolVersion: "legacy",
    choiceStructure: CHOICE_STRUCTURES.has(question.choiceStructure) ? question.choiceStructure : "direct_options",
    questionMode: question.material ? "material_analysis" : (optionDriven ? "option_judgement" : (allNodeIds.length > 1 ? "composite" : "stem_direct")),
    stemKeywords: lexicalKeywords(stemText, stemNodes.map(normalizedKnowledgeTitle)),
    coreKeywords: lexicalKeywords(stemText, stemNodes.map(normalizedKnowledgeTitle)),
    stemKnowledgeHints: uniqueStrings(stemNodes.map(normalizedKnowledgeTitle), 20),
    stemMatchedNodeIds: uniqueStrings(stemNodes.map((node) => node.id), 20),
    optionFeatures,
    primaryKnowledgeHints: primaryHints.length ? primaryHints : fallbackHints,
    secondaryKnowledgeHints: secondaryHints,
    coreKnowledgeNodeIds: primaryNodeIds,
    requiredKnowledgeNodeIds: primaryNodeIds,
    dependencySteps,
    knowledgePriorities: dependencyNodeIds.map((id) => ({
      label: normalizedKnowledgeTitle(nodeMap.get(id)) || id,
      nodeIds: [id],
      role: primaryNodeIds.includes(id) ? "primary" : "secondary",
      weight: primaryNodeIds.includes(id)
        ? Math.max(0.4, ...optionFeatures.filter((option) => option.matchedNodeIds.includes(id)).map((option) => option.weight))
        : optionFeatures.filter((option) => option.matchedNodeIds.includes(id)).reduce((sum, option) => sum + option.weight, 0),
      basis: primaryNodeIds.includes(id)
        ? "题干实际询问或正确答案直接依赖。"
        : "参与选项排除，权重低于核心知识。",
    })),
    primaryBasis: distractorDominant
      ? "题干要求判断选项，且多数干扰项集中在同一知识点；该共同知识点优先作为专项训练主维度，正确项知识点作为辅助维度。"
      : (stemNodes.length ? "主知识点优先依据题干直接询问的对象。" : "题干未直接命中目录节点，暂按答案与选项涉及的知识维度排序。"),
    crossFamilyProbability,
    callDepth: Math.max(1, dependencySteps.length),
    extractionSource: "heuristic",
  });
}

module.exports = {
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  OPTION_KNOWLEDGE_RELATIONS,
  CHOICE_STRUCTURES,
  extractQuestionClassificationFeatures,
  featureProfileContractViolations,
  normalizeFeatureProfile,
  validateFeatureProfileContract,
};
