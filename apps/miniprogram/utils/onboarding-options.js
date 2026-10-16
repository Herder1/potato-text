// 注册引导四项（性别 / 年龄段 / 目标考试项目 / 报考年份）的**客户端唯一档位定义**。
// 与 apps/api/src/user-auth-store.js 的 GENDER_CHOICES / AGE_BAND_CHOICES / EXAM_YEAR_SPAN 一一对应：
// 客户端只提供这些值、服务端仍然复核；任一侧改动都要同步，契约由 tests/onboarding-page.test.js 守住。
const GENDER_OPTIONS = [
  { id: "male", label: "男" },
  { id: "female", label: "女" },
  // 必填但不想说的人不能被卡死在门外，因此留一个显式档位（口径 2026-10-03）。
  { id: "undisclosed", label: "不愿透露" },
];

const AGE_BAND_OPTIONS = [
  { id: "16_18", label: "16–18 岁" },
  { id: "19_22", label: "19–22 岁" },
  { id: "23_26", label: "23–26 岁" },
  { id: "27_30", label: "27–30 岁" },
  { id: "31_plus", label: "31 岁以上" },
];

// 报考年份只给"当年 ~ 当年+5"：与服务端 EXAM_YEAR_SPAN 同口径。
const EXAM_YEAR_SPAN = 5;
function examYearOptions(now = Date.now()) {
  const current = new Date(now).getFullYear();
  return Array.from({ length: EXAM_YEAR_SPAN + 1 }, (unused, offset) => {
    const year = current + offset;
    return { id: String(year), label: offset === 0 ? `${year} 年（今年）` : `${year} 年` };
  });
}

// 目标考试项目来自 /api/catalog：优先读多项目形态 projects，读不到再退回单个 project（DEC-098 的预留形态）。
function projectOptionsFromCatalog(catalog) {
  const projects = Array.isArray(catalog && catalog.projects) && catalog.projects.length
    ? catalog.projects
    : (catalog && catalog.project ? [catalog.project] : []);
  return projects
    .filter((project) => project && String(project.id || "").trim())
    .map((project) => ({
      id: String(project.id),
      label: String(project.name || project.id),
      sublabel: [project.region, project.examType].map((part) => String(part || "").trim()).filter(Boolean).join(" · "),
    }));
}

// 四项的提交顺序与中文名（提示"还差哪一项"时按这个顺序取第一个）。
const ONBOARDING_FIELDS = [
  { key: "gender", label: "性别" },
  { key: "ageBand", label: "年龄段" },
  { key: "examProjectId", label: "目标考试项目" },
  { key: "examYear", label: "报考年份" },
];

/** 未登录时的"先随便看看"标记：只影响是否自动弹引导层，不影响任何数据归属。 */
const ONBOARDING_SKIP_KEY = "shukao_onboarding_skipped_v1";

/**
 * 隐私授权同意标记（2026-10-03）：引导页勾选「我已阅读并同意《用户隐私保护指引》」后写本机。
 * 只代表"用户在本机同意过"，不代表任何账号归属；app.js 的 wx.onNeedPrivacyAuthorization
 * 与引导页的提交前检查都读它，避免同一次同意问两遍。
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
    ageBand: String(draft.ageBand || ""),
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
