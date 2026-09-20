const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CARD_ASSISTANCE_SCHEMA_VERSION,
  MAX_ANSWER_LENGTH,
  MAX_CLOZE_RAW_LENGTH,
  MAX_HIGHLIGHT_RAW_LENGTH,
  MAX_MNEMONIC_LENGTH,
  buildCardAssistancePromptPoints,
  buildCardAssistanceSource,
  normalizeCardAssistanceOutput,
  sourceDigest,
} = require("../apps/api/src/card-assistance");

function reference(quote, occurrence = 0) {
  return { quote, occurrence };
}

function concept(id, pointId, highlight, clozes, role = "direct_answer") {
  return {
    id,
    pointId,
    role,
    highlight: typeof highlight === "string" ? reference(highlight) : highlight,
    clozes: clozes.map((cloze) => typeof cloze === "string" ? reference(cloze) : cloze),
  };
}

function modelOutput(concepts, mnemonic = {}) {
  return {
    schemaVersion: CARD_ASSISTANCE_SCHEMA_VERSION,
    concepts,
    mnemonic: {
      text: mnemonic.text || "抓住核心，依次记忆",
      conceptIds: mnemonic.conceptIds || concepts.map((item) => item.id),
    },
  };
}

function repeatedBody(length, seed = "文") {
  return seed.repeat(length);
}

test("prompt points expose v2 effective lengths and per-point generation budgets without offsets", () => {
  const crlfAnswer = "1.第一分点\r\n2.第二分点😀\r\n";
  const normalizedAnswer = "1.第一分点\n2.第二分点😀";
  const points = buildCardAssistancePromptPoints(crlfAnswer);

  assert.equal(CARD_ASSISTANCE_SCHEMA_VERSION, 2);
  assert.deepEqual(points.map(({ id, text, effectiveLength }) => ({ id, text, effectiveLength })), [
    { id: "p1", text: "1.第一分点", effectiveLength: 4 },
    { id: "p2", text: "2.第二分点😀", effectiveLength: 4 },
  ]);
  assert.deepEqual(points[0].targetHighlights, {
    min: 1,
    max: 1,
    minCoverage: 0,
    maxCoverage: 1,
    singleContentChars: { min: 1, max: 4 },
    singleRawCharsMax: MAX_HIGHLIGHT_RAW_LENGTH,
  });
  assert.deepEqual(points[0].targetClozes, {
    min: 1,
    max: 2,
    minCoverage: 0,
    maxCoverage: 1,
    singleContentChars: { min: 1, max: 4 },
    singleRawCharsMax: MAX_CLOZE_RAW_LENGTH,
  });
  assert.equal(Object.hasOwn(points[0], "start"), false);

  assert.equal(sourceDigest("问题", crlfAnswer), sourceDigest("问题", normalizedAnswer));
  assert.match(sourceDigest("问题", crlfAnswer), /^[a-f0-9]{64}$/u);

  const source = buildCardAssistanceSource("问题\r\n", crlfAnswer);
  assert.equal(source.version, 2);
  assert.equal(source.question, "问题");
  assert.equal(source.answer, normalizedAnswer);
  assert.deepEqual(source.points, points);
  assert.equal(source.sourceDigest, sourceDigest("问题", normalizedAnswer));
});

test("point budgets scale concept minimums and coverage limits with effective length", () => {
  const lengths = [8, 9, 25, 60, 120];
  const points = lengths.map((length) => buildCardAssistancePromptPoints(`1.${repeatedBody(length)}`)[0]);

  assert.deepEqual(points.map((point) => point.targetHighlights.min), [1, 1, 2, 3, 4]);
  assert.deepEqual(points.map((point) => point.targetHighlights.max), [1, 2, 4, 6, 8]);
  assert.deepEqual(points.map((point) => point.targetHighlights.maxCoverage), [1, .55, .4, .32, .28]);
  assert.deepEqual(points.map((point) => point.targetClozes.maxCoverage), [1, .45, .3, .25, .22]);
  assert.deepEqual(points.map((point) => point.targetHighlights.minCoverage), [0, .12, .1, .1, .1]);
  assert.deepEqual(points.map((point) => point.targetClozes.minCoverage), [0, .1, .08, .08, .08]);
});

test("repeated quotes are located by zero-based occurrence inside their point", () => {
  const answer = "1.语言是交际工具，语言也是思维工具。";
  const output = modelOutput([
    concept("language-2", "p1", reference("语言", 1), ["语言"]),
  ]);

  const result = normalizeCardAssistanceOutput(output, { question: "语言的作用？", answer });
  const expectedStart = answer.lastIndexOf("语言");
  assert.deepEqual(result.highlights, [{
    conceptId: "language-2",
    pointId: "p1",
    role: "direct_answer",
    start: expectedStart,
    end: expectedStart + "语言".length,
    text: "语言",
  }]);
  assert.deepEqual(result.clozes, result.highlights);
});

test("cloze occurrences are resolved inside the selected highlight quote", () => {
  const answer = "1.工具使语言成为工具，随后形成稳定体系并用于清晰表达。";
  const highlight = "工具使语言成为工具";
  const result = normalizeCardAssistanceOutput(modelOutput([
    concept("second-tool", "p1", highlight, [reference("工具", 1)], "definition"),
    concept("direct", "p1", "稳定体系", ["稳定体系"], "direct_answer"),
  ]), { question: "说明作用", answer });

  const highlightStart = answer.indexOf(highlight);
  const clozeStart = highlightStart + highlight.lastIndexOf("工具");
  assert.equal(result.clozes[0].start, clozeStart);
  assert.equal(result.clozes[0].end, clozeStart + 2);
  assert.equal(result.clozes[0].text, "工具");
});

test("the same quote in different points is scoped by pointId while every point remains covered", () => {
  const answer = "1.语言具有交际功能。\n2.语言具有思维功能。";
  const result = normalizeCardAssistanceOutput(modelOutput([
    concept("communication", "p1", "语言", ["语言"]),
    concept("thinking", "p2", "语言", ["语言"]),
  ]), { question: "语言有什么功能？", answer });

  assert.equal(result.highlights[1].start, answer.lastIndexOf("语言"));
  assert.equal(result.highlights[1].pointId, "p2");
});

test("ranges use JavaScript UTF-16 offsets after CRLF normalization", () => {
  const sourceAnswer = "1.😀语言是工具。\r\n2.记忆😀重点。\r\n";
  const normalizedAnswer = "1.😀语言是工具。\n2.记忆😀重点。";
  const output = modelOutput([
    concept("emoji-language", "p1", "语言", ["语言"]),
    concept("emoji-key", "p2", "重点", ["重点"]),
  ]);
  const result = normalizeCardAssistanceOutput(output, { question: "😀问题", answer: sourceAnswer });

  assert.deepEqual(result.highlights.map(({ start, end, text, pointId }) => ({ start, end, text, pointId })), [
    {
      start: normalizedAnswer.indexOf("语言"),
      end: normalizedAnswer.indexOf("语言") + "语言".length,
      text: "语言",
      pointId: "p1",
    },
    {
      start: normalizedAnswer.indexOf("重点"),
      end: normalizedAnswer.indexOf("重点") + "重点".length,
      text: "重点",
      pointId: "p2",
    },
  ]);
  assert.equal(result.clozes[0].start, normalizedAnswer.indexOf("语言"));
  assert.equal(result.clozes[1].start, normalizedAnswer.indexOf("重点"));
});

test("one concept accepts one or two clozes and preserves their exact ranges", () => {
  const answer = "1.普通话以北京语音作为共同标准并服务全国语言交流。";
  const highlight = "北京语音作为共同标准";
  const result = normalizeCardAssistanceOutput(modelOutput([
    concept("standard", "p1", highlight, ["北京语音", "共同标准"], "definition"),
    concept("direct", "p1", "交流", ["交流"], "direct_answer"),
  ]), { question: "普通话标准是什么？", answer });

  const standardClozes = result.clozes.filter((item) => item.conceptId === "standard");
  assert.deepEqual(standardClozes.map((item) => item.text), ["北京语音", "共同标准"]);
  assert.ok(standardClozes.every((item) => item.start >= result.highlights[0].start));
  assert.ok(standardClozes.every((item) => item.end <= result.highlights[0].end));

  const singularCloze = modelOutput([
    {
      id: "legacy",
      pointId: "p1",
      role: "direct_answer",
      highlight: reference("北京语音"),
      cloze: reference("北京语音"),
    },
  ]);
  assert.throws(
    () => normalizeCardAssistanceOutput(singularCloze, { question: "标准", answer }),
    /provider_output_format_error/u,
  );
});

test("schema version, role enum, and one direct_answer per point are mandatory", () => {
  const answer = "1.语言是人类最重要的交际工具。";
  const valid = concept("language", "p1", "交际工具", ["交际"]);

  assert.throws(
    () => normalizeCardAssistanceOutput({ ...modelOutput([valid]), schemaVersion: 1 }, { question: "定义", answer }),
    /provider_output_format_error/u,
  );
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([{ ...valid, role: "keyword" }]), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([{ ...valid, role: "definition" }]), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
});

test("a cloze outside its highlight is rejected instead of trusting model offsets", () => {
  const output = modelOutput([
    concept("invalid-cloze", "p1", "共同交际工具", ["语言"]),
  ]);

  assert.throws(
    () => normalizeCardAssistanceOutput(output, { question: "定义", answer: "1.语言是共同交际工具。" }),
    /provider_output_format_error/u,
  );
});

test("highlight and cloze ranges may not overlap within a point", () => {
  const answer = "1.双轨制度与轨制度之间形成明显差异并长期并存。";
  const overlappingHighlights = modelOutput([
    concept("double", "p1", "双轨制度", ["双轨"], "direct_answer"),
    concept("system", "p1", "轨制度", ["制度"], "contrast"),
  ]);
  assert.throws(
    () => normalizeCardAssistanceOutput(overlappingHighlights, { question: "说明差异", answer }),
    /provider_output_format_error/u,
  );

  const clozeAnswer = "1.普通话以北京语音作为共同标准并服务全国语言交流。";
  const overlappingClozes = modelOutput([
    concept("standard", "p1", "北京语音作为共同标准", ["北京语音", "语音作为"]),
  ]);
  assert.throws(
    () => normalizeCardAssistanceOutput(overlappingClozes, { question: "标准", answer: clozeAnswer }),
    /provider_output_format_error/u,
  );
});

test("direct answers and supporting highlights may be fully clozed within point budgets", () => {
  const answer = "1.普通话以北京语音作为共同标准并服务全国语言交流。";
  const directAnswer = normalizeCardAssistanceOutput(modelOutput([
    concept("direct", "p1", "北京语音", ["北京语音"], "direct_answer"),
  ]), { question: "标准", answer });
  assert.equal(directAnswer.clozes[0].text, "北京语音");

  const shortAnswer = "1.现代学校教育制度包括双轨制。";
  const shortResult = normalizeCardAssistanceOutput(modelOutput([
    concept("dual-system", "p1", "双轨制", ["双轨"], "direct_answer"),
  ]), { question: "学校教育制度的类型？", answer: shortAnswer });
  assert.equal(shortResult.clozes[0].text, "双轨制", "a short direct answer keeps its complete concept suffix");

  const longAnswer = `1.普通话以北京语音作为共同标准并服务全国语言交流${repeatedBody(30)}。`;
  const fullSupportingPhrase = normalizeCardAssistanceOutput(modelOutput([
    concept("all-hidden", "p1", "北京语音作为共同标准", ["北京语音作为共同标准"], "definition"),
    concept("direct", "p1", "普通话", ["普通话"], "direct_answer"),
  ]), { question: "标准", answer: longAnswer });
  assert.equal(fullSupportingPhrase.clozes[1].text, "北京语音作为共同标准");

  const splitSupportingPhrase = normalizeCardAssistanceOutput(modelOutput([
    concept("two-cues", "p1", "北京语音作为共同标准", ["北京语音", "作为共同标准"], "definition"),
    concept("direct", "p1", "普通话", ["普通话"], "direct_answer"),
  ]), { question: "标准", answer: longAnswer });
  assert.deepEqual(splitSupportingPhrase.clozes.map((range) => range.text), ["普通话", "北京语音", "作为共同标准"]);
});

test("short generic clozes expand to the complete key phrase and long generic clozes are rejected", () => {
  const shortAnswer = "1.所有学生在同一系统中学习并相互衔接，形成连续的学校教育体系。";
  const expanded = normalizeCardAssistanceOutput(modelOutput([
    concept("students", "p1", "所有学生", ["所有"], "direct_answer"),
    concept("connection", "p1", "相互衔接", ["相互"], "relation"),
  ]), { question: "单轨制有什么特点？", answer: shortAnswer });
  assert.deepEqual(expanded.clozes.map((item) => item.text), ["所有学生", "相互衔接"]);

  const longHighlight = "介于双轨制度和单轨制度两者之间";
  const longAnswer = `1.分支制度是${longHighlight}的学制形式${repeatedBody(30)}。`;
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("branch", "p1", "分支制度", ["分支制度"], "direct_answer"),
      concept("between", "p1", longHighlight, ["介于", "双轨制度"], "relation"),
    ]), { question: "分支制是什么？", answer: longAnswer }),
    /provider_output_format_error/u,
  );
});

test("medium-short points reject a token highlight that is too sparse to guide review", () => {
  const answer = `1.甲项${repeatedBody(22)}`;
  assert.equal(buildCardAssistancePromptPoints(answer)[0].effectiveLength, 24);
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("sparse", "p1", "甲项", ["甲项"], "direct_answer"),
    ]), { question: "说明主要内容", answer }),
    /provider_output_format_error/u,
  );
});

test("whole-point highlights and excessive per-point coverage are rejected", () => {
  const answer = "1.现代教育制度强调公平普及与多元发展。";
  const wholeBody = "现代教育制度强调公平普及与多元发展";
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("whole", "p1", wholeBody, ["现代教育"]),
    ]), { question: "特点", answer }),
    /provider_output_format_error/u,
  );
});

test("long points reject sparse highlights and sparse clozes by positional union", () => {
  const oneHundredCharacterAnswer = `1.甲类乙项丙点${repeatedBody(94)}`;
  const sparseHighlights = modelOutput([
    concept("a", "p1", "甲类", ["甲类"], "direct_answer"),
    concept("b", "p1", "乙项", ["乙项"], "definition"),
    concept("c", "p1", "丙点", ["丙点"], "conclusion"),
  ]);
  assert.equal(buildCardAssistancePromptPoints(oneHundredCharacterAnswer)[0].effectiveLength, 100);
  assert.throws(
    () => normalizeCardAssistanceOutput(sparseHighlights, { question: "分类", answer: oneHundredCharacterAnswer }),
    /provider_output_format_error/u,
  );

  const labels = ["甲类定义", "乙类条件", "丙类关系", "丁类结论"];
  const oneHundredFortyAnswer = `1.${labels.join("")}${repeatedBody(124)}`;
  const sparseClozes = modelOutput(labels.map((label, index) => concept(
    `item-${index}`,
    "p1",
    label,
    [label.slice(0, 2)],
    index === 0 ? "direct_answer" : ["definition", "condition", "relation"][index - 1],
  )));
  assert.equal(buildCardAssistancePromptPoints(oneHundredFortyAnswer)[0].effectiveLength, 140);
  assert.throws(
    () => normalizeCardAssistanceOutput(sparseClozes, { question: "说明", answer: oneHundredFortyAnswer }),
    /provider_output_format_error/u,
  );
});

test("every point is covered and concept counts obey the length-based minimum and maximum", () => {
  const twoPoints = "1.语言具有交际功能。\n2.语言具有思维功能。";
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("only-first", "p1", "交际", ["交际"]),
    ]), { question: "功能", answer: twoPoints }),
    /provider_output_format_error/u,
  );

  const twentyFiveAnswer = `1.甲类定义乙类条件${repeatedBody(17)}`;
  assert.equal(buildCardAssistancePromptPoints(twentyFiveAnswer)[0].effectiveLength, 25);
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("only-one", "p1", "甲类定义", ["甲类"]),
    ]), { question: "说明", answer: twentyFiveAnswer }),
    /provider_output_format_error/u,
  );

  const fortyAnswer = `1.甲类乙类丙类丁类戊类${repeatedBody(30)}`;
  assert.equal(buildCardAssistancePromptPoints(fortyAnswer)[0].effectiveLength, 40);
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("a", "p1", "甲类", ["甲类"], "direct_answer"),
      concept("b", "p1", "乙类", ["乙类"], "definition"),
      concept("c", "p1", "丙类", ["丙类"], "condition"),
      concept("d", "p1", "丁类", ["丁类"], "relation"),
      concept("e", "p1", "戊类", ["戊类"], "conclusion"),
    ]), { question: "说明", answer: fortyAnswer }),
    /provider_output_format_error/u,
  );
});

test("quotes obey content-character, raw-length, marker, punctuation, and boundary rules", () => {
  const shortAnswer = "1.甲乙丙丁。";
  const shortResult = normalizeCardAssistanceOutput(modelOutput([
    concept("single", "p1", "甲", ["甲"]),
  ]), { question: "短答案", answer: shortAnswer });
  assert.equal(shortResult.highlights[0].text, "甲");

  const longerAnswer = "1.甲乙丙丁戊己庚辛壬。";
  [
    concept("single", "p1", "甲", ["甲"]),
    concept("numbering", "p1", "1.甲乙", ["甲乙"]),
    concept("punctuation", "p1", "甲乙。", ["甲乙"]),
    concept("boundary", "p1", "甲乙，", ["甲乙"]),
  ].forEach((invalidConcept) => {
    assert.throws(
      () => normalizeCardAssistanceOutput(modelOutput([invalidConcept]), { question: "规则", answer: longerAnswer }),
      /provider_output_format_error/u,
    );
  });

  const oversizedHighlightAnswer = `1.${repeatedBody(MAX_HIGHLIGHT_RAW_LENGTH + 4)}`;
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([
      concept("long-highlight", "p1", repeatedBody(MAX_HIGHLIGHT_RAW_LENGTH + 1), ["文文"]),
    ]), { question: "规则", answer: oversizedHighlightAnswer }),
    /provider_output_format_error/u,
  );
});

test("unknown points, concept references, occurrences, and invalid cloze counts are rejected", () => {
  const answer = "1.语言是交际工具。";
  const baseConcept = concept("language", "p1", "语言", ["语言"]);

  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([{ ...baseConcept, pointId: "p2" }]), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([{
      ...baseConcept,
      highlight: reference("语言", 1),
    }]), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([baseConcept], { conceptIds: ["invented"] }), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([{ ...baseConcept, clozes: [] }]), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput([{
      ...baseConcept,
      clozes: [reference("语言"), reference("交际"), reference("工具")],
    }]), { question: "定义", answer }),
    /provider_output_format_error/u,
  );
});

test("empty or oversized model results fail with provider_output_format_error", () => {
  const context = { question: "定义", answer: "1.语言是交际工具。" };
  assert.throws(
    () => normalizeCardAssistanceOutput({
      schemaVersion: 2,
      concepts: [],
      mnemonic: { text: "口诀", conceptIds: [] },
    }, context),
    /provider_output_format_error/u,
  );

  const validConcept = concept("language", "p1", "语言", ["语言"]);
  assert.throws(
    () => normalizeCardAssistanceOutput(modelOutput(
      [validConcept],
      { text: "诀".repeat(MAX_MNEMONIC_LENGTH + 1) },
    ), context),
    /provider_output_format_error/u,
  );
});

test("source text has an explicit upper bound before it reaches a provider", () => {
  assert.throws(
    () => buildCardAssistanceSource("问题", "答".repeat(MAX_ANSWER_LENGTH + 1)),
    /card_assistance_source_too_long/u,
  );
});

test("normalized ranges are sorted by source position while mnemonic references stay explicit", () => {
  const answer = "1.先记甲重点。\n2.再记乙重点。";
  const output = modelOutput([
    concept("second", "p2", "乙重点", ["重点"]),
    concept("first", "p1", "甲重点", ["重点"]),
  ], { text: "甲乙两点", conceptIds: ["first", "second"] });

  const result = normalizeCardAssistanceOutput(output, "怎么记？", answer);
  assert.deepEqual(result.highlights.map((range) => range.conceptId), ["first", "second"]);
  assert.deepEqual(result.clozes.map((range) => range.conceptId), ["first", "second"]);
  assert.deepEqual(result.mnemonic, { text: "甲乙两点", conceptIds: ["first", "second"] });
});
