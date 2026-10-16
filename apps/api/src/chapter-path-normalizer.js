// 题目 `chapter` 文本 → 「目录路径写法」的**唯一匹配实现**。
//
// 背景（2026-09-27）：题目录入稿里的章节写法五花八门——`第四章语法 > 第二节词类（上） > 二、实词`、
// `第二章 文字·第二节 汉字的形体·二、汉字形体的演变`——而知识树节点的 `path` 是统一写法
// （`语法 > 词类(上) > 实词`）。写法不一致会让知识指纹匹配不上（题目知识点在树里"找不到节点"）。
//
// 三条硬规矩（都是为"改库安全"服务的）：
//   1. **逐段下钻、段数必须全中**：章节的每一段都要在目录里按层级找到对应节点，少一段就返回 null。
//      绝不允许"降级成更浅的节点"——`第一单元·文选：左传·晋灵公不君` 找不到后两段时，
//      不能改写成 `第一单元`（那是丢信息，不是归一）。
//   2. **只在能对上时改**：对不上就保持原样，让界面照旧报"知识点在知识树里没有对应节点"。
//   3. **序号与括号差异不算差异**：目录路径里不带「第四章」「二、」，所以比对前统一去掉序号前缀、
//      去空格、统一括号与顿号。

// 比对用的压缩形式：去空白、去序号前缀（「第四章」「二、」「(四)」「1.」）、去括号内容、统一标点、转小写。
function compactChapterSegment(value) {
  return String(value || "")
    .replace(/[\s　]/g, "")
    .replace(/^第[一二三四五六七八九十百零〇\d]+[章节编讲单元部分篇]/u, "")
    // 「二、」「(四)」「1.」这类**段内**序号：目录路径里不带，比对前一律去掉。
    .replace(/^[（(]?[一二三四五六七八九十百零〇\d]+[)）]?[、.．·]?/u, "")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/[、，,：:；;]/g, "")
    .toLowerCase();
}

// 章节文本 → 段数组。分隔符用 `·`／`>`／`／`／`/`／`\`／`|`；**`；` 不当作分隔符**，
// 因为那通常表示"这道题同时考两处"（多章节引用），应由人工处理而不是机械拆开。
function splitChapterSegments(value) {
  return String(value || "")
    .split(/[·・>／/\\|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// 返回该册目录里所有节点的 path（只取有 path 的）。
function catalogPaths(nodes = []) {
  return nodes.map((node) => String(node.path || "").trim()).filter(Boolean);
}

// 在 parentPath（空串＝顶层）的直接子节点里找与 segment 对应的那个。
function matchChildPath(paths, parentPath, segment) {
  const wanted = compactChapterSegment(segment);
  if (!wanted) return null;
  const children = paths.filter((item) => (parentPath
    ? item.startsWith(`${parentPath} > `) && !item.slice(parentPath.length + 3).includes(" > ")
    : !item.includes(" > ")));
  const exact = children.find((item) => compactChapterSegment(item.split(" > ").pop()) === wanted);
  if (exact) return exact;
  return children.find((item) => {
    const title = compactChapterSegment(item.split(" > ").pop());
    return title && (title.includes(wanted) || wanted.includes(title));
  }) || null;
}

// 主入口：把 chapter 归一到目录路径写法。
// 返回 { path, segments } 或 null（null＝保持原样，调用方不得自行降级）。
function normalizeChapterToCatalogPath(chapter, nodes = []) {
  const text = String(chapter || "").trim();
  if (!text) return null;
  const paths = catalogPaths(nodes);
  if (!paths.length) return null;
  // 已经是目录里的某个路径：原样返回（幂等，便于"改过就不再改"）。
  if (paths.includes(text)) return { path: text, segments: splitChapterSegments(text), alreadyNormalized: true };
  const segments = splitChapterSegments(text);
  if (!segments.length) return null;
  let currentPath = null;
  for (const segment of segments) {
    const hit = matchChildPath(paths, currentPath || "", segment);
    if (!hit) return null;
    currentPath = hit;
  }
  if (!currentPath || currentPath === text) return null;
  return { path: currentPath, segments, alreadyNormalized: false };
}

module.exports = {
  compactChapterSegment,
  normalizeChapterToCatalogPath,
  splitChapterSegments,
};
