function uniqueIds(values, limit = 20) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].slice(0, limit);
}

function cleanText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

const RELATED_FAMILY_COVERAGE_ROLES = new Set(["required", "reference"]);

function relationCoverageRole(value = {}) {
  const coverageRole = cleanText(value?.coverageRole, 40);
  if (RELATED_FAMILY_COVERAGE_ROLES.has(coverageRole)) return coverageRole;
  if (typeof value?.requiredForAnswer === "boolean") return value.requiredForAnswer ? "required" : "reference";
  return "";
}

function normalizeRelation(value = {}, familyId = "") {
  const coverageRole = relationCoverageRole(value);
  const contributionKnowledgeNodeIdsProvided = Object.prototype.hasOwnProperty.call(
    value || {},
    "contributionKnowledgeNodeIds",
  );
  return {
    familyId: String(value?.familyId || familyId || ""),
    coverageRole,
    requiredForAnswer: coverageRole === "required",
    contributionKnowledgeNodeIds: uniqueIds(value?.contributionKnowledgeNodeIds, 20),
    contributionKnowledgeNodeIdsProvided,
  };
}

function validateRelatedFamilySuggestionsContract(input = {}) {
  const validFamilyIds = input.validFamilyIds instanceof Set
    ? input.validFamilyIds
    : new Set(uniqueIds(input.validFamilyIds, 1000));
  const primaryFamilyId = String(input.primaryFamilyId || "");
  if (input.rawRelatedFamilyIds != null && !Array.isArray(input.rawRelatedFamilyIds)) {
    throw new Error("knowledge_classification_agent3_related_family_refs_invalid");
  }
  const rawRelatedFamilyIds = Array.isArray(input.rawRelatedFamilyIds)
    ? input.rawRelatedFamilyIds.map((value) => String(value || ""))
    : [];
  if (rawRelatedFamilyIds.some((familyId) => !familyId
    || familyId === primaryFamilyId
    || !validFamilyIds.has(familyId))) {
    throw new Error("knowledge_classification_agent3_related_family_refs_invalid");
  }
  if (new Set(rawRelatedFamilyIds).size !== rawRelatedFamilyIds.length) {
    throw new Error("knowledge_classification_agent3_related_family_ids_duplicate");
  }

  if (input.rawRelations != null && !Array.isArray(input.rawRelations)) {
    throw new Error("knowledge_classification_agent3_related_family_relation_invalid");
  }
  const rawRelations = Array.isArray(input.rawRelations) ? input.rawRelations : [];
  const relatedFamilyIdSet = new Set(rawRelatedFamilyIds);
  const relationByFamilyId = new Map();
  rawRelations.forEach((value) => {
    const familyId = String(value?.familyId || "");
    const coverageRole = cleanText(value?.coverageRole, 40);
    if (!familyId || !validFamilyIds.has(familyId) || !relatedFamilyIdSet.has(familyId)) {
      throw new Error("knowledge_classification_agent3_related_family_relation_invalid");
    }
    if (relationByFamilyId.has(familyId)) {
      throw new Error("knowledge_classification_agent3_related_family_relation_duplicate");
    }
    if (!RELATED_FAMILY_COVERAGE_ROLES.has(coverageRole)
      || (typeof value?.requiredForAnswer === "boolean" && value.requiredForAnswer !== (coverageRole === "required"))) {
      throw new Error("knowledge_classification_agent3_related_family_relation_invalid");
    }
    if (coverageRole === "reference" && uniqueIds(value?.contributionKnowledgeNodeIds, 20).length) {
      throw new Error("knowledge_classification_agent3_reference_family_contribution_forbidden");
    }
    relationByFamilyId.set(familyId, normalizeRelation(value, familyId));
  });
  if (rawRelatedFamilyIds.some((familyId) => !relationByFamilyId.has(familyId))) {
    throw new Error("knowledge_classification_agent3_related_family_relation_missing");
  }

  if (input.rawAssessments != null && !Array.isArray(input.rawAssessments)) {
    throw new Error("knowledge_classification_agent3_related_family_assessment_refs_invalid");
  }
  const rawAssessments = Array.isArray(input.rawAssessments) ? input.rawAssessments : [];
  const assessmentByFamilyId = new Map();
  rawAssessments.forEach((value) => {
    const familyId = String(value?.familyId || "");
    if (!familyId || !validFamilyIds.has(familyId) || !relatedFamilyIdSet.has(familyId)) {
      throw new Error("knowledge_classification_agent3_related_family_assessment_refs_invalid");
    }
    if (assessmentByFamilyId.has(familyId)) {
      throw new Error("knowledge_classification_agent3_related_family_assessment_duplicate");
    }
    assessmentByFamilyId.set(familyId, value);
  });
  if (rawRelatedFamilyIds.some((familyId) => !assessmentByFamilyId.has(familyId))) {
    throw new Error("knowledge_classification_agent3_related_family_assessment_missing");
  }

  const assessments = rawRelatedFamilyIds.map((familyId) => {
    const value = assessmentByFamilyId.get(familyId);
    const relation = relationByFamilyId.get(familyId);
    const deletionTest = cleanText(value?.deletionTest, 1200);
    const reason = cleanText(value?.reason, 1200);
    const requiredForAnswer = relation.coverageRole === "required";
    if ((requiredForAnswer && (value?.necessaryAfterDeletionTest !== true || !deletionTest || !reason))
      || (!requiredForAnswer && (value?.necessaryAfterDeletionTest !== false || !reason))) {
      throw new Error("knowledge_classification_agent3_related_family_deletion_test_invalid");
    }
    return {
      familyId,
      coverageRole: relation.coverageRole,
      requiredForAnswer,
      necessaryAfterDeletionTest: requiredForAnswer,
      deletionTest,
      reason,
      accepted: true,
    };
  });

  return {
    relatedFamilyIds: [...rawRelatedFamilyIds],
    relatedFamilyRelations: rawRelatedFamilyIds.map((familyId) => relationByFamilyId.get(familyId)),
    requiredRelatedFamilyIds: rawRelatedFamilyIds.filter((familyId) => relationByFamilyId.get(familyId).coverageRole === "required"),
    rejectedFamilyIds: [],
    assessments,
  };
}

function filterRelatedFamilySuggestions(input = {}) {
  const validFamilyIds = input.validFamilyIds instanceof Set
    ? input.validFamilyIds
    : new Set(uniqueIds(input.validFamilyIds, 1000));
  const primaryFamilyId = String(input.primaryFamilyId || "");
  const rawRelatedFamilyIds = uniqueIds(input.rawRelatedFamilyIds, 12)
    .filter((familyId) => validFamilyIds.has(familyId) && familyId !== primaryFamilyId);
  const rawAssessments = Array.isArray(input.rawAssessments) ? input.rawAssessments : [];
  const assessmentByFamilyId = new Map();
  const explicitRelationByFamilyId = new Map();

  (Array.isArray(input.rawRelations) ? input.rawRelations : []).forEach((value) => {
    const familyId = String(value?.familyId || "");
    const coverageRole = relationCoverageRole(value);
    if (!rawRelatedFamilyIds.includes(familyId) || explicitRelationByFamilyId.has(familyId) || !coverageRole) return;
    explicitRelationByFamilyId.set(familyId, normalizeRelation(value, familyId));
  });

  rawAssessments.forEach((value) => {
    const familyId = String(value?.familyId || "");
    if (!rawRelatedFamilyIds.includes(familyId) || assessmentByFamilyId.has(familyId)) return;
    const explicitRelation = explicitRelationByFamilyId.get(familyId);
    const legacyRequired = !explicitRelation && value?.necessaryAfterDeletionTest === true;
    const coverageRole = explicitRelation?.coverageRole || (legacyRequired ? "required" : "");
    const requiredForAnswer = coverageRole === "required";
    const necessaryAfterDeletionTest = value?.necessaryAfterDeletionTest === true;
    const deletionTest = cleanText(value?.deletionTest, 1200);
    const reason = cleanText(value?.reason, 1200);
    assessmentByFamilyId.set(familyId, {
      familyId,
      coverageRole,
      requiredForAnswer,
      necessaryAfterDeletionTest,
      deletionTest,
      reason,
      accepted: coverageRole === "required"
        ? necessaryAfterDeletionTest && Boolean(deletionTest) && Boolean(reason)
        : coverageRole === "reference" && value?.necessaryAfterDeletionTest === false && Boolean(reason),
    });
  });

  const assessments = rawRelatedFamilyIds.map((familyId) => assessmentByFamilyId.get(familyId) || {
    familyId,
    coverageRole: explicitRelationByFamilyId.get(familyId)?.coverageRole || "",
    requiredForAnswer: explicitRelationByFamilyId.get(familyId)?.coverageRole === "required",
    necessaryAfterDeletionTest: false,
    deletionTest: "",
    reason: "Agent 3 未提供逐题删除检验，不能作为关联题族。",
    accepted: false,
  });

  const acceptedAssessments = assessments.filter((item) => item.accepted);
  const relatedFamilyRelations = acceptedAssessments.map((item) => normalizeRelation({
    ...item,
    contributionKnowledgeNodeIds: explicitRelationByFamilyId.get(item.familyId)?.contributionKnowledgeNodeIds || [],
  }, item.familyId));

  return {
    relatedFamilyIds: acceptedAssessments.map((item) => item.familyId),
    relatedFamilyRelations,
    requiredRelatedFamilyIds: relatedFamilyRelations.filter((item) => item.coverageRole === "required").map((item) => item.familyId),
    rejectedFamilyIds: assessments.filter((item) => !item.accepted).map((item) => item.familyId),
    assessments,
  };
}

module.exports = {
  filterRelatedFamilySuggestions,
  validateRelatedFamilySuggestionsContract,
};
