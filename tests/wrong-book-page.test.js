const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildWrongBookView } = require("../apps/miniprogram/utils/review-library");

const root = path.join(__dirname, "../apps/miniprogram");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

// 产品负责人 2026-09-23 04:9x：「错题本页面需要修改一下，图1是效果图，筛选用图2」。
// 图1（tmp/verify-out/ref-04-9x-design.png，662px 宽 ≙ 750rpx）逐像素量出来的规格：
//   状态卡 96px≙108rpx 高 / 间距 21px≙20rpx（取整）/ 圆角 ~10px≙20rpx / 选中态底 #e4f4f1、字 #0a8f83；
//   分段轨道 55px≙62rpx；科目卡 100px≙112rpx 高 / 间距 10px≙12rpx / 圆标直径 50px≙56rpx。
// 图2 = 他截的我们自己收藏页那颗漏斗标（assets/icons/filter.svg，stroke #474d49）。
// 渲染侧的实测在本机跑：node tmp/verify-wrong-book-redesign.js（12 项，读真实 getComputedStyle/矩形）。
// 下面这些是**静态契约**：改坏文案/色值/结构时先在这里失败，不用等渲染。

const wrongBook = () => ({
  markup: read("pages", "wrong-book", "wrong-book.wxml"),
  style: read("pages", "wrong-book", "wrong-book.wxss"),
  script: read("pages", "wrong-book", "wrong-book.js"),
});

test("04:9x 筛选入口用「图2」那颗漏斗标：assets/icons/filter.svg，而不是自绘的三条横线", () => {
  const { markup, style } = wrongBook();
  assert.match(markup, /class="wrong-filter-button[\s\S]{0,220}<image class="wrong-filter-icon" src="\/assets\/icons\/filter\.svg" mode="aspectFit" \/>/);
  assert.match(markup, /aria-label="筛选"/);
  // 图2 就是收藏页那颗（同一颗标同一功能）——两页引用必须一致，不许各画一个
  assert.match(read("pages", "favorites", "favorites.wxml"), /icons\/filter\.svg/);
  // 不能再退回 CSS 画的三条横线图形（旧实现）
  assert.doesNotMatch(style, /\.wrong-filter-icon::after/);
  assert.doesNotMatch(style, /\.wrong-filter-icon \{[\s\S]{0,120}border-top: 3rpx solid currentColor/);
  const icon = read("assets", "icons", "filter.svg");
  assert.match(icon, /stroke="#474d49"/);
  assert.match(icon, /viewBox="0 0 24 24"/);
});

test("04:9x 状态卡：四张一行、选中态是浅绿底深青字（不再是深底白字）", () => {
  const { style } = wrongBook();
  const tabs = style.match(/\.wrong-status-tabs \{[^}]*\}/)[0];
  // 四等分 + 20rpx 间距（图1：卡间距 21px≙24rpx，取 20rpx 整档）
  assert.match(tabs, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(tabs, /gap: 20rpx;/);

  const card = style.match(/\.wrong-status-tab \{[^}]*\}/)[0];
  assert.match(card, /height: 108rpx;/);          // 图1：96px ≙ 108rpx
  assert.match(card, /border-radius: 20rpx;/);    // 图1：~10px ≙ 20rpx
  assert.match(card, /border: 0;/);               // 效果图里的卡没有描边
  assert.match(style, /\.wrong-status-tab view \{ font-size: 34rpx;/);
  assert.match(style, /\.wrong-status-tab text \{[\s\S]{0,120}font-size: 18rpx;/);

  // 选中态＝浅绿底 + 深青字；深青取 #0b7a6f 而不是效果图的 #0a8f83：#0a8f83 落在 #e4f4f1 上只有 3.51:1，
  // 18rpx 的小字标签够不到 4.5:1（#0b7a6f = 4.60:1）。数字是大字号，两处统一同色。
  const active = style.match(/\.wrong-status-tab-active[^{]*\{[^}]*\}/g).join("\n");
  assert.match(active, /color: #0b7a6f;/);
  assert.match(active, /background: #e4f4f1;/);
  assert.doesNotMatch(style, /\.wrong-status-tab-active \{ color: #fff;/);
});

test("04:9x 分段开关（原「按科目整理」标题的位置）：绿框左移取代标题、轨道几何（浅灰轨道 + 白色药丸）", () => {
  const { markup, style, script } = wrongBook();
  // 注释里会写"原来叫《按科目整理》"，用户可见文案只看去掉注释后的结构
  const visible = markup.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(visible, /data-mode="directory" bindtap="selectGroupMode">按科目</);
  assert.match(visible, /data-mode="knowledge" bindtap="selectGroupMode">按知识点</);
  // 产品负责人 04:9x 补充「图1绿框移动到左边取代标题」：标题「按科目整理」必须删掉，开关是这一行的第一个元素
  assert.doesNotMatch(visible, /按科目整理/);
  assert.doesNotMatch(visible, /<view>错题目录<\/view>/);
  assert.doesNotMatch(visible, />按目录</);
  assert.match(visible, /<view class="wrong-directory-head">\s*<view class="wrong-group-modes" wx:if="\{\{!selectedChapter\}\}">/);
  assert.doesNotMatch(visible, /wrong-directory-actions">\s*<view class="wrong-group-modes"/);
  // 选中章节时开关不显示，标题留作语境（开关所在位置改由「章节错题」占位）
  assert.match(visible, /<view class="wrong-directory-title" wx:else>章节错题<\/view>/);
  assert.doesNotMatch(visible, /selectedChapter \? '章节错题'/);
  // 分组模式的取值仍是 directory | knowledge（只改显示文案，不动数据契约）
  assert.match(script, /selectGroupMode\(event\) \{[\s\S]{0,160}groupMode: event\.currentTarget\.dataset\.mode/);

  // 开关与筛选在**同一行**（左开关、右筛选）：底座必须是 flex 行，
  // 竖排只允许出现在 ≤360px 的 @media 里（渲染稿当初把 media 当无条件规则，看截图差点误判成"没在一行"）。
  const head = style.match(/\.wrong-directory-head \{[^}]*\}/)[0];
  assert.match(head, /display: flex;/);
  assert.match(head, /align-items: center;/);
  assert.match(head, /justify-content: space-between;/);
  assert.doesNotMatch(head, /flex-direction: column;/);
  assert.match(style, /@media \(max-width: 360px\) \{[\s\S]{0,60}\.wrong-directory-head \{ align-items: flex-start; flex-direction: column; \}/);
  // 旧的 `> view:first-child` 标题规则会套到开关上（把开关写黑写粗），必须已换成独立 class
  assert.doesNotMatch(style, /\.wrong-directory-head > view:first-child/);
  assert.match(style, /\.wrong-directory-title \{ color: #171a18;/);

  const track = style.match(/\.wrong-group-modes \{[^}]*\}/)[0];  assert.match(track, /padding: 6rpx;/);
  assert.match(track, /background: #edefed;/);
  assert.match(track, /border-radius: 24rpx;/);
  const item = style.match(/\.wrong-group-modes view \{[^}]*\}/)[0];
  assert.match(item, /height: 50rpx;/);
  assert.match(item, /font-size: 20rpx;/);
  assert.match(style, /\.wrong-group-modes \.wrong-group-mode-active \{ color: #171a18; background: #fff;/);
});

test("04:9x 科目列表：每个科目＝独立白卡（不再是「一个大白容器 + 分隔线」）+ 56rpx 淡色圆标", () => {
  const { markup, style } = wrongBook();
  const list = style.match(/\.wrong-group-list \{[^}]*\}/)[0];
  assert.match(list, /flex-direction: column;/);
  assert.match(list, /gap: 12rpx;/);              // 图1：卡间距 10px ≙ 12rpx
  assert.match(list, /background: transparent;/); // 容器本身不再是那张大白底
  assert.match(list, /border: 0;/);

  const card = style.match(/\.wrong-group \{[^}]*\}/)[0];
  assert.match(card, /background: #fff;/);
  assert.match(card, /border-radius: 20rpx;/);
  assert.match(card, /overflow: hidden;/);        // 展开的子列表要被卡角裁住
  assert.match(card, /border: 0;/);
  assert.doesNotMatch(style, /\.wrong-group \{ border-bottom: 1rpx solid #e6e9e6; \}/);   // 分隔线方案已废弃
  assert.doesNotMatch(style, /\.wrong-group:last-child \{ border-bottom: 0; \}/);

  const row = style.match(/\.wrong-group-row \{[^}]*\}/)[0];
  assert.match(row, /min-height: 112rpx;/);       // 图1：100px ≙ 112rpx
  assert.match(row, /padding: 0 20rpx;/);
  assert.match(style, /\.wrong-group-arrow \{[\s\S]{0,140}width: 56rpx; height: 56rpx;/);  // 图1：直径 50px ≙ 56rpx
  assert.match(style, /\.wrong-group-arrow \{[\s\S]{0,200}margin-right: 24rpx;/);

  assert.match(markup, /class="wrong-group-list" wx:elif="\{\{groups\.length\}\}"/);
  assert.match(markup, /class="wrong-group" wx:for="\{\{groups\}\}" wx:key="id"/);
});

test("04:9x 圆标＝学科色淡底 + 加深档同色箭头：行内只传一个色，淡底由 CSS 用 currentColor 铺", () => {
  const { markup, style } = wrongBook();
  // 行内色改成 color（原来给的是 background）——淡底/箭头都由这一个色派生
  assert.match(markup, /<view class="wrong-group-arrow" style="color: \{\{item\.colorDeep\}\};"><view class="\{\{item\.expanded \? 'wrong-group-arrow-open' : ''\}\}"><\/view><\/view>/);
  assert.doesNotMatch(markup, /style="background: \{\{item\.color\}\};"/);
  assert.match(style, /\.wrong-group-arrow::before \{[\s\S]{0,200}background: currentColor;[\s\S]{0,60}opacity: \.13;/);
  assert.match(style, /\.wrong-group-arrow view \{[\s\S]{0,200}border-right: 3rpx solid currentColor;/);
  assert.doesNotMatch(style, /\.wrong-group-arrow view \{[\s\S]{0,200}border-right: 3rpx solid #fff;/);   // 白箭头方案已废弃
  assert.match(style, /\.wrong-group-arrow \.wrong-group-arrow-open \{[\s\S]{0,60}rotate\(225deg\);/);
});

test("04:9x 圆标箭头色（colorDeep）在淡底上必须够对比：六个学科色都 ≥3:1，否则标签看不清", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index}`,
    subjectId: `subject-${index}`,
    subjectName: `科目${index}`,
    chapter: `第${index}章`,
    knowledgePoint: `知识点${index}`,
  }));
  const attempts = questions.map((question, index) => ({ questionId: question.id, question, isCorrect: false, createdAt: 1000 - index }));
  const view = buildWrongBookView({ officialQuestions: questions, attempts, statusKey: "history", groupMode: "directory" });
  assert.equal(view.groupList.length, 6);

  const hex = (value) => [1, 3, 5].map((i) => parseInt(value.substr(i, 2), 16));
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const x = lum(hex(a));
    const y = lum(hex(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const overWhite = (value, alpha) => `#${hex(value).map((v) => Math.round(255 - alpha * (255 - v)).toString(16).padStart(2, "0")).join("")}`;

  view.groupList.forEach((group) => {
    assert.match(group.colorDeep, /^#[0-9a-f]{6}$/);
    assert.notEqual(group.colorDeep, group.color);                       // 必须真的加深过
    assert.ok(contrast(group.colorDeep, overWhite(group.colorDeep, 0.13)) >= 3, `${group.label} 箭头在淡底上对比度不足`);
  });
});

test("04:9x 科目行文字与右侧计数：科目名更深、计数是中性灰（不再是偏蓝的 #718095）", () => {
  const { style } = wrongBook();
  assert.match(style, /\.wrong-group-main view \{[\s\S]{0,140}color: #202522;[\s\S]{0,60}font-size: 24rpx;/);
  assert.match(style, /\.wrong-group-count \{ margin-left: 12rpx; color: #717873; font-size: 20rpx; \}/);
});

test("04:9x 筛选面板/标签/空态/章节态都还在（改版只动外观，不动这些链路）", () => {
  const { markup, style, script } = wrongBook();
  assert.match(markup, /class="wrong-filter-layer"/);
  assert.match(markup, /class="wrong-filter-footer"[\s\S]{0,220}重置[\s\S]{0,120}应用筛选/);
  assert.match(markup, /class="wrong-filter-tags" scroll-x="true" wx:if="\{\{filterTags\.length\}\}"/);
  assert.match(markup, /class="wrong-empty" wx:else>/);
  assert.match(markup, /class="wrong-book-tip" wx:if="\{\{!selectedChapter\}\}"/);
  assert.match(markup, /class="wrong-chapter-focus"[\s\S]{0,400}arrow-left\.svg/);
  for (const handler of ["selectStatus", "selectGroupMode", "toggleGroup", "openChapter", "closeChapter", "startGroupReview", "startQuestionReview", "openFilterPanel", "closeFilterPanel", "resetDraftFilters", "applyFilters", "toggleDraftFilter", "removeFilterTag"]) {
    assert.match(markup, new RegExp(`bindtap="${handler}"`), `缺少交互入口：${handler}`);
  }
  assert.match(script, /closeTransientLayers\(this, \["filterPanelOpen"\]\)/);
});

test("04:9x 顺带修：浅青底按钮上那圈小程序 button::after 默认细边框要清掉（否则是一圈多余的灰框）", () => {
  const { style, markup } = wrongBook();
  assert.match(markup, /<button class="wrong-group-review"/);
  assert.match(style, /\.wrong-group-review::after \{ border: 0; \}/);
});
