const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_DAYS = 30;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialState() {
  return { users: [], sessions: [] };
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function cleanProfile(profile = {}) {
  return {
    nickname: String(profile.nickname || "薯考同学").trim().slice(0, 32) || "薯考同学",
    avatarUrl: /^https?:\/\//i.test(String(profile.avatarUrl || "")) ? String(profile.avatarUrl).slice(0, 1000) : "",
  };
}

function publicUser(user) {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    communityNickname: user.communityNickname,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function createUserAuthStore(adapter) {
  const read = () => clone(adapter.read());
  const write = (state) => adapter.write(clone(state));
  return {
    exportState: () => clone(adapter.read()),
    loginWechat(identity, now = Date.now()) {
      const openid = String(identity && identity.openid || "").trim();
      if (!openid) throw new Error("wechat_openid_required");
      const profile = cleanProfile(identity.profile);
      const state = read();
      let user = state.users.find((item) => item.wechatOpenId === openid);
      const isNewUser = !user;
      if (!user) {
        user = {
          id: `user-${crypto.randomUUID()}`,
          wechatOpenId: openid,
          wechatUnionId: String(identity.unionid || ""),
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
          communityNickname: profile.nickname,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        };
        state.users.push(user);
      } else {
        user.nickname = profile.nickname || user.nickname;
        user.avatarUrl = profile.avatarUrl || user.avatarUrl;
        if (identity.unionid) user.wechatUnionId = String(identity.unionid);
        user.updatedAt = now;
        user.lastLoginAt = now;
      }
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

    deleteUser(userId) {
      const state = read();
      const before = state.users.length;
      state.users = state.users.filter((item) => item.id !== userId);
      state.sessions = state.sessions.filter((item) => item.userId !== userId);
      if (state.users.length !== before) write(state);
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
  let value = clone(state);
  return createUserAuthStore({ read: () => clone(value), write: (next) => { value = clone(next); } });
}

module.exports = { createFileUserAuthStore, createMemoryUserAuthStore, initialState };
