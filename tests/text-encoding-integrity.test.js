// 编码完整性静态兜底（2026-10-09 事故后新增）。
// 事故形态：用 PowerShell 把文本文件「GBK 读 + UTF-8 写」往返一趟，中文全部变成乱码，且每个损坏点
// 还会吃掉一个 ASCII 字符（标签被破坏）。这类损坏在提交前用静态扫描就能拦住，因此固化成测试：
//   ① 仓库文本文件不得出现 U+FFFD 替换字符；
//   ② 不得出现成片的 GBK 误码字（正常中文里几乎不会出现，阈值 5 避免误报）；
//   ③ apps/admin/index.html 必须无 BOM、只用 LF（本仓库文本一律 LF）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".runtime", "tmp", "删除件归档", "题目录入", "database"]);
// 本文件自己带着误码字清单，必须排除，否则会把自己判成损坏。
const SKIP_FILES = new Set([path.join(__dirname, "text-encoding-integrity.test.js")]);
const EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".html", ".css", ".json", ".md", ".txt", ".yml", ".yaml", ".wxss", ".wxml"]);
// 典型 GBK 误码字（UTF-8 中文被按 GBK 解码后产生的一批字）
const MOJIBAKE_CHARS = "锛鈥鐨绠鍙鏄浣涓鏂鐞鐢鍜鏁鏉鎴鎵钖冪悗鍚宸ヤ綔鍐呭搴鏁欐潗洰褰";

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(full, files);
      continue;
    }
    if (SKIP_FILES.has(full)) continue;
    if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

test("编码兜底：仓库文本文件里没有 U+FFFD 与成片 GBK 误码字", () => {
  const offenders = [];
  for (const file of walk(root)) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const replacement = (text.match(/\uFFFD/g) || []).length;
    let mojibake = 0;
    for (const char of text) if (MOJIBAKE_CHARS.includes(char)) mojibake += 1;
    if (replacement > 0 || mojibake > 5) {
      offenders.push(`${path.relative(root, file)}（U+FFFD=${replacement}，误码字=${mojibake}）`);
    }
  }
  assert.deepEqual(offenders, [], `这些文件出现编码损坏，必须先用「同一趟变换的逆变换 + 完好副本」修回：\n${offenders.join("\n")}`);
});

test("编码兜底：apps/admin/index.html 无 BOM、只用 LF", () => {
  const file = path.join(root, "apps", "admin", "index.html");
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "index.html 不得带 UTF-8 BOM");
  const text = bytes.toString("utf8");
  assert.equal((text.match(/\r\n/g) || []).length, 0, "index.html 不得使用 CRLF 行尾");
  assert.equal((text.match(/\uFFFD/g) || []).length, 0, "index.html 不得残留替换字符");
  assert.match(text, /<title>薯考管理后台<\/title>/, "index.html 标题应为可读中文");
});
