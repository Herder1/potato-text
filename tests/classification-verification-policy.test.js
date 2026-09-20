const assert = require("node:assert/strict");
const test = require("node:test");

const {
  filterRelatedFamilySuggestions,
  validateRelatedFamilySuggestionsContract,
} = require("../apps/api/src/classification-verification-policy");

test("related families require an explicit passing deletion test", () => {
  const result = filterRelatedFamilySuggestions({
    validFamilyIds: new Set(["family-primary", "family-required", "family-background", "family-missing"]),
    primaryFamilyId: "family-primary",
    rawRelatedFamilyIds: ["family-primary", "family-required", "family-background", "family-missing", "family-invalid"],
    rawAssessments: [{
      familyId: "family-required",
      necessaryAfterDeletionTest: true,
      deletionTest: "去掉该辨析能力后，无法可靠排除 B、C 两项。",
      reason: "它参与最终判断而不是只在选项中出现。",
    }, {
      familyId: "family-background",
      necessaryAfterDeletionTest: false,
      deletionTest: "去掉后仍可直接依据主题族知识完成作答。",
      reason: "仅为前置背景。",
    }],
  });

  assert.deepEqual(result.relatedFamilyIds, ["family-required"]);
  assert.deepEqual(result.rejectedFamilyIds, ["family-background", "family-missing"]);
  assert.equal(result.assessments.find((item) => item.familyId === "family-required").accepted, true);
  assert.equal(result.assessments.find((item) => item.familyId === "family-background").accepted, false);
  assert.match(result.assessments.find((item) => item.familyId === "family-missing").reason, /未提供逐题删除检验/);
});

test("related family deletion tests require both a test statement and a reason", () => {
  const result = filterRelatedFamilySuggestions({
    validFamilyIds: ["family-a", "family-b"],
    rawRelatedFamilyIds: ["family-a", "family-b"],
    rawAssessments: [
      { familyId: "family-a", necessaryAfterDeletionTest: true, deletionTest: "", reason: "仍然需要" },
      { familyId: "family-b", necessaryAfterDeletionTest: true, deletionTest: "去掉后不能作答", reason: "" },
    ],
  });

  assert.deepEqual(result.relatedFamilyIds, []);
  assert.deepEqual(result.rejectedFamilyIds, ["family-a", "family-b"]);
});

test("strict related-family contract accepts only fully assessed necessary families", () => {
  const result = validateRelatedFamilySuggestionsContract({
    validFamilyIds: new Set(["family-primary", "family-required", "family-similar"]),
    primaryFamilyId: "family-primary",
    rawRelatedFamilyIds: ["family-required"],
    rawRelations: [{
      familyId: "family-required",
      coverageRole: "required",
      contributionKnowledgeNodeIds: ["knowledge-a", "knowledge-a", "knowledge-b"],
    }],
    rawAssessments: [{
      familyId: "family-required",
      necessaryAfterDeletionTest: true,
      deletionTest: "删除该能力后，无法排除关键干扰项。",
      reason: "它独立参与最终判断。",
    }],
    matchedFamilyIds: ["family-similar"],
  });

  assert.deepEqual(result.relatedFamilyIds, ["family-required"]);
  assert.deepEqual(result.requiredRelatedFamilyIds, ["family-required"]);
  assert.deepEqual(result.relatedFamilyRelations, [{
    familyId: "family-required",
    coverageRole: "required",
    requiredForAnswer: true,
    contributionKnowledgeNodeIds: ["knowledge-a", "knowledge-b"],
    contributionKnowledgeNodeIdsProvided: true,
  }]);
  assert.equal(result.assessments[0].accepted, true);
  assert.deepEqual(validateRelatedFamilySuggestionsContract({
    validFamilyIds: ["family-similar"],
    rawRelatedFamilyIds: [],
    rawRelations: [],
    rawAssessments: [],
    matchedFamilyIds: ["family-similar"],
  }).relatedFamilyIds, []);
});

test("strict related-family contract rejects missing or duplicate assessments", () => {
  const base = {
    validFamilyIds: ["family-a"],
    rawRelatedFamilyIds: ["family-a"],
    rawRelations: [{ familyId: "family-a", coverageRole: "required" }],
  };
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawAssessments: [],
  }), /related_family_assessment_missing/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawAssessments: [{
      familyId: "family-a",
      necessaryAfterDeletionTest: true,
      deletionTest: "删除后不能作答。",
      reason: "独立参与判断。",
    }, {
      familyId: "family-a",
      necessaryAfterDeletionTest: true,
      deletionTest: "重复检验。",
      reason: "重复记录。",
    }],
  }), /related_family_assessment_duplicate/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawRelatedFamilyIds: ["family-a", "family-a"],
    rawAssessments: [],
  }), /related_family_ids_duplicate/);
});

test("strict related-family contract rejects incomplete deletion tests and out-of-range references", () => {
  const validAssessment = {
    familyId: "family-a",
    necessaryAfterDeletionTest: true,
    deletionTest: "删除后不能作答。",
    reason: "独立参与判断。",
  };
  const base = {
    validFamilyIds: ["family-primary", "family-a", "family-b"],
    primaryFamilyId: "family-primary",
    rawRelatedFamilyIds: ["family-a"],
    rawRelations: [{ familyId: "family-a", coverageRole: "required" }],
  };
  for (const invalidAssessment of [
    { ...validAssessment, necessaryAfterDeletionTest: false },
    { ...validAssessment, deletionTest: "" },
    { ...validAssessment, reason: "" },
  ]) {
    assert.throws(() => validateRelatedFamilySuggestionsContract({
      ...base,
      rawAssessments: [invalidAssessment],
    }), /related_family_deletion_test_invalid/);
  }
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawRelatedFamilyIds: ["family-outside"],
    rawRelations: [{ familyId: "family-outside", coverageRole: "required" }],
    rawAssessments: [],
  }), /related_family_refs_invalid/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawAssessments: [{ ...validAssessment, familyId: "family-b" }],
  }), /related_family_assessment_refs_invalid/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawRelatedFamilyIds: ["family-primary"],
    rawRelations: [{ familyId: "family-primary", coverageRole: "required" }],
    rawAssessments: [{ ...validAssessment, familyId: "family-primary" }],
  }), /related_family_refs_invalid/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawRelatedFamilyIds: "family-a",
    rawAssessments: [],
  }), /related_family_refs_invalid/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawAssessments: { ...validAssessment },
  }), /related_family_assessment_refs_invalid/);
});

test("strict related-family contract preserves reference relations without using them as required coverage", () => {
  const result = validateRelatedFamilySuggestionsContract({
    validFamilyIds: ["family-reference"],
    rawRelatedFamilyIds: ["family-reference"],
    rawRelations: [{ familyId: "family-reference", coverageRole: "reference" }],
    rawAssessments: [{
      familyId: "family-reference",
      necessaryAfterDeletionTest: false,
      deletionTest: "去掉后仍可完成作答。",
      reason: "与本题存在稳定辨析关系，但不属于最小充分知识集。",
    }],
  });

  assert.deepEqual(result.relatedFamilyIds, ["family-reference"]);
  assert.deepEqual(result.requiredRelatedFamilyIds, []);
  assert.equal(result.assessments[0].coverageRole, "reference");
  assert.equal(result.assessments[0].accepted, true);
});

test("strict related-family contract rejects contribution knowledge on reference relations", () => {
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    validFamilyIds: ["family-reference"],
    rawRelatedFamilyIds: ["family-reference"],
    rawRelations: [{
      familyId: "family-reference",
      coverageRole: "reference",
      contributionKnowledgeNodeIds: ["knowledge-a"],
    }],
    rawAssessments: [{
      familyId: "family-reference",
      necessaryAfterDeletionTest: false,
      deletionTest: "去掉后仍可完成作答。",
      reason: "仅保留为参考关系。",
    }],
  }), /reference_family_contribution_forbidden/);
});

test("strict related-family contract requires one explicit coverage role per related family", () => {
  const base = {
    validFamilyIds: ["family-a"],
    rawRelatedFamilyIds: ["family-a"],
    rawAssessments: [{
      familyId: "family-a",
      necessaryAfterDeletionTest: true,
      deletionTest: "删除后不能作答。",
      reason: "独立参与判断。",
    }],
  };
  assert.throws(() => validateRelatedFamilySuggestionsContract(base), /related_family_relation_missing/);
  assert.throws(() => validateRelatedFamilySuggestionsContract({
    ...base,
    rawRelations: [{ familyId: "family-a", coverageRole: "other" }],
  }), /related_family_relation_invalid/);
});
