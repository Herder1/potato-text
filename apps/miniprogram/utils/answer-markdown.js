function textNode(text) {
  return { type: "text", text: String(text || "") };
}

function formatAnswerInlineNodes(value) {
  const source = String(value || "");
  const nodes = [];
  const pattern = /\*\*([^*\n]+)\*\*/g;
  let cursor = 0;
  let match = pattern.exec(source);
  while (match) {
    if (match.index > cursor) nodes.push(textNode(source.slice(cursor, match.index)));
    nodes.push({ name: "strong", children: [textNode(match[1])] });
    cursor = match.index + match[0].length;
    match = pattern.exec(source);
  }
  if (cursor < source.length) nodes.push(textNode(source.slice(cursor)));
  return nodes.length ? nodes : [textNode(source)];
}

function formatAnswerMarkdownNodes(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const nodes = [];
  lines.forEach((line, index) => {
    if (index) nodes.push({ name: "br" });
    nodes.push(...formatAnswerInlineNodes(line));
  });
  return nodes;
}

function stripAnswerMarkdown(value) {
  return String(value || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*\*/g, "");
}

module.exports = { formatAnswerMarkdownNodes, stripAnswerMarkdown };
