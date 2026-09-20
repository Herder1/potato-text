const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_HOURS = 12;
const PASSWORD_MIN_LENGTH = 8;
const MAX_SESSIONS_PER_ACCOUNT = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;

const ROLE_LABELS = {
  super_admin: "超级管理员",
  operator: "运营操作员",
};

const ROLE_KEYS = new Set(Object.keys(ROLE_LABELS));
const STATUS_KEYS = new Set(["active", "disabled"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { accounts: [], sessions: [] };
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanDisplayName(value, fallback) {
  const text = String(value || "").trim().slice(0, 32);
  return text || fallback;
}

function assertUsername(username) {
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) {
    throw new Error("admin_username_invalid");
  }
}

function assertPassword(password, username = "") {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN_LENGTH) throw new Error("admin_password_too_short");
  if (value.length > 128) throw new Error("admin_password_too_long");
  if (username && value.toLowerCase() === normalizeUsername(username)) throw new Error("admin_password_equals_username");
  return value;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function passwordMatches(password, account) {
  if (!account || !account.passwordSalt || !account.passwordHash) return false;
  const expected = Buffer.from(account.passwordHash, "hex");
  const derived = crypto.scryptSync(String(password || ""), account.passwordSalt, 64);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function generatePassword() {
  return crypto.randomBytes(15).toString("base64url");
}

function publicAccount(account, sessions = []) {
  const activeSessions = sessions.filter((session) => session.accountId === account.id && session.expiresAt > Date.now()).length;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    roleLabel: ROLE_LABELS[account.role] || account.role,
    status: account.status,
    statusLabel: account.status === "active" ? "启用中" : "已停用",
    mustChangePassword: account.mustChangePassword === true,
    createdBy: account.createdBy || "",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt || 0,
    activeSessionCount: activeSessions,
  };
}

function createAdminAccountStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));

  const findById = (state, id) => state.accounts.find((item) => item.id === id) || null;
  const findByUsername = (state, username) => state.accounts.find((item) => item.username === normalizeUsername(username)) || null;
  const activeSuperAdmins = (state) => state.accounts.filter((item) => item.role === "super_admin" && item.status === "active");

  function issueSession(state, account, now) {
    const token = crypto.randomBytes(32).toString("base64url");
    state.sessions = state.sessions.filter((session) => session.expiresAt > now);
    state.sessions.push({
      id: `admin-session-${crypto.randomUUID()}`,
      accountId: account.id,
      tokenHash: tokenHash(token),
      createdAt: now,
      expiresAt: now + SESSION_HOURS * 60 * 60 * 1000,
    });
    const mine = state.sessions.filter((session) => session.accountId === account.id);
    if (mine.length > MAX_SESSIONS_PER_ACCOUNT) {
      const keep = new Set(mine.slice(-MAX_SESSIONS_PER_ACCOUNT).map((session) => session.id));
      state.sessions = state.sessions.filter((session) => session.accountId !== account.id || keep.has(session.id));
    }
    return { token, expiresAt: now + SESSION_HOURS * 60 * 60 * 1000 };
  }

  function revokeSessions(state, accountId) {
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((session) => session.accountId !== accountId);
    return before !== state.sessions.length;
  }

  return {
    exportState: () => clone(adapter.read()),

    hasAccounts() {
      return read().accounts.length > 0;
    },

    /**
     * 部署初始化：仅当账号表为空时创建首个超级管理员。
     * 环境变量只用于这一次建号，登录流程永远只校验库内账号，不构成免登录后门。
     */
    ensureBootstrapAdmin({ username = "admin", password = "", displayName = "", mustChangePassword = true } = {}) {
      const state = read();
      if (state.accounts.length > 0) return { created: false, account: null, generatedPassword: "" };
      const normalized = normalizeUsername(username) || "admin";
      const generatedPassword = password ? "" : generatePassword();
      const initialPassword = password || generatedPassword;
      assertUsername(normalized);
      assertPassword(initialPassword, normalized);
      const now = Date.now();
      const account = {
        id: `admin-${crypto.randomUUID()}`,
        username: normalized,
        displayName: cleanDisplayName(displayName, "超级管理员"),
        role: "super_admin",
        status: "active",
        ...hashPassword(initialPassword),
        mustChangePassword: mustChangePassword === true,
        createdBy: "deployment_bootstrap",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: 0,
        failedLoginCount: 0,
        lastFailedLoginAt: 0,
      };
      state.accounts.push(account);
      write(state);
      return { created: true, account: publicAccount(account, state.sessions), generatedPassword };
    },

    list(filters = {}) {
      const state = read();
      const query = String(filters.query || "").trim().toLowerCase();
      const role = String(filters.role || "all");
      const status = String(filters.status || "all");
      const items = state.accounts
        .filter((account) => {
          if (role !== "all" && account.role !== role) return false;
          if (status !== "all" && account.status !== status) return false;
          if (query && !`${account.username} ${account.displayName}`.toLowerCase().includes(query)) return false;
          return true;
        })
        .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
        .map((account) => publicAccount(account, state.sessions));
      return {
        items,
        summary: {
          total: state.accounts.length,
          active: state.accounts.filter((account) => account.status === "active").length,
          superAdmins: activeSuperAdmins(state).length,
        },
      };
    },

    get(id) {
      const state = read();
      const account = findById(state, String(id || ""));
      return account ? publicAccount(account, state.sessions) : null;
    },

    create({ username, password, displayName = "", role = "operator" } = {}, actor = "") {
      const state = read();
      const normalized = normalizeUsername(username);
      assertUsername(normalized);
      if (findByUsername(state, normalized)) throw new Error("admin_username_taken");
      if (!ROLE_KEYS.has(role)) throw new Error("admin_role_invalid");
      const loginPassword = assertPassword(password || generatePassword(), normalized);
      const now = Date.now();
      const account = {
        id: `admin-${crypto.randomUUID()}`,
        username: normalized,
        displayName: cleanDisplayName(displayName, ROLE_LABELS[role] || "管理员"),
        role,
        status: "active",
        ...hashPassword(loginPassword),
        mustChangePassword: !password,
        createdBy: String(actor || "").slice(0, 60),
        createdAt: now,
        updatedAt: now,
        lastLoginAt: 0,
        failedLoginCount: 0,
        lastFailedLoginAt: 0,
      };
      state.accounts.push(account);
      write(state);
      return { account: publicAccount(account, state.sessions), generatedPassword: password ? "" : loginPassword };
    },

    resetPassword(id, password = "", actor = "") {
      const state = read();
      const account = findById(state, String(id || ""));
      if (!account) throw new Error("admin_account_not_found");
      const nextPassword = assertPassword(password || generatePassword(), account.username);
      Object.assign(account, hashPassword(nextPassword), {
        mustChangePassword: true,
        updatedAt: Date.now(),
        failedLoginCount: 0,
      });
      revokeSessions(state, account.id);
      write(state);
      return { account: publicAccount(account, state.sessions), generatedPassword: password ? "" : nextPassword };
    },

    changePassword(id, currentPassword, nextPassword) {
      const state = read();
      const account = findById(state, String(id || ""));
      if (!account) throw new Error("admin_account_not_found");
      if (!passwordMatches(currentPassword, account)) throw new Error("admin_current_password_invalid");
      const cleaned = assertPassword(nextPassword, account.username);
      if (passwordMatches(cleaned, account)) throw new Error("admin_password_unchanged");
      Object.assign(account, hashPassword(cleaned), { mustChangePassword: false, updatedAt: Date.now() });
      revokeSessions(state, account.id);
      write(state);
      return publicAccount(account, state.sessions);
    },

    setStatus(id, status, actor = "") {
      const state = read();
      const account = findById(state, String(id || ""));
      if (!account) throw new Error("admin_account_not_found");
      if (!STATUS_KEYS.has(status)) throw new Error("admin_status_invalid");
      // 先判“停用自己”，这样提示更具体；再判“至少保留一个启用中的超级管理员”。
      if (status === "disabled" && actor && normalizeUsername(actor) === account.username) {
        throw new Error("admin_cannot_disable_self");
      }
      if (status === "disabled" && account.role === "super_admin"
        && activeSuperAdmins(state).filter((item) => item.id !== account.id).length === 0) {
        throw new Error("admin_last_super_admin");
      }
      account.status = status;
      account.updatedAt = Date.now();
      if (status === "disabled") revokeSessions(state, account.id);
      write(state);
      return publicAccount(account, state.sessions);
    },

    login({ username, password } = {}, now = Date.now()) {
      const state = read();
      const account = findByUsername(state, username);
      if (!account) throw new Error("admin_credentials_invalid");
      if (account.status !== "active") throw new Error("admin_account_disabled");
      if (Number(account.lastFailedLoginAt || 0) + LOGIN_FAILURE_WINDOW_MS > now
        && Number(account.failedLoginCount || 0) >= LOGIN_FAILURE_LIMIT) {
        throw new Error("admin_login_locked");
      }
      if (!passwordMatches(password, account)) {
        if (Number(account.lastFailedLoginAt || 0) + LOGIN_FAILURE_WINDOW_MS > now) {
          account.failedLoginCount = Number(account.failedLoginCount || 0) + 1;
        } else {
          account.failedLoginCount = 1;
        }
        account.lastFailedLoginAt = now;
        write(state);
        throw new Error("admin_credentials_invalid");
      }
      account.failedLoginCount = 0;
      account.lastLoginAt = now;
      account.updatedAt = now;
      const session = issueSession(state, account, now);
      write(state);
      return { account: publicAccount(account, state.sessions), token: session.token, expiresAt: session.expiresAt, sessionHours: SESSION_HOURS };
    },

    authenticate(token, now = Date.now()) {
      if (!token) return null;
      const state = read();
      const session = state.sessions.find((item) => item.tokenHash === tokenHash(token) && item.expiresAt > now);
      if (!session) return null;
      const account = findById(state, session.accountId);
      if (!account || account.status !== "active") return null;
      return { account: publicAccount(account, state.sessions), session: clone(session) };
    },

    logout(token) {
      const state = read();
      const hash = tokenHash(token);
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((session) => session.tokenHash !== hash);
      if (state.sessions.length !== before) write(state);
      return state.sessions.length !== before;
    },

    revokeSessions(id) {
      const state = read();
      const changed = revokeSessions(state, String(id || ""));
      if (changed) write(state);
      return changed;
    },

    delete(id) {
      const state = read();
      const account = findById(state, String(id || ""));
      if (!account) throw new Error("admin_account_not_found");
      if (account.role === "super_admin" && activeSuperAdmins(state).length <= 1) throw new Error("admin_last_super_admin");
      state.accounts = state.accounts.filter((item) => item.id !== account.id);
      revokeSessions(state, account.id);
      write(state);
      return true;
    },
  };
}

function createFileAdminAccountStore(filePath = path.resolve(__dirname, "../../../.runtime/admin-accounts.json")) {
  return createAdminAccountStore({
    read() {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return { accounts: Array.isArray(value.accounts) ? value.accounts : [], sessions: Array.isArray(value.sessions) ? value.sessions : [] };
      } catch (error) {
        if (error.code === "ENOENT") return initialState();
        throw error;
      }
    },
    write(state) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    },
  });
}

function createMemoryAdminAccountStore(state = initialState()) {
  let value = clone(state);
  return createAdminAccountStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = {
  ROLE_LABELS,
  SESSION_HOURS,
  createFileAdminAccountStore,
  createMemoryAdminAccountStore,
  initialState,
  publicAccount,
};
