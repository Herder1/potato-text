const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "apps", "admin", "styles.css"), "utf8");

// 《链路职责矩阵》第十三节：「完善题目」「裁决台」两个子标签（4 → 6）；
// DEC-092：盲测金标由「AI 巡检」子标签提升为平级子标签（6 → 7），并整块删除原来的子标签机制。
// 「题目完善」由一级导航搬进子标签；裁决台是形态 B（只做分流与追溯，不在本页采纳）。
// 本文件只做源码契约断言；真实行为由无头浏览器脚本验证（见各条注释里的脚本名）。

test("question library tabs: 含完善题目、AI 巡检、盲测金标与裁决台，且相对顺序正确", () => {
  const tabs = [...htmlSource.matchAll(/data-question-library-tab="([a-z-]+)"/g)].map((match) => match[1]);
  // 用"子序列"断言而不是整表相等：本项目有多个会话并行推进，别人随时可能插入新标签
  // （例如已在并行加入的 authoring）。这里只锁 DEC-092 要求的**相对顺序**，不把整张表写死，
  // 免得互相绊倒；少一个或顺序错了仍然会失败。
  const expected = ["library", "dossiers", "enrichment", "inspections", "gold-review", "adjudication", "rules"];
  let cursor = -1;
  for (const tab of expected) {
    const at = tabs.indexOf(tab, cursor + 1);
    assert.ok(at > cursor, `标签 ${tab} 缺失或顺序不对；实际顺序=${JSON.stringify(tabs)}`);
    cursor = at;
  }
  assert.match(htmlSource, /id="question-enrichment-panel"/);
  assert.match(htmlSource, /id="adjudication-panel"/);
  assert.match(htmlSource, /id="adjudication-table-body"/);
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
  assert.doesNotMatch(appSource, /isQuestionEnrichment/);
  // 兼容：旧名字进来时落到 题库管理 → 完善题目
  assert.match(appSource, /const requestedEnrichment = name === "题目完善";/);
  assert.match(appSource, /if \(requestedEnrichment\) name = "题库管理";/);
  assert.match(appSource, /if \(requestedEnrichment\) state\.questionLibraryTab = "enrichment";/);
});

test("question library tabs: 切换器认新标签、按标签加载，四个工作流/基准面板都隐藏知识树", () => {
  // 抽取数组字面量做"成员包含"断言，而不是整表相等 —— 多会话并行时别人会往同一行加标签
  //（例如已并入的 authoring），整表写死会互相绊倒；少一个必需成员仍然会失败。
  const literalAfter = (marker) => {
    const start = appSource.indexOf(marker);
    assert.ok(start > 0, `未找到锚点 ${marker}`);
    const from = appSource.indexOf("[", start);
    const to = appSource.indexOf("]", from);
    return appSource.slice(from, to + 1);
  };
  const whitelist = literalAfter("state.questionLibraryTab = ");
  for (const tab of ["library", "dossiers", "enrichment", "inspections", "gold-review", "adjudication", "rules"]) {
    assert.match(whitelist, new RegExp(`"${tab}"`), `标签白名单应包含 ${tab}；实际=${whitelist}`);
  }
  const hiddenList = literalAfter('"without-knowledge-tree",');
  for (const tab of ["inspections", "gold-review", "enrichment", "adjudication"]) {
    assert.match(hiddenList, new RegExp(`"${tab}"`), `隐藏知识树的标签应包含 ${tab}；实际=${hiddenList}`);
  }
  const officialOnly = literalAfter("官方题库下有意义");
  for (const tab of ["inspections", "gold-review", "dossiers", "enrichment", "adjudication"]) {
    assert.match(officialOnly, new RegExp(`"${tab}"`), `仅官方题库可见的标签应包含 ${tab}；实际=${officialOnly}`);
  }
  assert.match(appSource, /document\.querySelector\("#question-enrichment-panel"\)\.hidden = state\.questionLibraryTab !== "enrichment";/);
  assert.match(appSource, /document\.querySelector\("#adjudication-panel"\)\.hidden = state\.questionLibraryTab !== "adjudication";/);
  assert.match(appSource, /if \(state\.questionLibraryTab === "enrichment"\) return loadQuestionEnrichment\(\);/);
  assert.match(appSource, /if \(state\.questionLibraryTab === "adjudication"\) return loadAdjudicationQueue\(\);/);
  assert.match(appSource, /\.forEach\(\(key\) => \{/);
});

test("adjudication view: 只做分流与追溯，来源筛选由接口数据动态渲染", () => {
  // 形态 B 的边界：本页不得直接采纳/驳回（那是形态 C，明确不做）
  assert.doesNotMatch(appSource, /data-adjudication-action="(?:apply|reject)"/);
  assert.match(appSource, /function adjudicateJump\(entryId\)/);
  assert.match(appSource, /await openQuestionEnrichmentReview\(entry\.questionId\);/);
  assert.match(appSource, /openKnowledgeInspection\(entry\.id, entry\.questionId\);/);
  // 来源选项来自接口的 sourceOptions：第三条产线接入时界面结构不变
  assert.match(appSource, /function renderAdjudicationSourceOptions\(sourceOptions = \[\]\)/);
  assert.match(appSource, /renderAdjudicationSourceOptions\(sourceOptions\);/);
  assert.match(htmlSource, /<select id="adjudication-source"><option value="all">全部来源<\/option><\/select>/);
  // 状态筛选项固定在三条统一词汇上
  assert.match(htmlSource, /<option value="recommended">待处理<\/option><option value="applied">已采纳<\/option><option value="rejected">已驳回<\/option>/);
});

test("adjudication entry points: 两条产线页都标注了来源并能跳到裁决台（强约束切换前的那一步）", () => {
  // 两个产线页各有一处页头标注，文案一致
  assert.equal([...htmlSource.matchAll(/这些建议也会出现在「裁决台」/g)].length, 2);
  // 用 document 级代理（表格行是动态渲染的，静态注册抓不到新行）；行内入口带题号用于过去后预筛选
  assert.match(appSource, /document\.addEventListener\("click", \(event\) => \{\s*\n\s*const button = event\.target\.closest\("\[data-open-adjudication\]"\);/);
  assert.match(appSource, /if \(search\) search\.value = questionId;/);
  // 两个产线页的表格行内出口都带上题号
  assert.match(appSource, /data-open-adjudication="\$\{escapeHtml\(item\.question\.id\)\}"/);
  assert.match(appSource, /data-open-adjudication="\$\{escapeHtml\(question\.id \|\| result\.questionId \|\| ""\)\}"/);
  assert.match(stylesSource, /\.adjudication-hint\s*\{/);
});
