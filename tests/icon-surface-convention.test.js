const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PAGES_ROOT = path.join(__dirname, "../apps/miniprogram/pages");

function wxmlFiles(dir = PAGES_ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return wxmlFiles(full);
    return entry.name.endsWith(".wxml") ? [full] : [];
  });
}

// 深色表面（黑操作栏 / 深色菜单）：容器 class 里出现这些名字就认为背景是深的。
const DARK_SURFACES = ["context-toolbar", "selection-toolbar", "context-menu", "add-menu"];
// 浅色表面里出现这些名字则相反：白底容器不能用白色图标。
const LIGHT_SURFACES = ["drawer-layer", "more-drawer", "color-panel", "catalog-panel", "directory"];
const WHITE_PREFIX = "pack-";

function isWhiteIcon(icon) {
  return icon.startsWith(WHITE_PREFIX) || icon.includes("-light");
}

// 逐标签扫描：把每个 <image> 的祖先容器 class 记下来，判断它落在深色还是浅色表面。
function iconUsages(source) {
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  const usages = [];
  let match;
  while ((match = tagRe.exec(source))) {
    const [, close, name, attrs, selfClose] = match;
    if (close) {
      stack.pop();
      continue;
    }
    const classMatch = /class="([^"]*)"/.exec(attrs);
    // 按空格切成独立的 class token 再比对，避免 context-toolbar-directory 误判成浅色容器。
    const classes = (classMatch ? classMatch[1] : "").split(/\s+/).filter(Boolean);
    const iconMatch = /src="\/assets\/icons\/([a-z0-9-]+\.svg)"/.exec(attrs);
    const darkHere = DARK_SURFACES.some((cls) => classes.includes(cls));
    const lightHere = LIGHT_SURFACES.some((cls) => classes.includes(cls));
    if (iconMatch) {
      const line = source.slice(0, match.index).split("\n").length;
      usages.push({
        icon: iconMatch[1],
        line,
        dark: darkHere || stack.some((entry) => entry.dark),
        light: lightHere || stack.some((entry) => entry.light),
      });
    }
    if (!selfClose && name !== "input") stack.push({ name, dark: darkHere, light: lightHere });
  }
  return usages;
}

test("dark surfaces only use white pack-* icons", () => {
  const offenders = [];
  for (const file of wxmlFiles()) {
    for (const usage of iconUsages(fs.readFileSync(file, "utf8"))) {
      if (usage.dark && !isWhiteIcon(usage.icon)) {
        offenders.push(`${path.relative(PAGES_ROOT, file)}:${usage.line} → ${usage.icon}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `深色表面的图标必须是 pack-* 白色系：\n${offenders.join("\n")}`);
});

test("light drawer and panel surfaces never use the white pack-* icons", () => {
  const offenders = [];
  for (const file of wxmlFiles()) {
    for (const usage of iconUsages(fs.readFileSync(file, "utf8"))) {
      if (usage.light && isWhiteIcon(usage.icon)) {
        offenders.push(`${path.relative(PAGES_ROOT, file)}:${usage.line} → ${usage.icon}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `浅色抽屉/面板的图标必须是深色系：\n${offenders.join("\n")}`);
});

test("every icon referenced by a page exists in the icon folder", () => {
  const iconDir = path.join(__dirname, "../apps/miniprogram/assets/icons");
  const available = new Set(fs.readdirSync(iconDir));
  const missing = [];
  for (const file of wxmlFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/src="\/assets\/icons\/([a-z0-9-]+\.svg)"/g)) {
      if (!available.has(match[1])) {
        const line = source.slice(0, match.index).split("\n").length;
        missing.push(`${path.relative(PAGES_ROOT, file)}:${line} → ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `引用了不存在的图标：\n${missing.join("\n")}`);
});

// DEC-080：导入 / 导出必须是「同一个文档图标 + 相反箭头」，分享仍用「方框 + 上箭头」。
test("import and export share one document glyph with opposite arrows", () => {
  const iconDir = path.join(__dirname, "../apps/miniprogram/assets/icons");
  const read = (name) => fs.readFileSync(path.join(iconDir, name), "utf8");
  const importIcon = read("card-import.svg");
  const exportIcon = read("card-export.svg");
  const shareIcon = read("share.svg");

  const documentGlyph = (svg) => (svg.match(/<path d="M14 2H6[^"]*"[^>]*>/) || [])[0];
  assert.ok(documentGlyph(importIcon), "导入图标必须是文档轮廓");
  assert.equal(documentGlyph(importIcon), documentGlyph(exportIcon), "导入 / 导出共用同一个文档轮廓");
  assert.match(importIcon, /m9\.5 14\.5 2\.5 2\.5 2\.5-2\.5/, "导入是向下的箭头");
  assert.match(exportIcon, /m9\.5 13\.5 2\.5-2\.5 2\.5 2\.5/, "导出是向上的箭头（与导入相反）");
  assert.match(importIcon, /M12 11v6/, "导入的箭杆向下");
  assert.match(exportIcon, /M12 17v-6/, "导出的箭杆向上");

  // 分享仍用「方框 + 上箭头」，不跟着导入导出改成文档
  assert.match(shareIcon, /m16 7-4-4-4 4/, "分享是方框上的上箭头");
  assert.doesNotMatch(shareIcon, /M14 2H6/, "分享不用文档轮廓");
});

test("the white icon family keeps a light counterpart for every glyph it shares", () => {
  const iconDir = path.join(__dirname, "../apps/miniprogram/assets/icons");
  const files = new Set(fs.readdirSync(iconDir));
  // pack-x.svg 是白色系，浅色表面上通常需要同名深色版（x.svg）或专门的深色图标。
  const darkCounterparts = {
    "pack-plus.svg": "plus.svg",
    "pack-edit.svg": "card-rename.svg",
    "pack-trash.svg": "card-delete.svg",
    "pack-folder.svg": "card-move.svg",
    "pack-palette.svg": "palette.svg",
    "pack-close.svg": "x.svg",
  };
  for (const [white, dark] of Object.entries(darkCounterparts)) {
    if (!files.has(white)) continue;
    assert.ok(files.has(dark), `${white} 的浅色表面对应图标 ${dark} 不存在`);
    const whiteSource = fs.readFileSync(path.join(iconDir, white), "utf8");
    assert.match(whiteSource, /stroke="#ffffff"/, `${white} 必须是白色描边`);
  }
});
