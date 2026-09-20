const test = require("node:test");
const assert = require("node:assert/strict");
const { computeFamilyRelations } = require("../apps/api/src/question-family-relations");

function family(id, overrides = {}) {
  return {
    id,
    name: id,
    bookId: "modern-chinese-7-1",
    status: "confirmed",
    coreKnowledgeNodeId: `${id}-core`,
    requiredKnowledgeNodeIds: [`${id}-core`],
    textbookAnchorNodeIds: [`${id}-anchor`],
    assessmentAction: "分类判断",
    inclusionBoundary: "",
    exclusionBoundary: "",
    members: [],
    ...overrides,
  };
}

test("family relations derive prerequisites, shared cases and cross-chapter links without editing family sets", () => {
  const prerequisite = family("basic", { coreKnowledgeNodeId: "basic-core" });
  const target = family("target", {
    coreKnowledgeNodeId: "target-core",
    requiredKnowledgeNodeIds: ["target-core", "basic-core"],
    textbookAnchorNodeIds: ["chapter-a"],
    members: [{ questionId: "q-cross" }],
  });
  const related = family("related", {
    coreKnowledgeNodeId: "related-core",
    requiredKnowledgeNodeIds: ["related-core", "basic-core"],
    textbookAnchorNodeIds: ["chapter-b"],
    members: [{ questionId: "q-cross" }],
  });
  const relations = computeFamilyRelations(target, [target, prerequisite, related]);
  assert.equal(relations.some((item) => item.type === "prerequisite" && item.familyId === prerequisite.id), true);
  assert.equal(relations.some((item) => item.type === "shared_case" && item.familyId === related.id), true);
  assert.equal(relations.some((item) => item.type === "cross_chapter" && item.familyId === related.id), true);
});

test("same family semantics surface a duplicate risk while different actions remain similar", () => {
  const target = family("target", { coreKnowledgeNodeId: "same", inclusionBoundary: "判断声带是否振动" });
  const duplicate = family("duplicate", { coreKnowledgeNodeId: "same", inclusionBoundary: "判断声带是否振动" });
  const sibling = family("sibling", { coreKnowledgeNodeId: "same", assessmentAction: "例证辨析" });
  const relations = computeFamilyRelations(target, [target, duplicate, sibling]);
  assert.equal(relations.some((item) => item.type === "possible_duplicate" && item.familyId === duplicate.id), true);
  assert.equal(relations.some((item) => item.type === "similar" && item.familyId === sibling.id), true);
});

test("shared-case relations only count confirmed member relationships", () => {
  const target = family("target", {
    members: [
      { questionId: "q-confirmed", reviewStatus: "confirmed" },
      { questionId: "q-pending", reviewStatus: "pending_fit" },
      { questionId: "q-inactive", reviewStatus: "inactive" },
    ],
  });
  const related = family("related", {
    members: [
      { questionId: "q-confirmed", reviewStatus: "confirmed" },
      { questionId: "q-pending", reviewStatus: "confirmed" },
      { questionId: "q-inactive", reviewStatus: "confirmed" },
    ],
  });
  const pendingOnly = family("pending-only", {
    members: [{ questionId: "q-pending", reviewStatus: "confirmed" }],
  });

  const relations = computeFamilyRelations(target, [target, related, pendingOnly]);
  assert.match(relations.find((item) => item.type === "shared_case" && item.familyId === related.id).reason, /1 道/);
  assert.equal(relations.some((item) => item.type === "shared_case" && item.familyId === pendingOnly.id), false);
});
