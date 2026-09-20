const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function searchFeatures(value) {
  const normalized = normalizeSearchText(value);
  const features = new Set();
  const compactChinese = normalized.replace(/[^\u3400-\u9fff]/g, "");
  for (let index = 0; index < compactChinese.length - 1; index += 1) {
    features.add(compactChinese.slice(index, index + 2));
  }
  normalized.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{1,4}/g)?.forEach((token) => features.add(token));
  return features;
}

function featureCosine(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  left.forEach((feature) => { if (right.has(feature)) intersection += 1; });
  return intersection / Math.sqrt(left.size * right.size);
}

function catalogNodesWithPaths(nodes) {
  const stack = [];
  const flattened = (Array.isArray(nodes) ? nodes : []).map((node) => {
    const level = Math.max(1, Number(node.level) || 1);
    stack.length = level - 1;
    stack[level - 1] = String(node.title || "").trim();
    return {
      ...node,
      level,
      startPage: Math.max(1, Number(node.startPage) || 1),
      endPage: Math.max(1, Number(node.endPage) || Number(node.startPage) || 1),
      path: stack.filter(Boolean).join(" > "),
    };
  });
  flattened.forEach((node, index) => {
    let descendantEnd = node.endPage;
    for (let cursor = index + 1; cursor < flattened.length; cursor += 1) {
      if (flattened[cursor].level <= node.level) break;
      descendantEnd = Math.max(descendantEnd, flattened[cursor].startPage, flattened[cursor].endPage);
    }
    node.endPage = descendantEnd;
  });
  return flattened;
}

function pageCatalogNode(nodes, printedPage) {
  const matches = nodes.filter((node) => printedPage >= node.startPage && printedPage <= node.endPage);
  return matches.sort((left, right) => (
    right.level - left.level
    || right.startPage - left.startPage
    || Number(right.order || 0) - Number(left.order || 0)
  ))[0] || null;
}

function median(values) {
  const ordered = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  return ordered[Math.floor(ordered.length / 2)];
}

function compactHeading(value) {
  return String(value || "").normalize("NFKC").replace(/[^\u3400-\u9fffa-z0-9]/gi, "").toLowerCase();
}

function matchesConfirmedCatalogTitle(line, nodes) {
  const title = compactHeading(line);
  if (!title) return false;
  return (Array.isArray(nodes) ? nodes : []).some((node) => compactHeading(node.title) === title);
}

function trustedCatalogPageOffset(pages, catalogNodes) {
  const structuredCandidates = [];
  const candidates = [];
  const headings = (Array.isArray(catalogNodes) ? catalogNodes : [])
    .filter((node) => Number(node.level) <= 3 && Number(node.startPage) > 0)
    .map((node) => ({ ...node, compactTitle: compactHeading(node.title) }))
    .filter((node) => node.compactTitle.length >= 4 && !/^(初版序言|前言|修订本后记|第三版后记)$/.test(String(node.title || "").trim()));
  (Array.isArray(pages) ? pages : []).forEach((page) => {
    const pdfPage = Number(page.pdfPage);
    const printedPage = Number(page.printedPage);
    if (!(pdfPage > 0)) return;
    const sourceTitles = (Array.isArray(page.sourceBlocks) ? page.sourceBlocks : [])
      .filter((block) => String(block && block.type || "") === "title")
      .map((block) => compactHeading(block && block.text))
      .filter(Boolean);
    headings.forEach((node) => {
      if (sourceTitles.includes(node.compactTitle)) {
        structuredCandidates.push(pdfPage - Number(node.startPage));
      }
    });
    if (!(printedPage > 0)) return;
    const compactText = compactHeading(page.text);
    const matched = headings.some((node) => Number(node.startPage) === printedPage && compactText.includes(node.compactTitle));
    if (matched) candidates.push(pdfPage - printedPage);
  });
  // MinerU title blocks distinguish real body headings from titles merely listed on
  // contents pages. Require two agreeing titles so a repeated running head cannot
  // override a valid locked offset by itself.
  const structuredCounts = new Map();
  structuredCandidates.forEach((offset) => {
    structuredCounts.set(offset, (structuredCounts.get(offset) || 0) + 1);
  });
  const structuredMatch = [...structuredCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  return (structuredMatch && structuredMatch[1] >= 2 ? structuredMatch[0] : null)
    ?? median(candidates);
}

function inferPrintedPages(pages, fallbackOffset = null, lockOffset = false) {
  const offsets = pages
    .filter((page) => Number(page.pdfPage) > 0 && Number(page.printedPage) > 0)
    .map((page) => Number(page.pdfPage) - Number(page.printedPage));
  const fixedOffset = Number.isFinite(Number(fallbackOffset)) ? Number(fallbackOffset) : null;
  const pageOffset = lockOffset && fixedOffset != null ? fixedOffset : (median(offsets) ?? fixedOffset);
  return {
    pageOffset,
    pages: pages.map((page) => {
      const pdfPage = Math.max(1, Number(page.pdfPage) || 1);
      let printedPage = Math.max(0, Number(page.printedPage) || 0);
      if (lockOffset && pageOffset != null && pdfPage > pageOffset) printedPage = pdfPage - pageOffset;
      else if (!printedPage && pageOffset != null && pdfPage > pageOffset) printedPage = pdfPage - pageOffset;
      return {
        ...page,
        pdfPage,
        printedPage,
        text: String(page.text || "")
          .replace(/\r/g, "")
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
        visuals: Array.isArray(page.visuals) ? page.visuals.map((visual) => ({
          type: String(visual && visual.type || "figure"),
          caption: String(visual && visual.caption || "").trim(),
        })) : [],
        confidence: Math.min(1, Math.max(0, Number(page.confidence) || 0)),
      };
    }),
  };
}

function joinWrappedLines(left, right) {
  const previous = String(left || "");
  const next = String(right || "");
  const needsSpace = (/[a-z0-9]$/i.test(previous) && /^[a-z0-9]/i.test(next))
    || /[］\]]$/.test(previous);
  return `${previous}${needsSpace ? " " : ""}${next}`;
}

const OCR_BLOCK_MARKERS = ["目的要求", "学习目标", "本节要点", "内容提要", "教学要求"];

function coalesceOcrMarkers(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const result = [];
  for (let index = 0; index < source.length; index += 1) {
    let compact = "";
    let matched = null;
    for (let end = index; end < Math.min(source.length, index + 4); end += 1) {
      compact += compactHeading(source[end]);
      const marker = OCR_BLOCK_MARKERS.find((item) => item === compact);
      if (marker) {
        matched = { marker, count: end - index + 1 };
        break;
      }
      if (!OCR_BLOCK_MARKERS.some((item) => item.startsWith(compact))) break;
    }
    if (!matched) {
      result.push(source[index]);
      continue;
    }
    result.push(`［${matched.marker}］`);
    index += matched.count - 1;
  }
  return result;
}

function structuralTextLine(line) {
  const value = String(line || "").trim();
  return bodyHeadingFromLine(value)
    || (/^(第[一二三四五六七八九十百]+[编章节]\s*\S|[一二三四五六七八九十]+[、 ]\S|绪论$|前言$|附录\b|［(?:目的要求|学习目标|本节要点|内容提要|教学要求)］$)/.test(value) ? value : "");
}

function reflowOcrText(text) {
  const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/);
  const paragraphs = [];
  blocks.forEach((block) => {
    const lines = coalesceOcrMarkers(block.split(/\n/)
      .map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean));
    let current = "";
    let currentIsStructural = false;
    lines.forEach((line) => {
      const structural = structuralTextLine(line);
      const currentIsMarker = /^［(?:目的要求|学习目标|本节要点|内容提要|教学要求)］$/.test(current);
      const startsNewParagraph = structural || currentIsStructural
        || (current.length >= 120 && /[。！？；]$/.test(current));
      if (current && startsNewParagraph) {
        if (currentIsMarker && !structural) {
          current = joinWrappedLines(current, line);
          currentIsStructural = false;
          return;
        }
        paragraphs.push(current);
        current = "";
        currentIsStructural = false;
      }
      current = current ? joinWrappedLines(current, line) : line;
      currentIsStructural = Boolean(structural);
    });
    if (current) paragraphs.push(current);
  });
  return paragraphs.join("\n\n").trim();
}

function sentenceUnits(text) {
  return String(text || "").match(/[^。！？；!?]+[。！？；!?]+|[^。！？；!?]+$/g)?.map((item) => item.trim()).filter(Boolean) || [];
}

function sentenceOverlap(text, maxChars) {
  if (Number(maxChars) <= 0) return "";
  const units = sentenceUnits(text);
  let suffix = "";
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const candidate = `${units[index]}${suffix}`;
    if (candidate.length > maxChars && suffix) break;
    suffix = candidate;
    if (suffix.length >= maxChars) break;
  }
  return suffix.length < String(text || "").length ? suffix : "";
}

function splitLongParagraph(paragraph, maxChars, overlapChars) {
  const units = sentenceUnits(paragraph);
  if (!units.length) return [];
  const chunks = [];
  let current = "";
  const commit = () => {
    if (!current) return;
    chunks.push(current);
    current = Number(overlapChars) > 0 ? sentenceOverlap(current, overlapChars) : "";
  };
  units.forEach((unit) => {
    if (unit.length > maxChars) {
      if (current) commit();
      let cursor = 0;
      while (cursor < unit.length) {
        const desiredEnd = Math.min(unit.length, cursor + maxChars);
        const window = unit.slice(cursor, desiredEnd);
        const boundary = Math.max(window.lastIndexOf("，"), window.lastIndexOf("、"), window.lastIndexOf("："));
        const end = boundary >= Math.floor(maxChars * 0.55) ? cursor + boundary + 1 : desiredEnd;
        chunks.push(unit.slice(cursor, end).trim());
        cursor = end;
      }
      current = "";
      return;
    }
    if (current && current.length + unit.length > maxChars) commit();
    if (current && current.length + unit.length > maxChars) current = "";
    current += unit;
  });
  if (current) chunks.push(current);
  return chunks;
}

function splitPageText(text, maxChars = 1200, overlapChars = 120) {
  const value = reflowOcrText(text);
  if (!value) return [];
  const paragraphs = value.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const commit = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = Number(overlapChars) > 0 ? sentenceOverlap(current, overlapChars) : "";
  };
  paragraphs.forEach((paragraph) => {
    if (paragraph.length > maxChars) {
      if (current) commit();
      chunks.push(...splitLongParagraph(paragraph, maxChars, overlapChars));
      current = "";
      return;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) commit();
    if (current && current.length + paragraph.length + 2 > maxChars) current = "";
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  });
  if (current.trim()) chunks.push(current.trim());
  return [...new Set(chunks.filter(Boolean))];
}

function bodyHeadingFromLine(line) {
  const value = String(line || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!value || value.length > 48 || /[。！？；]$/.test(value)) return "";
  if (!/^[（(]\s*[一二三四五六七八九十百零〇两]{1,4}\s*[）)]\s*\S.{1,40}$/.test(value)) return "";
  const marker = value.match(/^[（(]\s*[一二三四五六七八九十百零〇两]{1,4}\s*[）)]/)?.[0] || "";
  let title = value.slice(marker.length).trim();
  if (/^[（(、，,；;：:]/.test(title) || (title.match(/[、，]/g) || []).length >= 3) return "";
  for (let boundary = 2; boundary <= Math.min(16, title.length - 2); boundary += 1) {
    let repeated = false;
    for (let overlap = 2; overlap <= Math.min(6, boundary, title.length - boundary); overlap += 1) {
      if (title.slice(boundary - overlap, boundary) === title.slice(boundary, boundary + overlap)) {
        title = title.slice(0, boundary);
        repeated = true;
        break;
      }
    }
    if (repeated) break;
  }
  const joinedBody = title.match(/^(.{2,16}?)(?=社会(?:不断地|的发展)|普通话的调类系统|词义中|就是确定|是按.+划分|是构成)/);
  if (joinedBody) title = joinedBody[1];
  return `${marker.replace(/^\(/, "（").replace(/\)/, "）")}${title}`;
}

function bodyHeadingRemainder(line, heading) {
  const value = String(line || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const marker = value.match(/^\(\s*[一二三四五六七八九十百零〇两]{1,4}\s*\)/)?.[0] || "";
  const title = String(heading || "").replace(/^[（(]\s*[一二三四五六七八九十百零〇两]{1,4}\s*[）)]\s*/, "");
  const content = value.slice(marker.length).trim();
  return content.startsWith(title) ? content.slice(title.length).trim() : "";
}

const BODY_HEADING_ENDING = /(?:属性|概说|概述|分类|特点|作用|方法|关系|单位|系统|规范|构成|类型|原则|变化|发展|概念|方案)$/;

function repairCommonOutlineOrdinal(value) {
  const replacements = new Map([
    ["-", "一"], ["—", "一"], ["–", "一"],
    ["~", "二"], ["～", "二"], ["=", "二"],
    ["H", "三"], ["h", "三"], ["Ⅲ", "三"], ["III", "三"],
  ]);
  return String(value || "").replace(
    /[（(]\s*([-—–~～=HhⅢ]|III)\s*[）)]\s*([\u3400-\u9fff]{2,18})/g,
    (match, marker, title) => (BODY_HEADING_ENDING.test(title)
      ? `（${replacements.get(marker)}）${title}` : match),
  );
}

function coalesceBodyHeadingLines(lines) {
  const source = (Array.isArray(lines) ? lines : []).map((line) => String(line || "").trim());
  const result = [];
  for (let index = 0; index < source.length; index += 1) {
    let markerText = source[index];
    let markerEnd = index;
    let marker = markerText.match(/^[（(]\s*([-一二三四五六七八九十百零〇两—–~～=HhⅢ]|III)\s*[）)]$/);
    for (let cursor = index + 1; !marker && cursor < Math.min(source.length, index + 3); cursor += 1) {
      if (!source[cursor] || markerText.length + source[cursor].length > 8) break;
      markerText += source[cursor];
      markerEnd = cursor;
      marker = markerText.match(/^[（(]\s*([-一二三四五六七八九十百零〇两—–~～=HhⅢ]|III)\s*[）)]$/);
    }
    if (!marker) {
      result.push(repairCommonOutlineOrdinal(source[index]));
      continue;
    }
    let title = "";
    let end = markerEnd;
    for (let cursor = markerEnd + 1; cursor < Math.min(source.length, markerEnd + 9); cursor += 1) {
      const part = source[cursor];
      if (!part || /[。！？；：:]/.test(part) || !/^[\u3400-\u9fff]{1,8}$/.test(part)) break;
      title += part;
      end = cursor;
      if (title.length >= 2 && BODY_HEADING_ENDING.test(title)) break;
    }
    if (end > index && BODY_HEADING_ENDING.test(title)) {
      result.push(repairCommonOutlineOrdinal(`（${marker[1]}）${title}`));
      index = end;
    } else {
      result.push(repairCommonOutlineOrdinal(source[index]));
    }
  }
  return result;
}

function matchingCatalogHeading(line, candidates) {
  const compactLine = compactHeading(line);
  if (!compactLine) return null;
  return (Array.isArray(candidates) ? candidates : [])
    .map((node) => ({ node, compactTitle: compactHeading(node.title) }))
    .filter(({ compactTitle }) => compactTitle.length >= 3
      && compactLine.startsWith(compactTitle)
      && compactLine.length <= compactTitle.length + 4)
    .sort((left, right) => right.compactTitle.length - left.compactTitle.length
    || Number(right.node.level) - Number(left.node.level))[0]?.node || null;
}

function matchingCatalogHeadingSpan(lines, startIndex, candidates) {
  const source = Array.isArray(lines) ? lines : [];
  const choices = (Array.isArray(candidates) ? candidates : [])
    .map((node) => ({ node, compactTitle: compactHeading(node.title) }))
    .filter(({ compactTitle }) => compactTitle.length >= 2)
    .sort((left, right) => right.compactTitle.length - left.compactTitle.length
      || Number(right.node.level) - Number(left.node.level));
  let compact = "";
  for (let end = startIndex; end < Math.min(source.length, startIndex + 12); end += 1) {
    compact += compactHeading(source[end]);
    if (!compact) continue;
    const exact = choices.find(({ compactTitle }) => compactTitle === compact);
    if (exact) return { node: exact.node, count: end - startIndex + 1 };
    if (!choices.some(({ compactTitle }) => compactTitle.startsWith(compact))) break;
  }
  return null;
}

function edgeOcrArtifact(line) {
  return /^(?:[IVXLCDMⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[-—·•]+|\d{1,4})$/i.test(String(line || "").trim());
}

function editDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (a[leftIndex - 1] === b[rightIndex - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[b.length];
}

function removePrintedPageMarkers(lines) {
  const result = Array.isArray(lines) ? lines.slice() : [];
  const marker = (value) => /^[-—·•]$/.test(String(value || "").trim());
  for (let index = result.length - 2; index >= 1; index -= 1) {
    const nearPageEdge = index <= 10 || index >= result.length - 11;
    if (!nearPageEdge || !/^\d{1,4}$/.test(String(result[index] || "").trim())) continue;
    if (marker(result[index - 1]) && marker(result[index + 1])) result.splice(index - 1, 3);
  }
  while (result.length && String(result[result.length - 1] || "").trim() === "第") result.pop();
  return result;
}

function firstMeaningfulEdgeLine(lines, fromEnd = false) {
  const source = Array.isArray(lines) ? lines : [];
  const indexes = Array.from({ length: source.length }, (_, index) => index);
  if (fromEnd) indexes.reverse();
  for (const index of indexes) {
    const value = String(source[index] || "").trim();
    if (!value || edgeOcrArtifact(value)) continue;
    return { index, value };
  }
  return null;
}

function stripCrossPageFootnoteIntrusions(pages) {
  const source = (Array.isArray(pages) ? pages : []).map((page) => ({ ...page }));
  for (let pageIndex = 0; pageIndex < source.length - 1; pageIndex += 1) {
    const current = source[pageIndex];
    const next = source[pageIndex + 1];
    if (Number(current.pdfPage) + 1 !== Number(next.pdfPage)) continue;

    const lines = String(current.text || "").replace(/\r/g, "").split(/\n/)
      .map((line) => line.trim());
    const nextLines = removePrintedPageMarkers(String(next.text || "").replace(/\r/g, "").split(/\n/));
    const nextEdge = firstMeaningfulEdgeLine(nextLines);
    if (!nextEdge || !/^[\u3400-\u9fff]{1,3}$/.test(nextEdge.value)) continue;

    const minimumIndex = Math.floor(lines.length * 0.58);
    let footnoteStart = -1;
    for (let index = minimumIndex; index < lines.length; index += 1) {
      const value = String(lines[index] || "").trim();
      const startsFootnote = /^(?:[①-⑳]\s*)?\d{3,4}$/.test(value) || /^[①-⑳]/.test(value);
      if (!startsFootnote) continue;
      const previous = firstMeaningfulEdgeLine(lines.slice(0, index), true);
      if (!previous || !/^[\u3400-\u9fff]{1,3}$/.test(previous.value)) continue;
      const tail = lines.slice(index).join("");
      if (tail.length < 12 || tail.length > 220 || !/年/.test(tail)) continue;
      footnoteStart = index;
      break;
    }
    if (footnoteStart < 0) continue;

    const preserved = lines.slice(0, footnoteStart);
    while (preserved.length && !preserved[preserved.length - 1]) preserved.pop();
    current.text = preserved.join("\n").trim();
  }
  return source;
}

function stripOcrPageArtifacts(lines, contextNodes) {
  const result = removePrintedPageMarkers((Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim()));
  while (result.length && !result[0]) result.shift();
  while (result.length && !result[result.length - 1]) result.pop();
  while (result.length && edgeOcrArtifact(result[0])) result.shift();
  while (result.length && edgeOcrArtifact(result[result.length - 1])) result.pop();

  const titles = (Array.isArray(contextNodes) ? contextNodes : [])
    .map((node) => String(node && node.title || ""))
    .filter(Boolean);
  for (let count = Math.min(6, result.length); count >= 1; count -= 1) {
    const suffix = result.slice(-count).join("");
    const compactSuffix = compactHeading(suffix);
    const repeatedHeading = titles.some((title) => {
      const compactTitle = compactHeading(title);
      if (!compactTitle || compactSuffix.length < 2 || compactSuffix.length > compactTitle.length + 3) return false;
      if (compactSuffix === compactTitle) return true;
      if (compactSuffix.length >= 4 && compactTitle.length >= 4
        && compactSuffix.slice(-2) === compactTitle.slice(-2)
        && editDistance(compactSuffix, compactTitle)
          <= Math.max(1, Math.ceil(compactTitle.length * 0.25))) return true;
      if (compactSuffix.length <= 4 && compactTitle.length <= 4
        && compactSuffix[0] === compactTitle[0]
        && editDistance(compactSuffix, compactTitle) <= 1) return true;
      if (compactSuffix.length < 3 || compactTitle.length < 3) return false;
      const sharedPrefix = compactSuffix.slice(0, Math.min(3, compactSuffix.length))
        === compactTitle.slice(0, Math.min(3, compactTitle.length));
      if (sharedPrefix && editDistance(compactSuffix, compactTitle)
        <= Math.max(1, Math.ceil(compactTitle.length * 0.25))) return true;
      return sharedPrefix && featureCosine(searchFeatures(compactSuffix), searchFeatures(compactTitle)) >= 0.58;
    });
    if (repeatedHeading) {
      result.splice(result.length - count, count);
      break;
    }
  }
  while (result.length && edgeOcrArtifact(result[0])) result.shift();
  while (result.length && edgeOcrArtifact(result[result.length - 1])) result.pop();
  return result;
}

function catalogHeadingEdgeLength(value, titles, fromEnd = false) {
  const source = String(value || "");
  const candidates = (Array.isArray(titles) ? titles : [])
    .map(compactHeading).filter((title) => title.length >= 3);
  if (!source || !candidates.length) return 0;
  let best = { length: 0, score: 0 };
  const maximum = Math.min(28, source.length);
  for (let length = 2; length <= maximum; length += 1) {
    const raw = fromEnd ? source.slice(-length) : source.slice(0, length);
    const compact = compactHeading(raw);
    if (compact.length < 3) continue;
    candidates.forEach((title) => {
      if (Math.abs(compact.length - title.length) > 4) return;
      const similarity = 1 - (editDistance(compact, title) / Math.max(compact.length, title.length));
      const cosine = featureCosine(searchFeatures(compact), searchFeatures(title));
      const score = Math.max(similarity, cosine);
      if (score >= 0.56 && (score > best.score || (score === best.score && length < best.length))) {
        best = { length, score };
      }
    });
  }
  return best.length;
}

function stripInlinePageFurniture(text, printedPage, contextNodes) {
  let result = String(text || "");
  const page = Math.max(0, Number(printedPage) || 0);
  if (!result || !page) return result;
  const titles = (Array.isArray(contextNodes) ? contextNodes : [])
    .map((node) => String(node && node.title || "")).filter(Boolean);
  const stripMarkers = (pattern, requireNearbyHeading) => {
    let searchIndex = 0;
    let safety = 0;
    while (safety < 24) {
      safety += 1;
      pattern.lastIndex = searchIndex;
      const match = pattern.exec(result);
      if (!match) break;
      const left = result.slice(0, match.index);
      const right = result.slice(match.index + match[0].length);
      const leftHeadingLength = catalogHeadingEdgeLength(left, titles, true);
      const rightHeadingLength = catalogHeadingEdgeLength(right, titles, false);
      if (requireNearbyHeading && !leftHeadingLength && !rightHeadingLength) {
        searchIndex = match.index + match[0].length;
        continue;
      }
      result = `${left.slice(0, left.length - leftHeadingLength)}${right.slice(rightHeadingLength)}`;
      searchIndex = Math.max(0, match.index - leftHeadingLength);
    }
  };
  stripMarkers(new RegExp(`(?:[-—·•・]\\s*${page}\\s*[-—·•・.*]|${page}\\s*[-—·•・*])`, "g"), false);
  stripMarkers(/[·•—-](?:\s*[A-Za-z0-9]){1,4}\s*[·•—-]/g, true);
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function catalogLayoutKind(node) {
  const title = String(node && node.title || "").replace(/\s+/g, "");
  return /(?:表|图谱|示意图|一览图|结构图)$/.test(title) ? "table" : "text";
}

function embeddedVisualLayoutKind(text) {
  const compact = String(text || "").normalize("NFKC").replace(/\s+/g, "");
  const matches = [...compact.matchAll(/([表图])([一二三四五六七八九十百零〇0-9]{1,3})[-—~·・T]([一二三四五六七八九十百零〇0-9]{1,3})/g)];
  if (matches.some((match) => match[1] === "表")) return "mixed_table";
  if (matches.some((match) => match[1] === "图")) return "figure";
  if (/(?:示意图|波形图|舌位图|结构图|分布区域图)/.test(compact)) return "figure";
  if (/(?:总表|简表|对照表|结构表|比较表|矩阵表|示例表|音节表|字母表(?!示)|笔形表|部首表|韵辙表)/.test(compact)) return "mixed_table";
  const tableHeaderGroups = [
    ["字母", "名称"],
    ["发音方法", "发音部位"],
    ["声母", "韵母", "例字"],
    ["调类", "调值"],
    ["韵头", "韵腹", "韵尾"],
    ["基本笔形", "例字"],
    ["语素种类", "结构类型"],
  ];
  return tableHeaderGroups.some((headers) => headers.every((header) => compact.includes(header)))
    ? "mixed_table" : "text";
}

function figureSafeEvidenceText(text) {
  return String(text || "")
    .replace(/(?:[A-Z]\s*[（(][^（）()\n]{2,28}[）)]\s*)?图\s*[一二三四五六七八九十\d]{1,3}\s*[-－—]\s*[一二三四五六七八九十\d]{1,3}\s*[^。！？；\n]{0,36}?(?:示意图|波形图|舌位图|结构图|分布区域图)(?:\s*[（(][^（）()\n]{2,64}[）)])?/g, "")
    .replace(/\b(?=[A-Za-z]{5,}\b)(?=(?:[A-Za-z]*[A-Z]){2})(?=[A-Za-z]*[a-z])[A-Za-z]+\b/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function figureOcrWarnings(text, layoutKind) {
  if (layoutKind !== "figure") return [];
  const value = String(text || "");
  const warnings = ["visual_region_present"];
  if (/\b(?=[A-Za-z]{5,}\b)(?=(?:[A-Za-z]*[A-Z]){2})(?=[A-Za-z]*[a-z])[A-Za-z]+\b/.test(value)
    || /[彳亻卞广]{2,}.{0,4}[A-Z]/.test(value)) warnings.push("visual_text_interleaving");
  return warnings;
}

function repairCrossPageSentenceBreaks(chunks) {
  const source = Array.isArray(chunks) ? chunks : [];
  for (let index = 1; index < source.length; index += 1) {
    const previous = source[index - 1];
    const current = source[index];
    const adjacentPages = Number(previous.pdfPageEnd) + 1 === Number(current.pdfPageStart);
    const sameSection = previous.catalogNodeId && previous.catalogNodeId === current.catalogNodeId
      && String(previous.bodyHeadingId || "") === String(current.bodyHeadingId || "");
    if (!adjacentPages || !sameSection || /[。！？；!?]$/.test(String(previous.text || "").trim())) continue;

    const previousText = String(previous.text || "").trim();
    const boundary = Math.max(
      previousText.lastIndexOf("。"),
      previousText.lastIndexOf("！"),
      previousText.lastIndexOf("？"),
      previousText.lastIndexOf("；"),
      previousText.lastIndexOf("!"),
      previousText.lastIndexOf("?"),
    );
    const prefix = previousText.slice(0, boundary + 1).trim();
    const rawContinuation = previousText.slice(boundary + 1);
    const continuation = rawContinuation.trim();
    if (!prefix || !continuation || continuation.length > 100
      || /^\s*\n\s*\n/.test(rawContinuation)
      || /【(?:插图|图表|图片)，?待人工核对】/.test(continuation)
      || /^［(?:目的要求|学习目标|本节要点|内容提要|教学要求)］/.test(String(current.text || ""))) continue;

    previous.text = prefix;
    current.text = `${continuation}${String(current.text || "").trimStart()}`;
    current.pdfPageStart = previous.pdfPageEnd;
    current.printedPageStart = previous.printedPageEnd;
  }
  return source.filter((chunk) => String(chunk.text || "").trim());
}

function refreshChunkRetrievalMetadata(chunks) {
  return (Array.isArray(chunks) ? chunks : []).map((chunk) => {
    const sourceBlockTypes = Array.isArray(chunk.sourceBlockTypes) ? chunk.sourceBlockTypes : [];
    const mineruLayoutKind = sourceBlockTypes.includes("table") ? "table"
      : (sourceBlockTypes.some((type) => type === "image" || type === "chart") ? "figure"
        : embeddedVisualLayoutKind(chunk.text));
    // Cross-page repair can move text after layoutKind was first assigned.
    // Recompute MinerU chunks from their final text and exact source blocks.
    const layoutKind = chunk.sourceProvider === "mineru"
      ? mineruLayoutKind
      : String(chunk.layoutKind || "text");
    const ocrWarnings = [...new Set([
      ...(Array.isArray(chunk.ocrWarnings) ? chunk.ocrWarnings : []),
      ...figureOcrWarnings(chunk.text, layoutKind),
    ].filter((warning) => warning !== "table_structure_review"
      || sourceBlockTypes.includes("table")))];
    const sourceReviewRequired = ocrWarnings.some((warning) => [
      "visual_text_interleaving", "visual_without_caption", "table_structure_review",
    ].includes(warning));
    return {
      ...chunk,
      layoutKind,
      retrievalText: layoutKind === "figure" ? figureSafeEvidenceText(chunk.text) : chunk.text,
      retrievalEnabled: chunk.retrievalEnabled !== false && !sourceReviewRequired,
      ocrReviewRequired: ocrWarnings.length > 0,
      ocrWarnings,
    };
  });
}

function catalogNodeAllowsBodyOutline(node) {
  return Boolean(node) && !/^(附录|初版序言|前言|修订本后记|第三版后记|思考和练习|练习|教学提示|目的要求)/.test(String(node.title || "").trim());
}

function sourceBlockTextKey(value) {
  return normalizeSearchText(value).replace(/[^\u3400-\u9fffa-z0-9]/gi, "");
}

function normalizeTableRows(value) {
  return (Array.isArray(value) ? value : []).slice(0, 200).map((row) => (
    (Array.isArray(row) ? row : []).slice(0, 50).map((cell) => String(cell || "").trim().slice(0, 1000))
  )).filter((row) => row.length);
}

function normalizeTableStructure(value) {
  return (Array.isArray(value) ? value : []).slice(0, 200).map((row) => (
    (Array.isArray(row) ? row : []).slice(0, 50).map((cell) => ({
      text: String(cell && cell.text || "").trim().slice(0, 1000),
      rowspan: Math.min(50, Math.max(1, Number(cell && cell.rowspan) || 1)),
      colspan: Math.min(50, Math.max(1, Number(cell && cell.colspan) || 1)),
    }))
  )).filter((row) => row.length);
}

function matchingSourceBlocks(page, text) {
  const chunkKey = sourceBlockTextKey(text);
  if (!chunkKey) return [];
  return (Array.isArray(page && page.sourceBlocks) ? page.sourceBlocks : []).filter((block) => {
    const blockKey = sourceBlockTextKey(block && block.text);
    if (!blockKey) return false;
    if (chunkKey.includes(blockKey) || blockKey.includes(chunkKey)) return true;
    const probeLength = Math.min(28, blockKey.length, chunkKey.length);
    return probeLength >= 8 && (chunkKey.includes(blockKey.slice(0, probeLength))
      || blockKey.includes(chunkKey.slice(0, probeLength)));
  });
}

function unionBboxes(blocks) {
  const boxes = (Array.isArray(blocks) ? blocks : []).map((block) => block && block.bbox)
    .filter((bbox) => Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite));
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((bbox) => bbox[0])),
    Math.min(...boxes.map((bbox) => bbox[1])),
    Math.max(...boxes.map((bbox) => bbox[2])),
    Math.max(...boxes.map((bbox) => bbox[3])),
  ];
}

function structuredChunkMetadata(page, text) {
  const blocks = matchingSourceBlocks(page, text);
  const types = [...new Set(blocks.map((block) => String(block.type || "paragraph")))];
  // page.sourceWarnings aggregates every block on the page. Applying it here
  // makes a table warning leak into unrelated paragraphs below the table.
  const warnings = [...new Set(blocks.flatMap((block) => (
    Array.isArray(block.warnings) ? block.warnings : []
  )))];
  return {
    sourceProvider: String(page && page.sourceProvider || ""),
    sourcePdfPage: Math.max(1, Number(page && page.pdfPage) || 1),
    sourcePrintedPage: Math.max(0, Number(page && page.printedPage) || 0),
    sourceBlockIds: blocks.map((block) => String(block.id || "")).filter(Boolean),
    sourceBlockTypes: types,
    sourceBbox: unionBboxes(blocks),
    sourcePageSize: Array.isArray(page && page.pageSize) ? page.pageSize.slice(0, 2) : [],
    sourceImagePaths: [...new Set(blocks.flatMap((block) => Array.isArray(block.imagePaths) ? block.imagePaths : []))],
    sourceTableCaption: String(blocks.find((block) => block.tableCaption)?.tableCaption || ""),
    sourceTableFootnote: String(blocks.find((block) => block.tableFootnote)?.tableFootnote || ""),
    sourceTableStructure: normalizeTableStructure(blocks.find((block) => Array.isArray(block.tableStructure) && block.tableStructure.length)?.tableStructure || []),
    sourceTableRows: normalizeTableRows(blocks.find((block) => Array.isArray(block.tableRows) && block.tableRows.length)?.tableRows || []),
    sourceWarnings: warnings,
  };
}

function sourceTitleHeading(page, line) {
  const compactLine = compactHeading(line);
  if (!compactLine || String(line || "").length > 60 || /[。！？；?]$/.test(String(line || "").trim())) return "";
  const matched = (Array.isArray(page && page.sourceBlocks) ? page.sourceBlocks : [])
    .find((block) => block.type === "title" && compactHeading(block.text) === compactLine);
  return matched ? String(line || "").trim() : "";
}

function bodyHeadingId(bookId, catalogNodeId, title) {
  return `knowledge-outline-${crypto.createHash("sha256")
    .update(`${bookId}\n${catalogNodeId}\n${compactHeading(title)}`)
    .digest("hex").slice(0, 20)}`;
}

function outlineNodesFromChunks(chunks) {
  const nodes = new Map();
  (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
    if (!chunk.bodyHeadingId || !chunk.bodyHeading) return;
    const current = nodes.get(chunk.bodyHeadingId);
    const printedPage = Math.max(0, Number(chunk.printedPageStart) || 0);
    const pdfPage = Math.max(1, Number(chunk.pdfPageStart) || 1);
    if (!current) {
      nodes.set(chunk.bodyHeadingId, {
        id: chunk.bodyHeadingId,
        parentId: String(chunk.catalogNodeId || ""),
        level: Math.max(2, Number(chunk.bodyHeadingLevel) || 4),
        title: String(chunk.bodyHeading),
        path: String(chunk.catalogPath),
        startPage: printedPage,
        endPage: printedPage,
        pdfPageStart: pdfPage,
        pdfPageEnd: pdfPage,
        source: "body_heading",
      });
      return;
    }
    if (printedPage > 0) {
      current.startPage = current.startPage > 0 ? Math.min(current.startPage, printedPage) : printedPage;
      current.endPage = Math.max(current.endPage, printedPage);
    }
    current.pdfPageStart = Math.min(current.pdfPageStart, pdfPage);
    current.pdfPageEnd = Math.max(current.pdfPageEnd, pdfPage);
  });
  return [...nodes.values()].sort((left, right) => left.pdfPageStart - right.pdfPageStart
    || left.startPage - right.startPage
    || left.title.localeCompare(right.title, "zh-CN"));
}

function chunkId(bookId, page, index, text) {
  return `knowledge-chunk-${crypto.createHash("sha256")
    .update(`${bookId}\n${page.pdfPage}\n${page.printedPage}\n${index}\n${text}`)
    .digest("hex").slice(0, 24)}`;
}

function buildKnowledgeChunks({ bookId, bookTitle, pages, catalogNodes, pageOffset, pageOffsetLocked = false }) {
  const detectedOffset = trustedCatalogPageOffset(pages, catalogNodes);
  const trustedOffset = detectedOffset ?? (pageOffsetLocked ? Number(pageOffset) : null);
  const inferred = inferPrintedPages(
    Array.isArray(pages) ? pages : [],
    trustedOffset ?? pageOffset,
    pageOffsetLocked || trustedOffset != null,
  );
  if (trustedOffset != null) inferred.pageOffset = trustedOffset;
  const offsetLocked = pageOffsetLocked || trustedOffset != null;
  const nodes = catalogNodesWithPaths(catalogNodes);
  const nodesByStartPage = new Map();
  nodes.forEach((node) => {
    const startPage = Number(node.startPage);
    if (!nodesByStartPage.has(startPage)) nodesByStartPage.set(startPage, []);
    nodesByStartPage.get(startPage).push(node);
  });
  const chunks = [];
  const processingPages = stripCrossPageFootnoteIntrusions(inferred.pages);
  let activeCatalogNode = null;
  let activeBodyHeading = null;
  processingPages.slice().sort((left, right) => left.pdfPage - right.pdfPage).forEach((page) => {
    const matchesBodyPagination = !offsetLocked
      || (page.printedPage > 0 && page.pdfPage - page.printedPage === inferred.pageOffset);
    if (!matchesBodyPagination || !page.printedPage) {
      activeCatalogNode = null;
      activeBodyHeading = null;
    } else if (!activeCatalogNode
      || page.printedPage < Number(activeCatalogNode.startPage)
      || page.printedPage > Number(activeCatalogNode.endPage)) {
      activeCatalogNode = pageCatalogNode(nodes, page.printedPage);
      activeBodyHeading = null;
    }

    const pageCatalogCandidates = matchesBodyPagination
      ? (nodesByStartPage.get(Number(page.printedPage)) || [])
      : [];
    const structuredSegments = [];
    let segmentLines = [];
    const commitSegment = () => {
      const text = segmentLines.join("\n").trim();
      segmentLines = [];
      if (!text) return;
      const compactText = compactHeading(text);
      const headingOnly = compactText === compactHeading(activeBodyHeading && activeBodyHeading.title)
        || compactText === compactHeading(activeCatalogNode && activeCatalogNode.title);
      if (!headingOnly) structuredSegments.push({
        text,
        catalogNode: activeCatalogNode,
        bodyHeading: activeBodyHeading,
      });
    };

    const pageContextNodes = nodes.filter((node) => page.printedPage >= Number(node.startPage)
      && page.printedPage <= Number(node.endPage));
    const pageContainsTable = pageContextNodes.some((node) => catalogLayoutKind(node) === "table");
    const pageSourceText = pageContainsTable
      ? String(page.text || "")
      : stripInlinePageFurniture(String(page.text || ""), page.printedPage, pageContextNodes);
    const pageLines = coalesceBodyHeadingLines(stripOcrPageArtifacts(
      repairCommonOutlineOrdinal(pageSourceText).split(/\n/),
      pageContextNodes,
    ));
    for (let lineIndex = 0; lineIndex < pageLines.length; lineIndex += 1) {
      const line = pageLines[lineIndex];
      const headingSpan = matchingCatalogHeadingSpan(pageLines, lineIndex, pageCatalogCandidates);
      const catalogHeading = headingSpan?.node || matchingCatalogHeading(line, pageCatalogCandidates);
      if (catalogHeading) {
        commitSegment();
        activeCatalogNode = catalogHeading;
        activeBodyHeading = null;
        lineIndex += Math.max(1, Number(headingSpan?.count) || 1) - 1;
        continue;
      }
      // Confirmed catalog titles already live in catalogPath. Repeated running heads and
      // cross-references must not become a second, contradictory body outline.
      if (matchesConfirmedCatalogTitle(line, nodes)) continue;
      const bodyHeading = catalogNodeAllowsBodyOutline(activeCatalogNode)
        ? (bodyHeadingFromLine(line) || sourceTitleHeading(page, line)) : "";
      if (bodyHeading) {
        commitSegment();
        activeBodyHeading = {
          id: bodyHeadingId(bookId, activeCatalogNode.id, bodyHeading),
          title: bodyHeading,
          level: Math.min(5, Number(activeCatalogNode.level) + 1),
        };
        const remainder = bodyHeadingRemainder(line, bodyHeading);
        if (remainder) segmentLines.push(remainder);
        continue;
      }
      segmentLines.push(line);
    }
    commitSegment();
    if (!structuredSegments.length && String(page.text || "").trim()) {
      structuredSegments.push({
        text: String(page.text).trim(),
        catalogNode: activeCatalogNode,
        bodyHeading: activeBodyHeading,
      });
    }

    let pageChunkIndex = 0;
    structuredSegments.forEach((segment) => {
      const catalogNode = segment.catalogNode;
      const catalogLayout = catalogLayoutKind(catalogNode);
      const segmentSourceMetadata = structuredChunkMetadata(page, segment.text);
      const segmentHasTable = segmentSourceMetadata.sourceBlockTypes.includes("table");
      const cleanedText = catalogLayout === "table" || segmentHasTable
        ? segment.text
        : stripInlinePageFurniture(reflowOcrText(segment.text), page.printedPage, pageContextNodes);
      const segmentChunks = segmentHasTable
        ? [String(cleanedText || "").trim()].filter(Boolean)
        : splitPageText(cleanedText, 800, 0);
      segmentChunks.forEach((text) => {
        const bodyHeading = segment.bodyHeading;
        const sourceMetadata = structuredChunkMetadata(page, text);
        const layoutKind = sourceMetadata.sourceBlockTypes.includes("table") ? "table"
          : (sourceMetadata.sourceBlockTypes.some((type) => type === "image" || type === "chart") ? "figure"
            : (catalogLayout === "table" ? catalogLayout : embeddedVisualLayoutKind(text)));
        const ocrWarnings = [...new Set([
          ...figureOcrWarnings(text, layoutKind),
          ...sourceMetadata.sourceWarnings,
        ])];
        const retrievalText = layoutKind === "figure" ? figureSafeEvidenceText(text) : text;
        const retrievalEnabled = !ocrWarnings.some((warning) => [
          "visual_text_interleaving", "visual_without_caption", "table_structure_review",
        ].includes(warning));
        const catalogPath = catalogNode
          ? `${catalogNode.path}${bodyHeading ? ` > ${bodyHeading.title}` : ""}`
          : "未归入目录";
        chunks.push({
          id: chunkId(bookId, page, pageChunkIndex, text),
          bookId,
          bookTitle: String(bookTitle || ""),
          catalogNodeId: String(catalogNode && catalogNode.id || ""),
          catalogPath,
          bodyHeadingId: String(bodyHeading && bodyHeading.id || ""),
          bodyHeading: String(bodyHeading && bodyHeading.title || ""),
          bodyHeadingLevel: Number(bodyHeading && bodyHeading.level || 0),
          contentKind: catalogNode ? "body" : "unmapped",
          layoutKind,
          retrievalText,
          retrievalEnabled,
          ocrReviewRequired: ocrWarnings.length > 0,
          ocrWarnings,
          printedPageStart: page.printedPage || 0,
          printedPageEnd: page.printedPage || 0,
          pdfPageStart: page.pdfPage,
          pdfPageEnd: page.pdfPage,
          text,
          confidence: page.confidence,
          ...sourceMetadata,
          enabled: true,
          edited: false,
          updatedAt: Date.now(),
        });
        pageChunkIndex += 1;
      });
    });
  });
  return {
    pages: inferred.pages,
    chunks: refreshChunkRetrievalMetadata(repairCrossPageSentenceBreaks(chunks)),
    pageOffset: inferred.pageOffset,
    pageOffsetLocked: offsetLocked,
  };
}

function initialRecord(bookId) {
  return {
    bookId,
    status: "not_built",
    version: 0,
    source: null,
    progress: { processedPages: 0, totalPages: 0, failedPages: 0, percent: 0 },
    pageOffset: null,
    pageOffsetLocked: false,
    pages: [],
    chunks: [],
    quality: null,
    lastError: "",
    startedAt: null,
    completedAt: null,
    updatedAt: null,
  };
}

function normalizeRecord(record, bookId = "") {
  const base = initialRecord(bookId || record && record.bookId || "");
  const value = { ...base, ...(record || {}) };
  value.pages = Array.isArray(value.pages) ? value.pages : [];
  value.chunks = Array.isArray(value.chunks) ? value.chunks : [];
  value.quality = value.quality && typeof value.quality === "object" ? value.quality : null;
  value.progress = { ...base.progress, ...(value.progress || {}) };
  return value;
}

function recordSummary(record) {
  const enabledChunks = record.chunks.filter((chunk) => chunk.enabled !== false);
  const outlineNodes = outlineNodesFromChunks(enabledChunks);
  const printedPages = enabledChunks.map((chunk) => Number(chunk.printedPageStart)).filter((page) => page > 0);
  return {
    bookId: record.bookId,
    status: record.status,
    version: record.version,
    source: clone(record.source),
    quality: clone(record.quality),
    progress: clone(record.progress),
    pageOffset: record.pageOffset,
    pageOffsetLocked: Boolean(record.pageOffsetLocked),
    pageCount: new Set(record.pages.map((page) => Number(page.pdfPage)).filter(Boolean)).size,
    chunkCount: enabledChunks.length,
    outlineCount: outlineNodes.length,
    characterCount: record.pages.reduce((total, page) => total + String(page.text || "").length, 0),
    printedPageRange: printedPages.length ? `${Math.min(...printedPages)}-${Math.max(...printedPages)}` : "",
    lastError: record.lastError,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
  };
}

function sameKnowledgeSource(left, right) {
  if (!left || !right) return false;
  return String(left.fingerprint || "") === String(right.fingerprint || "")
    && Number(left.catalogVersion || 0) === Number(right.catalogVersion || 0)
    && String(left.mode || "") === String(right.mode || "");
}

function createTextbookKnowledgeStore(adapter) {
  const read = () => {
    const stored = adapter.read();
    return (Array.isArray(stored) ? stored : []).map((record) => normalizeRecord(record));
  };
  const write = (records) => adapter.write(records.map(clone));
  const locate = (records, bookId) => {
    let index = records.findIndex((record) => record.bookId === bookId);
    if (index < 0) {
      records.push(initialRecord(bookId));
      index = records.length - 1;
    }
    return index;
  };
  return {
    exportState: () => clone(adapter.read()),
    backup(bookId, metadata = {}) {
      const record = read().find((item) => item.bookId === bookId) || initialRecord(bookId);
      if (typeof adapter.backup !== "function") {
        return { created: false, storage: "unavailable", bookId, version: Number(record.version) || 0 };
      }
      return clone(adapter.backup(bookId, clone(record), clone(metadata)));
    },
    listBackups(bookId) {
      return typeof adapter.listBackups === "function" ? clone(adapter.listBackups(bookId)) : [];
    },
    get(bookId, options = {}) {
      const record = read().find((item) => item.bookId === bookId) || initialRecord(bookId);
      return options.includeContent ? clone(record) : recordSummary(record);
    },
    list() {
      return read().map(recordSummary);
    },
    outline(bookId) {
      const record = read().find((item) => item.bookId === bookId) || initialRecord(bookId);
      return clone(outlineNodesFromChunks(record.chunks.filter((chunk) => chunk.enabled !== false)));
    },
    importStructuredPages(bookId, pages, options = {}) {
      const incoming = (Array.isArray(pages) ? pages : [])
        .filter((page) => Number(page && page.pdfPage) > 0 && (
          String(page && page.text || "").trim()
          || String(page && page.sourceProvider || "").trim()
          || Array.isArray(page && page.sourceBlocks)
        ));
      if (!incoming.length) throw new Error("textbook_knowledge_empty");
      const records = read();
      const index = locate(records, bookId);
      const previous = records[index];
      const preserveMissingPages = options.preserveMissingPages !== false;
      const requestedTotalPages = Math.max(0, Number(options.totalPages) || 0);
      const retainedPages = (preserveMissingPages ? previous.pages : [])
        .filter((page) => !requestedTotalPages || Number(page.pdfPage) <= requestedTotalPages);
      const pageMap = new Map(retainedPages
        .map((page) => [Number(page.pdfPage), page]));
      incoming.forEach((page) => pageMap.set(Number(page.pdfPage), clone(page)));
      const mergedPages = [...pageMap.values()].sort((left, right) => Number(left.pdfPage) - Number(right.pdfPage));
      const built = buildKnowledgeChunks({
        bookId,
        bookTitle: options.bookTitle,
        pages: mergedPages,
        catalogNodes: options.catalogNodes,
        pageOffset: previous.pageOffset,
        pageOffsetLocked: previous.pageOffsetLocked,
      });
      const expectedPages = requestedTotalPages || mergedPages.length;
      const processedPages = new Set(mergedPages.map((page) => Number(page.pdfPage)).filter(Boolean)).size;
      const missingPages = Math.max(0, expectedPages - processedPages);
      const now = Date.now();
      records[index] = {
        ...previous,
        bookId,
        status: missingPages ? "partial" : "ready",
        version: Number(previous.version || 0) + 1,
        source: clone(options.source || previous.source || null),
        quality: clone(options.quality || null),
        progress: {
          processedPages,
          totalPages: expectedPages,
          failedPages: missingPages,
          percent: expectedPages ? Math.min(100, Math.round((processedPages / expectedPages) * 100)) : 100,
        },
        pageOffset: built.pageOffset,
        pageOffsetLocked: built.pageOffsetLocked,
        pages: built.pages,
        chunks: built.chunks,
        lastError: "",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      write(records);
      return this.get(bookId);
    },
    begin(bookId, metadata = {}) {
      const records = read();
      const index = locate(records, bookId);
      const now = Date.now();
      const previous = records[index];
      const source = clone(metadata.source || null);
      const resumable = metadata.resume !== false
        && sameKnowledgeSource(previous.source, source)
        && previous.pages.length > 0;
      const totalPages = Math.max(0, Number(metadata.totalPages) || 0);
      const pages = resumable ? previous.pages : [];
      const chunks = resumable ? previous.chunks : [];
      const processedPages = new Set(pages.map((page) => Number(page.pdfPage)).filter(Boolean)).size;
      records[index] = {
        ...initialRecord(bookId),
        status: "building",
        version: Number(previous.version) || 0,
        source,
        progress: {
          processedPages,
          totalPages,
          failedPages: 0,
          percent: totalPages ? Math.min(100, Math.round((processedPages / totalPages) * 100)) : 0,
        },
        pageOffset: resumable ? previous.pageOffset : null,
        pageOffsetLocked: resumable ? Boolean(previous.pageOffsetLocked) : false,
        pages,
        chunks,
        lastError: "",
        startedAt: now,
        updatedAt: now,
      };
      write(records);
      return this.get(bookId);
    },
    appendPages(bookId, pages, options = {}) {
      const records = read();
      const index = locate(records, bookId);
      const record = records[index];
      const built = buildKnowledgeChunks({
        bookId,
        bookTitle: options.bookTitle,
        pages,
        catalogNodes: options.catalogNodes,
        pageOffset: record.pageOffsetLocked ? record.pageOffset : null,
        pageOffsetLocked: record.pageOffsetLocked,
      });
      const pageMap = new Map(record.pages.map((page) => [Number(page.pdfPage), page]));
      built.pages.forEach((page) => pageMap.set(Number(page.pdfPage), page));
      const replacedPages = new Set(built.pages.map((page) => Number(page.pdfPage)));
      const accumulatedTrustedOffset = record.pageOffsetLocked
        ? record.pageOffset
        : trustedCatalogPageOffset([...record.pages, ...built.pages], options.catalogNodes);
      let chunks;
      const needsPaginationReindex = accumulatedTrustedOffset != null
        && (!record.pageOffsetLocked || record.chunks.some((chunk) => !chunk.contentKind));
      if (needsPaginationReindex) {
        chunks = buildKnowledgeChunks({
          bookId,
          bookTitle: options.bookTitle,
          pages: [...pageMap.values()],
          catalogNodes: options.catalogNodes,
          pageOffset: accumulatedTrustedOffset,
          pageOffsetLocked: true,
        }).chunks;
      } else {
        const chunkMap = new Map(record.chunks
          .filter((chunk) => !replacedPages.has(Number(chunk.pdfPageStart)))
          .map((chunk) => [chunk.id, chunk]));
        built.chunks.forEach((chunk) => chunkMap.set(chunk.id, chunk));
        chunks = [...chunkMap.values()];
      }
      const totalPages = Math.max(Number(record.progress.totalPages) || 0, Number(options.totalPages) || 0);
      const processedPages = pageMap.size;
      const now = Date.now();
      records[index] = {
        ...record,
        status: "building",
        pageOffset: accumulatedTrustedOffset ?? built.pageOffset ?? record.pageOffset,
        pageOffsetLocked: Boolean(record.pageOffsetLocked || built.pageOffsetLocked || accumulatedTrustedOffset != null),
        pages: [...pageMap.values()].sort((left, right) => left.pdfPage - right.pdfPage),
        chunks: chunks.sort((left, right) => left.pdfPageStart - right.pdfPageStart),
        progress: {
          processedPages,
          totalPages,
          failedPages: Math.max(0, Number(options.failedPages) || Number(record.progress.failedPages) || 0),
          percent: totalPages ? Math.min(100, Math.round((processedPages / totalPages) * 100)) : 0,
        },
        updatedAt: now,
      };
      write(records);
      return this.get(bookId);
    },
    reindex(bookId, options = {}) {
      const records = read();
      const index = locate(records, bookId);
      const record = records[index];
      const maxPdfPage = Math.max(0, Number(options.maxPdfPage) || 0);
      const sourcePages = record.pages.filter((page) => !maxPdfPage || Number(page.pdfPage) <= maxPdfPage);
      if (!sourcePages.length) throw new Error("textbook_knowledge_empty");
      const built = buildKnowledgeChunks({
        bookId,
        bookTitle: options.bookTitle,
        pages: sourcePages,
        catalogNodes: options.catalogNodes,
        pageOffset: record.pageOffset,
        pageOffsetLocked: record.pageOffsetLocked,
      });
      const totalPages = maxPdfPage || Math.max(sourcePages.length, Number(record.progress.totalPages) || 0);
      const processedPages = new Set(sourcePages.map((page) => Number(page.pdfPage)).filter(Boolean)).size;
      const missingPages = Math.max(0, totalPages - processedPages);
      const source = record.source && typeof record.source === "object" ? { ...record.source } : {};
      if (Number(options.catalogVersion) > 0) source.catalogVersion = Number(options.catalogVersion);
      const now = Date.now();
      records[index] = {
        ...record,
        status: missingPages ? "partial" : "ready",
        version: Number(record.version || 0) + 1,
        source,
        progress: {
          processedPages,
          totalPages,
          failedPages: missingPages,
          percent: totalPages ? Math.min(100, Math.round((processedPages / totalPages) * 100)) : 100,
        },
        pageOffset: built.pageOffset,
        pageOffsetLocked: built.pageOffsetLocked,
        pages: built.pages,
        chunks: built.chunks,
        completedAt: now,
        updatedAt: now,
      };
      write(records);
      return this.get(bookId);
    },
    finish(bookId) {
      const records = read();
      const index = locate(records, bookId);
      const record = records[index];
      if (!record.chunks.length) throw new Error("textbook_knowledge_empty");
      const now = Date.now();
      records[index] = {
        ...record,
        status: Number(record.progress.failedPages) > 0 ? "partial" : "ready",
        version: Number(record.version || 0) + 1,
        progress: {
          ...record.progress,
          percent: record.progress.totalPages
            ? Math.min(100, Math.round((record.progress.processedPages / record.progress.totalPages) * 100))
            : 100,
        },
        lastError: "",
        completedAt: now,
        updatedAt: now,
      };
      write(records);
      return this.get(bookId);
    },
    fail(bookId, error) {
      const records = read();
      const index = locate(records, bookId);
      records[index] = {
        ...records[index],
        status: records[index].chunks.length ? "partial" : "failed",
        lastError: String(error && error.message || error || "textbook_knowledge_build_failed").slice(0, 500),
        updatedAt: Date.now(),
      };
      write(records);
      return this.get(bookId);
    },
    listChunks(bookId, options = {}) {
      const record = read().find((item) => item.bookId === bookId) || initialRecord(bookId);
      const query = normalizeSearchText(options.query);
      const catalogNodeId = String(options.catalogNodeId || "");
      const catalogPathPrefix = String(options.catalogPathPrefix || "");
      const contentKind = String(options.contentKind || "");
      const page = Math.max(1, Number(options.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20));
      const filtered = record.chunks.filter((chunk) => (
        (!catalogNodeId || chunk.catalogNodeId === catalogNodeId)
        && (!catalogPathPrefix || chunk.catalogPath === catalogPathPrefix || chunk.catalogPath.startsWith(`${catalogPathPrefix} > `))
        && (!contentKind || chunk.contentKind === contentKind)
        && (!query || normalizeSearchText(`${chunk.catalogPath} ${chunk.text}`).includes(query))
      )).sort((left, right) => (
        Number(left.pdfPageStart) - Number(right.pdfPageStart)
        || Number(left.printedPageStart) - Number(right.printedPageStart)
      ));
      return {
        items: clone(filtered.slice((page - 1) * pageSize, page * pageSize)),
        total: filtered.length,
        page,
        pageSize,
      };
    },
    updateChunk(bookId, chunkIdValue, payload = {}) {
      const records = read();
      const index = locate(records, bookId);
      const chunkIndex = records[index].chunks.findIndex((chunk) => chunk.id === chunkIdValue);
      if (chunkIndex < 0) throw new Error("textbook_knowledge_chunk_not_found");
      const text = String(payload.text ?? records[index].chunks[chunkIndex].text).trim().slice(0, 6000);
      if (!text) throw new Error("textbook_knowledge_chunk_text_required");
      const current = records[index].chunks[chunkIndex];
      const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);
      records[index].chunks[chunkIndex] = {
        ...current,
        text,
        retrievalText: text,
        retrievalEnabled: true,
        ocrReviewRequired: false,
        ocrWarnings: [],
        sourceTableCaption: hasOwn("tableCaption") ? String(payload.tableCaption || "").trim().slice(0, 1000) : current.sourceTableCaption,
        sourceTableFootnote: hasOwn("tableFootnote") ? String(payload.tableFootnote || "").trim().slice(0, 1000) : current.sourceTableFootnote,
        sourceTableStructure: Array.isArray(payload.tableStructure) ? normalizeTableStructure(payload.tableStructure) : current.sourceTableStructure,
        sourceTableRows: Array.isArray(payload.tableRows) ? normalizeTableRows(payload.tableRows) : current.sourceTableRows,
        enabled: payload.enabled !== false,
        edited: true,
        updatedAt: Date.now(),
      };
      records[index].updatedAt = Date.now();
      write(records);
      return clone(records[index].chunks[chunkIndex]);
    },
    search(bookId, query, options = {}) {
      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) return [];
      const record = read().find((item) => item.bookId === bookId) || initialRecord(bookId);
      const queryFeatures = searchFeatures(normalizedQuery);
      const catalogNodeId = String(options.catalogNodeId || "");
      const catalogPathPrefix = String(options.catalogPathPrefix || "");
      const limit = Math.min(20, Math.max(1, Number(options.limit) || 6));
      return record.chunks
        .filter((chunk) => chunk.enabled !== false
          && chunk.retrievalEnabled !== false
          && (options.includeUncataloged === true || Boolean(chunk.catalogNodeId))
          && (!catalogPathPrefix || chunk.catalogPath === catalogPathPrefix || chunk.catalogPath.startsWith(`${catalogPathPrefix} > `))
          && (!catalogNodeId || chunk.catalogNodeId === catalogNodeId))
        .map((chunk) => {
          const searchable = normalizeSearchText(`${chunk.catalogPath} ${typeof chunk.retrievalText === "string" ? chunk.retrievalText : chunk.text}`);
          const features = searchFeatures(searchable);
          const cosine = featureCosine(queryFeatures, features);
          let matched = 0;
          queryFeatures.forEach((feature) => { if (features.has(feature)) matched += 1; });
          const coverage = queryFeatures.size ? matched / queryFeatures.size : 0;
          const exact = searchable.includes(normalizedQuery) ? 1 : 0;
          const pathMatch = normalizeSearchText(chunk.catalogPath).includes(normalizedQuery) ? 1 : 0;
          const score = (coverage * 0.52) + (cosine * 0.28) + (exact * 0.14) + (pathMatch * 0.06);
          return { ...chunk, score: Number(score.toFixed(4)) };
        })
        .filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score || left.pdfPageStart - right.pdfPageStart)
        .slice(0, limit)
        .map(clone);
    },
  };
}

function createFileTextbookKnowledgeStore(filePath = path.resolve(__dirname, "../../../.runtime/textbook-knowledge.json")) {
  const backupRoot = path.join(path.dirname(filePath), "textbook-knowledge-backups");
  const safeBookId = (bookId) => String(bookId || "unknown").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120) || "unknown";
  return createTextbookKnowledgeStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
    write(records) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
    backup(bookId, record, metadata = {}) {
      const createdAt = Date.now();
      const directory = path.join(backupRoot, safeBookId(bookId));
      fs.mkdirSync(directory, { recursive: true });
      const fileName = `${createdAt}-${crypto.randomBytes(3).toString("hex")}-mineru-import.json`;
      const backupPath = path.join(directory, fileName);
      const temporaryPath = `${backupPath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ createdAt, metadata, record }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, backupPath);
      const files = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith("-mineru-import.json"))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      files.slice(10).forEach((name) => fs.unlinkSync(path.join(directory, name)));
      return {
        created: true,
        storage: "file",
        bookId,
        fileName,
        createdAt,
        version: Number(record.version) || 0,
      };
    },
    listBackups(bookId) {
      const directory = path.join(backupRoot, safeBookId(bookId));
      try {
        return fs.readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith("-mineru-import.json"))
          .map((entry) => ({ fileName: entry.name, storage: "file", bookId }))
          .sort((left, right) => right.fileName.localeCompare(left.fileName));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
  });
}

function createMemoryTextbookKnowledgeStore(initial = []) {
  let records = clone(initial);
  const backups = [];
  return createTextbookKnowledgeStore({
    read: () => clone(records),
    write: (value) => { records = clone(value); },
    backup(bookId, record, metadata = {}) {
      const descriptor = {
        created: true,
        storage: "memory",
        bookId,
        id: `memory-${backups.length + 1}`,
        createdAt: Date.now(),
        version: Number(record.version) || 0,
      };
      backups.push({ ...descriptor, metadata: clone(metadata), record: clone(record) });
      return descriptor;
    },
    listBackups: (bookId) => backups.filter((backup) => backup.bookId === bookId),
  });
}

module.exports = {
  bodyHeadingFromLine,
  buildKnowledgeChunks,
  catalogNodesWithPaths,
  createFileTextbookKnowledgeStore,
  createMemoryTextbookKnowledgeStore,
  embeddedVisualLayoutKind,
  inferPrintedPages,
  normalizeSearchText,
  outlineNodesFromChunks,
  reflowOcrText,
  splitPageText,
};
