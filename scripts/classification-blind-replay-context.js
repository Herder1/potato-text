const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  CORE_KNOWLEDGE_ROLES,
  FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  auditJointContributionCoverage,
  contentHash,
  knowledgeNodesCompatible,
  knowledgeSetsCompatible,
  readFrozenGoldSnapshot,
} = require("../apps/api/src/classification-gold-review-store");
const {
  normalizeAssessmentActionSemantics,
} = require("../packages/domain/assessment-action-semantics");
const {
  normalizeConfig,
} = require("../apps/api/src/ai-config");

const CONTEXT_SCHEMA_VERSION = "ClassificationBlindReplayContextV1";
const BINDING_SCHEMA_VERSION = "ClassificationBlindReplayBindingV1";
const GOLD_PREFLIGHT_SCHEMA_VERSION = "ClassificationGoldSemanticPreflightV1";
const CONTEXT_PREFLIGHT_SCHEMA_VERSION = "ClassificationBlindReplayContextPreflightV1";
const CONTEXT_VERSION = "C1";
const REQUIRED_MODES = ["mature", "singleton", "unmatched"];
const RUNTIME_CONTEXT_FILES = Object.freeze({
  questions: "questions.json",
  questionFamilies: "question-families.json",
  knowledgeStructures: "knowledge-structures.json",
  textbookKnowledge: "textbook-knowledge.json",
  textbookCatalogs: "textbook-catalogs.json",
  knowledgeDossiers: "knowledge-dossiers.json",
  knowledgeClassificationExperience: "knowledge-classification-experience.json",
  aiConfig: "ai-config.json",
});
const FORBIDDEN_CONTEXT_QUESTION_FIELDS = new Set([
  "knowledgeGold",
  "familyGold",
  "expectedDecision",
  "expectedFamilyId",
  "includedInAccuracy",
  "goldStatus",
]);
const SECRET_CONFIG_KEY = /(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|client[-_]?secret|credentials?)/i;

function isSecretConfigKey(key) {
  return String(key) !== "credentialRef" && SECRET_CONFIG_KEY.test(String(key));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
}

function sameStringSet(left, right) {
  const a = uniqueStrings(left).sort();
  const b = uniqueStrings(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeCoreKnowledgeRole(value) {
  const role = String(value || "").trim();
  return CORE_KNOWLEDGE_ROLES.has(role) ? role : "core";
}

function replayModeDistributions(items = []) {
  const empty = () => Object.fromEntries(REQUIRED_MODES.map((mode) => [mode, 0]));
  const total = empty();
  const scoreable = empty();
  const disputed = empty();
  items.forEach((item) => {
    const mode = String(item?.replayMode || item?.mode || "");
    if (!REQUIRED_MODES.includes(mode)) return;
    total[mode] += 1;
    const included = item?.includedInAccuracy !== false
      && String(item?.goldStatus || "") !== "gold_needs_review";
    (included ? scoreable : disputed)[mode] += 1;
  });
  return { total, scoreable, disputed };
}

function normalizedAction(value) {
  const normalized = normalizeAssessmentActionSemantics(value || "");
  if (["missing", "unclassified"].includes(normalized.type)) return normalized.normalizedText || "";
  return normalized.type || normalized.normalizedText || "";
}

function issue(code, message, options = {}) {
  return {
    code,
    severity: options.severity || "blocker",
    stage: options.stage || "family",
    field: options.field || "",
    resolution: options.resolution || "human_review",
    message,
    expected: options.expected === undefined ? null : clone(options.expected),
    actual: options.actual === undefined ? null : clone(options.actual),
  };
}

function familyCoreId(family) {
  return String(family?.coreKnowledgeNodeId || family?.coreKnowledge?.id || family?.knowledgeNodeId || "").trim();
}

function knowledgeNodeHasIdentity(node) {
  return Boolean(node && typeof node === "object" && !Array.isArray(node) && (
    node.id || node.nodeId || node.canonicalNodeId || node.path || node.knowledgePath || node.title
  ));
}

function familyCoreNode(family) {
  const explicit = family?.coreKnowledge;
  if (knowledgeNodeHasIdentity(explicit)) return explicit;
  return { id: familyCoreId(family) };
}

function familyRequiredIds(family) {
  return uniqueStrings([
    ...(family?.requiredKnowledgeNodeIds || []),
    ...(family?.requiredKnowledge || []).map((node) => node?.id || node?.nodeId),
  ]);
}

function familyRequiredNodes(family) {
  const nodes = (Array.isArray(family?.requiredKnowledge) ? family.requiredKnowledge : [])
    .filter(knowledgeNodeHasIdentity);
  const representedIds = new Set(nodes.map((node) => String(node.id || node.nodeId || "").trim()).filter(Boolean));
  (family?.requiredKnowledgeNodeIds || []).forEach((id) => {
    const normalizedId = String(id || "").trim();
    if (!normalizedId || representedIds.has(normalizedId)) return;
    nodes.push({ id: normalizedId });
    representedIds.add(normalizedId);
  });
  return nodes.length ? nodes : [familyCoreNode(family)].filter(knowledgeNodeHasIdentity);
}

function familyContributionNodes(family, questionId) {
  const membership = family?.membership
    && (!questionId || !family.membership.questionId || String(family.membership.questionId) === String(questionId))
    ? family.membership
    : (family?.members || []).find((member) => String(member?.questionId || "") === String(questionId || ""));
  const nodes = (Array.isArray(membership?.contributionKnowledge) ? membership.contributionKnowledge : [])
    .filter(knowledgeNodeHasIdentity);
  const representedIds = new Set(nodes.map((node) => String(node.id || node.nodeId || "")).filter(Boolean));
  (membership?.contributionKnowledgeNodeIds || []).forEach((id) => {
    const normalizedId = String(id || "").trim();
    if (!normalizedId || representedIds.has(normalizedId)) return;
    nodes.push({ id: normalizedId });
    representedIds.add(normalizedId);
  });
  return nodes;
}

function relatedFamilyRelationsFor(familyGold = {}) {
  const relations = [];
  const seen = new Set();
  const append = (value, fallbackRole = "required") => {
    const familyId = String(value?.familyId || value?.id || value || "").trim();
    if (!familyId || seen.has(familyId)) return;
    const explicitRole = String(value?.coverageRole || "").trim();
    const coverageRole = ["required", "reference"].includes(explicitRole)
      ? explicitRole
      : (value?.requiredForAnswer === false ? "reference"
        : (value?.requiredForAnswer === true ? "required" : fallbackRole));
    relations.push({
      familyId,
      coverageRole,
      requiredForAnswer: coverageRole === "required",
    });
    seen.add(familyId);
  };
  (Array.isArray(familyGold.relatedFamilyRelations) ? familyGold.relatedFamilyRelations : [])
    .forEach((relation) => append(relation));
  // Legacy snapshots treated every related family as an answer-essential
  // relation. Preserve that meaning until a human explicitly reclassifies it.
  (Array.isArray(familyGold.relatedFamilyIds) ? familyGold.relatedFamilyIds : [])
    .forEach((familyId) => append(familyId, "required"));
  return relations;
}

function validateJointFamilyKnowledgeCoverage(options = {}) {
  const {
    questionId,
    knowledge,
    primaryFamily,
    primaryLabel = "主题题族",
    relatedRelations = [],
    familyById = new Map(),
    semanticSeverity = "blocker",
    fieldPrefix = "familyGold.families",
    familyKnowledgeProtocolVersion = "",
  } = options;
  const useMemberContributions = familyKnowledgeProtocolVersion === FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
  const issues = [];
  const contributors = [];
  if (primaryFamily) contributors.push({ family: primaryFamily, role: "primary", label: primaryLabel });
  relatedRelations.filter((relation) => relation.coverageRole === "required").forEach((relation) => {
    const family = familyById.get(relation.familyId);
    if (!family) {
      issues.push(issue("required_related_family_fact_missing", `作答必需关联题族 ${relation.familyId} 缺少冻结题族事实。`, {
        severity: semanticSeverity,
        field: "familyGold.relatedFamilyRelations",
        expected: relation.familyId,
      }));
      return;
    }
    contributors.push({ family, role: "required_related", label: `作答必需关联题族 ${family.name || family.id}` });
  });

  // 覆盖判定统一走审核页同一份实现（DEC-039 严格集合口径），避免预检与冻结门禁
  // 对同一份金标给出相反结论。
  const joint = auditJointContributionCoverage({
    questionRequiredNodes: knowledge.requiredNodes,
    contributors: contributors.map((entry) => ({
      familyId: entry.family.id,
      familyName: entry.family.name,
      role: entry.role,
      contributionNodes: useMemberContributions
        ? familyContributionNodes(entry.family, questionId)
        : familyRequiredNodes(entry.family),
      familyCoverageNodes: familyRequiredNodes(entry.family),
    })),
  });

  joint.contributors.forEach((entry, index) => {
    const source = contributors[index];
    if (!entry.contribution.length || entry.outsideQuestion.length || entry.outsideFamilyCoverage.length) {
      issues.push(issue("family_required_knowledge_outside_question", `${source.label}必须声明本题成员贡献，且贡献只能取题目最小充分知识集与题族覆盖知识的交集。`, {
        severity: semanticSeverity,
        field: `${fieldPrefix}.membership.contributionKnowledgeNodeIds`,
        expected: { questionRequiredKnowledge: knowledge.requiredNodes, familyCoverageKnowledge: entry.coverage },
        actual: {
          contributionKnowledge: entry.contribution,
          outsideQuestion: entry.outsideQuestion,
          outsideFamilyCoverage: entry.outsideFamilyCoverage,
        },
        familyId: source.family.id,
        familyName: source.family.name,
        familyRole: source.role,
      }));
    }
  });

  joint.contributors.forEach((entry, index) => {
    const { family, role, label } = contributors[index];
    if (role !== "required_related") return;
    if (!entry.missingWithoutSelf.length) {
      issues.push(issue("required_family_redundant_knowledge_contribution", `${label}在知识节点层面没有新增覆盖，请人工复核其独立考查动作与删除检验。`, {
        severity: "warning",
        field: "familyGold.relatedFamilyRelations",
        familyId: family.id,
        familyName: family.name,
      }));
    }
  });

  const missingNodes = joint.missing;
  if (missingNodes.length) {
    issues.push(issue("question_family_required_coverage_incomplete", `题目 ${questionId} 的最小充分知识集未被主题题族与作答必需关联题族联合覆盖。`, {
      severity: semanticSeverity,
      field: "familyGold.relatedFamilyRelations",
      expected: knowledge.requiredNodes,
      actual: {
        coveredKnowledge: joint.covered,
        missingKnowledge: missingNodes,
        contributingFamilyIds: contributors.map(({ family }) => family.id).filter(Boolean),
      },
    }));
  }
  return issues;
}

function familyAnchorIds(family) {
  return uniqueStrings([
    ...(family?.textbookAnchorNodeIds || []),
    ...(family?.textbookAnchors || []).map((node) => node?.id || node?.nodeId),
  ]);
}

function familyMemberIds(family) {
  return uniqueStrings((family?.members || []).map((member) => member?.questionId));
}

function familyIndependentIds(family) {
  return uniqueStrings(family?.independentMemberQuestionIds?.length
    ? family.independentMemberQuestionIds
    : family?.memberQuestionIds);
}

function familyRetainedIds(family) {
  return uniqueStrings(family?.retainedIndependentMemberQuestionIds);
}

function primaryFamilyFor(item) {
  const familyGold = item?.familyGold || {};
  const families = Array.isArray(familyGold.families) ? familyGold.families : [];
  const primaryFamilyId = String(familyGold.primaryFamilyId || "").trim();
  return families.find((family) => String(family?.id || "") === primaryFamilyId) || null;
}

function knowledgeGoldFor(item) {
  const knowledge = item?.knowledgeGold || item?.answerAndEvidence || {};
  const answerKnowledge = item?.answerAndEvidence || {};
  const coreNode = knowledge.coreKnowledge || {};
  const coreId = String(coreNode.id || coreNode.nodeId || "").trim();
  const coreRole = normalizeCoreKnowledgeRole(knowledge.coreKnowledgeRole || answerKnowledge.coreKnowledgeRole);
  const declaredRequiredNodes = (Array.isArray(knowledge.requiredKnowledge) ? knowledge.requiredKnowledge : [])
    .filter(knowledgeNodeHasIdentity);
  const scopeAnchorDeclaredRequired = coreRole === "scope_anchor"
    && declaredRequiredNodes.some((node) => knowledgeNodesCompatible(node, coreNode));
  const requiredNodes = [
    ...(coreRole === "core" ? [coreNode] : []),
    ...declaredRequiredNodes.filter((node) => coreRole !== "scope_anchor"
      || !knowledgeNodesCompatible(node, coreNode)),
  ].filter(knowledgeNodeHasIdentity);
  const requiredIds = uniqueStrings(requiredNodes.map((node) => node?.id || node?.nodeId));
  return {
    coreId,
    coreNode,
    coreRole,
    declaredRequiredNodes,
    scopeAnchorDeclaredRequired,
    requiredIds,
    requiredNodes,
  };
}

function validateFamilyDefinition(family, options = {}) {
  const issues = [];
  const requiredFields = [
    ["name", String(family?.name || "").trim()],
    ["coreKnowledgeNodeId", familyCoreId(family)],
    ["requiredKnowledgeNodeIds", familyRequiredIds(family).length],
    ["textbookAnchorNodeIds", familyAnchorIds(family).length],
    ...(options.requireFocusKey === true ? [["focusKey", String(family?.focusKey || "").trim()]] : []),
    ["assessmentAction", String(family?.assessmentAction || "").trim()],
  ];
  requiredFields.forEach(([field, value]) => {
    if (value) return;
    issues.push(issue("family_definition_field_missing", `题族六维定义缺少 ${field}。`, {
      stage: options.stage || "family",
      field,
    }));
  });
  ["inclusionBoundary", "exclusionBoundary"].forEach((field) => {
    if (String(family?.[field] || "").trim()) return;
    issues.push(issue("family_boundary_missing", `题族 ${field} 尚未填写；边界不是确认题族的硬门槛，但需要保留为诊断项。`, {
      severity: "warning",
      stage: options.stage || "family",
      field,
    }));
  });
  return issues;
}

function validateGoldItem(item, index, options = {}) {
  const questionId = String(item?.questionId || "").trim();
  const mode = String(item?.replayMode || item?.familyGold?.replayMode || "").trim();
  const familyGold = item?.familyGold || {};
  const decision = String(familyGold.decision || "").trim();
  const knowledge = knowledgeGoldFor(item);
  const familyFacts = Array.isArray(familyGold.families) ? familyGold.families : [];
  const familyById = new Map(familyFacts
    .map((family) => [String(family?.id || "").trim(), family])
    .filter(([familyId]) => familyId));
  const relatedRelations = relatedFamilyRelationsFor(familyGold);
  const familyKnowledgeProtocolVersion = String(familyGold.familyKnowledgeProtocolVersion || "").trim();
  const usesFamilyKnowledgeV3 = familyKnowledgeProtocolVersion === FAMILY_KNOWLEDGE_PROTOCOL_VERSION;
  const usesKnownFamilyKnowledgeProtocol = [
    LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
    FAMILY_KNOWLEDGE_PROTOCOL_VERSION,
  ].includes(familyKnowledgeProtocolVersion);
  const primaryFamily = primaryFamilyFor(item);
  const primaryFamilyId = String(familyGold.primaryFamilyId || "").trim();
  const formalFamily = options.formalFamilyById?.get(primaryFamilyId) || null;
  const issues = [];
  const includedInAccuracy = item?.includedInAccuracy !== false
    && String(item?.goldStatus || "") !== "gold_needs_review";
  const semanticSeverity = includedInAccuracy ? "blocker" : "warning";

  if (!questionId) issues.push(issue("question_id_missing", `第 ${index + 1} 题缺少 questionId。`, { stage: "content", field: "questionId" }));
  if (!REQUIRED_MODES.includes(mode)) {
    issues.push(issue("replay_mode_invalid", `题目 ${questionId || index + 1} 的盲测模式无效。`, {
      field: "replayMode",
      expected: REQUIRED_MODES,
      actual: mode,
    }));
  }
  if (!item?.questionSnapshot?.version) {
    issues.push(issue("question_version_missing", `题目 ${questionId || index + 1} 未冻结题目版本。`, {
      stage: "content",
      field: "questionSnapshot.version",
    }));
  }
  if (!String(item?.questionSnapshot?.bookId || "").trim()) {
    issues.push(issue("question_book_missing", `题目 ${questionId || index + 1} 未冻结教材 ID。`, {
      stage: "content",
      field: "questionSnapshot.bookId",
    }));
  }
  if (!knowledge.coreId) {
    issues.push(issue("core_knowledge_missing", `题目 ${questionId || index + 1} 缺少核心知识。`, {
      stage: "content",
      field: "knowledgeGold.coreKnowledge",
    }));
  }
  if (!knowledge.requiredIds.length
    || (knowledge.coreRole === "core" && knowledge.coreId && !knowledge.requiredIds.includes(knowledge.coreId))) {
    issues.push(issue("required_knowledge_invalid", `题目 ${questionId || index + 1} 的最小充分知识集为空，或作答核心未纳入最小充分知识集。`, {
      stage: "content",
      field: "knowledgeGold.requiredKnowledge",
      expected: knowledge.coreRole === "core" && knowledge.coreId ? [knowledge.coreId] : ["至少一个实际作答必需知识"],
      actual: knowledge.requiredIds,
    }));
  }
  if (knowledge.coreRole === "scope_anchor" && knowledge.scopeAnchorDeclaredRequired) {
    issues.push(issue("scope_anchor_in_required_knowledge", `题目 ${questionId || index + 1} 的范围锚点不得进入最小充分知识集。`, {
      stage: "content",
      field: "knowledgeGold.requiredKnowledge",
      expected: "exclude_scope_anchor",
      actual: knowledge.declaredRequiredNodes,
    }));
  }
  if (options.requireFamilyKnowledgeProtocol && !usesKnownFamilyKnowledgeProtocol) {
    issues.push(issue("family_knowledge_protocol_missing", `冻结金标必须声明已知的题族知识协议版本；新快照使用 ${FAMILY_KNOWLEDGE_PROTOCOL_VERSION}。`, {
      field: "familyGold.familyKnowledgeProtocolVersion",
      expected: [LEGACY_FAMILY_KNOWLEDGE_PROTOCOL_VERSION, FAMILY_KNOWLEDGE_PROTOCOL_VERSION],
      actual: familyKnowledgeProtocolVersion || "missing",
    }));
  }

  relatedRelations.forEach((relation) => {
    if (relation.familyId === primaryFamilyId) {
      issues.push(issue("related_family_duplicates_primary", "同一题族不能同时作为主题题族和关联题族。", {
        field: "familyGold.relatedFamilyRelations",
        actual: relation,
      }));
      return;
    }
    const family = familyById.get(relation.familyId);
    if (!family) {
      issues.push(issue("related_family_fact_missing", `关联题族 ${relation.familyId} 缺少冻结题族事实。`, {
        field: "familyGold.families",
        expected: relation.familyId,
      }));
      return;
    }
    issues.push(...validateFamilyDefinition(family, { requireFocusKey: usesFamilyKnowledgeV3 }));
    if (String(family.status || "") !== "confirmed") {
      issues.push(issue("related_family_status_not_confirmed", `关联题族 ${family.name || family.id} 的冻结状态必须为 confirmed。`, {
        field: "familyGold.families.status",
        expected: "confirmed",
        actual: String(family.status || "missing"),
      }));
    }
    if (String(family.bookId || "") !== String(item?.questionSnapshot?.bookId || "")) {
      issues.push(issue("related_family_book_mismatch", `关联题族 ${family.name || family.id} 的教材归属与题目不一致。`, {
        field: "familyGold.families.bookId",
        expected: String(item?.questionSnapshot?.bookId || ""),
        actual: String(family.bookId || "missing"),
      }));
    }
    if (usesFamilyKnowledgeV3 && relation.coverageRole === "reference"
      && familyContributionNodes(family, questionId).length) {
      issues.push(issue("reference_family_knowledge_contribution_forbidden", `普通关联题族 ${family.name || family.id} 不参与本题知识覆盖，成员贡献必须为空。`, {
        severity: semanticSeverity,
        field: "familyGold.families.membership.contributionKnowledgeNodeIds",
        expected: [],
        actual: familyContributionNodes(family, questionId),
      }));
    }
  });

  if (["mature", "singleton"].includes(mode)) {
    if (decision !== "join_existing") {
      issues.push(issue("existing_family_decision_required", `${mode} 模式必须裁决为加入现有题族。`, {
        field: "familyGold.decision",
        expected: "join_existing",
        actual: decision,
      }));
    }
    if (!primaryFamilyId || !primaryFamily) {
      issues.push(issue("primary_family_missing", `${mode} 模式缺少可解析的主题族。`, {
        field: "familyGold.primaryFamilyId",
        actual: primaryFamilyId,
      }));
    } else {
      issues.push(...validateFamilyDefinition(primaryFamily, { requireFocusKey: usesFamilyKnowledgeV3 }));
      const frozenFamilyStatus = String(primaryFamily.status || "");
      if (!frozenFamilyStatus) {
        issues.push(issue("family_status_missing", `主題族 ${primaryFamilyId} 未冻结正式状态，V2 必须从正式题族事实补齐。`, {
          field: "familyGold.families.status",
          resolution: "hydrate_from_formal",
        }));
        if (formalFamily && String(formalFamily.status || "") !== "confirmed") {
          issues.push(issue("family_status_not_confirmed", `主題族 ${primaryFamilyId} 的正式状态不是 confirmed，必须重新审核。`, {
            field: "familyGold.families.status",
            expected: "confirmed",
            actual: String(formalFamily.status || "missing"),
          }));
        }
      } else if (frozenFamilyStatus !== "confirmed") {
        issues.push(issue("family_status_not_confirmed", `主題族 ${primaryFamilyId} 的冻结状态必须为 confirmed。`, {
          field: "familyGold.families.status",
          expected: "confirmed",
          actual: frozenFamilyStatus,
        }));
      }
      const familyBookId = String(primaryFamily.bookId || "").trim();
      if (!familyBookId) {
        issues.push(issue("family_book_missing", `主題族 ${primaryFamilyId} 未冻结教材归属，V2 必须从正式题族事实补齐。`, {
          field: "familyGold.families.bookId",
          resolution: "hydrate_from_formal",
        }));
        if (formalFamily && String(formalFamily.bookId || "") !== String(item?.questionSnapshot?.bookId || "")) {
          issues.push(issue("family_book_mismatch", `主題族 ${primaryFamilyId} 的正式教材归属与题目不一致。`, {
            field: "familyGold.families.bookId",
            expected: String(item?.questionSnapshot?.bookId || ""),
            actual: String(formalFamily.bookId || ""),
          }));
        }
      } else if (familyBookId !== String(item?.questionSnapshot?.bookId || "")) {
        issues.push(issue("family_book_mismatch", `主題族 ${primaryFamilyId} 的教材归属缺失或与题目不一致。`, {
          field: "familyGold.families.bookId",
          expected: String(item?.questionSnapshot?.bookId || ""),
          actual: familyBookId,
        }));
      }
      const primaryContribution = familyContributionNodes(primaryFamily, questionId);
      if (knowledge.coreRole === "core"
        && ((!usesFamilyKnowledgeV3 && !knowledgeNodesCompatible(familyCoreNode(primaryFamily), knowledge.coreNode))
        || (usesFamilyKnowledgeV3 && !primaryContribution
          .some((node) => knowledgeNodesCompatible(node, knowledge.coreNode))))) {
        issues.push(issue("question_family_core_mismatch", usesFamilyKnowledgeV3
          ? `题目 ${questionId} 的知识焦点未由主题题族的成员贡献知识承载。`
          : `题目 ${questionId} 的核心知识与主題族不一致。`, {
          severity: semanticSeverity,
          field: usesFamilyKnowledgeV3
            ? "familyGold.families.membership.contributionKnowledgeNodeIds"
            : "familyGold.families.coreKnowledgeNodeId",
          expected: knowledge.coreNode,
          actual: usesFamilyKnowledgeV3 ? primaryContribution : familyCoreNode(primaryFamily),
        }));
      }
      issues.push(...validateJointFamilyKnowledgeCoverage({
        questionId,
        knowledge,
        primaryFamily,
        relatedRelations,
        familyById,
        semanticSeverity,
        familyKnowledgeProtocolVersion,
      }));

      const independentIds = familyIndependentIds(primaryFamily);
      const retainedIds = familyRetainedIds(primaryFamily);
      const declaredCount = Number(primaryFamily.independentMemberCount);
      if (!Number.isInteger(declaredCount) || declaredCount < 0 || declaredCount !== independentIds.length) {
        issues.push(issue("independent_member_count_mismatch", `主題族 ${primaryFamilyId} 的独立成员数量与冻结 ID 列表不一致。`, {
          field: "familyGold.families.independentMemberCount",
          expected: independentIds.length,
          actual: Number.isFinite(declaredCount) ? declaredCount : null,
        }));
      }
      if (!independentIds.includes(questionId)) {
        issues.push(issue("gold_question_not_in_family_members", `题目 ${questionId} 不在主題族冻结成员列表中。`, {
          field: "familyGold.families.independentMemberQuestionIds",
          actual: independentIds,
        }));
      }
      const expectedRetainedIds = independentIds.filter((id) => id !== questionId);
      if (!sameStringSet(retainedIds, expectedRetainedIds)) {
        issues.push(issue("retained_member_ids_mismatch", `主題族 ${primaryFamilyId} 的留存成员 ID 与遮蔽策略不一致。`, {
          severity: "warning",
          field: "familyGold.families.retainedIndependentMemberQuestionIds",
          expected: expectedRetainedIds,
          actual: retainedIds,
          resolution: "derive_from_frozen_members",
        }));
      }
      const memberRoles = Array.isArray(primaryFamily.members) ? primaryFamily.members : [];
      const targetRole = memberRoles.find((member) => String(member?.questionId || "") === questionId);
      if (!memberRoles.length) {
        issues.push(issue("member_roles_missing", `主題族 ${primaryFamilyId} 未冻结成员角色，V2 必须从正式题族事实补齐。`, {
          field: "familyGold.families.members",
          resolution: "hydrate_from_formal",
        }));
        const formalTargetRole = (formalFamily?.members || []).find((member) => String(member?.questionId || "") === questionId);
        if (formalFamily && (!formalTargetRole || formalTargetRole.isPrimary !== true || !String(formalTargetRole.role || "").trim())) {
          issues.push(issue("primary_member_role_invalid", `主題族 ${primaryFamilyId} 的正式成员角色未把题目 ${questionId} 标为主成员。`, {
            field: "familyGold.families.members",
          }));
        }
      } else if (!targetRole || targetRole.isPrimary !== true || !String(targetRole.role || "").trim()) {
        issues.push(issue("primary_member_role_invalid", `主題族 ${primaryFamilyId} 中题目 ${questionId} 的主成员角色不正确。`, {
          field: "familyGold.families.members",
        }));
      }

      if (mode === "mature") {
        if (independentIds.length < 2 || retainedIds.length < 1) {
          issues.push(issue("mature_family_members_insufficient", `成熟题族 ${primaryFamilyId} 至少需要 2 个独立成员，并在隐藏本题后留存至少 1 题。`, {
            field: "familyGold.families.independentMemberQuestionIds",
            actual: { independent: independentIds.length, retained: retainedIds.length },
          }));
        }
      } else if (independentIds.length !== 1 || retainedIds.length !== 0) {
        issues.push(issue("singleton_family_members_invalid", `单题题族 ${primaryFamilyId} 必须恰有本题 1 个独立成员，且整族隐藏后无留存成员。`, {
          field: "familyGold.families.independentMemberQuestionIds",
          expected: [questionId],
          actual: independentIds,
        }));
      }
    }
  }

  if (mode === "unmatched") {
    if (decision !== "create_new") {
      issues.push(issue("unmatched_create_new_required", "无匹配题必须裁决为候选新题族。", {
        field: "familyGold.decision",
        expected: "create_new",
        actual: decision,
      }));
    }
    if (String(familyGold.primaryFamilyId || "").trim()) {
      issues.push(issue("unmatched_primary_family_forbidden", "无匹配题不得冻结现有主題族 ID。", {
        field: "familyGold.primaryFamilyId",
        actual: familyGold.primaryFamilyId,
      }));
    }
    const candidate = familyGold.candidateFamily;
    if (!candidate || typeof candidate !== "object") {
      issues.push(issue("candidate_family_missing", "无匹配题缺少人工确认的候选新题族定义。", {
        field: "familyGold.candidateFamily",
      }));
    } else {
      issues.push(...validateFamilyDefinition(candidate, { requireFocusKey: usesFamilyKnowledgeV3 }));
      const candidateContribution = familyContributionNodes(candidate, questionId);
      if (knowledge.coreRole === "core"
        && ((!usesFamilyKnowledgeV3 && !knowledgeNodesCompatible(familyCoreNode(candidate), knowledge.coreNode))
        || (usesFamilyKnowledgeV3 && !candidateContribution
          .some((node) => knowledgeNodesCompatible(node, knowledge.coreNode))))) {
        issues.push(issue("candidate_family_core_mismatch", usesFamilyKnowledgeV3
          ? `题目 ${questionId} 的知识焦点未由候选主题题族的成员贡献知识承载。`
          : `题目 ${questionId} 的核心知识与候选题族不一致。`, {
          severity: semanticSeverity,
          field: usesFamilyKnowledgeV3
            ? "familyGold.candidateFamily.membership.contributionKnowledgeNodeIds"
            : "familyGold.candidateFamily.coreKnowledgeNodeId",
          expected: knowledge.coreNode,
          actual: usesFamilyKnowledgeV3 ? candidateContribution : familyCoreNode(candidate),
        }));
      }
      issues.push(...validateJointFamilyKnowledgeCoverage({
        questionId,
        knowledge,
        primaryFamily: candidate,
        primaryLabel: "候选主题题族",
        relatedRelations,
        familyById,
        semanticSeverity,
        fieldPrefix: "familyGold.candidateFamily",
        familyKnowledgeProtocolVersion,
      }));
    }
  }

  return {
    order: Number(item?.order) || index + 1,
    questionId,
    replayMode: mode,
    goldStatus: String(item?.goldStatus || ""),
    includedInAccuracy,
    diagnosticOnly: !includedInAccuracy,
    primaryNodeRole: knowledge.coreRole,
    decision,
    passed: !issues.some((entry) => entry.severity === "blocker"),
    issues,
  };
}

function buildGoldSemanticPreflight(loadedGold, options = {}) {
  const snapshot = loadedGold.snapshot || loadedGold;
  const formalFamilies = options.formalFamilyState?.families || [];
  const formalFamilyById = new Map(formalFamilies.map((family) => [String(family?.id || ""), family]));
  const snapshotVersion = Number(String(snapshot.version || "").match(/\d+/)?.[0] || 0);
  const items = (snapshot.items || []).map((item, index) => validateGoldItem(item, index, {
    formalFamilyById,
    requireFamilyKnowledgeProtocol: snapshotVersion >= 2,
  }));
  const blockers = items.flatMap((item) => item.issues
    .filter((entry) => entry.severity === "blocker")
    .map((entry) => ({ questionId: item.questionId, replayMode: item.replayMode, ...entry })));
  const warnings = items.flatMap((item) => item.issues
    .filter((entry) => entry.severity === "warning")
    .map((entry) => ({ questionId: item.questionId, replayMode: item.replayMode, ...entry })));
  const duplicateQuestionIds = uniqueStrings((snapshot.items || []).map((item) => item.questionId))
    .filter((questionId) => (snapshot.items || []).filter((item) => String(item.questionId) === questionId).length > 1);
  duplicateQuestionIds.forEach((questionId) => blockers.push({
    questionId,
    replayMode: "",
    ...issue("duplicate_question_id", `冻结金标重复包含题目 ${questionId}。`, { stage: "content", field: "questionId" }),
  }));
  const modeDistributions = replayModeDistributions(items);
  const distribution = modeDistributions.total;
  REQUIRED_MODES.filter((mode) => distribution[mode] === 0).forEach((mode) => blockers.push({
    questionId: "",
    replayMode: mode,
    ...issue("replay_mode_missing", `冻结金标未覆盖 ${mode} 模式。`, { field: "replayMode" }),
  }));
  if (options.expectedCount !== undefined && items.length !== Number(options.expectedCount)) {
    blockers.push({
      questionId: "",
      replayMode: "",
      ...issue("gold_item_count_mismatch", "冻结金标题量与预期不一致。", {
        stage: "content",
        field: "items",
        expected: Number(options.expectedCount),
        actual: items.length,
      }),
    });
  }
  REQUIRED_MODES.filter((mode) => modeDistributions.scoreable[mode] === 0).forEach((mode) => warnings.push({
    questionId: "",
    replayMode: mode,
    ...issue("scoreable_replay_mode_missing", `冻结金标的 ${mode} 模式没有可计分题；可生成诊断上下文，但不得据此进入连续门禁。`, {
      severity: "warning",
      field: "includedInAccuracy",
      expected: "at_least_one_scoreable_item",
      actual: 0,
    }),
  }));
  const humanBlockers = blockers.filter((entry) => entry.resolution === "human_review");
  const preparationFixes = blockers.filter((entry) => entry.resolution !== "human_review");
  const reopenMap = new Map();
  humanBlockers.filter((entry) => entry.questionId).forEach((entry) => {
    if (!reopenMap.has(entry.questionId)) reopenMap.set(entry.questionId, new Set());
    reopenMap.get(entry.questionId).add(entry.stage || "family");
  });
  return {
    schemaVersion: GOLD_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: (options.now || new Date()).toISOString(),
    modelCallsPerformed: 0,
    snapshot: {
      snapshotId: String(snapshot.snapshotId || ""),
      version: String(snapshot.version || ""),
      status: String(snapshot.status || ""),
      filePath: loadedGold.filePath || "",
      fileSha256: loadedGold.fileSha256 || "",
      contentSha256: loadedGold.contentSha256 || snapshot.integrity?.contentSha256 || "",
    },
    formalFacts: options.formalFamilyState ? {
      supplied: true,
      familyCount: formalFamilies.length,
      filePath: options.formalFamilyStatePath || "",
      fileSha256: options.formalFamilyStateSha256 || "",
    } : { supplied: false, familyCount: 0, filePath: "", fileSha256: "" },
    status: blockers.length ? "blocked" : "passed",
    eligibleForContextFreeze: blockers.length === 0,
    summary: {
      total: items.length,
      passed: items.filter((item) => item.passed).length,
      blocked: items.filter((item) => !item.passed).length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
      humanReviewQuestionCount: reopenMap.size,
      preparationFixCount: preparationFixes.length,
      distribution,
      scoreableDistribution: modeDistributions.scoreable,
      disputedDistribution: modeDistributions.disputed,
      modeDistributions,
    },
    reopenCandidates: [...reopenMap.entries()].map(([questionId, stages]) => ({
      questionId,
      stages: [...stages].sort(),
      issueCodes: uniqueStrings(humanBlockers.filter((entry) => entry.questionId === questionId).map((entry) => entry.code)),
    })),
    preparationFixes,
    blockers,
    warnings,
    items,
  };
}

function isVerifiedContextAnswer(question) {
  return question?.answerVerified === true
    || ["verified", "official_verified"].includes(String(question?.answerReviewStatus || "").trim().toLowerCase());
}

function sanitizeContextQuestion(question) {
  const answerVerified = isVerifiedContextAnswer(question);
  const answerSource = String(question?.answerSource || "");
  const answerReviewStatus = String(question?.answerReviewStatus || "");
  const sanitized = {
    id: String(question?.id || ""),
    bookId: String(question?.bookId || ""),
    version: Number(question?.version) || 1,
    library: question?.library || "official",
    status: question?.status || "official",
    type: String(question?.type || ""),
    stem: String(question?.stem || ""),
    material: String(question?.material || ""),
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
      key: String(option?.key || ""),
      text: String(option?.text || ""),
    })),
    sourceTitle: String(question?.sourceTitle || ""),
    sourceYear: question?.sourceYear || "",
    sourcePage: question?.sourcePage || "",
    correctAnswer: answerVerified ? clone(question?.correctAnswer || []) : [],
    referenceAnswer: answerVerified ? String(question?.referenceAnswer || "") : "",
    answerSource,
    answerReviewStatus,
    answerVerified,
    answerProvenance: {
      status: answerVerified ? "frozen_verified" : "not_frozen_unverified",
      source: answerVerified ? "formal_runtime_at_c1_freeze" : "formal_runtime_answer_excluded",
      answerSource,
      answerReviewStatus,
    },
  };
  return sanitized;
}

function sanitizeProviderBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (isSecretConfigKey(key)) return [];
    if (key === "baseUrl") return [[key, sanitizeProviderBaseUrl(entry)]];
    return [[key, stripSecrets(entry)]];
  }));
}

function sanitizeAiConfig(aiConfig) {
  const sanitized = stripSecrets(clone(aiConfig || {}));
  sanitized.providers = (sanitized.providers || []).map((provider) => ({
    ...provider,
    credentialRef: `BLIND_REPLAY_PROVIDER_${String(provider.id || "UNKNOWN").replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`,
  }));
  return sanitized;
}

function findSecretConfigPaths(value, basePath = "") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSecretConfigPaths(entry, `${basePath}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const nextPath = basePath ? `${basePath}.${key}` : key;
    if (isSecretConfigKey(key)) return [nextPath];
    if (key === "baseUrl" && /[?#]|:\/\/[^/@]+@/.test(String(entry || ""))) return [nextPath];
    return findSecretConfigPaths(entry, nextPath);
  });
}

function contextQuestionAnswerFields(question) {
  return Object.keys(question || {}).filter((key) => FORBIDDEN_CONTEXT_QUESTION_FIELDS.has(key));
}

function findGoldLeakPaths(value, basePath = "") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findGoldLeakPaths(entry, `${basePath}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const nextPath = basePath ? `${basePath}.${key}` : key;
    if (FORBIDDEN_CONTEXT_QUESTION_FIELDS.has(key)) return [nextPath];
    return findGoldLeakPaths(entry, nextPath);
  });
}

function filterQuestionFamilyState(state, bookIds) {
  const allowedBooks = new Set(bookIds);
  const next = clone(state || {});
  next.families = (next.families || []).filter((family) => allowedBooks.has(String(family?.bookId || "")));
  const familyIds = new Set(next.families.map((family) => String(family?.id || "")));
  next.familySets = (next.familySets || []).filter((familySet) => allowedBooks.has(String(familySet?.bookId || "")));
  const familySetIds = new Set(next.familySets.map((familySet) => String(familySet?.id || "")));
  next.familySetLinks = (next.familySetLinks || []).filter((link) => (
    (link?.memberType === "family" && familyIds.has(String(link?.memberId || "")))
    || (link?.memberType === "family_set" && familySetIds.has(String(link?.memberId || "")))
  ));
  if (next.familyAliases && typeof next.familyAliases === "object" && !Array.isArray(next.familyAliases)) {
    next.familyAliases = Object.fromEntries(Object.entries(next.familyAliases)
      .filter(([aliasId, targetId]) => familyIds.has(String(aliasId)) || familyIds.has(String(targetId))));
  }
  next.historyByBook = Object.fromEntries(Object.entries(next.historyByBook || {})
    .filter(([bookId]) => allowedBooks.has(String(bookId))));
  next.unresolvedByBook = Object.fromEntries(Object.entries(next.unresolvedByBook || {})
    .filter(([bookId]) => allowedBooks.has(String(bookId))));
  const questionIds = new Set(next.families.flatMap((family) => (family.members || []).map((member) => String(member?.questionId || ""))));
  next.membershipRevisionByQuestion = Object.fromEntries(Object.entries(next.membershipRevisionByQuestion || {})
    .filter(([questionId]) => questionIds.has(String(questionId))));
  return next;
}

function filterExperienceState(state, bookIds) {
  const allowedBooks = new Set(bookIds);
  const next = clone(state || {});
  ["messages", "rules", "cases", "corrections", "ruleExceptions", "reviewEvents", "dossierSuggestions"].forEach((key) => {
    next[key] = (next[key] || []).filter((entry) => !entry?.bookId || allowedBooks.has(String(entry.bookId)));
  });
  return next;
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

function questionStemCore(question) {
  return normalizeText(String(question?.stem || "")
    .replace(/^[（(【\[][^）)】\]]{0,100}[）)】\]]\s*/u, "")
    .replace(/[（(]\s*[）)]\s*$/u, ""));
}

function familyAliasIdsResolvingTo(state, familyIds) {
  const aliases = state?.familyAliases && typeof state.familyAliases === "object" && !Array.isArray(state.familyAliases)
    ? state.familyAliases
    : {};
  const hidden = new Set(uniqueStrings(familyIds));
  let changed = true;
  while (changed) {
    changed = false;
    Object.entries(aliases).forEach(([aliasId, targetId]) => {
      if (!hidden.has(String(targetId)) || hidden.has(String(aliasId))) return;
      hidden.add(String(aliasId));
      changed = true;
    });
  }
  return [...hidden];
}

function maskQuestionFamilyState(state, questionId, hiddenFamilyIds = []) {
  const targetId = String(questionId || "");
  const masked = clone(state || {});
  const hiddenReferences = new Set(familyAliasIdsResolvingTo(masked, hiddenFamilyIds));
  masked.families = (masked.families || [])
    .filter((family) => !hiddenReferences.has(String(family?.id || "")))
    .map((family) => ({
      ...family,
      // 成熟题族回放中的可见同族案例只能来自冻结金标确认的独立成员，即成员角色中
      // isPrimary === true 的主归属成员（口径与 classification-gold-review-store 的
      // 独立成员清单一致）。普通副归属成员即使存在于正式题族，也不能进入回放上下文，
      // 否则会被当成留一案例参与核对。判据必须是 isPrimary，不能按 role 名判断——
      // 正式数据里存在 role=prototype 但 isPrimary=false 的成员。
      members: (family.members || []).filter((member) => member?.isPrimary === true
        && String(member?.questionId || "") !== targetId),
    }));
  if (masked.familyAliases && typeof masked.familyAliases === "object" && !Array.isArray(masked.familyAliases)) {
    masked.familyAliases = Object.fromEntries(Object.entries(masked.familyAliases)
      .filter(([aliasId, targetIdValue]) => !hiddenReferences.has(String(aliasId)) && !hiddenReferences.has(String(targetIdValue))));
  }
  masked.familySetLinks = (masked.familySetLinks || [])
    .filter((link) => link?.memberType !== "family" || !hiddenReferences.has(String(link?.memberId || "")));
  Object.entries(masked.historyByBook || {}).forEach(([bookId, history]) => {
    if (!Array.isArray(history)) return;
    masked.historyByBook[bookId] = history.map((entry) => ({
      ...entry,
      families: (entry?.families || []).filter((family) => !hiddenReferences.has(String(family?.id || ""))),
      ...(entry?.familyAliases && typeof entry.familyAliases === "object" && !Array.isArray(entry.familyAliases)
        ? {
          familyAliases: Object.fromEntries(Object.entries(entry.familyAliases)
            .filter(([aliasId, targetIdValue]) => !hiddenReferences.has(String(aliasId)) && !hiddenReferences.has(String(targetIdValue)))),
        }
        : {}),
    }));
  });
  if (masked.membershipRevisionByQuestion && typeof masked.membershipRevisionByQuestion === "object") {
    delete masked.membershipRevisionByQuestion[targetId];
  }
  Object.entries(masked.unresolvedByBook || {}).forEach(([bookId, unresolved]) => {
    if (Array.isArray(unresolved)) masked.unresolvedByBook[bookId] = unresolved.filter((id) => String(id) !== targetId);
  });
  return masked;
}

function maskKnowledgeStructureState(state, questionId, bookId) {
  const targetId = String(questionId || "");
  const masked = clone(state || {});
  masked.records = (masked.records || []).filter((record) => String(record?.bookId || "") === String(bookId || ""))
    .map((record) => ({
      ...record,
      fingerprints: (record.fingerprints || []).filter((fingerprint) => String(fingerprint?.questionId || "") !== targetId),
    }));
  masked.editsByBook = masked.editsByBook?.[bookId]
    ? { [bookId]: clone(masked.editsByBook[bookId]) }
    : {};
  const overrides = masked.editsByBook?.[bookId]?.fingerprintOverrides;
  if (overrides && typeof overrides === "object") delete overrides[targetId];
  return masked;
}

function maskExperienceState(state, targetQuestion) {
  const targetId = String(targetQuestion?.id || "");
  const targetStem = questionStemCore(targetQuestion);
  const masked = clone(state || {});
  const collections = ["messages", "cases", "corrections", "ruleExceptions", "reviewEvents", "dossierSuggestions"];
  const targetResultIds = new Set();
  const targetFeedbackIds = new Set();
  collections.forEach((key) => {
    (masked[key] || []).forEach((entry) => {
      if (String(entry?.questionId || entry?.sourceQuestionId || "") !== targetId) return;
      if (entry?.resultId) targetResultIds.add(String(entry.resultId));
      if (key === "messages" && entry?.id) targetFeedbackIds.add(String(entry.id));
    });
  });
  collections.forEach((key) => {
    masked[key] = (masked[key] || []).filter((entry) => (
      String(entry?.questionId || entry?.sourceQuestionId || "") !== targetId
      && !targetResultIds.has(String(entry?.resultId || entry?.sourceResultId || ""))
    ));
  });
  masked.rules = (masked.rules || []).filter((rule) => {
    if (String(rule?.sourceQuestionId || "") === targetId) return false;
    if (targetResultIds.has(String(rule?.sourceResultId || ""))) return false;
    const sourceFeedbackIds = uniqueStrings([rule?.sourceFeedbackId, ...(rule?.sourceFeedbackIds || [])]);
    if (sourceFeedbackIds.some((id) => targetFeedbackIds.has(id))) return false;
    if (targetStem.length < 8) return true;
    const ruleText = normalizeText([
      rule?.title,
      rule?.statement,
      ...(rule?.triggerTerms || []),
      ...(rule?.positiveExamples || []),
      ...(rule?.negativeExamples || []),
    ].filter(Boolean).join("\n"));
    return !ruleText.includes(targetStem);
  });
  return masked;
}

function familiesSemanticallyCompatible(left, right) {
  if (!left || !right) return false;
  const leftAction = normalizedAction(left.assessmentAction);
  const rightAction = normalizedAction(right.assessmentAction);
  return Boolean(leftAction && rightAction && leftAction === rightAction)
    && knowledgeNodesCompatible(familyCoreNode(left), familyCoreNode(right))
    && knowledgeSetsCompatible(familyRequiredNodes(left), familyRequiredNodes(right));
}

function buildFrozenModePlan(item, familyState) {
  const mode = String(item?.replayMode || "");
  const familyGold = item?.familyGold || {};
  const primaryFamilyId = String(familyGold.primaryFamilyId || "");
  const primaryGoldFamily = primaryFamilyFor(item);
  const derivedRetainedIds = familyIndependentIds(primaryGoldFamily)
    .filter((questionId) => questionId !== String(item?.questionId || ""));
  const hiddenFamilyIds = new Set();
  const equivalentFamilyIds = new Set();
  if (mode === "singleton" && primaryFamilyId) hiddenFamilyIds.add(primaryFamilyId);
  if (mode === "unmatched") {
    const candidate = familyGold.candidateFamily;
    // Existing related families remain visible candidates. Only families that
    // would leak the candidate primary-family answer are hidden.
    const semanticReferences = [candidate].filter(Boolean);
    (familyState.families || []).forEach((family) => {
      if (semanticReferences.some((reference) => familiesSemanticallyCompatible(reference, family))) {
        hiddenFamilyIds.add(String(family.id));
        equivalentFamilyIds.add(String(family.id));
      }
    });
  }
  return {
    requestedMode: mode,
    mode,
    primaryFamilyId,
    primaryFamilyIndependentMemberCount: familyIndependentIds(primaryGoldFamily).length,
    retainedIndependentMemberCount: mode === "mature" ? derivedRetainedIds.length : 0,
    hiddenFamilyIds: [...hiddenFamilyIds],
    equivalentFamilyIds: [...equivalentFamilyIds],
    retainedIndependentMemberQuestionIds: mode === "mature" ? derivedRetainedIds : [],
    expectsExistingFamily: mode === "mature",
    expectsCandidateFamilyDraft: mode !== "mature",
    goldFamilySemanticsAvailable: Boolean(primaryGoldFamily),
    unmatchedGoldStatus: mode === "unmatched" ? "confirmed" : "unreviewed",
  };
}

function countHistoricalFamilyDefinitions(state, familyIds) {
  const hidden = new Set(uniqueStrings(familyIds));
  return Object.values(state?.historyByBook || {}).flatMap((history) => Array.isArray(history) ? history : [])
    .flatMap((entry) => Array.isArray(entry?.families) ? entry.families : [])
    .filter((family) => hidden.has(String(family?.id || ""))).length;
}

function buildFrozenMaskAudit(originalFamilyState, maskedFamilyState, item, modePlan, maskedStructureState, maskedExperienceState) {
  const questionId = String(item.questionId || "");
  const hiddenReferences = new Set(familyAliasIdsResolvingTo(originalFamilyState, modePlan.hiddenFamilyIds));
  const remainingHiddenDefinitions = (maskedFamilyState.families || []).filter((family) => hiddenReferences.has(String(family?.id || ""))).length;
  const remainingAliases = Object.entries(maskedFamilyState.familyAliases || {})
    .filter(([aliasId, familyId]) => hiddenReferences.has(String(aliasId)) || hiddenReferences.has(String(familyId))).length;
  const remainingSetLinks = (maskedFamilyState.familySetLinks || [])
    .filter((link) => link?.memberType === "family" && hiddenReferences.has(String(link?.memberId || ""))).length;
  const remainingHistoricalDefinitions = countHistoricalFamilyDefinitions(maskedFamilyState, [...hiddenReferences]);
  const remainingTargetMemberships = (maskedFamilyState.families || []).flatMap((family) => family.members || [])
    .filter((member) => String(member?.questionId || "") === questionId).length;
  const retainedPrimary = (maskedFamilyState.families || []).find((family) => String(family?.id || "") === modePlan.primaryFamilyId);
  const retainedMembers = new Set(familyMemberIds(retainedPrimary));
  const retainedOtherPrimaryMembers = modePlan.retainedIndependentMemberQuestionIds.filter((id) => retainedMembers.has(id)).length;
  const remainingTargetFingerprints = (maskedStructureState.records || []).flatMap((record) => record.fingerprints || [])
    .filter((fingerprint) => String(fingerprint?.questionId || "") === questionId).length;
  const remainingSelfExperience = ["messages", "cases", "corrections", "ruleExceptions", "reviewEvents", "dossierSuggestions"]
    .flatMap((key) => maskedExperienceState[key] || [])
    .filter((entry) => String(entry?.questionId || entry?.sourceQuestionId || "") === questionId).length;
  const matureLeaveOneSatisfied = modePlan.mode !== "mature" || retainedOtherPrimaryMembers >= 1;
  const candidateContextClean = remainingHiddenDefinitions === 0
    && remainingAliases === 0
    && remainingSetLinks === 0
    && remainingHistoricalDefinitions === 0
    && remainingTargetMemberships === 0
    && remainingTargetFingerprints === 0
    && remainingSelfExperience === 0
    && matureLeaveOneSatisfied;
  return {
    hiddenFamilyIds: modePlan.hiddenFamilyIds,
    equivalentFamilyIds: modePlan.equivalentFamilyIds,
    removedFamilyDefinitions: (originalFamilyState.families || []).filter((family) => hiddenReferences.has(String(family?.id || ""))).length,
    removedFamilyAliases: Object.entries(originalFamilyState.familyAliases || {})
      .filter(([aliasId, familyId]) => hiddenReferences.has(String(aliasId)) || hiddenReferences.has(String(familyId))).length,
    removedFamilySetLinks: (originalFamilyState.familySetLinks || [])
      .filter((link) => link?.memberType === "family" && hiddenReferences.has(String(link?.memberId || ""))).length,
    removedHistoricalFamilyDefinitions: countHistoricalFamilyDefinitions(originalFamilyState, [...hiddenReferences]) - remainingHistoricalDefinitions,
    remainingHiddenDefinitions,
    remainingAliases,
    remainingFamilySetLinks: remainingSetLinks,
    remainingHistoricalDefinitions,
    remainingTargetMemberships,
    remainingTargetFingerprints,
    remainingSelfExperience,
    retainedOtherPrimaryMembers,
    matureLeaveOneSatisfied,
    candidateContextClean,
  };
}

function runtimeStateFromDirectory(runtimeDir) {
  const data = {};
  const sourceFileHashes = {};
  Object.entries(RUNTIME_CONTEXT_FILES).forEach(([key, fileName]) => {
    const filePath = path.join(runtimeDir, fileName);
    const bytes = fs.readFileSync(filePath);
    const parsed = JSON.parse(bytes.toString("utf8"));
    // 与运行时同源：运行时通过 createFileAiConfigStore().load() 读取并 normalizeConfig，
    // 因此提示词等口径以归一化结果为准。冻结上下文若直接使用文件原文，会出现
    // "程序已按新口径执行、冻结上下文仍内嵌旧提示词"的不一致（实测发生过）。
    data[key] = key === "aiConfig" ? normalizeConfig(parsed) : parsed;
    sourceFileHashes[fileName] = sha256(bytes);
  });
  return { data, sourceFileHashes };
}

function buildContextData(snapshot, runtimeState) {
  const bookIds = uniqueStrings((snapshot.items || []).map((item) => item?.questionSnapshot?.bookId));
  const rawDossiers = runtimeState.knowledgeDossiers || {};
  const sharedByBook = Object.fromEntries(bookIds.map((bookId) => [bookId, {
    textbookKnowledge: (runtimeState.textbookKnowledge || []).filter((record) => String(record?.bookId || "") === bookId),
    textbookCatalogs: (runtimeState.textbookCatalogs || []).filter((record) => String(record?.bookId || "") === bookId),
    knowledgeDossiers: {
      ...rawDossiers,
      dossiers: (rawDossiers.dossiers || []).filter((dossier) => String(dossier?.bookId || "") === bookId),
      deltas: [],
      runs: [],
    },
  }]));
  const questionById = new Map((runtimeState.questions || []).map((question) => [String(question?.id || ""), question]));
  const itemContexts = {};
  (snapshot.items || []).forEach((item) => {
    const questionId = String(item.questionId || "");
    const bookId = String(item.questionSnapshot?.bookId || "");
    const sourceQuestion = questionById.get(questionId) || null;
    const scopedFamilies = filterQuestionFamilyState(runtimeState.questionFamilies, [bookId]);
    const scopedExperience = filterExperienceState(runtimeState.knowledgeClassificationExperience, [bookId]);
    const modePlan = buildFrozenModePlan(item, scopedFamilies);
    const sourcePrimaryFamily = (scopedFamilies.families || [])
      .find((family) => String(family?.id || "") === String(item.familyGold?.primaryFamilyId || "")) || null;
    const maskedFamilies = maskQuestionFamilyState(scopedFamilies, questionId, modePlan.hiddenFamilyIds);
    const maskedStructure = maskKnowledgeStructureState(runtimeState.knowledgeStructures, questionId, bookId);
    const maskedExperience = maskExperienceState(scopedExperience, sourceQuestion || item.questionSnapshot || { id: questionId });
    const contextQuestionIds = new Set([questionId]);
    (scopedFamilies.families || []).forEach((family) => (family.members || []).forEach((member) => {
      if (member?.questionId) contextQuestionIds.add(String(member.questionId));
    }));
    modePlan.retainedIndependentMemberQuestionIds.forEach((id) => contextQuestionIds.add(id));
    const questions = [...contextQuestionIds]
      .map((id) => questionById.get(id))
      .filter(Boolean)
      .map(sanitizeContextQuestion);
    const targetQuestion = questions.find((question) => question.id === questionId) || null;
    const maskAudit = buildFrozenMaskAudit(
      scopedFamilies,
      maskedFamilies,
      item,
      modePlan,
      maskedStructure,
      maskedExperience,
    );
    itemContexts[questionId] = {
      questionId,
      bookId,
      replayMode: String(item.replayMode || ""),
      sharedBookId: bookId,
      questionVersion: Number(item.questionSnapshot?.version) || 0,
      sourceAudit: {
        questionFound: Boolean(sourceQuestion),
        questionVersionMatches: Boolean(sourceQuestion)
          && Number(sourceQuestion.version || 1) === Number(item.questionSnapshot?.version || 0),
        sourceQuestionVersion: Number(sourceQuestion?.version) || 0,
        frozenQuestionVersion: Number(item.questionSnapshot?.version) || 0,
        verifiedAnswerFrozen: targetQuestion?.answerProvenance?.status === "frozen_verified",
        answerFreezeStatus: String(targetQuestion?.answerProvenance?.status || "question_not_found"),
        primaryFamilyFound: Boolean(sourcePrimaryFamily),
        primaryFamilyStatus: String(sourcePrimaryFamily?.status || ""),
        primaryFamilyDefinitionSha256: familyDefinitionDigest(sourcePrimaryFamily),
        frozenPrimaryFamilyDefinitionSha256: familyDefinitionDigest(primaryFamilyFor(item)),
      },
      modePlan,
      maskAudit,
      input: {
        questions,
        questionFamilies: maskedFamilies,
        knowledgeStructures: maskedStructure,
        knowledgeClassificationExperience: maskedExperience,
      },
    };
  });
  return {
    bookIds,
    executionConfig: sanitizeAiConfig(runtimeState.aiConfig || {}),
    sharedByBook,
    itemContexts,
  };
}

function createReplayContextDocument(options) {
  const loadedGold = options.loadedGold;
  const snapshot = loadedGold.snapshot;
  const goldPreflight = buildGoldSemanticPreflight(loadedGold, {
    expectedCount: options.expectedCount,
    now: options.now,
    formalFamilyState: options.runtimeState.data.questionFamilies,
    formalFamilyStateSha256: options.runtimeState.sourceFileHashes?.[RUNTIME_CONTEXT_FILES.questionFamilies] || "",
  });
  if (!goldPreflight.eligibleForContextFreeze) {
    const error = new Error("blind_replay_context_gold_preflight_failed");
    error.preflightReport = goldPreflight;
    throw error;
  }
  const contextData = buildContextData(snapshot, options.runtimeState.data);
  const componentHashes = Object.fromEntries(Object.entries(contextData).map(([key, value]) => [key, contentHash(value)]));
  const scopedComponentHashes = {
    sharedByBook: Object.fromEntries(Object.entries(contextData.sharedByBook || {}).map(([bookId, shared]) => [bookId, {
      textbookKnowledge: contentHash(shared.textbookKnowledge || []),
      textbookCatalogs: contentHash(shared.textbookCatalogs || []),
      knowledgeDossiers: contentHash(shared.knowledgeDossiers || {}),
    }])),
    itemContexts: Object.fromEntries(Object.entries(contextData.itemContexts || {}).map(([questionId, itemContext]) => [questionId, {
      questions: contentHash(itemContext.input?.questions || []),
      questionFamilies: contentHash(itemContext.input?.questionFamilies || {}),
      knowledgeStructures: contentHash(itemContext.input?.knowledgeStructures || {}),
      knowledgeClassificationExperience: contentHash(itemContext.input?.knowledgeClassificationExperience || {}),
      maskAudit: contentHash(itemContext.maskAudit || {}),
    }])),
  };
  const contextDataSha256 = contentHash(contextData);
  const now = options.now || new Date();
  const contextId = options.contextId
    || `blind-context-${String(snapshot.version || "gold").toLowerCase()}-${CONTEXT_VERSION.toLowerCase()}-${contextDataSha256.slice(0, 16)}`;
  const bindingId = `blind-binding-${sha256(`${loadedGold.contentSha256}|${contextDataSha256}`).slice(0, 24)}`;
  const payload = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    contextId,
    version: CONTEXT_VERSION,
    status: "frozen",
    createdAt: now.toISOString(),
    bindingId,
    goldSnapshotBinding: {
      snapshotId: String(snapshot.snapshotId || ""),
      version: String(snapshot.version || ""),
      fileSha256: loadedGold.fileSha256,
      contentSha256: loadedGold.contentSha256,
    },
    source: {
      runtimeFileHashes: clone(options.runtimeState.sourceFileHashes || {}),
      capturedAt: now.toISOString(),
      note: "Only this frozen context may supply model-visible replay data. Formal runtime files are isolation-audited but never used to supplement context during a run.",
    },
    componentHashes,
    scopedComponentHashes,
    contextDataSha256,
    data: contextData,
  };
  const document = { ...payload, integrity: { algorithm: "sha256", contentSha256: contentHash(payload) } };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  const fileSha256 = sha256(bytes);
  const bindingPayload = {
    schemaVersion: BINDING_SCHEMA_VERSION,
    bindingId,
    createdAt: now.toISOString(),
    goldSnapshot: clone(payload.goldSnapshotBinding),
    replayContext: {
      contextId,
      version: CONTEXT_VERSION,
      fileSha256,
      contentSha256: document.integrity.contentSha256,
      contextDataSha256,
    },
  };
  const bindingDocument = {
    ...bindingPayload,
    integrity: { algorithm: "sha256", contentSha256: contentHash(bindingPayload) },
  };
  const bindingBytes = Buffer.from(`${JSON.stringify(bindingDocument, null, 2)}\n`, "utf8");
  return {
    document,
    bytes,
    fileSha256,
    contentSha256: document.integrity.contentSha256,
    contextDataSha256,
    bindingDocument,
    bindingBytes,
    bindingFileSha256: sha256(bindingBytes),
    goldPreflight,
  };
}

function writeReplayContext(prepared, outputPath) {
  const absolutePath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, prepared.bytes);
  fs.writeFileSync(`${absolutePath}.sha256`, `${prepared.fileSha256}  ${path.basename(absolutePath)}\n`, "utf8");
  fs.writeFileSync(`${absolutePath}.binding.json`, prepared.bindingBytes);
  fs.writeFileSync(`${absolutePath}.binding.json.sha256`, `${prepared.bindingFileSha256}  ${path.basename(absolutePath)}.binding.json\n`, "utf8");
  return {
    filePath: absolutePath,
    sidecarPath: `${absolutePath}.sha256`,
    bindingPath: `${absolutePath}.binding.json`,
    bindingSidecarPath: `${absolutePath}.binding.json.sha256`,
  };
}

function readExpectedSidecarHash(filePath) {
  const sidecarPath = `${filePath}.sha256`;
  if (!fs.existsSync(sidecarPath)) throw new Error("blind_replay_context_sidecar_missing");
  const value = String(fs.readFileSync(sidecarPath, "utf8")).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("blind_replay_context_sidecar_invalid");
  return { sidecarPath, expectedHash: value.toLowerCase() };
}

function readReplayContext(contextPath, loadedGold = null) {
  if (!contextPath) throw new Error("blind_replay_context_required");
  const filePath = path.resolve(contextPath);
  const bytes = fs.readFileSync(filePath);
  const fileSha256 = sha256(bytes);
  const sidecar = readExpectedSidecarHash(filePath);
  if (sidecar.expectedHash !== fileSha256) throw new Error("blind_replay_context_file_hash_mismatch");
  const document = JSON.parse(bytes.toString("utf8"));
  if (document.schemaVersion !== CONTEXT_SCHEMA_VERSION || document.status !== "frozen") {
    throw new Error("blind_replay_context_schema_invalid");
  }
  const { integrity, ...payload } = document;
  if (!integrity?.contentSha256 || contentHash(payload) !== integrity.contentSha256) {
    throw new Error("blind_replay_context_content_hash_mismatch");
  }
  if (contentHash(document.data) !== document.contextDataSha256) {
    throw new Error("blind_replay_context_data_hash_mismatch");
  }
  Object.entries(document.componentHashes || {}).forEach(([key, expectedHash]) => {
    if (!Object.prototype.hasOwnProperty.call(document.data || {}, key) || contentHash(document.data[key]) !== expectedHash) {
      throw new Error(`blind_replay_context_component_hash_mismatch:${key}`);
    }
  });
  Object.entries(document.scopedComponentHashes?.sharedByBook || {}).forEach(([bookId, hashes]) => {
    const shared = document.data?.sharedByBook?.[bookId];
    if (!shared) throw new Error(`blind_replay_context_scoped_component_missing:sharedByBook:${bookId}`);
    Object.entries(hashes || {}).forEach(([key, expectedHash]) => {
      if (contentHash(shared[key] ?? (Array.isArray(shared[key]) ? [] : {})) !== expectedHash) {
        throw new Error(`blind_replay_context_scoped_component_hash_mismatch:sharedByBook:${bookId}:${key}`);
      }
    });
  });
  Object.entries(document.scopedComponentHashes?.itemContexts || {}).forEach(([questionId, hashes]) => {
    const itemContext = document.data?.itemContexts?.[questionId];
    if (!itemContext) throw new Error(`blind_replay_context_scoped_component_missing:itemContexts:${questionId}`);
    const values = {
      questions: itemContext.input?.questions || [],
      questionFamilies: itemContext.input?.questionFamilies || {},
      knowledgeStructures: itemContext.input?.knowledgeStructures || {},
      knowledgeClassificationExperience: itemContext.input?.knowledgeClassificationExperience || {},
      maskAudit: itemContext.maskAudit || {},
    };
    Object.entries(hashes || {}).forEach(([key, expectedHash]) => {
      if (contentHash(values[key]) !== expectedHash) {
        throw new Error(`blind_replay_context_scoped_component_hash_mismatch:itemContexts:${questionId}:${key}`);
      }
    });
  });
  const bindingPath = `${filePath}.binding.json`;
  if (!fs.existsSync(bindingPath)) throw new Error("blind_replay_context_binding_missing");
  const bindingBytes = fs.readFileSync(bindingPath);
  const bindingFileSha256 = sha256(bindingBytes);
  const bindingSidecar = readExpectedSidecarHash(bindingPath);
  if (bindingSidecar.expectedHash !== bindingFileSha256) throw new Error("blind_replay_context_binding_file_hash_mismatch");
  const binding = JSON.parse(bindingBytes.toString("utf8"));
  const { integrity: bindingIntegrity, ...bindingPayload } = binding;
  if (binding.schemaVersion !== BINDING_SCHEMA_VERSION
    || !bindingIntegrity?.contentSha256
    || contentHash(bindingPayload) !== bindingIntegrity.contentSha256) {
    throw new Error("blind_replay_context_binding_invalid");
  }
  if (binding.bindingId !== document.bindingId
    || binding.replayContext?.contextId !== document.contextId
    || binding.replayContext?.fileSha256 !== fileSha256
    || binding.replayContext?.contentSha256 !== integrity.contentSha256
    || binding.replayContext?.contextDataSha256 !== document.contextDataSha256) {
    throw new Error("blind_replay_context_binding_context_mismatch");
  }
  if (loadedGold) {
    const goldBinding = document.goldSnapshotBinding || {};
    if (goldBinding.snapshotId !== loadedGold.snapshot.snapshotId
      || goldBinding.version !== loadedGold.snapshot.version
      || goldBinding.fileSha256 !== loadedGold.fileSha256
      || goldBinding.contentSha256 !== loadedGold.contentSha256
      || binding.goldSnapshot?.fileSha256 !== loadedGold.fileSha256
      || binding.goldSnapshot?.contentSha256 !== loadedGold.contentSha256) {
      throw new Error("blind_replay_context_gold_binding_mismatch");
    }
  }
  return {
    document,
    data: document.data,
    filePath,
    sidecarPath: sidecar.sidecarPath,
    bindingPath,
    bindingSidecarPath: bindingSidecar.sidecarPath,
    bytes,
    bindingBytes,
    fileSha256,
    contentSha256: integrity.contentSha256,
    contextDataSha256: document.contextDataSha256,
    bindingFileSha256,
  };
}

function compareFamilyDefinition(goldFamily, contextFamily) {
  const differences = [];
  const comparisons = [
    ["name", String(goldFamily?.name || ""), String(contextFamily?.name || "")],
    ["bookId", String(goldFamily?.bookId || ""), String(contextFamily?.bookId || "")],
    ["textbookAnchorNodeIds", familyAnchorIds(goldFamily).sort(), familyAnchorIds(contextFamily).sort()],
    ["assessmentAction", normalizedAction(goldFamily?.assessmentAction), normalizedAction(contextFamily?.assessmentAction)],
    ["inclusionBoundary", String(goldFamily?.inclusionBoundary || "").trim(), String(contextFamily?.inclusionBoundary || "").trim()],
    ["exclusionBoundary", String(goldFamily?.exclusionBoundary || "").trim(), String(contextFamily?.exclusionBoundary || "").trim()],
  ];
  comparisons.forEach(([field, expected, actual]) => {
    const equal = Array.isArray(expected) ? sameStringSet(expected, actual) : expected === actual;
    if (!equal) differences.push({ field, expected, actual });
  });
  if (!knowledgeNodesCompatible(familyCoreNode(goldFamily), familyCoreNode(contextFamily))) {
    differences.push({
      field: "coreKnowledgeNodeId",
      expected: familyCoreNode(goldFamily),
      actual: familyCoreNode(contextFamily),
    });
  }
  if (!knowledgeSetsCompatible(familyRequiredNodes(goldFamily), familyRequiredNodes(contextFamily))) {
    differences.push({
      field: "requiredKnowledgeNodeIds",
      expected: familyRequiredIds(goldFamily).sort(),
      actual: familyRequiredIds(contextFamily).sort(),
    });
  }
  return differences;
}

function familyDefinitionDigest(family) {
  if (!family) return "";
  return contentHash({
    id: String(family.id || ""),
    name: String(family.name || ""),
    bookId: String(family.bookId || ""),
    status: String(family.status || ""),
    coreKnowledgeNodeId: familyCoreId(family),
    requiredKnowledgeNodeIds: familyRequiredIds(family).sort(),
    textbookAnchorNodeIds: familyAnchorIds(family).sort(),
    assessmentAction: normalizedAction(family.assessmentAction),
    inclusionBoundary: String(family.inclusionBoundary || "").trim(),
    exclusionBoundary: String(family.exclusionBoundary || "").trim(),
    members: (family.members || []).map((member) => ({
      questionId: String(member?.questionId || ""),
      isPrimary: member?.isPrimary === true,
      role: String(member?.role || ""),
    })).sort((left, right) => left.questionId.localeCompare(right.questionId)),
  });
}

function buildReplayContextPreflight(loadedGold, loadedContext, options = {}) {
  const goldReport = buildGoldSemanticPreflight(loadedGold, { expectedCount: options.expectedCount, now: options.now });
  const blockers = [...goldReport.blockers.map((entry) => ({ ...entry, source: "gold" }))];
  const warnings = [...goldReport.warnings.map((entry) => ({ ...entry, source: "gold" }))];
  const context = loadedContext.document;
  const data = loadedContext.data || {};
  const secretConfigPaths = findSecretConfigPaths(data.executionConfig || {});
  secretConfigPaths.forEach((secretPath) => blockers.push({
    questionId: "",
    replayMode: "",
    source: "context",
    ...issue("context_secret_present", `C1 执行配置含秘密或带凭据参数的地址：${secretPath}。`, {
      stage: "context",
      field: secretPath,
    }),
  }));
  findGoldLeakPaths(data).forEach((leakPath) => blockers.push({
    questionId: "",
    replayMode: "",
    source: "context",
    ...issue("context_gold_leak", `C1 数据层泄露评分金标字段：${leakPath}。`, {
      stage: "context",
      field: leakPath,
    }),
  }));
  const items = (loadedGold.snapshot.items || []).map((item) => {
    const questionId = String(item.questionId || "");
    const mode = String(item.replayMode || "");
    const itemIssues = [];
    const itemContext = data.itemContexts?.[questionId];
    if (!itemContext) {
      itemIssues.push(issue("item_context_missing", `C1 缺少题目 ${questionId} 的冻结遮蔽上下文。`, { stage: "context" }));
      return { questionId, replayMode: mode, passed: false, issues: itemIssues };
    }
    if (String(itemContext.replayMode || "") !== mode || String(itemContext.bookId || "") !== String(item.questionSnapshot?.bookId || "")) {
      itemIssues.push(issue("item_context_identity_mismatch", `C1 题目 ${questionId} 的模式或教材绑定不一致。`, {
        stage: "context",
        expected: { replayMode: mode, bookId: String(item.questionSnapshot?.bookId || "") },
        actual: { replayMode: itemContext.replayMode, bookId: itemContext.bookId },
      }));
    }
    if (!data.sharedByBook?.[itemContext.sharedBookId]) {
      itemIssues.push(issue("item_context_shared_book_missing", `C1 缺少题目 ${questionId} 引用的教材共享上下文。`, { stage: "context" }));
    }
    if (!itemContext.sourceAudit?.questionFound || !itemContext.sourceAudit?.questionVersionMatches) {
      itemIssues.push(issue("item_context_question_source_mismatch", `题目 ${questionId} 的正式题面不存在或版本与冻结金标不一致。`, {
        stage: "context",
        expected: itemContext.sourceAudit?.frozenQuestionVersion,
        actual: itemContext.sourceAudit?.sourceQuestionVersion,
      }));
    }
    const input = itemContext.input || {};
    const goldLeakPaths = findGoldLeakPaths(input);
    goldLeakPaths.forEach((leakPath) => itemIssues.push(issue("item_context_gold_leak", `题目 ${questionId} 的模型输入泄露评分金标字段：${leakPath}。`, {
      stage: "context",
      field: leakPath,
    })));
    const contextQuestions = input.questions || [];
    const questionById = new Map(contextQuestions.map((question) => [String(question?.id || ""), question]));
    const contextFamilies = input.questionFamilies?.families || [];
    const familyById = new Map(contextFamilies.map((family) => [String(family?.id || ""), family]));
    const targetQuestion = questionById.get(questionId);
    if (!targetQuestion) {
      itemIssues.push(issue("item_context_target_question_missing", `C1 模型输入缺少目标题面 ${questionId}。`, { stage: "context" }));
    }
    if (!itemContext.maskAudit?.candidateContextClean) {
      itemIssues.push(issue("item_context_mask_audit_failed", `题目 ${questionId} 的冻结遮蔽审计未通过。`, {
        stage: "context",
        actual: itemContext.maskAudit,
      }));
    }
    const goldFamily = primaryFamilyFor(item);
    if (mode === "mature" && goldFamily) {
      const familyId = String(goldFamily.id || "");
      const contextFamily = familyById.get(familyId);
      if (!contextFamily) {
        itemIssues.push(issue("context_mature_family_missing", `成熟题族回放必须保留主题族定义 ${familyId}。`, { stage: "context" }));
      } else {
        if (String(contextFamily.status || "") !== "confirmed") {
          itemIssues.push(issue("context_family_status_not_confirmed", `C1 中主題族 ${familyId} 不是 confirmed。`, {
            stage: "context",
            expected: "confirmed",
            actual: String(contextFamily.status || "missing"),
          }));
        }
        const differences = compareFamilyDefinition(goldFamily, contextFamily);
        differences.forEach((difference) => itemIssues.push(issue("context_family_definition_mismatch", `C1 中主題族 ${familyId} 的 ${difference.field} 与冻结金标不一致。`, {
          stage: "context",
          field: difference.field,
          expected: difference.expected,
          actual: difference.actual,
        })));
        const contextMembers = familyMemberIds(contextFamily);
        const retainedMembers = familyIndependentIds(goldFamily).filter((id) => id !== questionId);
        if (!sameStringSet(contextMembers, retainedMembers)) {
          itemIssues.push(issue("context_mature_retained_members_mismatch", `成熟题族 ${familyId} 隐藏目标题后，C1 留存成员与冻结策略不一致。`, {
            stage: "context",
            expected: retainedMembers,
            actual: contextMembers,
          }));
        }
        if (contextMembers.includes(questionId)) {
          itemIssues.push(issue("context_target_membership_leaked", `成熟题族 ${familyId} 仍泄露目标题成员关系。`, {
            stage: "context",
          }));
        }
      }
      familyIndependentIds(goldFamily).filter((id) => id !== questionId).forEach((retainedId) => {
        const retainedQuestion = questionById.get(retainedId);
        if (!retainedQuestion) {
          itemIssues.push(issue("context_retained_question_missing", `C1 缺少留存成员题面 ${retainedId}。`, {
            stage: "context",
            field: "data.questions",
          }));
        } else {
          const answerFields = contextQuestionAnswerFields(retainedQuestion);
          if (answerFields.length) {
            itemIssues.push(issue("context_scoring_answer_present", `C1 的留存成员 ${retainedId} 含评分答案字段。`, {
              stage: "context",
              field: "data.questions",
              actual: answerFields,
            }));
          }
        }
      });
    }
    if (mode === "singleton") {
      const familyId = String(item.familyGold?.primaryFamilyId || "");
      if (familyById.has(familyId)) {
        itemIssues.push(issue("context_singleton_family_leaked", `单题题族 ${familyId} 必须整族隐藏。`, { stage: "context" }));
      }
      if (itemContext.maskAudit?.remainingHiddenDefinitions
        || itemContext.maskAudit?.remainingAliases
        || itemContext.maskAudit?.remainingFamilySetLinks
        || itemContext.maskAudit?.remainingHistoricalDefinitions) {
        itemIssues.push(issue("context_singleton_references_leaked", `单题题族 ${familyId} 的定义、别名、题族集链接或历史定义仍有残留。`, {
          stage: "context",
          actual: itemContext.maskAudit,
        }));
      }
      if (!itemContext.sourceAudit?.primaryFamilyFound
        || itemContext.sourceAudit?.primaryFamilyStatus !== "confirmed"
        || itemContext.sourceAudit?.primaryFamilyDefinitionSha256 !== itemContext.sourceAudit?.frozenPrimaryFamilyDefinitionSha256) {
        itemIssues.push(issue("context_singleton_source_family_mismatch", `单题题族 ${familyId} 在遮蔽前与冻结金标不一致。`, {
          stage: "context",
          expected: itemContext.sourceAudit?.frozenPrimaryFamilyDefinitionSha256,
          actual: itemContext.sourceAudit?.primaryFamilyDefinitionSha256,
        }));
      }
    }
    if (mode === "unmatched") {
      const hiddenIds = uniqueStrings(itemContext.modePlan?.equivalentFamilyIds || []);
      const leakedIds = hiddenIds.filter((familyId) => familyById.has(familyId));
      if (leakedIds.length || itemContext.maskAudit?.remainingHiddenDefinitions
        || itemContext.maskAudit?.remainingAliases
        || itemContext.maskAudit?.remainingFamilySetLinks
        || itemContext.maskAudit?.remainingHistoricalDefinitions) {
        itemIssues.push(issue("context_unmatched_equivalent_family_leaked", `无匹配题 ${questionId} 的等价现有族或引用未完全隐藏。`, {
          stage: "context",
          actual: leakedIds,
        }));
      }
    }
    const targetMemberships = contextFamilies.flatMap((family) => family.members || [])
      .filter((member) => String(member?.questionId || "") === questionId);
    if (targetMemberships.length) {
      itemIssues.push(issue("context_target_membership_leaked", `C1 仍含题目 ${questionId} 的题族成员关系。`, {
        stage: "context",
        actual: targetMemberships.length,
      }));
    }
    return {
      questionId,
      replayMode: mode,
      passed: !itemIssues.some((entry) => entry.severity === "blocker"),
      issues: itemIssues,
    };
  });
  items.forEach((item) => item.issues.forEach((entry) => {
    const target = entry.severity === "warning" ? warnings : blockers;
    target.push({ questionId: item.questionId, replayMode: item.replayMode, source: "context", ...entry });
  }));
  const bindingPassed = context.goldSnapshotBinding?.fileSha256 === loadedGold.fileSha256
    && context.goldSnapshotBinding?.contentSha256 === loadedGold.contentSha256;
  if (!bindingPassed) {
    blockers.push({
      questionId: "",
      replayMode: "",
      source: "binding",
      ...issue("context_gold_binding_mismatch", "冻结金标与 C1 的双向绑定哈希不一致。", { stage: "context" }),
    });
  }
  return {
    schemaVersion: CONTEXT_PREFLIGHT_SCHEMA_VERSION,
    generatedAt: (options.now || new Date()).toISOString(),
    modelCallsPerformed: 0,
    status: blockers.length ? "blocked" : "passed",
    eligibleForReplay: blockers.length === 0,
    goldSnapshot: goldReport.snapshot,
    replayContext: {
      contextId: context.contextId,
      version: context.version,
      filePath: loadedContext.filePath,
      fileSha256: loadedContext.fileSha256,
      contentSha256: loadedContext.contentSha256,
      contextDataSha256: loadedContext.contextDataSha256,
      bindingId: context.bindingId,
      bindingFileSha256: loadedContext.bindingFileSha256,
    },
    summary: {
      total: items.length,
      passed: items.filter((item) => item.passed).length,
      blocked: items.filter((item) => !item.passed).length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
      distribution: goldReport.summary.distribution,
      scoreableDistribution: goldReport.summary.scoreableDistribution,
      disputedDistribution: goldReport.summary.disputedDistribution,
      modeDistributions: goldReport.summary.modeDistributions,
    },
    blockers,
    warnings,
    items,
    goldSemanticPreflight: goldReport,
  };
}

function renderPreflightMarkdown(report) {
  const status = report.status === "passed" ? "通过" : "阻断";
  const modeDistributions = report.summary?.modeDistributions || {
    total: report.summary?.distribution || {},
    scoreable: report.summary?.scoreableDistribution || {},
    disputed: report.summary?.disputedDistribution || {},
  };
  const modeRows = [
    ["全部", modeDistributions.total],
    ["可计分", modeDistributions.scoreable],
    ["争议诊断", modeDistributions.disputed],
  ].map(([label, values]) => `| ${label} | ${values?.mature || 0} | ${values?.singleton || 0} | ${values?.unmatched || 0} |`).join("\n");
  const rows = (report.blockers || []).map((entry) => `| ${entry.questionId || "批次"} | ${entry.replayMode || "-"} | ${entry.stage || "-"} | \`${entry.code}\` | ${String(entry.message || "").replace(/\|/g, "\\|")} |`).join("\n");
  return `# 盲测零模型预检\n\n| 项目 | 结果 |\n| --- | --- |\n| 状态 | ${status} |\n| 模型调用 | ${report.modelCallsPerformed || 0} |\n| 阻断项 | ${report.summary?.blockerCount || 0} |\n| 警告项 | ${report.summary?.warningCount || 0} |\n\n## 模式分布\n\n| 口径 | 成熟题族 | 单题题族 | 无匹配题 |\n| --- | ---: | ---: | ---: |\n${modeRows}\n\n## 阻断明细\n\n| 题目 | 模式 | 阶段 | 代码 | 说明 |\n| --- | --- | --- | --- | --- |\n${rows || "| - | - | - | - | 无 |"}\n`;
}

function writePreflightReport(report, outputPath) {
  const absolutePath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = absolutePath.replace(/\.json$/i, ".md");
  fs.writeFileSync(markdownPath, renderPreflightMarkdown(report), "utf8");
  return { jsonPath: absolutePath, markdownPath };
}

function buildReplayContextFromRuntime(options = {}) {
  const loadedGold = readFrozenGoldSnapshot(options.goldSnapshotPath, { requireSidecar: true });
  const runtimeDir = path.resolve(options.runtimeDir || path.join(__dirname, "../.runtime"));
  const runtimeState = runtimeStateFromDirectory(runtimeDir);
  const prepared = createReplayContextDocument({
    loadedGold,
    runtimeState,
    expectedCount: options.expectedCount,
    now: options.now,
    contextId: options.contextId,
  });
  const outputPath = path.resolve(options.outputPath || path.join(
    runtimeDir,
    "blind-replay-contexts",
    `${String(loadedGold.snapshot.version || "gold")}-${CONTEXT_VERSION}-${timestampForPath(options.now || new Date())}.json`,
  ));
  const paths = writeReplayContext(prepared, outputPath);
  const loadedContext = readReplayContext(paths.filePath, loadedGold);
  const preflight = buildReplayContextPreflight(loadedGold, loadedContext, {
    expectedCount: options.expectedCount,
    now: options.now,
  });
  const preflightPaths = writePreflightReport(preflight, `${paths.filePath}.preflight.json`);
  return { loadedGold, prepared, loadedContext, preflight, paths: { ...paths, ...preflightPaths } };
}

module.exports = {
  BINDING_SCHEMA_VERSION,
  CONTEXT_PREFLIGHT_SCHEMA_VERSION,
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_VERSION,
  GOLD_PREFLIGHT_SCHEMA_VERSION,
  RUNTIME_CONTEXT_FILES,
  buildContextData,
  buildGoldSemanticPreflight,
  buildReplayContextFromRuntime,
  buildReplayContextPreflight,
  compareFamilyDefinition,
  contextQuestionAnswerFields,
  createReplayContextDocument,
  familyAnchorIds,
  familyCoreId,
  familyIndependentIds,
  familyRequiredIds,
  familyRetainedIds,
  findGoldLeakPaths,
  knowledgeGoldFor,
  primaryFamilyFor,
  readReplayContext,
  replayModeDistributions,
  renderPreflightMarkdown,
  runtimeStateFromDirectory,
  sanitizeAiConfig,
  sanitizeContextQuestion,
  sanitizeProviderBaseUrl,
  sameStringSet,
  sha256,
  findSecretConfigPaths,
  validateGoldItem,
  writePreflightReport,
  writeReplayContext,
};
