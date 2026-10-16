const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "styles.css"), "utf8");

// DEC-105 removes the independent adjudication tab; existing production workflows remain.
// DEC-092：盲测金标由「AI 巡检」子标签提升为平级子标签（6 → 7），并整块删除原来的子标签机制。
// 「题目完善」保留在原题库中，审核入口不再绕经汇总页。
// 本文件只做源码契约断言；真实行为由无头浏览器脚本验证（见各条注释里的脚本名）。

test("question library tabs: 含完善题目、AI 巡检、盲测金标，且相对顺序正确", () => {
  const tabs = [...htmlSource.matchAll(/data-question-library-tab="([a-z-]+)"/g)].map((match) => match[1]);
  // 用"子序列"断言而不是整表相等：本项目有多个会话并行推进，别人随时可能插入新标签
  // （例如已在并行加入的 authoring）。这里只锁 DEC-092 要求的**相对顺序**，不把整张表写死，
  // 免得互相绊倒；少一个或顺序错了仍然会失败。
  const expected = ["library", "dossiers", "enrichment", "inspections", "gold-review", "rules"];
  let cursor = -1;
  for (const tab of expected) {
    const at = tabs.indexOf(tab, cursor + 1);
    assert.ok(at > cursor, `标签 ${tab} 缺失或顺序不对；实际顺序=${JSON.stringify(tabs)}`);
    cursor = at;
  }
  assert.match(htmlSource, /id="question-enrichment-panel"/);
  // DEC-092：金标页搬进自己的平级面板
  assert.match(htmlSource, /<section class="blind-gold-review-panel" id="blind-gold-review-panel" hidden/);
  assert.match(htmlSource, /id="blind-gold-review-page"/);
});

test("question library tabs: DEC-092 拆出盲测金标，原子标签机制整块删除（不留双入口）", () => {
  // 子标签行、状态、切换函数、点击监听全清干净
  assert.doesNotMatch(htmlSource, /knowledge-inspection-subtabs/);
  assert.doesNotMatch(htmlSource, /data-knowledge-inspection-subtab/);
  assert.doesNotMatch(appSource, /knowledgeInspectionSubtab/);
  assert.doesNotMatch(appSource, /setKnowledgeInspectionSubtab/);
  // 金标页不再自带 hidden（否则面板 + 内层两层 hidden 叠加，永远显示不出来）
  assert.match(htmlSource, /<div class="blind-gold-review-page" id="blind-gold-review-page">/);
  // 页面显隐的唯一来源是 state.questionLibraryTab
  assert.match(appSource, /document\.querySelector\("#blind-gold-review-panel"\)\.hidden = state\.questionLibraryTab !== "gold-review";/);
  assert.match(appSource, /if \(state\.questionLibraryTab === "gold-review"\) return loadBlindGoldReviewSets\(\);/);
  // 「AI 巡检」标签只留巡检建议
  assert.match(appSource, /if \(state\.questionLibraryTab === "inspections"\) return loadKnowledgeInspections\(\);/);
});

test("question library tabs: 题目完善已从一级导航移除，旧入口落到子标签", () => {
  assert.doesNotMatch(htmlSource, /data-view="题目完善"/);
  // 旧的顶层视图必须已经不在了（内容已搬进面板）
  assert.doesNotMatch(htmlSource, /id="question-enrichment"/);
  assert.doesNotMatch(appSource, /#question-enrichment"\)/);
  assert.doesNotMatch(appSource, /\b(?:const|let)\s+isQuestionEnrichment\s*=/);
  // 兼容：旧名字进来时落到 题库管理 → 完善题目
  assert.match(appSource, /const requestedEnrichment = name === "题目完善";/);
  assert.match(appSource, /if \(requestedEnrichment\) name = "题库管理";/);
  assert.match(appSource, /if \(requestedEnrichment\) state\.questionLibraryTab = "enrichment";/);
});

test("question library tabs: 切换器认新标签、按标签加载，四个工作流/基准面板都隐藏知识树", () => {
  // 抽取数组字面量做"成员包含"断言，而不是整表相等 —— 多会话并行时别人会往同一行加标签
  //（例如已并入的 authoring），整表写死会互相绊倒；少一个必需成员仍然会失败。
  const literalAfter = (marker, fromIndex = 0) => {
    const start = appSource.indexOf(marker, fromIndex);
    assert.ok(start > 0, `未找到锚点 ${marker}`);
    const from = appSource.indexOf("[", start);
    const to = appSource.indexOf("]", from);
    return appSource.slice(from, to + 1);
  };
  const whitelist = literalAfter("const nextTab = ");
  for (const tab of ["library", "dossiers", "enrichment", "inspections", "gold-review", "rules"]) {
    assert.match(whitelist, new RegExp(`"${tab}"`), `标签白名单应包含 ${tab}；实际=${whitelist}`);
  }
  // The teaching-standard subview also toggles the tree; inspect the tab switcher itself.
  const tabSwitcherStart = appSource.indexOf("function setQuestionLibraryTab(");
  assert.ok(tabSwitcherStart >= 0);
  const hiddenList = literalAfter('"without-knowledge-tree",', tabSwitcherStart);
  for (const tab of ["inspections", "gold-review", "enrichment"]) {
    assert.match(hiddenList, new RegExp(`"${tab}"`), `隐藏知识树的标签应包含 ${tab}；实际=${hiddenList}`);
  }
  const officialOnly = literalAfter("官方题库下有意义");
  for (const tab of ["inspections", "gold-review", "dossiers", "enrichment"]) {
    assert.match(officialOnly, new RegExp(`"${tab}"`), `仅官方题库可见的标签应包含 ${tab}；实际=${officialOnly}`);
  }
  assert.match(appSource, /document\.querySelector\("#question-enrichment-panel"\)\.hidden = state\.questionLibraryTab !== "enrichment";/);
  assert.match(appSource, /if \(state\.questionLibraryTab === "enrichment"\) return loadQuestionEnrichment\(\);/);
  assert.match(appSource, /\.forEach\(\(key\) => \{/);
});


test("DEC-105 removes the adjudication panel, links, state and stylesheet", () => {
  assert.doesNotMatch(htmlSource, /adjudication/);
  assert.doesNotMatch(appSource, /adjudication|Adjudication/);
  assert.doesNotMatch(stylesSource, /adjudication/);
});
