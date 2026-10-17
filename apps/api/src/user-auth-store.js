const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { subjects } = require("../../../packages/domain/catalog");
const { listExamProjects } = require("./exam-project-registry");

const SESSION_DAYS = 30;
const DEFAULT_NICKNAME = "薯考同学";
const NICKNAME_MAX_LENGTH = 32;
/** 头像与反馈截图同规格：只收 data URL，解码后不超过 200KB（见 moderation-store.normalizeAttachments）。 */
const AVATAR_MAX_BYTES = 200 * 1024;
const AVATAR_DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
/**
 * 资料页里用户自填的文本字段（个人签名 / 所在地区 / 学习方向）：允许空串表示"不填"，
 * 一律去控制字符、按码点限长，避免表情或生僻字被截半。
 */
const SIGNATURE_MAX_LENGTH = 40;
const REGION_MAX_LENGTH = 60;
const STUDY_FIELD_MAX_LENGTH = 40;
/** 每日目标只接受固定档位（分钟）；默认 20 分钟，与资料页"学习偏好"里展示的默认值一致。 */
const DAILY_GOAL_CHOICES = [10, 15, 20, 30, 45, 60];
const DEFAULT_DAILY_GOAL_MINUTES = 20;
/** 学习方向只能取正式目录里的科目名：客户端只提供这些值，服务端仍然复核。 */
const STUDY_FIELD_NAMES = new Set(subjects.map((subject) => String(subject.name || "").trim()).filter(Boolean));

/**
 * 注册引导收集的用户属性（2026-10-03 产品负责人确认）：性别、年龄段、目标考试项目、报考年份。
 * 服务端只认固定档位与登记表里的值——客户端只提供这些值，服务端仍然复核，脏值一律拒绝而不是兜底。
 * 空串/0 表示"未填"（允许清空）；"必填才能进首页"由引导层把关，不在这里硬拦，
 * 否则资料页的部分更新会被误伤。是否填全由派生字段 `onboardingCompleted` 表达。
 */
const GENDER_CHOICES = ["male", "female", "undisclosed"];
const AGE_BAND_CHOICES = ["16_18", "19_22", "23_26", "27_30", "31_plus"];
/** 报考年份只收"当年与之后 3 年（共 4 档）"的整数（2026-10-17 产品负责人口径，与客户端 onboarding-options 同值）：跨年后不改历史值，只影响新填写的档位。 */
const EXAM_YEAR_SPAN = 3;
const PUBLIC_ID_MIN = 100000000;
const PUBLIC_ID_MAX = 1000000000;

/**
 * 协议同意记录（2026-10-05）：`{ docKey, version, agreedAt, source }`。
 * docKey / version 由 platform-content store 定义（当前 7 份文档），这里只做长度与存在性兜底。
 */
const AGREEMENT_DOC_KEY_MAX_LENGTH = 40;
const AGREEMENT_VERSION_MAX_LENGTH = 40;
const AGREEMENT_SOURCE_MAX_LENGTH = 40;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assignPublicIds(users) {
  const used = new Set();
  for (const user of users) {
    if (!user.publicId) continue;
    if (!/^[1-9]\d{8}$/.test(String(user.publicId)) || used.has(String(user.publicId))) {
      throw new Error("user_public_id_conflict");
    }
    used.add(String(user.publicId));
  }
  let assigned = 0;
  for (const user of users) {
    if (user.publicId) continue;
    let value;
    do { value = String(crypto.randomInt(PUBLIC_ID_MIN, PUBLIC_ID_MAX)); } while (used.has(value));
    user.publicId = value;
    used.add(value);
    assigned += 1;
  }
  return assigned;
}

function initialState() {
  return { users: [], sessions: [], accountDeletions: [] };
}

/**
 * 旧 users.json / 旧内存夹具没有 `accountDeletions`。读路径统一补齐，
 * 其余字段原样保留；注销记录只存时间与随机事件 ID，不保留账号身份。
 */
function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    ...state,
    users: Array.isArray(state.users) ? state.users : [],
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    accountDeletions: Array.isArray(state.accountDeletions) ? state.accountDeletions : [],
  };
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/**
 * 昵称只来自用户在 "input type=nickname" 里自己填的内容：去首尾空白与控制字符，
 * 1–32 个字符（按码点计数，避免表情/生僻字被 slice 截断成半个代理对）。
 */
function normalizeNickname(value) {
  const nickname = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!nickname || Array.from(nickname).length > NICKNAME_MAX_LENGTH) throw new Error("nickname_invalid");
  return nickname;
}

/**
 * 头像只接受小程序 chooseAvatar 回调里的本地临时图转成的 data URL：
 * 既拒绝任意外链（客户端可伪造、服务端无法验证归属），也拒绝空串以外的格式。
 * 传空串表示清除头像，回到默认占位。
 */
function normalizeAvatarUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  const matched = raw.match(AVATAR_DATA_URL);
  if (!matched) throw new Error("avatar_invalid_format");
  if (Buffer.byteLength(matched[2], "base64") > AVATAR_MAX_BYTES) throw new Error("avatar_too_large");
  return raw;
}

/** 个人签名 / 所在地区：用户自填文本，空串=不填；只收字符串（挡掉对象/数字被 String() 洗成 "[object Object]" 这类脏值）。 */
function normalizeOptionalText(value, maxLength, errorCode) {
  if (typeof value !== "string") throw new Error(errorCode);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (Array.from(text).length > maxLength) throw new Error(errorCode);
  return text;
}

/** 学习方向只收正式目录里的科目名（或空串=未设置），客户端只提供这些值，服务端仍然复核。 */
function normalizeStudyField(value) {
  const text = normalizeOptionalText(value, STUDY_FIELD_MAX_LENGTH, "study_field_invalid");
  if (text && !STUDY_FIELD_NAMES.has(text)) throw new Error("study_field_invalid");
  return text;
}

/** 每日目标只收固定档位（分钟），不接受任意数字。 */
function normalizeDailyGoalMinutes(value) {
  const minutes = Number(value);
  if (!DAILY_GOAL_CHOICES.includes(minutes)) throw new Error("daily_goal_invalid");
  return minutes;
}

/** 公开学习数据只收布尔值：字符串 "true" / 1 这类模糊输入一律拒绝，避免开关语义被客户端糊弄。 */
function normalizePublicLearningStats(value) {
  if (typeof value !== "boolean") throw new Error("public_learning_stats_invalid");
  return value;
}

/**
 * 生日（2026-10-17 第九次调整：注册引导第 2 步由年龄段改为具体生日，产品负责人明确"既然能保存具体生日，
 * 那就不再需要换算年龄段"）。
 * 只接受 `YYYY-MM-DD` 或空串（空串＝清空）；必须是真实存在的日期（2 月 30 日这类直接拒绝），
 * 并且落在 [1940-01-01, 今天] 之间——未来日期明显是客户端造假或时区错乱，不接受。
 */
function normalizeBirthday(value, now = Date.now()) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("birthday_invalid");
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error("birthday_invalid");
  }
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (parsed.getTime() > todayUtc) throw new Error("birthday_invalid");
  if (parsed.getTime() < Date.UTC(1940, 0, 1)) throw new Error("birthday_invalid");
  return raw;
}

/** 读路径上的生日兜底：历史账号没有该字段、或存的值已不合法，都当作未填，不让读接口抛错。 */
function normalizeBirthdayOrBlank(value, now = Date.now()) {
  try {
    return normalizeBirthday(value, now);
  } catch (error) {
    return "";
  }
}

/** 固定档位字段（性别 / 年龄段）：空串=未填，其余必须是登记过的档位码。 */
function normalizeChoice(value, choices, errorCode) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  if (!choices.includes(text)) throw new Error(errorCode);
  return text;
}

/** 目标考试项目只收登记表里的一级项目 id（DEC-098 的 listExamProjects 是唯一读取入口）。 */
function normalizeTargetExamProject(value) {
  const id = String(value == null ? "" : value).trim();
  if (!id) return "";
  if (!listExamProjects().some((project) => project.id === id)) throw new Error("exam_project_invalid");
  return id;
}

/** 报考年份：空=未填；其余必须是"当年 ~ 当年+5"的整数（4 位年份，拒绝字符串化的任意数）。 */
function normalizeExamYear(value, now = Date.now()) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return 0;
  if (!/^\d{4}$/.test(raw)) throw new Error("exam_year_invalid");
  const year = Number(raw);
  const current = new Date(now).getFullYear();
  if (year < current || year > current + EXAM_YEAR_SPAN) throw new Error("exam_year_invalid");
  return year;
}

/**
 * 引导项是否填全（性别 + 生日 + 目标考试项目 + 报考年份）：派生值，不落库，避免与四个字段双写。
 * 2026-10-17 第九次调整：第 2 项由「年龄段」改为「具体生日」——产品负责人明确不再需要换算年龄段，
 * 因此这里只认 birthday；ageBand 字段保留（老账号仍有值、接口继续回传），但不再参与必填判定。
 */
function onboardingCompleted(user) {
  return GENDER_CHOICES.includes(String(user && user.gender || ""))
    && Boolean(normalizeBirthdayOrBlank(user && user.birthday))
    && Boolean(normalizeExamProjectIdOrBlank(user && user.examProjectId))
    && Number(user && user.examYear) > 0;
}

/** 读路径上的考试项目兜底：历史账号可能存着已下线的项目 id，读的时候不抛错，只当作未填。 */
function normalizeExamProjectIdOrBlank(value) {
  const id = String(value == null ? "" : value).trim();
  if (!id) return "";
  return listExamProjects().some((project) => project.id === id) ? id : "";
}

function publicUser(user) {
  return {
    id: user.id,
    publicId: String(user.publicId || ""),
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    communityNickname: user.communityNickname,
    // 2026-09-22 之前建的账号没有这些键，读的时候统一兜底，接口形状保持稳定。
    signature: String(user.signature || ""),
    region: String(user.region || ""),
    studyField: String(user.studyField || ""),
    dailyGoalMinutes: DAILY_GOAL_CHOICES.includes(Number(user.dailyGoalMinutes)) ? Number(user.dailyGoalMinutes) : DEFAULT_DAILY_GOAL_MINUTES,
    publicLearningStats: user.publicLearningStats === true,
    // 注册引导收集的用户属性（2026-10-03）：读路径统一兜底，接口形状对老账号保持稳定。
    gender: GENDER_CHOICES.includes(String(user.gender || "")) ? String(user.gender) : "",
    // 2026-10-17 第九次调整：引导第 2 项改存具体生日；ageBand 保留回传，供老账号与设置页兼容。
    birthday: normalizeBirthdayOrBlank(user.birthday),
    ageBand: AGE_BAND_CHOICES.includes(String(user.ageBand || "")) ? String(user.ageBand) : "",
    examProjectId: normalizeExamProjectIdOrBlank(user.examProjectId),
    examYear: Number(user.examYear) > 0 ? Number(user.examYear) : 0,
    onboardingCompleted: onboardingCompleted(user),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * 协议同意记录（2026-10-05）：`user.agreements` 是**只追加**的数组，元素形状
 * `{ docKey, version, agreedAt, source }`。读路径统一兜底，老账号没有该字段时当空数组。
 * 口径（产品负责人确认）：不得覆盖用户过去同意过的版本记录 —— 只追加、不修改、不删除。
 */
function normalizeAgreements(raw) {
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    docKey: String(item && item.docKey || "").trim().slice(0, AGREEMENT_DOC_KEY_MAX_LENGTH),
    version: String(item && item.version || "").trim().slice(0, AGREEMENT_VERSION_MAX_LENGTH),
    agreedAt: Number(item && item.agreedAt) || 0,
    source: String(item && item.source || "").trim().slice(0, AGREEMENT_SOURCE_MAX_LENGTH),
  })).filter((item) => item.docKey && item.version);
}

function createUserAuthStore(adapter) {
  const read = () => normalizeState(clone(adapter.read()));
  const write = (state) => adapter.write(clone(state));
  return {
    exportState: () => clone(normalizeState(adapter.read())),
    assignPublicIds() {
      const state = read();
      const assigned = assignPublicIds(state.users);
      if (assigned) write(state);
      return { assigned, total: state.users.length };
    },
    listUsers() {
      return read().users.map((user) => publicUser(user));
    },
    /**
     * 后台用户管理总览。累计注册 = 当前账号 + 有记录的注销账号。
     * `accountDeletions` 是本次功能上线后才开始写的；`deletionTrackingSince` 用来说明边界，
     * 不能把它当成"全生命周期注销数"。
     */
    accountSummary(now = Date.now()) {
      const state = read();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const todayStart = startOfToday.getTime();
      const sevenDayStart = todayStart - 6 * 24 * 60 * 60 * 1000;
      const users = state.users;
      const deletions = state.accountDeletions
        .map((item) => ({ id: String(item && item.id || ""), deletedAt: Number(item && item.deletedAt) || 0 }))
        .filter((item) => item.deletedAt > 0);
      const activeSessionUsers = new Set(
        state.sessions
          .filter((session) => Number(session && session.expiresAt) > now)
          .map((session) => String(session && session.userId || ""))
          .filter(Boolean),
      );
      const deletionTrackingSince = deletions.reduce(
        (earliest, item) => (earliest ? Math.min(earliest, item.deletedAt) : item.deletedAt),
        0,
      );
      return {
        currentUsers: users.length,
        registeredTotal: users.length + deletions.length,
        newToday: users.filter((user) => Number(user.createdAt) >= todayStart).length,
        newLast7Days: users.filter((user) => Number(user.createdAt) >= sevenDayStart).length,
        onboardedUsers: users.filter((user) => onboardingCompleted(user)).length,
        activeSessions: activeSessionUsers.size,
        deletedTotal: deletions.length,
        deletedToday: deletions.filter((item) => item.deletedAt >= todayStart).length,
        deletedLast7Days: deletions.filter((item) => item.deletedAt >= sevenDayStart).length,
        deletionTrackingSince,
        latestDeletionAt: deletions.reduce((latest, item) => Math.max(latest, item.deletedAt), 0),
      };
    },
    resolveUserId(identifier) {
      const value = String(identifier || "").trim();
      if (!value) return "";
      const user = read().users.find((item) => item.id === value || String(item.publicId || "") === value);
      return user ? user.id : "";
    },
    /**
     * 登录只认微信 code 换来的 openid/unionid：自 2022-10-25 起 wx.getUserProfile 已回收，
     * 客户端不再有可信的头像/昵称来源，因此 identity.profile 一律忽略（头像昵称走 updateProfile）。
     */
    loginWechat(identity, now = Date.now()) {
      const openid = String(identity && identity.openid || "").trim();
      if (!openid) throw new Error("wechat_openid_required");
      const state = read();
      let user = state.users.find((item) => item.wechatOpenId === openid);
      const isNewUser = !user;
      if (!user) {
        user = {
          id: `user-${crypto.randomUUID()}`,
          wechatOpenId: openid,
          wechatUnionId: String(identity.unionid || ""),
          nickname: DEFAULT_NICKNAME,
          avatarUrl: "",
          communityNickname: DEFAULT_NICKNAME,
          signature: "",
          region: "",
          studyField: "",
          dailyGoalMinutes: DEFAULT_DAILY_GOAL_MINUTES,
          // 学习数据公开与否属隐私开关：默认不公开，由用户自己在资料页打开。
          publicLearningStats: false,
          // 注册引导四项：新账号一律未填，由引导层必填提交（2026-10-03）。
          // 2026-10-17 第九次调整：第 2 项改存 birthday（ageBand 仍保留键位，老数据继续可读）。
          gender: "",
          birthday: "",
          ageBand: "",
          examProjectId: "",
          examYear: 0,
          // 协议同意记录：新账号从空数组起（2026-10-05），形状对老账号由读路径兜底。
          agreements: [],
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        };
        state.users.push(user);
      } else {
        if (identity.unionid) user.wechatUnionId = String(identity.unionid);
        user.updatedAt = now;
        user.lastLoginAt = now;
      }
      assignPublicIds(state.users);
      state.sessions = state.sessions.filter((session) => session.expiresAt > now && session.userId !== user.id);
      const token = crypto.randomBytes(32).toString("base64url");
      const session = {
        id: `session-${crypto.randomUUID()}`,
        userId: user.id,
        tokenHash: tokenHash(token),
        createdAt: now,
        expiresAt: now + SESSION_DAYS * 24 * 60 * 60 * 1000,
      };
      state.sessions.push(session);
      write(state);
      return { user: publicUser(user), token, expiresAt: session.expiresAt, isNewUser };
    },

    /**
     * 用户自设资料（唯一写入点）：头像、昵称、个人签名、所在地区、学习方向、每日目标、公开学习数据开关。
     * 只处理请求里显式出现的字段：没带的字段保持原值；文本字段传空串表示清空，avatarUrl 空串表示清除头像。
     * 昵称同时写进 communityNickname，保证账号身份与社区身份同名。
     */
    updateProfile(userId, patch = {}, now = Date.now()) {
      const target = String(userId || "").trim();
      if (!target) throw new Error("user_required");
      const changes = patch && typeof patch === "object" ? patch : {};
      const has = (field) => Object.prototype.hasOwnProperty.call(changes, field);
      const fields = ["nickname", "avatarUrl", "signature", "region", "studyField", "dailyGoalMinutes", "publicLearningStats",
        "gender", "birthday", "ageBand", "examProjectId", "examYear"];
      if (!fields.some(has)) throw new Error("profile_patch_required");
      const state = read();
      const user = state.users.find((item) => item.id === target);
      if (!user) throw new Error("user_not_found");
      // 先全部校验再落库：任一字段非法都不写入，避免留下"昵称改了、头像没改"的半截状态。
      const nickname = has("nickname") ? normalizeNickname(changes.nickname) : "";
      const avatarUrl = has("avatarUrl") ? normalizeAvatarUrl(changes.avatarUrl) : "";
      const signature = has("signature") ? normalizeOptionalText(changes.signature, SIGNATURE_MAX_LENGTH, "signature_invalid") : "";
      const region = has("region") ? normalizeOptionalText(changes.region, REGION_MAX_LENGTH, "region_invalid") : "";
      const studyField = has("studyField") ? normalizeStudyField(changes.studyField) : "";
      const dailyGoalMinutes = has("dailyGoalMinutes") ? normalizeDailyGoalMinutes(changes.dailyGoalMinutes) : 0;
      const publicLearningStats = has("publicLearningStats") ? normalizePublicLearningStats(changes.publicLearningStats) : false;
      const gender = has("gender") ? normalizeChoice(changes.gender, GENDER_CHOICES, "gender_invalid") : "";
      const birthday = has("birthday") ? normalizeBirthday(changes.birthday, now) : "";
      const ageBand = has("ageBand") ? normalizeChoice(changes.ageBand, AGE_BAND_CHOICES, "age_band_invalid") : "";
      const examProjectId = has("examProjectId") ? normalizeTargetExamProject(changes.examProjectId) : "";
      const examYear = has("examYear") ? normalizeExamYear(changes.examYear, now) : 0;
      if (has("nickname")) {
        user.nickname = nickname;
        user.communityNickname = nickname;
      }
      if (has("avatarUrl")) user.avatarUrl = avatarUrl;
      if (has("signature")) user.signature = signature;
      if (has("region")) user.region = region;
      if (has("studyField")) user.studyField = studyField;
      if (has("dailyGoalMinutes")) user.dailyGoalMinutes = dailyGoalMinutes;
      if (has("publicLearningStats")) user.publicLearningStats = publicLearningStats;
      if (has("gender")) user.gender = gender;
      if (has("birthday")) user.birthday = birthday;
      if (has("ageBand")) user.ageBand = ageBand;
      if (has("examProjectId")) user.examProjectId = examProjectId;
      if (has("examYear")) user.examYear = examYear;
      user.updatedAt = now;
      write(state);
      return publicUser(user);
    },

    /**
     * 记录一次协议同意（2026-10-05）：同一文档同一版本重复同意**不重复落库**（幂等，登录/换设备重进不刷记录），
     * 版本变了才追加新记录。返回值带 `recorded` 让调用方区分"新记录"与"已存在"。
     * 校验"必须是当前已发布版本"由 server.js 的路由负责（store 不依赖 platform-content store）。
     */
    recordAgreement(userId, payload = {}, now = Date.now()) {
      const target = String(userId || "").trim();
      if (!target) throw new Error("user_required");
      const docKey = String(payload.docKey || "").trim().slice(0, AGREEMENT_DOC_KEY_MAX_LENGTH);
      const version = String(payload.version || "").trim().slice(0, AGREEMENT_VERSION_MAX_LENGTH);
      if (!docKey) throw new Error("agreement_doc_required");
      if (!version) throw new Error("agreement_version_required");
      const state = read();
      const user = state.users.find((item) => item.id === target);
      if (!user) throw new Error("user_not_found");
      const agreements = normalizeAgreements(user.agreements);
      const latest = agreements.slice().reverse().find((item) => item.docKey === docKey);
      if (latest && latest.version === version) {
        // 历史数据可能还没有 agreements 字段：读到旧版本时顺手补写成归一化后的形状（不改动已有记录内容）。
        if (!Array.isArray(user.agreements)) {
          user.agreements = agreements;
          write(state);
        }
        return { recorded: false, agreement: clone(latest), agreements: clone(agreements) };
      }
      const record = {
        docKey,
        version,
        agreedAt: now,
        source: String(payload.source || "").trim().slice(0, AGREEMENT_SOURCE_MAX_LENGTH),
      };
      agreements.push(record);
      user.agreements = agreements;
      user.updatedAt = now;
      write(state);
      return { recorded: true, agreement: clone(record), agreements: clone(agreements) };
    },

    /** 我的协议同意记录（按时间顺序，旧→新）。 */
    listAgreements(userId) {
      const target = String(userId || "").trim();
      if (!target) throw new Error("user_required");
      const state = read();
      const user = state.users.find((item) => item.id === target);
      if (!user) throw new Error("user_not_found");
      return normalizeAgreements(user.agreements);
    },

    authenticate(token, now = Date.now()) {
      if (!token) return null;
      const state = read();
      const session = state.sessions.find((item) => item.tokenHash === tokenHash(token) && item.expiresAt > now);
      if (!session) return null;
      const user = state.users.find((item) => item.id === session.userId);
      return user ? { user: publicUser(user), session: clone(session) } : null;
    },

    logout(token) {
      const state = read();
      const hash = tokenHash(token);
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.tokenHash !== hash);
      if (state.sessions.length !== before) write(state);
      return state.sessions.length !== before;
    },

    /** 撤销某个用户的全部会话（封禁、销号等场景），返回撤销条数。 */
    logoutUser(userId) {
      const target = String(userId || "");
      if (!target) return 0;
      const state = read();
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => item.userId !== target);
      const removed = before - state.sessions.length;
      if (removed) write(state);
      return removed;
    },

    deleteUser(userId, now = Date.now()) {
      const state = read();
      const before = state.users.length;
      state.users = state.users.filter((item) => item.id !== userId);
      state.sessions = state.sessions.filter((item) => item.userId !== userId);
      if (state.users.length !== before) {
        // 隐私边界：只记录"发生过一次注销"与时间，不保留 userId、openid、昵称或任何可回溯身份。
        state.accountDeletions.push({
          id: `account-deletion-${crypto.randomUUID()}`,
          deletedAt: now,
        });
        write(state);
      }
      return state.users.length !== before;
    },
  };
}

function createFileUserAuthStore(filePath = path.resolve(__dirname, "../../../.runtime/users.json")) {
  return createUserAuthStore({
    read() {
      try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return initialState(); throw error; }
    },
    write(state) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryUserAuthStore(state = initialState()) {
  let value = clone(normalizeState(state));
  return createUserAuthStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  createFileUserAuthStore,
  createMemoryUserAuthStore,
  initialState,
  DEFAULT_DAILY_GOAL_MINUTES,
  DAILY_GOAL_CHOICES,
  // 注册引导的档位口径：客户端只提供这些值，服务端复核。
  // 两端清单必须一致，由 tests/onboarding-page.test.js 的契约用例守住。
  GENDER_CHOICES,
  AGE_BAND_CHOICES,
  EXAM_YEAR_SPAN,
};
