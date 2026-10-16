// 「白图标必须有深色底片」静态兜底（2026-09-23 04:1x 真机反馈「看不见」之后新增）。
//
// 起因：仓库里 `pack-*.svg` 一组图标描边是 #ffffff，它们是给**深色工具条**用的；一旦被放到
// 浅色底片（淡青 #e7f6f1 / 淡红 #fdecea / 淡灰 #f2f4f3）甚至没有底片上，就等于隐形——
// 产品负责人在真机导航栏上撞到的就是这一类（当时那颗是 pack-folder.svg 放在浅色导航栏上）。
//
// 本测试不写死"哪个图标该配哪个底色"，而是：**读图标自己的 stroke/fill** 判断它是不是近白色，
// 再去**它所在页面的 wxss** 里沿祖先往上找最近的、带背景声明的类，判断那个背景够不够深。
// 半透明底片（如 rgba(255,255,255,.22) 叠在渐变横幅上）算不准，跳过不判——不制造假阳性。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MP = path.join(__dirname, "..", "apps", "miniprogram");

/** 解析颜色 → 相对亮度（WCAG）。半透明、渐变、解析不出来的都返回 null（不判）。 */
function luminance(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/gradient/i.test(text)) {
    const inner = text.match(/#[0-9a-fA-F]{3,6}|rgba?\([^)]*\)/);
    return inner ? luminance(inner[0]) : null;
  }
  let r;
  let g;
  let b;
  let a = 1;
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((v) => Number(v.trim()));
    [r, g, b] = parts;
    a = parts.length > 3 ? parts[3] : 1;
  } else if (/^#[0-9a-fA-F]{3}$/.test(text) || /^#[0-9a-fA-F]{6}$/.test(text)) {
    const hex = text.slice(1);
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    r = Number.parseInt(full.slice(0, 2), 16);
    g = Number.parseInt(full.slice(2, 4), 16);
    b = Number.parseInt(full.slice(4, 6), 16);
  } else {
    return null;
  }
  if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null;
  if (a < 1) return null;
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 图标整体是不是近白色（描边/填充都浅）＝只能落在深色底片上。 */
function iconIsNearWhite(file) {
  const svg = fs.readFileSync(path.join(MP, "assets", "icons", file), "utf8");
  const paints = [...svg.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  if (!paints.length) return false;
  return paints.every((c) => (luminance(c) ?? 0) >= 0.75);
}

/** 页面 wxss 里某个类名最终生效的背景声明（同名规则取文件里最后一条，近似 cascade）。 */
function backgroundOfClass(css, className) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let found = null;
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(",").map((s) => s.trim());
    if (!selectors.includes(`.${className}`)) continue;
    const decl = rule[2].match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
    if (decl) found = decl[1].trim();
  }
  return found;
}

/** 取元素 class 里最终生效的背景：多个类都有背景时，文件里靠后的那条赢。 */
function backgroundOfElement(css, classNames) {
  let winner = null;
  let index = -1;
  for (const name of classNames) {
    const bg = backgroundOfClass(css, name);
    if (!bg) continue;
    const at = css.lastIndexOf(`.${name}`);
    if (at > index) {
      index = at;
      winner = { className: name, background: bg };
    }
  }
  return winner;
}

/** 扫一个页面：白图标 + 祖先里最近的背景，太浅就记账。 */
function auditPage(dir) {
  const wxmlPath = path.join(MP, "pages", dir, `${dir}.wxml`);
  const wxssPath = path.join(MP, "pages", dir, `${dir}.wxss`);
  if (!fs.existsSync(wxmlPath)) return [];
  const wxml = fs.readFileSync(wxmlPath, "utf8");
  const css = fs.existsSync(wxssPath) ? fs.readFileSync(wxssPath, "utf8") : "";
  const lines = wxml.split("\n");
  const problems = [];
  const stack = [];

  lines.forEach((line, i) => {
    const noComment = line.replace(/<!--[\s\S]*?-->/g, "");
    // 按文档顺序走这一行的标签：开标签入栈、闭标签出栈、遇到 <image> 就当场用当前祖先链判。
    // （先判 image 再入栈会让「同一行的父容器」判不到，诊断会指向更外层的容器，不如现在准确。）
    for (const tag of noComment.matchAll(/<(\/?)([a-zA-Z-]+)([^>]*?)(\/?)>/g)) {
      const [, closing, name, attrs, selfClose] = tag;
      if (name === "image") {
        const src = (attrs.match(/src="\/assets\/icons\/([a-z0-9-]+\.svg)"/) || [])[1];
        if (!src || !iconIsNearWhite(src)) continue;
        const elementClasses = (attrs.match(/class="([^"]*)"/) || [, ""])[1]
          .replace(/\{\{[^}]*\}\}/g, "")
          .split(/\s+/)
          .filter(Boolean);
        const candidates = [];
        if (elementClasses.length) candidates.push({ line: i + 1, elementClasses, self: true });
        for (let k = stack.length - 1; k >= 0; k -= 1) candidates.push(stack[k]);
        let hit = null;
        for (const frame of candidates) {
          const bg = backgroundOfElement(css, frame.elementClasses);
          if (bg) {
            hit = { ...bg, at: frame.line };
            break;
          }
        }
        const lum = hit ? luminance(hit.background) : null;
        if (hit === null || (lum !== null && lum > 0.5)) {
          problems.push(
            `${dir}.wxml:${i + 1} 白标 ${src} 落在浅底/无底：`
            + (hit ? `.${hit.className} { background: ${hit.background} }（亮度 ${lum === null ? "算不准" : lum.toFixed(3)}，行 ${hit.at}）` : "往上一路都没有背景声明（等于白底）"),
          );
        }
        continue;
      }
      if (selfClose === "/" || /^(input|br)$/.test(name)) continue;
      if (closing === "/") {
        stack.pop();
        continue;
      }
      const classes = (attrs.match(/class="([^"]*)"/) || [, ""])[1]
        .replace(/\{\{[^}]*\}\}/g, "")
        .split(/\s+/)
        .filter(Boolean);
      stack.push({ line: i + 1, elementClasses: classes });
    }
  });
  return problems;
}

test("白图标（pack-*.svg 一类）必须落在深色底片上——浅色底片/无底片等于「看不见」", () => {
  const pages = fs.readdirSync(path.join(MP, "pages")).filter((d) => fs.statSync(path.join(MP, "pages", d)).isDirectory());
  const problems = pages.flatMap(auditPage);
  assert.deepEqual(
    problems,
    [],
    `以下位置的白色图标画在浅色/无底片上，真机上就是看不见（要么换深色标，要么给深色底片）：\n${problems.join("\n")}`,
  );
});

// 「同一个功能在多个页面必须是同一颗标」（2026-09-23 04:6x 产品负责人指出「排序」两处要统一用箭头标）。
// 起因：同一个语义当时散着两颗标——「排序」在收藏页/卡集页用的是画三条竖杆的「滑块」标 sliders.svg，
// 而他在练习页把「设置」也画成了同一颗。语义与图形对不上时，用户只能靠猜。
// 判据按**语义**（元素上的 aria-label 精确匹配，不是"这行出现过排序两个字"）反查它用的图标——
// 精确匹配是为了避开 `{{settings.x}}`、`按错误率排序`（纯文案）、多行注释里提到"排序"这些噪声。
const FUNCTION_ICONS = {
  切换排序: "sort.svg",
  卡盒排序: "sort.svg",
  排序: "sort.svg",
  练习设置: "settings-gear.svg",
  设置: "settings-gear.svg",
};

test("同一功能在多个页面用同一颗标：排序＝sort.svg、设置＝settings-gear.svg（不许再用「滑块」标顶替）", () => {
  const pages = fs.readdirSync(path.join(MP, "pages")).filter((d) => fs.statSync(path.join(MP, "pages", d)).isDirectory());
  const problems = [];
  const seen = [];
  for (const dir of pages) {
    const wxmlPath = path.join(MP, "pages", dir, `${dir}.wxml`);
    if (!fs.existsSync(wxmlPath)) continue;
    const lines = fs.readFileSync(wxmlPath, "utf8").split("\n");
    lines.forEach((line, i) => {
      const label = (line.match(/aria-label="([^"]*)"/) || [])[1];
      if (!label || !FUNCTION_ICONS[label]) return;
      // 图标多半挂在被标注的那个元素**自己的**子节点上：同一行，或紧跟其后以 <image 开头的那一行。
      // 不能用"往后看两行"——知识库那处 aria-label="排序" 是文字画的标，后面第 2 行是**另一个兄弟按钮**
      // 的 sliders.svg（筛选），窗口放宽就会误判成"排序用了滑块标"（第一版就是这么误报的）。
      let src = (line.match(/\/assets\/icons\/([a-z0-9-]+\.svg)/) || [])[1];
      if (!src) {
        for (const next of [lines[i + 1] || "", lines[i + 2] || ""]) {
          if (!/^\s*<image\b/.test(next)) break;
          src = (next.match(/\/assets\/icons\/([a-z0-9-]+\.svg)/) || [])[1];
          if (src) break;
        }
      }
      if (!src) return; // 用文字/伪元素画的标（如知识库那处）不适用本判据
      seen.push(`${dir}:${label}→${src}`);
      if (src !== FUNCTION_ICONS[label]) {
        problems.push(`${dir}.wxml:${i + 1}「${label}」用的是 ${src}，应为 ${FUNCTION_ICONS[label]}（同一个功能不许两颗标）`);
      }
    });
  }
  assert.ok(seen.length >= 3, `扫描到的排序/设置入口太少（${seen.length} 处），判据可能失效：${seen.join(" / ")}`);
  assert.deepEqual(problems, [], `同一功能的图标必须统一：\n${problems.join("\n")}`);
});
