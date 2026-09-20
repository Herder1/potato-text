const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLOZE_COLOR,
  plainTextToHtml,
  plainTextToDelta,
  deltaText,
  answerSegmentsFromDelta,
  applyAttributesToRanges,
  splitAnswerPoints,
  buildHintLines,
  buildHintText,
  generateMnemonic,
} = require("../apps/miniprogram/utils/card-rich-content");

function makeMarkedCard(answer, phrases, id = "hint-card") {
  const ranges = phrases.map((phrase) => {
    const start = answer.lastIndexOf(phrase);
    assert.notEqual(start, -1, `fixture phrase ${phrase} must exist in the answer`);
    return { start, end: start + phrase.length };
  });
  const answerDelta = applyAttributesToRanges(
    plainTextToDelta(answer),
    ranges,
    { underline: true, color: CLOZE_COLOR },
  );
  return {
    id,
    answer,
    answerDelta,
    answerSegments: answerSegmentsFromDelta(answerDelta),
  };
}

function visibleText(line) {
  return (line.parts || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assertLineCoversBody(line, body) {
  const source = Array.from(body);
  const visibleIndexes = [];
  const restoredParts = [];
  let cursor = 0;
  let previousType = "";

  assert.ok(Array.isArray(line.parts), "a hint line exposes renderable parts");
  line.parts.forEach((part) => {
    assert.ok(part.type === "text" || part.type === "gap", "parts use only text and gap types");
    assert.notEqual(part.type === "gap" && previousType === "gap", true, "adjacent hidden runs are merged");
    assert.equal(typeof part.text, "string", "every part carries its corresponding source text");
    restoredParts.push(part.text);
    if (part.type === "gap") {
      assert.ok(Number.isInteger(part.hiddenLength) && part.hiddenLength > 0, "a gap records its source length");
      const hiddenChars = Array.from(part.text);
      assert.equal(hiddenChars.length, part.hiddenLength, "gap text length matches hiddenLength");
      assert.equal(hiddenChars.join(""), source.slice(cursor, cursor + hiddenChars.length).join(""), "gap text preserves the hidden source range");
      cursor += hiddenChars.length;
    } else {
      assert.ok(part.text, "empty text parts are omitted");
      const textChars = Array.from(part.text);
      assert.equal(textChars.join(""), source.slice(cursor, cursor + textChars.length).join(""), "visible text keeps its source position");
      textChars.forEach((_, offset) => visibleIndexes.push(cursor + offset));
      cursor += textChars.length;
    }
    previousType = part.type;
  });
  assert.equal(cursor, source.length, "text and gaps together cover the complete point body");
  assert.equal(restoredParts.join(""), body, "concatenating every part text restores the exact point body");
  return visibleIndexes;
}

function assertSubset(left, right, message) {
  const rightSet = new Set(right);
  assert.ok(left.every((value) => rightSet.has(value)), message);
}

function isEffectiveChar(char) {
  return Boolean(char) && /[\u3400-\u9fffA-Za-z0-9]/u.test(char);
}

function effectiveVisibleIndexes(body, visibleIndexes) {
  const chars = Array.from(body);
  return visibleIndexes.filter((index) => isEffectiveChar(chars[index]));
}

function effectiveCharCount(body) {
  return Array.from(body).filter(isEffectiveChar).length;
}

function hasVisibleContentRun(body, visibleIndexes, wantedLength) {
  const visible = new Set(visibleIndexes);
  let run = 0;
  for (let index = 0; index < Array.from(body).length; index += 1) {
    if (!isEffectiveChar(Array.from(body)[index])) continue;
    run = visible.has(index) ? run + 1 : 0;
    if (run >= wantedLength) return true;
  }
  return false;
}

function clozeContextIndexes(body, phrases) {
  const chars = Array.from(body);
  const effective = chars.map((char, index) => isEffectiveChar(char) ? index : -1).filter((index) => index >= 0);
  const allowed = new Set();
  phrases.forEach((phrase) => {
    const phraseChars = Array.from(phrase);
    const start = chars.findIndex((_, index) => chars.slice(index, index + phraseChars.length).join("") === phrase);
    assert.ok(start >= 0, `fixture phrase ${phrase} must exist in the point body`);
    const end = start + phraseChars.length;
    const selected = effective.filter((index) => index >= start && index < end);
    if (!selected.length) return;
    const firstIndex = effective.indexOf(selected[0]);
    const lastIndex = effective.indexOf(selected[selected.length - 1]);
    effective.slice(Math.max(0, firstIndex - 1), Math.min(effective.length, lastIndex + 2))
      .forEach((index) => allowed.add(index));
  });
  return [...allowed].sort((left, right) => left - right);
}

function makeSixPointBudgetCard(id = "six-point-budget") {
  const prefix = "教师引导学生观察思考积累知识培养能力形成习惯";
  const keyPhrases = ["天地玄黄", "宇宙洪荒", "日月盈昃", "辰宿列张", "寒来暑往", "秋收冬藏"];
  const bodies = keyPhrases.map((phrase) => `${prefix}${phrase}。`);
  const answer = bodies.map((body, index) => `${index + 1}.${body}`).join("\n");
  return { answer, bodies, keyPhrases, card: makeMarkedCard(answer, keyPhrases, id) };
}

test("legacy plain text is converted to editor HTML and Delta without losing line structure", () => {
  const text = "第一行 <重点>\r\n\r\n第二行\n";

  assert.equal(
    plainTextToHtml(text),
    "<p>第一行 &lt;重点&gt;</p><p><br></p><p>第二行</p>",
  );
  assert.deepEqual(plainTextToDelta(text), { ops: [{ insert: "第一行 <重点>\n\n第二行\n" }] });
});

test("Delta text and cloze segments are extracted while non-text embeds are ignored", () => {
  const delta = {
    ops: [
      { insert: "定义：" },
      { insert: "共同交际", attributes: { underline: true, color: "rgb(22, 143, 216)" } },
      { insert: { image: "example.png" } },
      { insert: "工具\n" },
    ],
  };

  assert.equal(deltaText(delta), "定义：共同交际工具");
  assert.deepEqual(answerSegmentsFromDelta(delta), [
    { text: "定义：", cloze: false },
    { text: "共同交际", cloze: true },
    { text: "工具", cloze: false },
  ]);
});

test("blue underlined ranges become cloze segments without discarding existing formatting", () => {
  const marked = applyAttributesToRanges(
    { ops: [{ insert: "语言是交际工具\n", attributes: { bold: true } }] },
    [{ start: 3, end: 7 }],
    { underline: true, color: CLOZE_COLOR },
  );

  assert.deepEqual(marked.ops, [
    { insert: "语言是", attributes: { bold: true } },
    { insert: "交际工具", attributes: { bold: true, underline: true, color: CLOZE_COLOR } },
    { insert: "\n", attributes: { bold: true } },
  ]);
  assert.deepEqual(answerSegmentsFromDelta(marked), [
    { text: "语言是", cloze: false },
    { text: "交际工具", cloze: true },
  ]);
});

test("first hint keeps only each point marker, source length, and terminal punctuation", () => {
  const answer = [
    "1.教师要引导学生学会观察，丰富学生的表象存储",
    "2.教师要积极引导学习思考，打开学生想象力的大门",
    "3.教师要引导学生努力学习科学文化知识，扩大学生的知经以发展学生的空间想象能力",
    "4.教师要注意发展学生的语言能力",
    "5.教师要结合科学教学，有目的地训练学生的想象力",
    "6.教师要引导学生进行积极的幻想",
  ].join("\n");
  const phrases = ["表象存储", "想象力的大门", "空间想象能力", "语言能力", "想象力", "积极的幻想"];
  const card = makeMarkedCard(answer, phrases, "six-teaching-points");

  const lines = buildHintLines(card, 1);
  assert.deepEqual(splitAnswerPoints(answer), answer.split("\n"));
  assert.equal(new Set(lines.map((line) => line.key)).size, 6, "each render line has a stable unique key");
  assert.deepEqual(lines.map((line) => line.marker), ["1.", "2.", "3.", "4.", "5.", "6."]);
  assert.deepEqual(lines.map(visibleText), ["", "", "", "", "", ""]);
  lines.forEach((line, index) => {
    const body = answer.split("\n")[index].slice(2);
    assertLineCoversBody(line, body);
    assert.equal(line.parts.filter((part) => part.type === "gap").length, 1, "the remaining continuous hidden body is one gap");
  });

  const safeTailCard = makeMarkedCard("1.甲中间重点内容乙", ["重点内容"], "safe-tail");
  assert.equal(visibleText(buildHintLines(safeTailCard, 1)[0]), "", "boundary characters never leak from a point without punctuation");
  const duplicateBoundaryCard = makeMarkedCard("1.教甲乙重点内容丙丁教", ["重点内容"], "duplicate-boundary");
  assert.equal(visibleText(buildHintLines(duplicateBoundaryCard, 1)[0]), "", "matching boundary characters remain hidden too");
});

test("first hint preserves sentence-ending punctuation when the final content character is protected", () => {
  const endings = ["。", "！", "？", "；", ".", "!", "?"];
  const phrases = ["重点甲", "重点乙", "重点丙", "重点丁", "重点戊", "重点己", "重点庚"];
  const bodies = endings.map((ending, index) => `首部内容${phrases[index]}${ending}`);
  const answer = bodies.map((body, index) => `${index + 1}.${body}`).join("\n");
  const lines = buildHintLines(makeMarkedCard(answer, phrases, "ending-punctuation"), 1);

  assert.deepEqual(lines.map(visibleText), endings);
  lines.forEach((line, index) => assertLineCoversBody(line, bodies[index]));

  const highlightedAnswer = "1.首部内容重点辛。";
  const highlightStart = highlightedAnswer.indexOf("重点辛");
  const highlightDelta = applyAttributesToRanges(
    plainTextToDelta(highlightedAnswer),
    [{ start: highlightStart, end: highlightStart + 3 }],
    { backgroundColor: "#fff0a8" },
  );
  const highlightedCard = {
    id: "highlighted-ending-punctuation",
    answer: highlightedAnswer,
    answerDelta: highlightDelta,
    answerSegments: answerSegmentsFromDelta(highlightDelta),
  };
  const highlightedLine = buildHintLines(highlightedCard, 1)[0];
  assert.equal(visibleText(highlightedLine), "。", "highlighted text follows the same punctuation-only rule");
  assertLineCoversBody(highlightedLine, highlightedAnswer.slice(2));
});

test("seeded second and third hints reveal stable neighboring windows and grow monotonically", () => {
  const body = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄";
  const answer = `1.${body}`;
  const card = makeMarkedCard(answer, [body], "fixed-seed-neighbor-windows");

  const first = buildHintLines(card, 1);
  const second = buildHintLines(card, 2);
  const secondAgain = buildHintLines(card, 2);
  const third = buildHintLines(card, 3);
  assert.deepEqual(secondAgain, second, "the same card and level always choose the same reveal positions");

  const firstVisible = assertLineCoversBody(first[0], body);
  const secondVisible = assertLineCoversBody(second[0], body);
  const thirdVisible = assertLineCoversBody(third[0], body);
  assert.equal(firstVisible.length, 0, "a boundary inside a cloze is not leaked by the first hint");
  assert.ok(secondVisible.length > 0 && secondVisible.length < body.length / 2, "the second hint reveals only a small portion");
  second[0].parts.filter((part) => part.type === "text").forEach((part) => {
    assert.ok(Array.from(part.text).length >= 3, "each seeded reveal includes a content character on both sides");
  });
  assertSubset(firstVisible, secondVisible, "the second hint preserves everything already visible");
  assertSubset(secondVisible, thirdVisible, "the third hint is a superset of the second");
  assert.ok(thirdVisible.length > secondVisible.length, "the third hint strictly reveals more content");
});

test("second and third hints stay inside each explicit cloze and its one-character context", () => {
  const { bodies, keyPhrases, card } = makeSixPointBudgetCard("per-point-formula-seed");
  const first = buildHintLines(card, 1);
  const second = buildHintLines(card, 2);
  const third = buildHintLines(card, 3);

  assert.deepEqual(buildHintLines(card, 1), first, "level 1 stays stable for the same card");
  assert.deepEqual(buildHintLines(card, 2), second, "level 2 stays stable for the same card");
  assert.deepEqual(buildHintLines(card, 3), third, "level 3 stays stable for the same card");

  bodies.forEach((body, index) => {
    const firstVisible = effectiveVisibleIndexes(body, assertLineCoversBody(first[index], body));
    const secondVisible = effectiveVisibleIndexes(body, assertLineCoversBody(second[index], body));
    const thirdVisible = effectiveVisibleIndexes(body, assertLineCoversBody(third[index], body));
    const secondNew = secondVisible.filter((position) => !firstVisible.includes(position));
    const allowed = clozeContextIndexes(body, [keyPhrases[index]]);

    assertSubset(firstVisible, secondVisible, `point ${index + 1}: level 2 preserves level 1`);
    assertSubset(secondVisible, thirdVisible, `point ${index + 1}: level 3 preserves level 2`);
    assert.ok(hasVisibleContentRun(body, secondNew, 3), `point ${index + 1}: level 2 adds a previous + center + next window`);
    assertSubset(secondVisible, allowed, `point ${index + 1}: level 2 never leaves the marked cloze context`);
    assert.ok(thirdVisible.length > secondVisible.length, `point ${index + 1}: level 3 strictly adds content`);
    assertSubset(thirdVisible, allowed, `point ${index + 1}: level 3 never leaves the marked cloze context`);
  });
});

test("all hint levels preserve identical source text and line-break foundations", () => {
  const { answer, bodies, card } = makeSixPointBudgetCard("stable-source-layout");
  const reconstructed = [1, 2, 3].map((level) => {
    const lines = buildHintLines(card, level);
    assert.deepEqual(lines.map((line) => line.parts.map((part) => part.text).join("")), bodies);
    return lines.map((line) => `${line.marker}${line.parts.map((part) => part.text).join("")}`).join("\n");
  });

  assert.deepEqual(reconstructed, [answer, answer, answer], "all three levels use the exact same characters and newline boundaries");
});

test("short points keep the three-character reveal window even when it exceeds the normal ratio", () => {
  const body = "甲乙丙丁戊。";
  const card = makeMarkedCard(`1.${body}`, ["甲乙丙丁戊"], "short-window-floor");
  const firstVisible = effectiveVisibleIndexes(body, assertLineCoversBody(buildHintLines(card, 1)[0], body));
  const secondVisible = effectiveVisibleIndexes(body, assertLineCoversBody(buildHintLines(card, 2)[0], body));
  const thirdVisible = effectiveVisibleIndexes(body, assertLineCoversBody(buildHintLines(card, 3)[0], body));
  const secondNew = secondVisible.filter((position) => !firstVisible.includes(position));

  assert.ok(hasVisibleContentRun(body, secondNew, 3));
  assert.ok(secondVisible.length / effectiveCharCount(body) > .25, "the hard three-character window may exceed the long-sentence budget");
  assertSubset(secondVisible, thirdVisible, "the short point remains monotonic");
  assert.ok(thirdVisible.length > secondVisible.length, "level 3 still adds content on a short point");
});

test("points with at most three effective characters may saturate at level 2", () => {
  const bodies = ["甲。", "乙丙。", "丁戊己。"];
  const phrases = ["甲", "乙丙", "丁戊己"];
  const answer = bodies.map((body, index) => `${index + 1}.${body}`).join("\n");
  const card = makeMarkedCard(answer, phrases, "saturated-short-points");
  const second = buildHintLines(card, 2);
  const third = buildHintLines(card, 3);

  bodies.forEach((body, index) => {
    const secondVisible = effectiveVisibleIndexes(body, assertLineCoversBody(second[index], body));
    const thirdVisible = effectiveVisibleIndexes(body, assertLineCoversBody(third[index], body));
    assert.equal(secondVisible.length, effectiveCharCount(body), `point ${index + 1}: level 2 reaches the three-character floor`);
    assert.deepEqual(thirdVisible, secondVisible, `point ${index + 1}: level 3 need not grow after full saturation`);
  });
});

test("one manual cloze prevents unmarked points from receiving invented reveal windows", () => {
  const { answer, bodies, keyPhrases } = makeSixPointBudgetCard("one-manual-cloze");
  const card = makeMarkedCard(answer, [keyPhrases[0]], "one-manual-cloze");
  const first = buildHintLines(card, 1);
  const second = buildHintLines(card, 2);

  bodies.forEach((body, index) => {
    const firstVisible = effectiveVisibleIndexes(body, assertLineCoversBody(first[index], body));
    const secondVisible = effectiveVisibleIndexes(body, assertLineCoversBody(second[index], body));
    if (index === 0) {
      const secondNew = secondVisible.filter((position) => !firstVisible.includes(position));
      assert.ok(hasVisibleContentRun(body, secondNew, 3), "the marked point receives a cloze context window");
      assertSubset(secondVisible, clozeContextIndexes(body, [keyPhrases[0]]), "the marked point stays inside its cloze context");
    } else {
      assert.deepEqual(secondVisible, firstVisible, `point ${index + 1}: an unmarked point remains hidden`);
    }
  });
});

test("a single-character cloze may saturate at level 2 without leaking elsewhere at level 3", () => {
  const body = "教师引导学生观察思考积累知识培养能力形成习惯甲。";
  const card = makeMarkedCard(`1.${body}`, ["甲"], "single-character-cloze");
  const firstVisible = effectiveVisibleIndexes(body, assertLineCoversBody(buildHintLines(card, 1)[0], body));
  const secondVisible = effectiveVisibleIndexes(body, assertLineCoversBody(buildHintLines(card, 2)[0], body));
  const thirdVisible = effectiveVisibleIndexes(body, assertLineCoversBody(buildHintLines(card, 3)[0], body));
  const secondNew = secondVisible.filter((position) => !firstVisible.includes(position));
  const allowed = clozeContextIndexes(body, ["甲"]);

  assert.ok(hasVisibleContentRun(body, secondNew, 2), "level 2 includes the available previous-character and cloze window");
  assertSubset(secondVisible, allowed, "level 2 is limited to the single-character cloze context");
  assertSubset(secondVisible, thirdVisible, "level 3 preserves the level 2 context");
  assert.deepEqual(thirdVisible, secondVisible, "level 3 does not reveal unrelated text after the allowed context is saturated");
});

test("legacy and unmarked cards preserve hint length without revealing invented content", () => {
  const answer = "1.语言是人类最重要的交际工具\n2.文字是记录语言的书写符号系统";
  const legacy = { id: "legacy-answer-only", answer };
  const migrated = {
    ...legacy,
    answerDelta: plainTextToDelta(answer),
    answerSegments: answerSegmentsFromDelta(plainTextToDelta(answer)),
  };

  [1, 2, 3].forEach((level) => {
    const legacyLines = buildHintLines(legacy, level);
    assert.deepEqual(legacyLines, buildHintLines(migrated, level));
    assert.equal(legacyLines.length, 2);
    legacyLines.forEach((line, index) => {
      const source = answer.split("\n")[index];
      const body = source.slice(line.marker.length);
      const rendered = assertLineCoversBody(line, body);
      assert.deepEqual(effectiveVisibleIndexes(body, rendered), []);
    });
  });

  assert.equal(typeof buildHintText(legacy, 2), "string", "the text compatibility wrapper remains available");
});

test("mnemonics take a short distinct keyword from each answer point", () => {
  assert.equal(
    generateMnemonic("1、以北京语音为标准音。2、以北方话为基础方言。3、以白话文著作为语法规范。"),
    "为标准音 · 基础方言 · 为语法规",
  );
});
