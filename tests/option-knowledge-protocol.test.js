const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  OPTION_KNOWLEDGE_PROTOCOL_VERSION,
  validateFeatureProfileContract,
} = require("../apps/api/src/question-classification-features");

const fixturePath = path.join(__dirname, "fixtures", "option-knowledge-protocol-v2-samples.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("isolated V2 protocol samples cover every agreed relation and composition mode", () => {
  assert.equal(fixture.purpose, "protocol_only");
  assert.equal(fixture.includedInModelAccuracy, false);
  assert.equal(fixture.sourceBatchId, null);
  assert.equal(fixture.optionKnowledgeProtocolVersion, OPTION_KNOWLEDGE_PROTOCOL_VERSION);
  fixture.samples.forEach((sample) => {
    assert.equal(validateFeatureProfileContract(sample.profile, sample.question), sample.profile, sample.id);
  });
  const categories = new Set(fixture.samples.map((sample) => sample.category));
  ["all_question_only", "all_option_specific", "mixed", "composed_options", "composed_all_above", "undetermined"]
    .forEach((category) => assert.equal(categories.has(category), true, category));
  assert.equal(fixture.samples.some((sample) => sample.profile.atomicStatements?.length >= 3), true);
  assert.equal(fixture.samples.some((sample) => sample.question.options.some((option) => /all statements above/i.test(option.text))), true);
});

test("protocol samples never overlap the formal 20-question gold batch", () => {
  assert.equal(fixture.samples.every((sample) => sample.id.startsWith("protocol-")
    && sample.question.id === sample.id), true);
  assert.equal(new Set(fixture.samples.map((sample) => sample.id)).size, fixture.samples.length);
});
