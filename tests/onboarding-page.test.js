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

test("exam year options run from this year to this year plus the agreed span", () => {
  const now = new Date("2026-05-01T00:00:00+08:00").getTime();
  const options = examYearOptions(now);
  assert.deepEqual(options.map((option) => option.id), ["2026", "2027", "2028", "2029", "2030", "2031"]);
  assert.match(options[0].label, /今年/);
});

test("the four answers are required before anything is sent", () => {
  assert.equal(firstMissingField({}).key, "gender");
  assert.equal(firstMissingField({ gender: "male" }).key, "ageBand");
  assert.equal(firstMissingField({ gender: "male", ageBand: "19_22" }).key, "examProjectId");
  assert.equal(firstMissingField({ gender: "male", ageBand: "19_22", examProjectId: "p" }).key, "examYear");
  assert.equal(firstMissingField({ gender: "male", ageBand: "19_22", examProjectId: "p", examYear: 2027 }), null);
  // 年份是数字型：0 / 空串都算没填，不能被当成字符串"已填"。
  assert.equal(firstMissingField({ gender: "male", ageBand: "19_22", examProjectId: "p", examYear: 0 }).key, "examYear");
  assert.deepEqual(onboardingPatch({ gender: "male", ageBand: "19_22", examProjectId: "p", examYear: "2027", nickname: "不该带上" }), {
    gender: "male",
    ageBand: "19_22",
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
    tap(page, "ageBand", "23_26");

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
      ageBand: "23_26",
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
    tap(page, "ageBand", "31_plus");
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
    tap(page, "ageBand", "19_22");
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
    [{ id: "a", label: "甲项目", sublabel: "广东 · 专升本" }],
  );
  assert.deepEqual(
    projectOptionsFromCatalog({ project: { id: "b", name: "乙项目" } }),
    [{ id: "b", label: "乙项目", sublabel: "" }],
  );
  assert.deepEqual(projectOptionsFromCatalog({}), []);
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
    tap(page, "ageBand", "19_22");
    tap(page, "examProjectId", page.data.projectOptions[0].id);
    assert.equal(typeof page.data.gender, "string");
    assert.equal(typeof page.data.ageBand, "string");
    assert.equal(typeof page.data.examProjectId, "string");
  });
});

test("the avatar picker is reachable: explicit hit area, no inset shorthand, no opacity:0", () => {
  const pageDir = path.join(__dirname, "..", "apps", "miniprogram", "pages", "onboarding");
  const markup = fs.readFileSync(path.join(pageDir, "onboarding.wxml"), "utf8");
  const style = fs.readFileSync(path.join(pageDir, "onboarding.wxss"), "utf8");
  // 头像本体和「选择头像」胶囊各有一枚 open-type=chooseAvatar 的 button（命中区 = 视觉区）。
  const pickers = markup.match(/<button[^>]*open-type="chooseAvatar"[^>]*>/g) || [];
  assert.equal(pickers.length, 2, "头像本体与胶囊都要能点开微信头像选择");
  pickers.forEach((tag) => assert.match(tag, /bindchooseavatar="chooseAvatar"/));

  const block = (className) => {
    const match = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(style);
    assert.ok(match, `缺少样式块 .${className}`);
    return match[1];
  };
  ["avatar-button", "avatar-shot-button"].forEach((className) => {
    const body = block(className);
    assert.match(body, /position:\s*absolute/, `.${className} 必须绝对定位覆盖视觉块`);
    assert.match(body, /width:\s*100%/, `.${className} 必须显式撑满宽度`);
    assert.match(body, /height:\s*100%/, `.${className} 必须显式撑满高度`);
    assert.doesNotMatch(body, /inset\s*:/, `.${className} 不得用 inset 简写：安卓 X5 / 旧 iOS 不认，会塌成 0 宽点不到`);
    assert.doesNotMatch(body, /opacity\s*:\s*0\b/, `.${className} 不得靠 opacity:0 隐形：个别机型上等于不可点`);
  });
});

test("a blur without a value never wipes the nickname, and wechat-side privacy consent is requested on expand", () => {
  withPage({ loginUser: { id: "u7", onboardingCompleted: false } }, (page, harness) => {
    page.onLoad();
    agreeAndLogin(page);
    page.inputNickname({ detail: { value: "微信昵称" } });
    assert.equal(page.data.nickname, "微信昵称");
    // 部分基础库的 blur 不带 value：老写法会把刚填好的昵称清空。
    page.inputNickname({ type: "blur", detail: {} });
    page.inputNickname({});
    assert.equal(page.data.nickname, "微信昵称", "拿不到字符串时保留原值，不清空");

    // 展开「头像与昵称」要补一次微信侧隐私授权：不补时点头像会静默无反应。
    harness.calls.privacyAuthorize = 0;
    global.wx.requirePrivacyAuthorize = () => { harness.calls.privacyAuthorize += 1; };
    page.toggleOptional();
    assert.equal(page.data.optionalOpen, true);
    assert.equal(harness.calls.privacyAuthorize, 1);
    page.toggleOptional();
    assert.equal(page.data.optionalOpen, false);
    assert.equal(harness.calls.privacyAuthorize, 1, "收起时不重复请求授权");
  });
});
