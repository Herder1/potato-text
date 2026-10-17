const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { applyDataPatch } = require("./helpers/set-data");
const {
  GENDER_CHOICES,
  AGE_BAND_CHOICES,
  EXAM_YEAR_SPAN,
} = require("../apps/api/src/user-auth-store");
const {
  GENDER_OPTIONS,
  AGE_BAND_OPTIONS,
  EXAM_YEAR_SPAN: CLIENT_YEAR_SPAN,
  examYearOptions,
  projectOptionsFromCatalog,
  ONBOARDING_SKIP_KEY,
  PRIVACY_AGREED_KEY,
  firstMissingField,
  onboardingPatch,
} = require("../apps/miniprogram/utils/onboarding-options");

// 注册引导层（2026-10-03 产品负责人确认）：冷启动拦一次 + 四项必填（性别 / 年龄段 / 目标考试项目 / 报考年份）
// +「先随便看看」。这里锁的是"契约与行为"，不是界面壳：
//   ① 客户端档位必须与服务端 GENDER_CHOICES / AGE_BAND_CHOICES / EXAM_YEAR_SPAN 一一对应（防两端写歪）；
//   ② 四项没填全不得发请求；③ 登录成功但没填全 → 就地展开表单，已填全 → 直接进首页；
//   ④ 提交只带这四项（头像昵称选填才带）；⑤「先随便看看」只写本机标记，不写任何账号数据。
const PAGE_PATH = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding", "onboarding.js");

function createHarness(options = {}) {
  const store = new Map();
  const calls = { switchTab: [], reLaunch: [], requests: [], toasts: [], savedPatches: [], login: 0, privacyContract: 0 };
  const app = {
    globalData: { apiBaseUrl: "https://api.example.test", loggedIn: false, user: {} },
    loginWithWechat(callback) {
      calls.login += 1;
      callback(options.loginUser || null, options.loginUser ? "" : "wechat_login_failed");
    },
    saveProfile(patch, callback) {
      calls.savedPatches.push(patch);
      if (options.saveFails) { callback(null, options.saveFails); return; }
      callback({ ...app.globalData.user, ...patch }, "");
    },
    avatarDataUrl: () => Promise.resolve(options.avatarResult || { dataUrl: "data:image/png;base64,AAA" }),
  };
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => store.get(key) || "",
    setStorageSync: (key, value) => store.set(key, value),
    removeStorageSync: (key) => store.delete(key),
    switchTab: ({ url }) => calls.switchTab.push(url),
    reLaunch: ({ url }) => calls.reLaunch.push(url),
    showToast: ({ title }) => calls.toasts.push(title),
    showLoading: () => {},
    hideLoading: () => {},
    getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 375, windowHeight: 812 }),
    // 2026-10-17 第十八次调整：顶部那一行要按微信胶囊实测值对齐；
    // menuRect: null 用来模拟"旧基础库拿不到胶囊矩形"的回退分支。
    getMenuButtonBoundingClientRect: () => (options.menuRect === null
      ? undefined
      : (options.menuRect || { top: 28, height: 32, left: 281, right: 368, width: 87, bottom: 60 })),
    openPrivacyContract: () => { calls.privacyContract += 1; },
    request: (request) => {
      calls.requests.push(request.url);
      if (options.catalogFailure) { request.fail && request.fail({ errMsg: "request:fail" }); return; }
      request.success && request.success({ statusCode: 200, data: options.catalog || { projects: [{ id: "gd-zsb-hyy", name: "广东专升本 · 汉语言文学学科基础", region: "广东", examType: "普通专升本" }] } });
    },
  };
  return { app, store, calls };
}

function loadPage(harness) {
  let definition;
  global.Page = (value) => { definition = value; };
  delete require.cache[require.resolve(PAGE_PATH)];
  require(PAGE_PATH);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = function setData(patch, callback) {
    applyDataPatch(this.data, patch);
    if (callback) callback();
  };
  return page;
}

function withPage(options, run) {
  const harness = createHarness(options);
  const previousPage = global.Page;
  const previousGetApp = global.getApp;
  try {
    const page = loadPage(harness);
    run(page, harness);
  } finally {
    delete require.cache[require.resolve(PAGE_PATH)];
    if (previousPage === undefined) delete global.Page; else global.Page = previousPage;
    if (previousGetApp === undefined) delete global.getApp; else global.getApp = previousGetApp;
    delete global.wx;
  }
}

function tap(page, field, id) {
  page.selectOption({ currentTarget: { dataset: { field, id } } });
}

/**
 * 第 2 步现在是生日三列滚轮（2026-10-17 第八次调整），不再是年龄段胶囊。
 * 这里按真实 bindchange 的形状喂 `{ detail: { value: [年索引, 月索引, 日索引] } }`。
 */
function pickBirthday(page, year, month, day) {
  const yearIndex = page.data.birthYears.indexOf(year);
  // 2026-10-17 第十七次调整：月/日两列改成"重复 WHEEL_LOOP_COPIES 份"的循环缓冲，
  // 数组里同一个数字会出现多次，所以索引要落到中段（与 initBirthdayWheels 的初始位置一致）。
  const monthIndex = page.data.birthMonths.indexOf(month, 12 * 2);
  const dayIndex = page.data.birthDays.indexOf(day, page.data.birthDaySpan * 2);
  assert.ok(yearIndex >= 0, `生日年 ${year} 必须在滚轮范围内`);
  assert.ok(monthIndex >= 0, `生日月 ${month} 必须在滚轮范围内`);
  assert.ok(dayIndex >= 0, `生日日 ${day} 必须在滚轮范围内`);
  page.onBirthdayChange({ detail: { value: [yearIndex, monthIndex, dayIndex] } });
}

/** 引导页的登录闸门要求先勾选隐私授权：测试里统一先同意再登录。 */
function agreeAndLogin(page) {
  page.toggleAgree();
  page.login();
}

test("login is blocked until the privacy guide is agreed, and agreeing is remembered on this device", () => {
  withPage({ loginUser: { id: "u9", onboardingCompleted: true } }, (page, harness) => {
    page.onLoad();
    page.login();
    assert.equal(harness.calls.login, 0, "没勾选不得发起登录：登录就要收 openid");
    assert.match(page.data.hint, /隐私保护指引/);
    assert.deepEqual(harness.calls.switchTab, []);
    assert.equal(harness.store.get(PRIVACY_AGREED_KEY), undefined, "没同意就不该留下标记");

    page.openPrivacyContract();
    assert.equal(harness.calls.privacyContract, 1, "《指引》要能打开微信里的官方文本");

    agreeAndLogin(page);
    assert.equal(harness.calls.login, 1);
    assert.equal(harness.store.get(PRIVACY_AGREED_KEY), true, "同意标记只写本机");
    assert.equal(harness.calls.switchTab.at(-1), "/pages/review/review");
  });
});

test("client onboarding choices stay in step with the server contract", () => {
  assert.deepEqual(GENDER_OPTIONS.map((option) => option.id), GENDER_CHOICES);
  assert.deepEqual(AGE_BAND_OPTIONS.map((option) => option.id), AGE_BAND_CHOICES);
  assert.equal(CLIENT_YEAR_SPAN, EXAM_YEAR_SPAN, "年份跨度两端必须一致，否则会出现「客户端能选、服务端拒绝」");
  // 每个档位都要有中文标签，避免真机上出现裸码值。
  [...GENDER_OPTIONS, ...AGE_BAND_OPTIONS].forEach((option) => assert.ok(option.label, `${option.id} 缺标签`));
});

// 2026-10-17 产品负责人口径：只给 4 档——今年是 25 年就 2025–2028，今年是 26 年就 2026–2029。
test("exam year options are exactly four chips: this year plus the next three", () => {
  const now = new Date("2026-05-01T00:00:00+08:00").getTime();
  const options = examYearOptions(now);
  assert.deepEqual(options.map((option) => option.id), ["2026", "2027", "2028", "2029"]);
  assert.equal(options.length, 4, "只保留 4 个年份档位");
  // 2026-10-17 第十五次调整（产品负责人：「去掉这个今年」）：四档一律只显示「YYYY 年」。
  assert.deepEqual(options.map((option) => option.label), ["2026 年", "2027 年", "2028 年", "2029 年"]);
  options.forEach((option) => {
    assert.doesNotMatch(option.label, /今年/, "任何一档都不该再带「今年」");
    assert.doesNotMatch(option.label, /[（(]/, "也不该带任何括号后缀");
  });

  const earlier = examYearOptions(new Date("2025-03-01T00:00:00+08:00").getTime());
  assert.deepEqual(earlier.map((option) => option.id), ["2025", "2026", "2027", "2028"], "跨年后仍从当年起算 4 档");
});

test("the four answers are required before anything is sent", () => {
  assert.equal(firstMissingField({}).key, "gender");
  // 2026-10-17 第八次调整：第 2 项从「年龄段」改为「生日」，提交时仍换算成 ageBand。
  assert.equal(firstMissingField({ gender: "male" }).key, "birthday");
  assert.equal(firstMissingField({ gender: "male", birthday: "1999-05-04" }).key, "examProjectId");
  assert.equal(firstMissingField({ gender: "male", birthday: "1999-05-04", examProjectId: "p" }).key, "examYear");
  assert.equal(firstMissingField({ gender: "male", birthday: "1999-05-04", examProjectId: "p", examYear: 2027 }), null);
  // 年份是数字型：0 / 空串都算没填，不能被当成字符串"已填"。
  assert.equal(firstMissingField({ gender: "male", birthday: "1999-05-04", examProjectId: "p", examYear: 0 }).key, "examYear");
  // patch 只发四项：生日本身不外发（服务端仍只认 ageBand），由客户端先换算。
  assert.deepEqual(onboardingPatch({ gender: "male", birthday: "1999-05-04", examProjectId: "p", examYear: "2027", nickname: "不该带上" }), {
    gender: "male",
    birthday: "1999-05-04",
    examProjectId: "p",
    examYear: 2027,
  });
});

test("a logged-in account that already answered goes straight in; a fresh one sees the form", () => {
  withPage({ loginUser: { id: "u1", onboardingCompleted: true } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    assert.equal(harness.calls.switchTab.at(-1), "/pages/review/review");
    assert.equal(page.data.stage, "login", "已填全的账号不该再看到表单");
  });

  withPage({ loginUser: { id: "u2", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    assert.equal(page.data.stage, "form");
    assert.deepEqual(harness.calls.switchTab, [], "没填全不能放行");
  });
});

test("submitting with a missing answer is blocked locally, and a filled form posts exactly four fields", () => {
  withPage({ loginUser: { id: "u3", onboardingCompleted: false }, loginOnce: true }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    tap(page, "gender", "female");
    pickBirthday(page, 2000, 5, 4);

    page.submit();
    assert.deepEqual(harness.calls.savedPatches, [], "缺项不得发请求");
    assert.match(page.data.hint, /目标考试项目/);
    assert.deepEqual(harness.calls.switchTab, []);

    const projectId = page.data.projectOptions[0].id;
    tap(page, "examProjectId", projectId);
    tap(page, "examYear", String(new Date().getFullYear() + 1));
    page.submit();

    assert.equal(harness.calls.savedPatches.length, 1);
    assert.deepEqual(harness.calls.savedPatches[0], {
      gender: "female",
      birthday: "2000-05-04",
      examProjectId: projectId,
      examYear: new Date().getFullYear() + 1,
    });
    assert.equal(harness.calls.switchTab.at(-1), "/pages/review/review");
  });
});

test("the optional nickname and avatar ride along only when the user actually set them", () => {
  withPage({ loginUser: { id: "u4", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    tap(page, "gender", "undisclosed");
    pickBirthday(page, 1990, 1, 1);
    tap(page, "examProjectId", page.data.projectOptions[0].id);
    tap(page, "examYear", String(new Date().getFullYear()));
    page.inputNickname({ detail: { value: "  小薯  " } });
    page.submit();
    assert.equal(harness.calls.savedPatches[0].nickname, "小薯", "昵称两端空白要清掉");
    assert.equal("avatarUrl" in harness.calls.savedPatches[0], false, "没选头像就不该带 avatarUrl");
  });
});

test("a failed catalog fetch keeps the target question open instead of inventing a project", () => {
  withPage({ catalogFailure: true }, (page, harness) => {
    page.onLoad();
    assert.deepEqual(page.data.projectOptions, []);
    assert.match(page.data.projectError, /加载失败/);
    agreeAndLogin(page);
    tap(page, "gender", "male");
    pickBirthday(page, 2007, 3, 2);
    tap(page, "examYear", String(new Date().getFullYear()));
    page.submit();
    assert.deepEqual(harness.calls.savedPatches, [], "拿不到考试项目就不能提交");
    assert.match(page.data.hint, /目标考试项目/);
  });
});

test("skipping only writes a local marker, and never touches account data", () => {
  withPage({}, (page, harness) => {
    page.onLoad();
    page.skip();
    assert.equal(harness.store.get(ONBOARDING_SKIP_KEY), true);
    assert.deepEqual(harness.calls.savedPatches, []);
    assert.equal(harness.calls.login, 0);
    assert.equal(harness.calls.switchTab.at(-1), "/pages/review/review");
  });
});

test("catalog payload shapes both work: multi-project and the legacy single project", () => {
  assert.deepEqual(
    projectOptionsFromCatalog({ projects: [{ id: "a", name: "甲项目", region: "广东", examType: "专升本" }] }),
    [{ id: "a", label: "甲项目" }],
    "项目档位只带项目名：2026-10-17 起不再产出「广东 · 专升本」这类副标题",
  );
  assert.deepEqual(
    projectOptionsFromCatalog({ project: { id: "b", name: "乙项目" } }),
    [{ id: "b", label: "乙项目" }],
  );
  assert.deepEqual(projectOptionsFromCatalog({}), []);
});

// 2026-10-17 产品负责人：项目胶囊不能再整行拉满、不能再文字靠左、不能带副标题。
test("the target-exam chips use the same centred, content-width style as every other chip", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");
  const projectBlock = markup.slice(markup.indexOf("目标考试项目"), markup.indexOf("报考年份"));
  assert.doesNotMatch(projectBlock, /chip-wide/, "项目胶囊不再用整行宽的 chip-wide");
  assert.doesNotMatch(projectBlock, /chip-sub/, "项目胶囊不再渲染副标题");
  assert.match(projectBlock, /class="chip \{\{examProjectId === item\.id/, "项目胶囊走通用 .chip");
  assert.doesNotMatch(style, /\.chip-wide\s*\{/, ".chip-wide 已删除");
  assert.doesNotMatch(style, /\.chip-sub\s*\{/, ".chip-sub 已删除");
  assert.match(/\.chip\s*\{([^}]*)\}/.exec(style)[1], /text-align:\s*center/, "胶囊文字居中");
});

// 2026-10-04 真机反馈三项：头像点不了 / 年份点不了 / 昵称读不到微信昵称。
// 前两项是代码 bug（下面锁住），第三项一是 blur 清空、二是微信侧隐私授权没跑完。
test("picking a year leaves a selection the template can actually match", () => {
  withPage({ loginUser: { id: "u5", onboardingCompleted: false } }, (page) => {
    page.onLoad();
    agreeAndLogin(page);
    const option = page.data.yearOptions[1];
    tap(page, "examYear", option.id);
    // 模板写的是 `examYear === item.id`：必须同类型同值，否则点了不高亮，真机观感就是"点不了"。
    assert.equal(typeof page.data.examYear, "string", "examYear 必须与 yearOptions[].id 同为字符串");
    assert.equal(page.data.examYear, option.id);
    assert.ok(page.data.yearOptions.some((item) => item.id === page.data.examYear), "选中值必须能在选项里找到");
  });
});

test("other chips stay on the same string convention as the year chips", () => {
  withPage({ loginUser: { id: "u6", onboardingCompleted: false } }, (page) => {
    page.onLoad();
    agreeAndLogin(page);
    tap(page, "gender", "female");
    pickBirthday(page, 2007, 3, 2);
    tap(page, "examProjectId", page.data.projectOptions[0].id);
    assert.equal(typeof page.data.gender, "string");
    assert.equal(typeof page.data.birthday, "string", "生日也走字符串约定（YYYY-MM-DD）");
    assert.equal(typeof page.data.examProjectId, "string");
  });
});

test("the avatar circle itself is the native chooseAvatar button", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");
  const pickers = markup.match(/<button[^>]*open-type="chooseAvatar"[^>]*>/g) || [];
  assert.equal(pickers.length, 1, "整颗头像圆就是唯一的上传入口");
  pickers.forEach((tag) => assert.match(tag, /bindchooseavatar="chooseAvatar"/));
  assert.doesNotMatch(markup, /avatar-shot-button/, "不能再靠空内容的透明按钮接收点击");
  assert.match(markup, /<button class="avatar-upload"[^>]*open-type="chooseAvatar"/);
  assert.match(style, /\.avatar-upload\s*\{[^}]*width:\s*168rpx[^}]*height:\s*168rpx/s);
  assert.match(style, /\.avatar-upload\s*\{[^}]*margin:\s*0[^}]*padding:\s*0/s);
});

test("the gender picker shows only two coloured capsules with icons, and never invents labels", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");
  // 2026-10-17 产品负责人：「去掉这个不愿透露」——页面只剩男/女两颗胶囊。
  assert.match(markup, /gender-row/, "缺少男/女胶囊行");
  assert.doesNotMatch(markup, /gender-extra/, "「不愿透露」那一行必须删掉");
  assert.doesNotMatch(style, /\.gender-extra\s*\{/, "「不愿透露」的样式也要删掉");
  // 但档位定义里那一档要留着：服务端 GENDER_CHOICES 同款，历史账号要能读回（契约见选项一致性用例）。
  assert.match(markup, /item\.id !== 'undisclosed'/, "渲染时要按 id 过滤掉 undisclosed");
  // 文案仍取 genderOptions，不在 wxml 里另写一套
  assert.doesNotMatch(markup, />\s*男生\s*</);
  // 选中态必须整块上色（男主题绿、女粉），不能只描边。
  // 2026-10-17 第十三次调整：产品负责人要「男的按钮颜色改成和下一步按钮一样的绿色」，
  // 所以男的选中色由 #3d8bfd 改为与 .primary-button 相同的 #0b9588。
  assert.match(style, /\.gender-male\.gender-chip-on\s*\{[^}]*background:\s*#0b9588/);
  // 2026-10-17 第二十二次调整：主按钮改成"深绿 + 浅绿"的渐变进度条（按步数比例），
  // 起色必须还是同一个主题绿，男的选中色才对得上；比例走 CSS 变量，忙碌态才能覆盖背景。
  assert.match(style, /background:\s*linear-gradient\(\s*90deg/, "主按钮底色必须是横向渐变");
  assert.match(style, /#0b9588 0%/, "渐变起色必须与男的选中色同一主题色");
  assert.match(style, /#0b9588 var\(--step-progress, 100%\)/, "深绿按 --step-progress 收边");
  assert.match(style, /#5cb3a7 var\(--step-progress, 100%\)/, "未到的那部分填浅绿，并在同一点起算");
  assert.match(style, /#5cb3a7 100%/, "浅绿铺到最右端");
  assert.match(style, /\.gender-female\.gender-chip-on\s*\{[^}]*background:\s*#f0639b/);
  // 性别胶囊下方那行说明（照参考图 1）：颜色与「跳过」一致。
  assert.match(markup, /注册成功后性别不可随意修改哦/);
  assert.match(style, /\.gender-note\s*\{[^}]*color:\s*#8a938d/, "说明文字颜色要与「跳过」一致");
  assert.match(style, /\.step-skip\s*\{[^}]*color:\s*#8a938d/);
  assert.match(style, /\.gender-chip\s*\{[^}]*flex:\s*1 1 0/, "男/女两颗要等宽并排");
});

// 2026-10-17 第二十次调整（产品负责人：「上一步按钮好像低了」）：
// 返回键原来打的是 `‹` 字符，各端字体基线不同，几何居中后视觉仍偏低；
// 现在改成 CSS 画的箭头（.step-back-arrow），视觉中心由盒子决定。这条守卫防止又被改回字符。
test("the back button is a css arrow, not a `‹` glyph", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");
  assert.match(markup, /class="step-back-arrow"/, "返回键里必须有箭头元素");
  assert.doesNotMatch(markup, />\s*‹\s*</, "不应该再直接打字形 `‹`");
  assert.match(style, /\.step-back-arrow\s*\{[^}]*border-width:\s*0 3rpx 3rpx 0/, "箭头由右+下两条边框画");
  assert.match(style, /\.step-back-arrow\s*\{[^}]*rotate\(135deg\)/, "旋转 135° 才朝左");
  assert.doesNotMatch(style, /\.step-back\s*\{[^}]*font-size/, "返回键容器不再靠字号定位");
});

// 2026-10-17 第二十一次调整（产品负责人：「1.返回图标和下方文案左对齐 2.去掉进度条」）：
// ① 三段进度条整段移除；② 返回箭头贴内容左边界，与标题/说明同一条竖线。
test("the top row keeps only the back arrow, flush with the copy's left edge", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");

  // 进度条彻底移除：标记、样式、数据字段都不该再出现
  assert.doesNotMatch(markup, /class="step-progress"/, "wxml 里不该再有进度条");
  assert.doesNotMatch(style, /\.step-progress(-bar|-on)?\s*\{/, "wxss 里不该再有三段进度条样式");
  assert.doesNotMatch(fs.readFileSync(PAGE_PATH, "utf8"), /progressBars/, "页面数据里不该再有 progressBars");

  // 返回箭头改为左对齐，与文案同一条竖线
  assert.match(style, /\.step-back\s*\{[^}]*justify-content:\s*flex-start/, "返回键容器要左对齐");
  assert.match(style, /\.step-back-arrow\s*\{[^}]*margin-left:\s*4rpx/, "箭头要抵掉旋转溢出的 4rpx");
  assert.match(style, /\.birthday-head\s*\{[^}]*padding:\s*16rpx 0 0/, "第 2 步标题不再叠一层 44rpx 边距");
  assert.match(style, /\.birthday-privacy\s*\{[^}]*padding:\s*0[;}]/, "保密说明同样不再叠边距");
});

// 2026-10-17 第二十三次调整（产品负责人：「这里怎么变了」——真机上头像被拉成宽扁的胶囊）：
// 头像是 `<button>` 且是 flex 子项，真机上被拉伸。这里用静态守卫把尺寸钉死。
test("the avatar button keeps a 168rpx square and cannot be stretched", () => {
  const style = fs.readFileSync(path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding", "onboarding.wxss"), "utf8");
  const block = /\.avatar-upload\s*\{[^}]*\}/.exec(style);
  assert.ok(block, "缺少 .avatar-upload 样式");
  const body = block[0];
  assert.match(body, /flex:\s*0 0 168rpx/, "头像必须用 flex 钉死主轴尺寸，不能被拉伸");
  assert.match(body, /width:\s*168rpx/, "宽度 168rpx");
  assert.match(body, /height:\s*168rpx/, "高度 168rpx");
  assert.match(body, /min-width:\s*168rpx/, "补 min-width 兜底");
  assert.match(body, /max-width:\s*168rpx/, "补 max-width 兜底");
  assert.match(body, /box-sizing:\s*border-box/, "内边距不撑破 168rpx");
  assert.match(body, /position:\s*relative/, "压条是 absolute，必须有定位祖先");
  assert.match(style, /\.avatar-upload-row\s*\{[^}]*align-items:\s*center/, "头像行交叉轴居中，不做拉伸");
  assert.match(style, /\.avatar-upload-img\s*\{[^}]*display:\s*block/, "图片去基线空隙，否则圆会被压扁");
});

test("「跳过」sits under the primary button, and the upload-avatar circle shows the logo plus a masked label", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");
  // 2026-10-17 产品负责人：右上角那个「跳过」会被微信胶囊挡住 → 挪到「下一步」下面。
  const footer = /<view class="step-footer"[\s\S]*?<\/view>\s*<\/view>/.exec(markup);
  assert.ok(footer, "缺少 .step-footer");
  assert.match(footer[0], /class="step-skip"/, "「跳过」必须在 .step-footer 里（主按钮那一块）");
  // 2026-10-17 第十八次调整：header 带上内联高度（按微信胶囊算），正则要允许属性存在
  const header = /<view class="step-header"[^>]*>[\s\S]*?<\/view>\s*<\/view>/.exec(markup);
  assert.ok(header, "缺少 .step-header");
  assert.doesNotMatch(header[0], /step-skip/, "「跳过」不能再留在顶部 header 里");
  assert.match(style, /\.step-skip\s*\{[^}]*text-align:\s*center/, "「跳过」现在在按钮下方居中");

  // 2026-10-17 第七处调整：头像圆里默认铺土豆头像，圆底部压半透明条写「上传头像」
  // （素材是抠掉白底的 potato-avatar.png；早前错用过带圆底的商标版 logo-potato.jpg，产品负责人说"不是同一张图"）
  assert.match(markup, /src="\/assets\/potato-avatar\.png"/, "无头像时圆里应该显示土豆头像");
  assert.match(markup, /class="avatar-upload-mask"/, "缺圆底那条半透明压条");
  assert.doesNotMatch(style, /\.avatar-camera\s*\{/, "相机图标已由土豆头像替换，样式不该再留着");
  assert.match(style, /\.avatar-upload-mask\s*\{[^}]*background:\s*rgba\(0, 0, 0, \.32\)/);
  assert.match(style, /\.avatar-upload-text\s*\{[^}]*color:\s*#ffffff/, "「上传头像」现在是压条上的白字");
  // 昵称框在 flex 列里必须固定高度 + 不可收缩，否则会被压扁、文字被裁（真机反馈）
  assert.match(style, /\.optional-input\s*\{[^}]*flex:\s*none/, "昵称 input 必须 flex: none");
  assert.match(style, /\.optional-input\s*\{[^}]*height:\s*96rpx/, "昵称 input 必须有固定高度");

  // 头像上方那段三行欢迎语（产品负责人给的文案）
  assert.match(markup, /欢迎来到薯考/);
  assert.match(markup, /完善你的资料/);
});

test("a blur without a value never wipes the nickname, and wechat-side privacy consent runs when the form opens", () => {
  withPage({ loginUser: { id: "u7", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    page.inputNickname({ detail: { value: "微信昵称" } });
    assert.equal(page.data.nickname, "微信昵称");
    // 部分基础库的 blur 不带 value：老写法会把刚填好的昵称清空。
    page.inputNickname({ type: "blur", detail: {} });
    page.inputNickname({});
    assert.equal(page.data.nickname, "微信昵称", "拿不到字符串时保留原值，不清空");

    // 2026-10-17 三步化后头像选择在第 1 步，微信侧隐私授权由页面主动探测：
    // 先问 getPrivacySetting 再决定要不要申请。
    harness.calls.privacyAuthorize = 0;
    global.wx.getPrivacySetting = ({ success }) => success({ needAuthorization: true });
    global.wx.requirePrivacyAuthorize = () => { harness.calls.privacyAuthorize += 1; };
    page.ensurePrivacyAuthorization();
    assert.equal(harness.calls.privacyAuthorize, 1);
    page.ensurePrivacyAuthorization();
    assert.equal(harness.calls.privacyAuthorize, 2, "每次进表单各探测一次，不缓存上一次的结论");
  });
});

// 2026-10-17 真机反馈：明明勾选了同意，展开「头像与昵称」却弹出"微信侧隐私授权未通过"红字。
// 根因是无条件调 requirePrivacyAuthorize——在"本来就不需要授权"的环境里它直接 fail。
test("no scary hint when wechat says authorization is not needed, and no request either", () => {
  withPage({ loginUser: { id: "u8", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    harness.calls.privacyAuthorize = 0;
    global.wx.getPrivacySetting = ({ success }) => success({ needAuthorization: false });
    global.wx.requirePrivacyAuthorize = () => { harness.calls.privacyAuthorize += 1; };
    page.ensurePrivacyAuthorization();
    assert.equal(harness.calls.privacyAuthorize, 0, "不需要授权时不得申请，否则会拿到无意义的 fail");
    assert.equal(page.data.hint, "", "不得弹出误导性的红字");
  });
});

test("a denied authorization is surfaced only after wechat actually asked for it", () => {
  withPage({ loginUser: { id: "u9b", onboardingCompleted: false } }, (page) => {
    page.onLoad();
    agreeAndLogin(page);
    global.wx.getPrivacySetting = ({ success }) => success({ needAuthorization: true });
    global.wx.requirePrivacyAuthorize = ({ fail }) => fail && fail({ errMsg: "requirePrivacyAuthorize:fail" });
    page.ensurePrivacyAuthorization();
    assert.match(page.data.hint, /微信/);
    assert.doesNotMatch(page.data.hint, /回登录页/, "不要把用户指向一个无效动作");
  });
});

test("base libraries without getPrivacySetting are left alone", () => {
  withPage({ loginUser: { id: "u9c", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    harness.calls.privacyAuthorize = 0;
    global.wx.requirePrivacyAuthorize = () => { harness.calls.privacyAuthorize += 1; };
    page.ensurePrivacyAuthorization();
    assert.equal(harness.calls.privacyAuthorize, 0);
    assert.equal(page.data.hint, "");
  });
});

// 2026-10-17 产品负责人：一屏四问拆成三步（头像/昵称/性别 → 年龄段 → 考试信息）。
// 锁住：每步只校验自己那几项、上一步保留已选、最后一步才提交，且四项必填口径不变。
test("the form is split into three steps, each step only validates its own answers", () => {
  withPage({ loginUser: { id: "u11", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    assert.equal(page.data.stage, "form");
    assert.equal(page.data.step, 1, "登录后从第 1 步开始");
    assert.equal(page.data.stepTotal, 3);

    // 第 1 步：没选性别就停在原地，且不会因为后面三步没填而报"目标考试项目"
    page.nextStep();
    assert.equal(page.data.step, 1);
    assert.match(page.data.hint, /性别/);
    assert.deepEqual(harness.calls.savedPatches, [], "任何一步缺项都不得发请求");

    tap(page, "gender", "female");
    page.nextStep();
    assert.equal(page.data.step, 2, "只填性别就能进第 2 步（头像昵称选填）");

    // 第 2 步：只校验生日（2026-10-17 第八次调整，原为年龄段）
    page.nextStep();
    assert.equal(page.data.step, 2);
    assert.match(page.data.hint, /生日/);
    pickBirthday(page, 2007, 3, 2);
    assert.equal(page.data.birthday, "2007-03-02", "生日原样落在 data 上，直接提交");
    page.nextStep();
    assert.equal(page.data.step, 3);

    // 第 3 步：项目与年份两项都要，缺一项不外发
    page.nextStep();
    assert.equal(page.data.step, 3);
    assert.match(page.data.hint, /目标考试项目/);
    tap(page, "examProjectId", page.data.projectOptions[0].id);
    page.nextStep();
    assert.match(page.data.hint, /报考年份/);
    assert.deepEqual(harness.calls.savedPatches, []);

    // 回退保留已选值
    page.prevStep();
    assert.equal(page.data.step, 2);
    assert.equal(page.data.gender, "female", "回退不丢已选");
    page.nextStep();
    assert.equal(page.data.step, 3, "第 2 步已填过，直接回到第 3 步");

    tap(page, "examYear", String(new Date().getFullYear()));
    page.nextStep();
    assert.equal(harness.calls.savedPatches.length, 1, "最后一步的按钮就是提交");
    assert.equal(harness.calls.savedPatches[0].gender, "female");
    assert.equal(harness.calls.savedPatches[0].examYear, new Date().getFullYear());
    assert.equal(harness.calls.switchTab.at(-1), "/pages/review/review");
  });
});

// 2026-10-17 第十八次调整（产品负责人：「实际效果没有对齐」）：
// 顶部那一行的高度与右侧让位必须按微信胶囊的实测矩形算，不能写死，否则不同机型上进度条会偏离胶囊中线。
test("the top row is sized and inset from the real wechat capsule rect", () => {
  withPage({}, (page) => {
    page.onLoad();
    // statusBarHeight 24、胶囊 top 28 / height 32 → header 高 = 32 + (28-24)*2 = 40；
    // 胶囊 left 281、屏宽 375 → 右侧让位 = 375 - 281 + 8 = 102。
    assert.equal(page.data.navBarHeight, 40, "header 高度按胶囊算（上下留白对称、等高）");
    assert.equal(page.data.menuRightGap, 102, "进度条右端停在胶囊左侧 8px");
  });
});

test("the top row falls back to fixed sizes when the capsule rect is unavailable", () => {
  withPage({ menuRect: null }, (page) => {
    page.onLoad();
    assert.equal(page.data.navBarHeight, 44, "拿不到胶囊时回退 44px（= 88rpx @375）");
    assert.equal(page.data.menuRightGap, 100, "拿不到胶囊时右侧回退 100px（≈200rpx）");
  });
});
