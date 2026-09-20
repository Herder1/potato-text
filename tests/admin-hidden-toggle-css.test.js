const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../apps/admin");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

/**
 * 后台有一类静默 UI 故障：元素用 `hidden` 属性切换显隐，但它的 class 自己在 CSS 里设了 display。
 * 作者样式优先于浏览器默认的 `[hidden] { display: none }`，于是"设了 hidden 却依旧显示"。
 * 侧边导航二级菜单就踩过这个坑（收起分组后子项还在），这里做一次全量静态自检防回归。
 */
test("后台：带 hidden 切换的元素若自己设了 display，必须有 [hidden] 兜底规则", () => {
  const hiddenElements = [];
  for (const match of html.matchAll(/<[a-z][^>]*\bhidden\b[^>]*>/gi)) {
    const tag = match[0];
    const classMatch = tag.match(/class="([^"]*)"/);
    const idMatch = tag.match(/id="([^"]*)"/);
    hiddenElements.push({
      classes: classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [],
      id: idMatch ? idMatch[1] : "",
      tag: tag.slice(0, 60).replace(/\s+/g, " "),
    });
  }
  assert.ok(hiddenElements.length > 50, `解析到的 hidden 元素过少（${hiddenElements.length}），解析逻辑可能失效`);

  const displayByClass = new Map();
  for (const match of css.matchAll(/(^|\})\s*\.([a-z0-9-]+)\s*\{([^}]*)\}/gi)) {
    const [, , className, body] = match;
    const display = body.match(/display\s*:\s*([a-z-]+)/i);
    if (display) displayByClass.set(className, display[1]);
  }

  const offenders = [];
  hiddenElements.forEach((element) => {
    element.classes.forEach((className) => {
      const display = displayByClass.get(className);
      if (!display || display === "none") return;
      if (new RegExp(`\\.${className}\\[hidden\\]`).test(css)) return;
      offenders.push(`#${element.id || "(no id)"} .${className} → display:${display}，缺少 .${className}[hidden]{display:none}`);
    });
  });
  assert.deepEqual(offenders, [], `这些元素设了 hidden 也藏不住：\n${offenders.join("\n")}`);
});

test("侧边导航二级菜单的收起必须「真的看不见」：容器要有 [hidden] 兜底", () => {
  assert.match(css, /\.nav-sub\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.nav-sub\[hidden\]\s*\{\s*display:\s*none/);
  const markup = html;
  ["内容与题库", "考试与题包", "社区管理", "AI 与订阅", "系统与审计"].forEach((group) => {
    assert.match(markup, new RegExp(`data-nav-group="${group}"`), `缺少分组 ${group}`);
    assert.match(markup, new RegExp(`data-nav-sub="${group}"`), `缺少分组容器 ${group}`);
  });
  const subContainers = [...markup.matchAll(/<div class="nav-sub" data-nav-sub="[^"]+" hidden>/g)];
  assert.equal(subContainers.length, 5, "五个分组容器都必须默认收起（带 hidden）");
});
