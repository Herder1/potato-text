"use strict";

// 小程序 setData 支持「数据路径」写法（"catalogChapters[2].expanded"、"a.b.c"），
// 真机上只有这一条路径被更新，其他字段保持不动。用例里的 setData 桩必须按同一套语义
// 落到 data 上，否则页面用路径更新时用例会读到旧值（2026-09-23 目录抽屉瘦身时的实测教训）。
function parseDataPath(path) {
  return String(path)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment !== "")
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

function setByDataPath(target, path, value) {
  const segments = parseDataPath(path);
  if (!segments.length) return target;
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (cursor[segment] === undefined || cursor[segment] === null) {
      cursor[segment] = typeof nextSegment === "number" ? [] : {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
  return target;
}

// 把一次 setData 的补丁按数据路径语义合并进 data（原地修改并返回）。
function applyDataPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => setByDataPath(target, key, patch[key]));
  return target;
}

module.exports = { applyDataPatch, parseDataPath, setByDataPath };
