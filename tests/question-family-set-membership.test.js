const assert = require("node:assert/strict");
const test = require("node:test");
const { deriveQuestionFamilySets } = require("../apps/api/src/question-family-set-membership");

const sets = [
  { id: "root", name: "总集", directFamilyIds: [], parentSetId: "" },
  { id: "one", name: "第一集", directFamilyIds: ["primary", "related"], parentSetId: "root" },
  { id: "two", name: "第二集", directFamilyIds: ["other"], parentSetId: "root" },
];
const primary = { familyId: "primary", familyName: "主题族", isPrimary: true, familyStatus: "confirmed", reviewStatus: "confirmed" };
const related = { familyId: "related", familyName: "关联族", isPrimary: false, familyStatus: "confirmed", reviewStatus: "pending_fit" };
const other = { familyId: "other", familyName: "另一族", isPrimary: false, familyStatus: "pending_review", reviewStatus: "pending_fit" };

test("empty membership or a family without a set has no derived set", () => {
  assert.deepEqual(deriveQuestionFamilySets([], sets), []);
  assert.deepEqual(deriveQuestionFamilySets([primary], []), []);
});

test("one family includes its direct and ancestor sets, with confirmed provenance", () => {
  const result = deriveQuestionFamilySets([primary], sets);
  assert.deepEqual(result.map((item) => item.setId), ["one", "root"]);
  assert.equal(result[0].sources[0].relation, "direct");
  assert.equal(result[1].sources[0].relation, "ancestor");
  assert.equal(result[0].sources[0].status, "confirmed");
});

test("multiple families deduplicate shared sets and put the primary source first", () => {
  const result = deriveQuestionFamilySets([other, related, primary], sets);
  assert.deepEqual(result.map((item) => item.setId), ["one", "root", "two"]);
  assert.deepEqual(result[0].sources.map((item) => item.familyId), ["primary", "related"]);
  assert.deepEqual(result[0].sources.map((item) => item.status), ["confirmed", "pending"]);
  assert.equal(result[1].sources.length, 3);
});

test("changing or removing a family-set link changes the next read without changing membership", () => {
  const moved = sets.map((set) => ({ ...set, directFamilyIds: set.id === "one" ? ["related"] : (set.id === "two" ? ["primary", "other"] : []) }));
  assert.deepEqual(deriveQuestionFamilySets([primary], moved).map((item) => item.setId), ["two", "root"]);
  assert.deepEqual(deriveQuestionFamilySets([primary], moved.map((set) => ({ ...set, directFamilyIds: set.directFamilyIds.filter((id) => id !== "primary") }))), []);
  assert.deepEqual(deriveQuestionFamilySets([primary], sets).map((item) => item.setId), ["one", "root"]);
});

test("a pending or rejected relation never appears confirmed", () => {
  assert.equal(deriveQuestionFamilySets([related], sets)[0].sources[0].confirmed, false);
  assert.equal(deriveQuestionFamilySets([{ ...primary, reviewStatus: "inactive" }], sets)[0].sources[0].status, "inactive");
  const rejected = { ...related, familyStatus: "rejected" };
  assert.equal(deriveQuestionFamilySets([rejected], sets)[0].sources[0].status, "rejected");
});
