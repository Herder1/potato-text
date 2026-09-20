const test = require("node:test");
const assert = require("node:assert/strict");

global.Page = () => {};
global.getApp = () => ({ globalData: {} });
global.wx = {};

const { buildMaterialSegments } = require("../apps/miniprogram/pages/practice/practice");
const { formatMaterialWithMarks, materialMarksForQuestion } = require("../apps/api/src/material-mark");

test("practice material renders each original line style on its exact target", () => {
  const material = "普通句。下划线句。双下划线句。波浪线句。推动发展。";
  const display = buildMaterialSegments({
    material,
    materialMarks: [
      { type: "underline", text: "下划线句。" },
      { type: "double_underline", text: "双下划线句。" },
      { type: "wave", text: "波浪线句。" },
      { type: "dot", text: "推动" },
    ],
  });
  assert.equal(display.segments.map((segment) => segment.text).join(""), material);
  assert.deepEqual(display.segments.filter((segment) => segment.type !== "plain").map((segment) => segment.type), [
    "underline",
    "double_underline",
    "wave",
    "dot",
  ]);
  assert.deepEqual(display.legend.map((item) => item.label), ["下划线", "双下划线", "波浪线", "加点"]);
});

test("each shared-material subquestion sends only its own marked text to AI", () => {
  const material = "下划线句。双下划线句。推动发展。波浪线句。";
  const sharedMarks = [
    { type: "underline", text: "下划线句。" },
    { type: "double_underline", text: "双下划线句。" },
    { type: "dot", text: "推动" },
    { type: "wave", text: "波浪线句。" },
  ];
  const questionMarks = materialMarksForQuestion({
    stem: "请分析材料中下划线的句子。",
    materialMarks: sharedMarks,
  });
  assert.deepEqual(questionMarks, [{ type: "underline", text: "下划线句。", occurrence: 1 }]);
  assert.equal(
    formatMaterialWithMarks(material, questionMarks),
    "【下划线开始】下划线句。【下划线结束】双下划线句。推动发展。波浪线句。",
  );
});

test("double underline never falls through to the single-underline subquestion", () => {
  const questionMarks = materialMarksForQuestion({
    stem: "分析双下划线复句中的层次和关系。",
    materialMarks: [
      { type: "underline", text: "第一句" },
      { type: "double_underline", text: "第二句" },
    ],
  });
  assert.deepEqual(questionMarks, [{ type: "double_underline", text: "第二句", occurrence: 1 }]);
});
