const markTypeAliases = {
  underline: "underline",
  single_underline: "underline",
  "下划线": "underline",
  double_underline: "double_underline",
  double: "double_underline",
  "双下划线": "double_underline",
  wave: "wave",
  wavy: "wave",
  "波浪线": "wave",
  dot: "dot",
  emphasis: "dot",
  "加点": "dot",
  "着重号": "dot",
};

function normalizeMaterialMarks(value) {
  return (Array.isArray(value) ? value : []).slice(0, 12).map((mark) => {
    const rawType = String(mark && (mark.type || mark.markType) || "").trim();
    const type = markTypeAliases[rawType.toLowerCase()] || markTypeAliases[rawType];
    const text = String(mark && (mark.text || mark.targetText || mark.content) || "").trim().slice(0, 4000);
    const occurrence = Math.max(1, Math.min(20, Number(mark && mark.occurrence) || 1));
    return type && text ? { type, text, occurrence } : null;
  }).filter(Boolean);
}

function inferMaterialMarks(value = {}) {
  const explicit = normalizeMaterialMarks(value.materialMarks);
  if (explicit.length) return explicit;
  const material = String(value.material || "");
  const stem = String(value.stem || "");
  let type = "";
  if (/双下划线/.test(stem)) type = "double_underline";
  else if (/波浪线/.test(stem)) type = "wave";
  else if (/下划线/.test(stem)) type = "underline";
  else if (/加点|着重号/.test(stem)) type = "dot";
  if (!type || !/(?:材料中|句中|词语|字词|加点|着重号)/.test(stem)) return [];
  const quoted = [...stem.matchAll(/[“"]([^”"]{1,4000})[”"]/g)]
    .map((match) => match[1].trim())
    .filter((text) => text && material.includes(text))
    .sort((left, right) => right.length - left.length)[0];
  const annotationText = String(value.annotationText || "").trim();
  const text = quoted || (annotationText && material.includes(annotationText) ? annotationText : "");
  return text ? [{ type, text, occurrence: 1 }] : [];
}

function materialMarkTypesFromStem(stem) {
  const text = String(stem || "");
  const types = [];
  if (/双下划线/.test(text)) types.push("double_underline");
  if (/波浪线/.test(text)) types.push("wave");
  if (/加点|着重号/.test(text)) types.push("dot");
  if (/下划线/.test(text.replace(/双下划线/g, ""))) types.push("underline");
  return [...new Set(types)];
}

function materialMarksForQuestion(question = {}) {
  const marks = normalizeMaterialMarks(question.materialMarks);
  const expectedTypes = materialMarkTypesFromStem(question.stem);
  if (expectedTypes.length) return marks.filter((mark) => expectedTypes.includes(mark.type));
  const uniqueTypes = [...new Set(marks.map((mark) => mark.type))];
  return uniqueTypes.length <= 1 ? marks : [];
}

function materialMarkIndex(material, target, occurrence = 1) {
  let fromIndex = 0;
  let found = -1;
  for (let index = 0; index < occurrence; index += 1) {
    found = material.indexOf(target, fromIndex);
    if (found < 0) return -1;
    fromIndex = found + target.length;
  }
  return found;
}

function formatMaterialWithMarks(material, marks) {
  const text = String(material || "");
  const labels = {
    underline: "下划线",
    double_underline: "双下划线",
    wave: "波浪线",
    dot: "加点",
  };
  const ranges = normalizeMaterialMarks(marks).map((mark) => {
    const start = materialMarkIndex(text, mark.text, mark.occurrence);
    return start >= 0 ? { ...mark, start, end: start + mark.text.length } : null;
  }).filter(Boolean).sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce((accepted, range) => {
      if (!accepted.some((item) => range.start < item.end && range.end > item.start)) accepted.push(range);
      return accepted;
    }, []);
  if (!ranges.length) return text;
  let cursor = 0;
  const output = [];
  ranges.forEach((range) => {
    if (range.start > cursor) output.push(text.slice(cursor, range.start));
    const label = labels[range.type];
    output.push(`【${label}开始】${text.slice(range.start, range.end)}【${label}结束】`);
    cursor = range.end;
  });
  output.push(text.slice(cursor));
  return output.join("");
}

module.exports = {
  formatMaterialWithMarks,
  inferMaterialMarks,
  materialMarksForQuestion,
  materialMarkTypesFromStem,
  normalizeMaterialMarks,
};
