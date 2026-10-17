// 注册引导四项（性别 / 年龄段 / 目标考试项目 / 报考年份）的**客户端唯一档位定义**。
// 与 apps/api/src/user-auth-store.js 的 GENDER_CHOICES / AGE_BAND_CHOICES / EXAM_YEAR_SPAN 一一对应：
// 客户端只提供这些值、服务端仍然复核；任一侧改动都要同步，契约由 tests/onboarding-page.test.js 守住。
const GENDER_OPTIONS = [
  { id: "male", label: "男" },
  { id: "female", label: "女" },
  // 2026-10-17 产品负责人要求「去掉这个不愿透露」：引导页只展示男/女两档。
  // 这一档**不删**，只因为服务端 GENDER_CHOICES 同款、且历史上已选该档的账号要能正常读回；
  // 页面上不再渲染它（onboarding.wxml 按 id 过滤）。服务端要收窄请先改 GENDER_CHOICES 再同步这里。
  { id: "undisclosed", label: "不愿透露" },
];

const AGE_BAND_OPTIONS = [
  { id: "16_18", label: "16–18 岁" },
  { id: "19_22", label: "19–22 岁" },
  { id: "23_26", label: "23–26 岁" },
  { id: "27_30", label: "27–30 岁" },
  { id: "31_plus", label: "31 岁以上" },
];

// 报考年份只给**当年与之后 3 年、共 4 档**（2026-10-17 产品负责人口径：
// "今年是 25 年那就是 2025、2026、2027、2028；今年是 26 年则显示 2026、2027、2028、2029"）。
// 与服务端 user-auth-store 的 EXAM_YEAR_SPAN 同口径，两端由 tests/onboarding-page.test.js 钉住。
// 2026-10-17 第十五次调整（产品负责人：「去掉这个今年」）：当年那一档不再带「（今年）」后缀，
// 四档一律只显示「YYYY 年」。
const EXAM_YEAR_SPAN = 3;
function examYearOptions(now = Date.now()) {
  const current = new Date(now).getFullYear();
  return Array.from({ length: EXAM_YEAR_SPAN + 1 }, (unused, offset) => {
    const year = current + offset;
    return { id: String(year), label: `${year} 年` };
  });
}

// 目标考试项目来自 /api/catalog：优先读多项目形态 projects，读不到再退回单个 project（DEC-098 的预留形态）。
// 2026-10-17 产品负责人："去掉汉语言文学学科基础下方的「广东 · 普通专升本」"——项目 chip 只显示项目名本身，
// 不再产出 region/examType 拼出来的 sublabel（该副标题既占行高、又把胶囊撑成整行宽）。
function projectOptionsFromCatalog(catalog) {
  const projects = Array.isArray(catalog && catalog.projects) && catalog.projects.length
    ? catalog.projects
    : (catalog && catalog.project ? [catalog.project] : []);
  return projects
    .filter((project) => project && String(project.id || "").trim())
    .map((project) => ({
      id: String(project.id),
      label: String(project.name || project.id),
    }));
}

// 四项的提交顺序与中文名（提示"还差哪一项"时按这个顺序取第一个）。
// 2026-10-17 第九次调整：第 2 项就是「生日」——服务端已改为保存具体生日（birthday 字段），
// 不再由客户端换算年龄段（产品负责人："既然能保存具体生日，那就不再需要换算年龄段"）。
const ONBOARDING_FIELDS = [
  { key: "gender", label: "性别" },
  { key: "birthday", label: "生日" },
  { key: "examProjectId", label: "目标考试项目" },
  { key: "examYear", label: "报考年份" },
];

/** 未登录时的"先随便看看"标记：只影响是否自动弹引导层，不影响任何数据归属。 */
const ONBOARDING_SKIP_KEY = "shukao_onboarding_skipped_v1";

/**
 * 隐私授权同意标记（2026-10-03）：引导页勾选「我已阅读并同意《用户隐私保护指引》」后写本机。
 * 只代表"用户在本机同意过"，不代表任何账号归属；这个标记只用于本机登录闸门。
 * 微信侧隐私授权由微信原生弹窗完成，不拿它替代或自动回答原生授权。
 */
const PRIVACY_AGREED_KEY = "shukao_privacy_agreed_v1";

function isFilled(key, value) {
  if (key === "examYear") return Number(value) > 0;
  return Boolean(String(value == null ? "" : value).trim());
}

/** 第一个没填的项（都填了返回 null）：引导层就靠它决定能不能提交。 */
function firstMissingField(draft = {}) {
  return ONBOARDING_FIELDS.find((field) => !isFilled(field.key, draft[field.key])) || null;
}

/** 引导层只提交这四项（头像昵称选填，另外并入）：不夹带其它资料字段。 */
function onboardingPatch(draft = {}) {
  return {
    gender: String(draft.gender || ""),
    // 2026-10-17 第九次调整：直接提交生日（YYYY-MM-DD），服务端负责校验与存储。
    birthday: String(draft.birthday || ""),
    examProjectId: String(draft.examProjectId || ""),
    examYear: Number(draft.examYear) || 0,
  };
}

module.exports = {
  GENDER_OPTIONS,
  AGE_BAND_OPTIONS,
  EXAM_YEAR_SPAN,
  examYearOptions,
  projectOptionsFromCatalog,
  ONBOARDING_FIELDS,
  ONBOARDING_SKIP_KEY,
  PRIVACY_AGREED_KEY,
  isFilled,
  firstMissingField,
  onboardingPatch,
};
