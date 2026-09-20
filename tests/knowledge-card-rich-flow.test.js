const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CLOZE_COLOR,
  answerSegmentsFromDelta,
  applyAttributesToRanges,
  plainTextToDelta,
} = require("../apps/miniprogram/utils/card-rich-content");

let definition;
global.Page = (value) => { definition = value; };
const pageModule = require("../apps/miniprogram/pages/knowledge-card/knowledge-card.js");

function createPage(card) {
  const page = { ...definition, data: { ...definition.data, card } };
  page.setData = function setData(patch) { Object.assign(this.data, patch); };
  return page;
}

// DEC-088：知识卡支持左右滑动切换卡片（竖向滑动仍交给滚动，到头给提示不循环）。
test("cards can be switched with a horizontal swipe", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge-card/knowledge-card.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge-card/knowledge-card.wxss"), "utf8");
  assert.match(markup, /class="card-shell \{\{slideDirection \? 'card-slide-' \+ slideDirection : ''\}\}"/);
  assert.match(markup, /bindtouchstart="handleCardSwipeStart"[\s\S]{0,120}bindtouchend="handleCardSwipeEnd"/);
  assert.match(markup, /轻点卡片查看答案 · 左右滑动切换卡片/);
  assert.match(styles, /\.card-slide-left\{animation:card-in-left/);
  assert.match(styles, /@keyframes card-in-right\{from\{opacity:\.25;transform:translateX\(-56rpx\)/);
  // 位置提示在右上角（与面包屑同一行），只有一张卡时不显示
  assert.match(markup, /<view class="crumb-row">[\s\S]{0,160}class="crumb">\{\{setTitle\}\} · \{\{card\.section\}\}<\/view>[\s\S]{0,200}class="crumb-position" wx:if="\{\{cardTotal > 1\}\}"[\s\S]{0,80}\{\{cardIndex \+ 1\}\} \/ \{\{cardTotal\}\}/);
  assert.match(styles, /\.crumb-row\{display:flex[^}]*justify-content:space-between/);
  assert.match(styles, /\.crumb-position\{[^}]*font-variant-numeric:tabular-nums/);

  const toasts = [];
  global.wx = { showToast: (options) => toasts.push(options.title) };
  const page = createPage({ id: "c-1", type: "qa", question: "一", section: "目录" });
  page.cardIds = ["c-1", "c-2", "c-3"];
  const loaded = [];
  page.loadCard = (options) => loaded.push({ cardId: page.cardId, ...(options || {}) });

  // 第一张再向右滑 → 提示，不切卡
  page.handleCardSwipeStart({ touches: [{ clientX: 200, clientY: 300 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 320, clientY: 305 }] });
  assert.equal(toasts[0], "已经是第一张卡片");
  assert.deepEqual(loaded, []);

  // 向左滑 → 下一张，并重置正反面、带左滑入动效
  page.handleCardSwipeStart({ touches: [{ clientX: 300, clientY: 300 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 180, clientY: 306 }] });
  assert.equal(page.cardId, "c-2");
  assert.deepEqual(loaded, [{ cardId: "c-2", resetFace: true, slide: "left" }]);

  // 竖向滑动（幅度更大）不切卡
  page.handleCardSwipeStart({ touches: [{ clientX: 300, clientY: 100 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 250, clientY: 420 }] });
  assert.equal(loaded.length, 1);

  // 幅度不够（< 60px）不切卡
  page.handleCardSwipeStart({ touches: [{ clientX: 300, clientY: 100 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 282, clientY: 104 }] });
  assert.equal(loaded.length, 1);

  // 向右滑回上一张
  page.data.cardIndex = 1;
  page.handleCardSwipeStart({ touches: [{ clientX: 180, clientY: 300 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 300, clientY: 302 }] });
  assert.deepEqual(loaded[1], { cardId: "c-1", resetFace: true, slide: "right" });

  // 最后一张再向左滑 → 提示
  page.cardId = "c-3";
  page.data.cardIndex = 2;
  page.handleCardSwipeStart({ touches: [{ clientX: 300, clientY: 100 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 150, clientY: 104 }] });
  assert.equal(toasts[toasts.length - 1], "已经是最后一张卡片");

  // 只有一张卡片时给另一句提示
  page.cardIds = ["c-9"];
  page.handleCardSwipeStart({ touches: [{ clientX: 300, clientY: 100 }] });
  page.handleCardSwipeEnd({ changedTouches: [{ clientX: 150, clientY: 104 }] });
  assert.equal(toasts[toasts.length - 1], "这个卡集只有一张卡片");
});

test("note cards read as title plus scrollable content instead of a flip card", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge-card/knowledge-card.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge-card/knowledge-card.wxss"), "utf8");

  // 笔记卡：上方标题 + 下方内容（可滚动），没有"轻点查看答案"这种正反面提示。
  assert.match(markup, /<view class="side note-side" wx:if="\{\{card\.type === 'note'\}\}">/);
  assert.match(markup, /<view class="question note-title">\{\{card\.question\}\}<\/view>/);
  assert.match(markup, /<scroll-view class="note-body" scroll-y="true">/);
  assert.match(styles, /\.note-body\{[^}]*max-height:[^}]*\}/);
  // 提示 / 口诀 / 翻页 / 掌握度只对问答卡与主题卡显示。
  assert.match(markup, /<view wx:if="\{\{card\.type !== 'note'\}\}" bindtap="hint">/);
  assert.match(markup, /<view wx:if="\{\{card\.type !== 'note'\}\}" bindtap="toggleMnemonic">/);
  assert.match(markup, /<view wx:if="\{\{card\.type !== 'note'\}\}" bindtap="flip">/);
  assert.match(markup, /<view class="mastery" wx:if="\{\{card\.type !== 'note' && flipped\}\}">/);

  // 点卡片也不能把笔记卡翻过去。
  const notePage = createPage({ id: "n1", type: "note", question: "标题", section: "目录" });
  notePage.flip();
  assert.equal(notePage.data.flipped, false);
  const qaPage = createPage({ id: "q1", type: "qa", question: "问题", section: "目录" });
  qaPage.flip();
  assert.equal(qaPage.data.flipped, true);
});

test("card back prefers sanitized rich HTML and falls back to escaped plain text", () => {
  const rich = pageModule.studyCard({
    answer: "纯文本答案",
    answerHtml: '<p onclick="steal()"><strong>重点</strong><a href=javascript:steal()>链接</a><script>alert(1)</script></p>',
  });
  assert.equal(rich.answerNodes, "<p><strong>重点</strong><a>链接</a></p>");

  const legacy = pageModule.studyCard({ answer: "第一行 <重点>\n第二行" });
  assert.equal(legacy.answerNodes, "<p>第一行 &lt;重点&gt;</p><p>第二行</p>");

  const indented = pageModule.studyCard({ answer: "  保留缩进\n第二行\n" });
  assert.equal(indented.answer, "  保留缩进\n第二行");
});

test("answer text and cloze segments remain compatible with delta-only cards", () => {
  const card = pageModule.studyCard({
    answerDelta: { ops: [
      { insert: "第一点：" },
      { insert: "关键词", attributes: { underline: true, color: "#168fd8" } },
      { insert: "。\n" },
    ] },
  });
  assert.equal(card.answer, "第一点：关键词。");
  assert.equal(card.answerSegments.some((segment) => segment.cloze && segment.text === "关键词"), true);
});

test("three hint clicks use structured progressive hints and ignore legacy hint points", () => {
  const answer = [
    "1.教师要引导学生学会观察，丰富学生的表象存储",
    "2.教师要积极引导学习思考，打开学生想象力的大门",
    "3.教师要引导学生努力学习科学文化知识，扩大学生的知经以发展学生的空间想象能力",
    "4.教师要注意发展学生的语言能力",
    "5.教师要结合科学教学，有目的地训练学生的想象力",
    "6.教师要引导学生进行积极的幻想",
  ].join("\n");
  const phrases = ["表象存储", "想象力的大门", "空间想象能力", "语言能力", "想象力", "积极的幻想"];
  const ranges = phrases.map((phrase) => {
    const start = answer.lastIndexOf(phrase);
    return { start, end: start + phrase.length };
  });
  const answerDelta = applyAttributesToRanges(
    plainTextToDelta(answer),
    ranges,
    { underline: true, color: CLOZE_COLOR },
  );
  const card = pageModule.studyCard({
    id: "many-points",
    answer,
    answerDelta,
    hints: ["旧提示不应出现"],
    answerSegments: answerSegmentsFromDelta(answerDelta),
  });
  const page = createPage(card);
  page.hint();
  const first = page.data.hintLines;
  page.hint();
  const second = page.data.hintLines;
  page.hint();
  const third = page.data.hintLines;

  const visibleText = (line) => line.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  assert.deepEqual(first.map((line) => `${line.marker}${visibleText(line)}`), ["1.", "2.", "3.", "4.", "5.", "6."]);
  assert.equal(JSON.stringify(first).includes("旧提示不应出现"), false);
  assert.notDeepEqual(second, first);
  assert.notDeepEqual(third, second);
  assert.equal(page.data.hintLevel, 3);
});

test("knowledge card markup uses rich text and adaptive answer and hint areas", () => {
  const pageDir = path.join(__dirname, "../apps/miniprogram/pages/knowledge-card");
  const markup = fs.readFileSync(path.join(pageDir, "knowledge-card.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(pageDir, "knowledge-card.wxss"), "utf8");
  assert.match(markup, /<rich-text class="answer answer-rich" nodes="\{\{card\.answerNodes\}\}">/);
  assert.doesNotMatch(markup, /\{\{card\.answer\}\}/);
  assert.match(markup, /wx:for="\{\{hintLines\}\}"/);
  assert.match(
    markup,
    /<text class="hint-parts">\s*<text class="\{\{part\.type === 'gap' \? 'hint-gap' : 'hint-fragment'\}\}" wx:for="\{\{line\.parts\}\}" wx:key="key" wx:for-item="part"[^>]*>\{\{part\.text\}\}<\/text>\s*<\/text>/,
  );
  assert.doesNotMatch(markup, /<block wx:for="\{\{line\.parts\}\}"/);
  assert.doesNotMatch(markup, /<view class="hint-gap/);
  assert.match(styles, /\.hint-card\{height:auto;max-height:none\}/);
  assert.match(styles, /\.answer-rich\{[^}]*overflow-wrap:anywhere/);
  const gapRule = styles.match(/\.hint-gap\{([^}]*)\}/);
  const partsRule = styles.match(/\.hint-parts\{([^}]*)\}/);
  assert.ok(gapRule, "hint gaps have one shared inline text style");
  assert.ok(partsRule, "hint parts have one shared inline flow style");
  assert.doesNotMatch(partsRule[1], /flex-wrap/);
  assert.match(gapRule[1], /color:transparent/);
  assert.match(gapRule[1], /(?:text-decoration[^;]*underline|border-bottom)/);
  assert.match(gapRule[1], /text-decoration-color:[^;}]+/);
  assert.doesNotMatch(gapRule[1], /display:inline-block|(?:^|;)width:|flex:/);
  assert.doesNotMatch(styles, /\.hint-gap-[2-8]\b/);
});

test("the source question bar shows a summary and opens the full question on demand", () => {
  const markup = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge-card/knowledge-card.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../apps/miniprogram/pages/knowledge-card/knowledge-card.wxss"), "utf8");

  // 默认只有一条细栏（题干摘要 + 详情），没有题目 id 的卡片不显示。
  assert.match(markup, /<view class="source-bar" wx:if="\{\{card\.questionId\}\}" bindtap="openQuestionSource"/);
  assert.match(markup, /\{\{card\.questionStem \|\| card\.question\}\}/);
  assert.match(markup, /<view class="source-layer" wx:if="\{\{questionSourceOpen\}\}"/);
  assert.match(markup, /class="source-practice" bindtap="goToPracticeQuestion">去刷题看整道题</);
  assert.match(styles, /\.source-layer\{position:fixed/);
  // scroll-view 自带 width:100%，加了 padding 必须配 box-sizing，否则正文往右撑出对话框。
  assert.match(styles, /\.source-scroll\{[^}]*width:100%[^}]*box-sizing:border-box[^}]*\}/);
  // 底部两个按钮沿用其它弹窗的等分网格写法，不依赖微信 button 的默认整宽。
  assert.match(styles, /\.source-actions\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)[^}]*\}/);
  assert.match(styles, /\.source-actions button\{[^}]*display:flex[^}]*align-items:center[^}]*justify-content:center[^}]*\}/);
  assert.doesNotMatch(styles, /\.source-dismiss\{[^}]*flex:0 0 auto/);
  // 题干与选项在窄屏要能换行，不能横向溢出。
  assert.match(styles, /\.source-stem\{[^}]*word-break:break-word[^}]*\}/);
  assert.match(styles, /\.source-option label\{[^}]*word-break:break-word[^}]*\}/);

  // 点开才去回查整道题：选项与参考答案进入弹层。
  const requests = [];
  let navigatedUrl = "";
  global.getApp = () => ({ globalData: { apiBaseUrl: "http://127.0.0.1:3212" } });
  global.wx = {
    request(options) {
      requests.push(options.url);
      options.success({
        statusCode: 200,
        data: {
          questions: [{
            id: "question-aaa",
            stem: "下面哪个音节的拼写是正确的？",
            options: [{ key: "A", text: "niou" }, { key: "B", text: "niu" }],
            correctAnswer: ["B"],
            referenceAnswer: "iou 前加声母时写作 iu。",
          }],
        },
      });
    },
    navigateTo: ({ url }) => { navigatedUrl = url; },
  };

  const page = createPage({
    id: "n1", type: "note", question: "音节的拼写规则", section: "第一章语音",
    questionId: "question-aaa", questionStem: "下面哪个音节的拼写是正确的？",
    questionCatalogPath: "第一章语音 > 第五节音节 > 三、音节的拼写规则", bookId: "modern-chinese-7-1", subjectId: "modern-chinese",
  });
  page.openQuestionSource();
  assert.equal(page.data.questionSourceOpen, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/api\/questions\?library=official&query=question-aaa&bookId=modern-chinese-7-1/);
  assert.equal(page.data.questionOptions.length, 2);
  assert.equal(page.data.questionAnswerText, "iou 前加声母时写作 iu。");
  assert.equal(page.data.questionSourceNotice, "");

  page.goToPracticeQuestion();
  assert.equal(page.data.questionSourceOpen, false);
  assert.equal(navigatedUrl, "/pages/practice/practice?questionId=question-aaa&bookId=modern-chinese-7-1&subjectId=modern-chinese");

  // 题目已下线 / 无网络时用卡片上的题干快照兜底，不弹错误。
  global.wx = { request: (options) => options.success({ statusCode: 200, data: { questions: [] } }), navigateTo() {} };
  const offlinePage = createPage({ id: "n2", type: "note", question: "标题", section: "目录", questionId: "question-gone", questionStem: "记录时的题干" });
  offlinePage.openQuestionSource();
  assert.equal(offlinePage.data.questionDetail, null);
  assert.match(offlinePage.data.questionSourceNotice, /先显示记录时的题干/);

  delete global.getApp;
  delete global.wx;
});

test.after(() => {
  delete global.Page;
});
