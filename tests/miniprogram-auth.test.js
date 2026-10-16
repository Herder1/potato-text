const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function loadApp(wxMock) {
  let definition;
  global.App = (value) => { definition = value; };
  global.wx = wxMock;
  const appPath = require.resolve("../apps/miniprogram/app.js");
  delete require.cache[appPath];
  require(appPath);
  return definition;
}

function unloadApp() {
  delete global.App;
  delete global.wx;
}

function storageMock(initial = []) {
  const storage = new Map(initial);
  return {
    storage,
    getStorageSync: (key) => storage.get(key) || "",
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
  };
}

test("mini program logs in with wx.login only and never uploads a client-side profile", () => {
  const { storage, ...storageApi } = storageMock([["shukao_attempts", [{ questionId: "q1", isCorrect: false, createdAt: 100 }]]]);
  const requests = [];
  const definition = loadApp({
    ...storageApi,
    login: ({ success }) => success({ code: "wechat-code" }),
    request(options) {
      requests.push(options);
      if (options.url.endsWith("/api/auth/wechat/login")) {
        options.success({
          statusCode: 200,
          data: {
            token: "session-token",
            expiresAt: Date.now() + 100000,
            authMode: "wechat",
            user: { id: "user-live", nickname: "薯考同学", avatarUrl: "" },
            account: { beanBalance: 0.5, subscriptions: [], transactions: [] },
          },
        });
        return;
      }
      if (options.url.endsWith("/api/learning/state/sync")) {
        options.success({ statusCode: 200, data: { state: { ...options.data, bookmarks: {}, savedKnowledgeIds: [], scoreHistory: [] } } });
      }
    },
  });

  let result;
  definition.loginWithWechat((user, error) => { result = { user, error }; });
  assert.equal(result.error, "");
  assert.equal(result.user.id, "user-live");
  assert.equal(definition.globalData.loggedIn, true);
  assert.equal(definition.globalData.userId, "user-live");
  assert.equal(storage.get("shukao_auth_session").token, "session-token");
  assert.equal(requests.find((request) => request.url.endsWith("/api/learning/state/sync")).data.attempts.length, 1);

  // 回归点：登录请求里不允许再出现客户端自报的 profile（头像昵称改由 /api/auth/profile 显式设置）。
  const loginRequest = requests.find((request) => request.url.endsWith("/api/auth/wechat/login"));
  assert.equal(loginRequest.data.profile, undefined);
  assert.equal(loginRequest.data.code, "wechat-code");
  assert.equal(typeof loginRequest.data.deviceId, "string");
  assert.equal(loginRequest.data.deviceId.length > 0, true);

  unloadApp();
});

test("mini program saves a user-chosen avatar and nickname through /api/auth/profile", () => {
  const { storage, ...storageApi } = storageMock();
  const requests = [];
  const avatarUrl = `data:image/png;base64,${Buffer.from("avatar-bytes").toString("base64")}`;
  const definition = loadApp({
    ...storageApi,
    login: ({ success }) => success({ code: "wechat-code" }),
    request(options) {
      requests.push(options);
      if (options.url.endsWith("/api/auth/wechat/login")) {
        options.success({
          statusCode: 200,
          data: {
            token: "session-token",
            expiresAt: Date.now() + 100000,
            authMode: "wechat",
            user: { id: "user-live", nickname: "薯考同学", avatarUrl: "" },
          },
        });
        return;
      }
      if (options.url.endsWith("/api/auth/profile")) {
        options.success({ statusCode: 200, data: { success: true, user: { id: "user-live", ...options.data } } });
      }
    },
  });

  definition.loginWithWechat(() => {});
  let result;
  definition.saveProfile({ nickname: "薯考同学二代", avatarUrl }, (user, error) => { result = { user, error }; });

  assert.equal(result.error, "");
  assert.equal(result.user.nickname, "薯考同学二代");
  assert.equal(definition.globalData.user.avatarUrl, avatarUrl);
  assert.equal(definition.globalData.user.nickname, "薯考同学二代");
  assert.equal(storage.get("shukao_auth_session").user.nickname, "薯考同学二代");

  const profileRequest = requests.find((request) => request.url.endsWith("/api/auth/profile"));
  assert.equal(profileRequest.method, "POST");
  assert.equal(profileRequest.header.Authorization, "Bearer session-token");
  assert.equal(profileRequest.data.avatarUrl, avatarUrl);

  // 未登录时不能改资料，也不该发出请求。
  definition.clearAuthSession();
  const before = requests.length;
  let failure;
  definition.saveProfile({ nickname: "匿名改资料" }, (user, error) => { failure = { user, error }; });
  assert.equal(failure.user, null);
  assert.equal(failure.error, "login_required");
  assert.equal(requests.length, before);

  unloadApp();
});

test("mini program compresses an oversized avatar before encoding it as a data URL", async () => {
  const sizes = { "big.jpg": 900 * 1024, "compressed.jpg": 4 * 1024, "huge.jpg": 900 * 1024 };
  const definition = loadApp({
    getFileSystemManager: () => ({
      getFileInfo: ({ filePath, success }) => success({ size: sizes[filePath] || 0 }),
      readFileSync: () => Buffer.from("compressed-avatar").toString("base64"),
    }),
    compressImage: ({ src, success }) => success({ tempFilePath: src === "big.jpg" ? "compressed.jpg" : src }),
  });

  const compressed = await definition.avatarDataUrl("big.jpg");
  assert.match(compressed.dataUrl, /^data:image\/jpeg;base64,/);

  // 压不下去时必须明确报错，而不是把超限图片丢给服务端换来一个 400。
  const tooLarge = await definition.avatarDataUrl("huge.jpg");
  assert.equal(tooLarge.error, "avatar_too_large");
  assert.equal((await definition.avatarDataUrl("")).error, "avatar_missing");

  unloadApp();
});

test("mini program sources use the compliant avatar/nickname pickers and never call wx.getUserProfile", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|wxml)$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  assert.equal(files.length > 20, true);

  // 已被微信回收的接口不许再被调用（注释里可以提它，调用不行）。
  const offenders = files.filter((file) => /wx\.getUserProfile\s*\(/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);

  // 头像昵称的编辑在二级页「编辑资料」（产品负责人 2026-09-22 定的形态）：我的页只负责入口。
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
  assert.ok(appConfig.pages.includes("pages/profile-edit/profile-edit"), "编辑资料页必须在 app.json 注册");

  const profileWxml = fs.readFileSync(path.join(root, "pages/profile/profile.wxml"), "utf8");
  const profileJs = fs.readFileSync(path.join(root, "pages/profile/profile.js"), "utf8");
  const profileWxss = fs.readFileSync(path.join(root, "pages/profile/profile.wxss"), "utf8");
  assert.match(profileWxml, /bindtap="tapAvatar"/);
  assert.match(profileJs, /\btapAvatar\s*\(/);
  // 头像即入口：未登录点它走登录，已登录才进「编辑资料」。
  assert.match(profileJs, /tapAvatar\(\)\s*\{[\s\S]{0,240}?loggedIn !== true[\s\S]{0,160}?this\.login\(\)/, "未登录点头像必须直接走登录");
  assert.match(profileJs, /\/pages\/profile-edit\/profile-edit/);
  // 三行状态文案都是多余的（产品负责人 2026-09-22 真机反馈）：已连接提示 / 账号已登录 / 编辑头像与昵称。
  // 断言只匹配 wxml 里的字符串字面量，避免误伤注释里提到的同一句话。
  assert.doesNotMatch(profileWxml, /'微信账号已连接/);
  assert.doesNotMatch(profileWxml, /'账号已登录'/);
  assert.doesNotMatch(profileWxml, /编辑头像与昵称<\/button>/);
  assert.doesNotMatch(profileWxml, /登录后同步复习记录/);
  assert.doesNotMatch(profileWxss, /\.identity-note/, "多余的说明行样式应一并删除");
  // 未登录的引导标志 + 头像绿色点缀：「+」是青绿字、头像回落是浅绿底，都不做深绿实心。
  assert.match(profileWxml, /class="avatar-badge"/);
  assert.match(profileWxml, /class="avatar avatar-fallback"/);
  assert.match(profileWxss, /\.avatar-fallback\s*\{[^}]*color:\s*#0b9588/, "回落头像是青绿字（昵称首字）");
  assert.doesNotMatch(profileWxss, /\.avatar-fallback\s*\{[^}]*background:\s*#0b9588/, "回落头像不要纯绿实心，只做绿色点缀");
  // 2026-09-22 23:4x 真机反馈：头像改回**正圆**看看效果（10:3x 那版「与编辑资料同形态的圆角方形色块」作废）。
  assert.match(profileWxss, /\.avatar\s*\{[^}]*border-radius:\s*50%/, "头像要正圆");
  assert.doesNotMatch(profileWxss, /\.avatar\s*\{[^}]*border-radius:\s*36rpx/, "圆角方形那版已作废");
  assert.match(profileJs, /avatarChar:\s*nickname\.slice\(0,\s*1\)\s*\|\|\s*"薯"/, "没有昵称时要兜底成「薯」");
  // 2026-09-23 00:4x 真机反馈「➕号移动到头像中间，去掉林」：
  // ① 未登录时头像里不再渲染昵称首字（首字节点带 wx:if="{{loggedIn}}"）——否则「+」与「林」叠在一起；
  // ② 已登录且没有可用头像时，首字仍然要显示（否则圆里空着）。
  assert.match(profileWxml, /class="avatar avatar-fallback"><text wx:if="\{\{loggedIn\}\}">\{\{avatarChar\}\}<\/text><\/view>/,
    "未登录时不渲染「林」，已登录才显示昵称首字");
  // 2026-09-23 01:1x 产品负责人参考图定案：未登录头像里是**青绿人形轮廓图标**（不是「+」），
  // 右边文案同时从一行变两行（主行「点击登录」+ 副行「登录后同步学习记录与进度」）。
  // 三条契约：① 壳仍然必须是透明的（一旦上色就盖掉浅绿回落底 → 又变回被否掉的"整颗绿圆"）；
  // ② 图标必须是 assets 里的 svg 资源、且那个文件真的是青绿描边的人形（不是空的占位文件）；
  // ③ 副行文案与字号/颜色按参考图实测值钉住（改文案/改色都该红）。
  const badgeRule = profileWxss.match(/\.avatar-badge\s*\{([^}]*)\}/);
  assert.ok(badgeRule, ".avatar-badge 规则要在");
  assert.doesNotMatch(badgeRule[1], /background\s*:/, "壳不许上色——浅绿圆底色来自 .avatar-fallback，不能被盖掉");
  assert.doesNotMatch(badgeRule[1], /border-radius\s*:/, "壳是透明的，不需要圆形底");
  assert.doesNotMatch(badgeRule[1], /(?:^|[\s;])border\s*:/, "也不要套一圈描边");
  for (const inset of ["top", "right", "bottom", "left"]) {
    assert.match(badgeRule[1], new RegExp(`${inset}:\\s*0`), `壳要铺满整颗头像（${inset}: 0），图标才对得上圆心`);
  }
  assert.doesNotMatch(profileWxml, /avatar-plus|avatar-badge-plus/, "「+」已被参考图里的头像图标取代，不该再出现");
  assert.match(profileWxml, /<image class="avatar-user" src="\/assets\/icons\/user-outline\.svg" mode="aspectFit" \/>/,
    "头像里必须是本地 svg 图标（与顶栏铃铛/齿轮同一套引用方式）");
  const iconRule = profileWxss.match(/\.avatar-user\s*\{([^}]*)\}/);
  assert.ok(iconRule, ".avatar-user 规则要在");
  assert.match(iconRule[1], /width:\s*48rpx/);
  assert.match(iconRule[1], /height:\s*48rpx/);
  const iconSvg = fs.readFileSync(path.join(root, "assets/icons/user-outline.svg"), "utf8");
  assert.match(iconSvg, /stroke="#0b9588"/, "图标线色＝品牌青绿（参考图采样值 10,143,131 就是这个色系）");
  assert.match(iconSvg, /<circle cx="12" cy="7" r="4"\/>/, "人形图标要有头部圆");
  assert.match(iconSvg, /M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2/, "人形图标要有头肩开环");
  assert.doesNotMatch(iconSvg, /fill="#(?!none)/, "轮廓图标不要实心填充");
  // 2026-09-22 23:4x 真机反馈：顶栏「消息通知」从句首挪到右边「设置」旁边（两颗图标靠右并排，DOM 顺序仍是铃铛在前）。
  assert.match(profileWxss, /\.profile-topbar\s*\{[^}]*justify-content:\s*flex-end/, "顶栏两颗图标要靠右并排");
  assert.doesNotMatch(profileWxss, /\.profile-topbar\s*\{[^}]*justify-content:\s*space-between/, "不再一左一右");
  // 2026-09-22 23:4x 真机反馈：未登录时去掉占位昵称与绿色胶囊按钮，只留轻盈文字；
  // 2026-09-23 01:1x 参考图：改成两行（主行「点击登录」+ 副行「登录后同步学习记录与进度」），整块仍是登录入口。
  assert.match(profileWxml, /class="login-entry" wx:if="\{\{!loggedIn\}\}" bindtap="login"[^>]*>\s*<view class="login-text">点击登录<\/view>\s*<view class="login-sub">登录后同步学习记录与进度<\/view>/,
    "未登录是两行登录入口：主行「点击登录」+ 副行「登录后同步学习记录与进度」");
  assert.match(profileWxml, /class="nickname" wx:if="\{\{loggedIn\}\}" bindtap="tapAvatar"/, "点昵称也要进「编辑资料」");
  assert.match(profileWxml, /class="nickname" wx:if="\{\{loggedIn\}\}"/, "未登录不再摆占位昵称");
  // 2026-09-22 23:5x 反馈「点击头像、点击昵称、点击签名都会进入编辑资料」——昵称与签名都挂上同一个 tapAvatar。
  assert.match(profileWxml, /class="identity-signature"[^>]*bindtap="tapAvatar"/, "点签名也要进「编辑资料」");
  assert.match(profileWxml, /class="avatar-wrap" bindtap="tapAvatar"/, "点头像进「编辑资料」（原有入口）");
  assert.equal(
    (profileWxml.match(/bindtap="tapAvatar"/g) || []).length,
    3,
    "头像/昵称/签名三处共用同一个处理函数，不各写一套"
  );
  assert.doesNotMatch(profileWxml, /login-link/, "绿色胶囊登录按钮已换成轻盈文字");
  assert.doesNotMatch(profileWxml, /微信快捷登录/, "旧文案「微信快捷登录」已按你给的「点击登录」替换");
  assert.match(profileWxss, /\.login-entry\s*\{[^}]*min-height:\s*72rpx/, "两行登录入口也要留够点击区");
  assert.match(profileWxss, /\.login-text\s*\{[^}]*font-size:\s*28rpx/, "主行字号按参考图实测值 28rpx");
  assert.match(profileWxss, /\.login-text\s*\{[^}]*color:\s*#0b9588/, "主行仍是品牌青绿");
  assert.match(profileWxss, /\.login-sub\s*\{[^}]*font-size:\s*18rpx/, "副行字号按参考图实测值 18rpx");
  assert.match(profileWxss, /\.login-sub\s*\{[^}]*color:\s*#717873/, "副行灰字（参考图采样 113,120,115）");
  assert.match(profileWxml, /class="identity-meta"[^>]*>\{\{joinedLabel\}\}</);
  assert.match(profileWxml, /class="identity-user-id" wx:if="\{\{loggedIn && userId\}\}" bindtap="copyUserId"[^>]*>[\s\S]*?\{\{userId\}\}/);
  assert.ok(profileWxml.indexOf('class="nickname"') < profileWxml.indexOf('class="identity-user-id"')
    && profileWxml.indexOf('class="identity-user-id"') < profileWxml.indexOf('class="identity-meta"'), "ID 应在昵称正下方、加入时间上方");
  assert.match(profileJs, /userId: app\.globalData\.loggedIn === true \? String\(user\.publicId \|\| ""\) : ""/);
  assert.doesNotMatch(profileJs, /shortUserId/, "对外数字 ID 不做视觉截断");
  assert.match(profileJs, /copyUserId\(\)[\s\S]*?wx\.setClipboardData\(\{ data: this\.data\.userId \}\)/);
  assert.match(profileWxml, /class="identity-signature"[^>]*>\{\{signature\}\}/);
  assert.match(profileJs, /已加入 \$\{days\} 天/, "「已加入 N 天」的文案");
  assert.match(profileJs, /Number\(user && user\.createdAt\)/, "加入天数必须取账号真实的 createdAt，不能写死");
  // 2026-09-22 二次确认（产品负责人二选一）：小字前缀用账号真实的身份标签（与社区身份页同一套口径），
  // 远端拿不到时不猜档位（只显示「已加入 N 天」）；布局改成参考图的横向排布。
  assert.match(profileJs, /buildCommunityIdentity\(items\)\.current\.label/, "身份标签必须复用 buildCommunityIdentity，不能自造档位名");
  assert.match(profileJs, /api\/community\/assets\/mine/, "身份标签的贡献数据来源与社区身份页一致");
  assert.match(profileWxss, /\.identity-block\s*\{[^}]*align-items:\s*center/);
  assert.doesNotMatch(profileWxss, /\.identity-block\s*\{[^}]*flex-direction:\s*column/, "身份区已改为横向排布");
  assert.match(profileWxss, /\.identity-main\s*\{[^}]*flex-direction:\s*column/, "右边的昵称/小字/签名成列");
  assert.match(profileWxml, /class="identity-main"/);
  // 2026-09-23 00:2x 真机反馈「要拉满这个区域」＋「我指背景色」：顶栏 + 身份区 + 资产卡片必须在同一块底色里。
  const heroStart = profileWxml.indexOf('<view class="profile-hero">');
  assert.ok(heroStart > -1, "顶栏/身份区/资产卡片要包在 .profile-hero 这一层里");
  let heroDepth = 0;
  let heroEnd = -1;
  const heroTag = /<\/?view\b[^>]*>/g;
  heroTag.lastIndex = heroStart;
  for (let m = heroTag.exec(profileWxml); m; m = heroTag.exec(profileWxml)) {
    heroDepth += m[0].startsWith("</") ? -1 : 1;
    if (heroDepth === 0) { heroEnd = m.index; break; }
  }
  assert.ok(heroEnd > heroStart, ".profile-hero 的开闭标签必须配平");
  const heroMarkup = profileWxml.slice(heroStart, heroEnd);
  ["profile-topbar", "identity-block", "asset-card"].forEach((cls) => {
    assert.match(heroMarkup, new RegExp(`class="${cls}"`), `「${cls}」要在这块底色里（背景色要拉满整个区域）`);
  });
  const heroRule = profileWxss.match(/\.profile-hero\s*\{([^}]*)\}/);
  assert.ok(heroRule, ".profile-hero 必须有背景色规则");
  // 2026-09-23 00:3x 真机反馈「否则这里就涂成一片了」：竖渐变在 58%/88% 两个同色 stop 之间是一段没有变化的平台，
  // 整块看成一片平色 → 改成 150deg 对角撞色（冷绿在上左、暖米杏在下右），同一块里必须有两处色相。
  assert.match(heroRule[1], /linear-gradient\(150deg,\s*#e6f7f1/, "渐变的起点色值（冷绿）");
  assert.match(heroRule[1], /#fbeedd/, "渐变必须有暖色那一档，否则又变回一片同色");
  assert.match(heroRule[1], /padding:\s*28rpx 28rpx 0/, "顶部那 28rpx 内边距要接住原来的行距；左右与 .page-shell 的 28rpx 抵消");
  assert.match(heroRule[1], /margin:\s*-28rpx -28rpx 0/, "向上顶到顶栏下沿，左右通铺到屏幕两边");
  // 顶栏那一条也要算进这块底色，否则最上面留一条白边（截图里绿框是从屏幕最上沿起算的）。
  const navRule = profileWxss.match(/\.profile-nav\s*\{([^}]*)\}/);
  assert.ok(navRule, ".profile-nav 规则要在");
  assert.match(navRule[1], /background:\s*linear-gradient\(90deg/, "顶栏要跟着底色层顶边做横向过渡（150deg 渐变下顶边是左右渐变的）");
  // 两侧起点必须同色：抽第一处 #hex 比一比，防止只改一处造成接缝色差（真机上是逐像素可见的）。
  const firstHex = (text) => (text.match(/#[0-9a-fA-F]{6}/) || [""])[0].toLowerCase();
  assert.equal(firstHex(navRule[1]), firstHex(heroRule[1]), "顶栏起点色必须与底色层起点色一致（改一处就得改另一处）");
  assert.doesNotMatch(navRule[1], /border-bottom/, "顶栏那条分隔线会把这块区域切一道，应当去掉");
  // 2026-09-22 真机反馈：原「我的资产」标题 + 四宫格（绿框）换成参考图那张卡片——整张卡片就是资产入口。
  // 23:4x 二次反馈：卡片太大 → 压高度；三列口径定为「学习天数（复习记录去重日期数）/ 卡集 / 题包」（笔记下属于卡集，不再单列）。
  assert.match(profileWxml, /class="asset-card" data-name="我的资产" bindtap="openMenu" role="button" aria-label="我的资产"/, "资产卡片整张可点、且必须仍是资产入口");
  assert.doesNotMatch(profileWxml, /asset-summary/, "旧的四宫格已换成卡片");
  assert.doesNotMatch(profileWxml, /class="section-more"[^>]*>管理</, "「管理」文字链已随绿框一起去掉（卡片本身就是入口）");
  ["学习天数", "卡集", "题包"].forEach((label) => {
    assert.match(profileWxml, new RegExp(`asset-card-label">${label}<`), `资产卡片必须有「${label}」这一列`);
  });
  assert.doesNotMatch(profileWxml, /asset-card-label">笔记</, "笔记下属于卡集，不再单独占一列");
  assert.doesNotMatch(profileWxml, /asset-card-label">全部资产</, "参考图三列没有「全部资产」，已换成 学习天数/卡集/题包");
  assert.match(profileJs, /studyDayCount\(wx\.getStorageSync\(REVIEW_HISTORY_KEY\)\)/, "学习天数取自复习记录");
  assert.match(profileJs, /new Set\(keys\)\.size/, "学习天数是复习记录里**去重**后的日期数");
  assert.match(profileJs, /entry\.dateKey/, "日期用记录里已有的 dateKey，不另造日期键");
  assert.match(profileJs, /loadCardSets\(\)\.length/, "卡集数取知识库本地库（与「知识库」页同一份数据）");
  assert.match(profileWxss, /\.asset-card\s*\{[^}]*background:\s*#ffffff/, "资产卡片是白底卡片");
  assert.match(profileWxss, /\.asset-card\s*\{[^}]*grid-template-columns:\s*repeat\(3/, "资产卡片三列");
  assert.match(profileWxss, /\.asset-card:active/, "卡片要有按下反馈，让人知道可点");
  assert.match(profileWxss, /\.asset-card-value\s*\{[^}]*font-size:\s*34rpx/, "数字已压小（太大那条反馈）");
  assert.match(profileWxss, /\.asset-card\s*\{[^}]*margin-top:\s*60rpx/, "卡片整体下移约半张卡片高（23:5x 那条反馈）");
  // 2026-09-22 23:5x 真机反馈「这些文字太粗了」：绿框点的是昵称、卡片三个数字、「账户与服务」标题——三处 900 → 500（Medium；
  // 不取 600 是因为中文字体 600 与 900 常落同一个字面，等于没改，见 tmp/weight-probe.js 的实测）。
  [["\\.nickname", "昵称"], ["\\.asset-card-value", "卡片数字"]].forEach(([sel, who]) => {
    assert.match(profileWxss, new RegExp(`${sel}\\s*\\{[^}]*font-weight:\\s*500`), `${who}要细一档（500 Medium）`);
    assert.doesNotMatch(profileWxss, new RegExp(`${sel}\\s*\\{[^}]*font-weight:\\s*(600|700|900)`), `${who}不该再用粗体那一档`);
  });
  // 2026-10-05 产品负责人指定：「账户与服务」标题对齐「编辑资料」页的分组标签（基础资料 / 学习偏好）——
  // 小号 24rpx、灰色 #6c7771、常规字重（原来 34rpx/500）。
  assert.match(profileWxss, /\.section-title\s*\{[^}]*color:\s*#6c7771[^}]*font-size:\s*24rpx/, "改成小号灰色分组标签");
  assert.doesNotMatch(profileWxss, /\.section-title\s*\{[^}]*font-weight:\s*(500|600|700|900)/, "不该再用半粗/粗体");
  assert.match(profileWxss, /\.avatar\s*\{[^}]*font-weight:\s*900/, "头像圈里的首字仍是最粗（它没被点）");
  assert.doesNotMatch(profileWxss, /\.asset-summary/, "旧四宫格样式已清掉");
  // 2026-09-22 真机反馈：签名不要胶囊外框（内边距会把文字推右、跟上一行「身份标签 · 已加入 N 天」对不齐）；
  // 顶栏铃铛与齿轮也不要灰色圆底，只留 72rpx 点击区。
  assert.doesNotMatch(profileWxss, /\.identity-signature\s*\{[^}]*background/, "签名不要外框：去掉胶囊底色");
  // 2026-09-22 23:5x：签名成了「编辑资料」入口，补点击区只能加**纵向**内边距（横向必须是 0，否则文字会被推离左对齐）。
  assert.match(profileWxss, /\.identity-signature\s*\{[^}]*padding:\s*22rpx\s+0/, "签名只补纵向点击区，横向保持 0");
  assert.doesNotMatch(profileWxss, /\.identity-signature\s*\{[^}]*padding(-left|-right)\s*:/, "签名不要横向内边距，文字要与上一行左对齐");
  assert.match(profileWxss, /\.nickname\s*\{[^}]*padding:\s*14rpx\s+0/, "昵称也只补纵向点击区");
  assert.doesNotMatch(profileWxss, /\.identity-signature\s*\{[^}]*border/, "签名不要描边");
  assert.doesNotMatch(profileWxss, /\.profile-notification-button\s*\{[^}]*background/, "铃铛不要灰色外框");
  assert.doesNotMatch(profileWxss, /\.profile-settings-button\s*\{[^}]*background/, "齿轮不要灰色外框");
  assert.match(profileJs, /signature:\s*String\(\(user && user\.signature\) \|\| ""\)\.trim\(\)/, "签名取账号投影里的 signature，不新造字段");
  assert.match(profileWxml, /wx:if="\{\{!loggedIn\}\}"/, "登录入口只在未登录时出现");
  // 2026-10-02：「设置」页已立项，齿轮直接进 pages/settings；退出登录搬进设置页（设置页里必须有出口）。
  assert.match(profileJs, /\bopenSettings\s*\(/);
  assert.match(profileJs, /openSettings\(\)\s*\{\s*wx\.navigateTo\(\{ url: "\/pages\/settings\/settings" \}\);/);
  const settingsJs = fs.readFileSync(require.resolve("../apps/miniprogram/pages/settings/settings.js"), "utf8");
  assert.match(settingsJs, /logoutAccount\(\)/, "设置页必须有退出登录入口");
  assert.match(settingsJs, /app\.logout\(/);
  // 顶栏「设置」：2026-09-22 按产品负责人给的齿轮图标把文字按钮换成图标按钮（真机截图红框）。
  assert.match(profileWxml, /class="profile-settings-button"[^>]*bindtap="openSettings"/, "「设置」必须仍是可点按钮（现在直接进设置页）");
  assert.match(profileWxml, /aria-label="设置"/);
  assert.match(profileWxml, /\/assets\/icons\/settings-gear\.svg/);
  assert.doesNotMatch(profileWxml, />设置</, "文字「设置」按钮应已换成图标");
  assert.match(profileWxss, /\.profile-settings-button\s*\{[^}]*width:\s*72rpx/, "「设置」应是与铃铛对称的圆形按钮");
  // 齿轮图标资产：与仓库图标同一套描边规范（24 视口 / fill=none / 线宽 2 / #555d58），不是嵌的位图。
  const gearSvg = fs.readFileSync(path.join(root, "assets/icons/settings-gear.svg"), "utf8");
  assert.match(gearSvg, /viewBox="0 0 24 24"/);
  assert.match(gearSvg, /fill="none"/);
  assert.match(gearSvg, /stroke="#555d58"/);
  assert.match(gearSvg, /stroke-width="2"/);
  assert.doesNotMatch(gearSvg, /base64/, "图标应是矢量路径，不嵌位图");
  // 我的页不再内嵌编辑器：采集控件只应出现在二级页。
  assert.doesNotMatch(profileWxml, /open-type="chooseAvatar"/);
  assert.doesNotMatch(profileWxml, /type="nickname"/);
  // 小程序显隐一律 wx:if（把节点移出渲染树），不用 hidden + 作者 display 的组合。
  assert.doesNotMatch(profileWxml, /\shidden(=|\s|>)/);

  const editWxml = fs.readFileSync(path.join(root, "pages/profile-edit/profile-edit.wxml"), "utf8");
  const editJs = fs.readFileSync(path.join(root, "pages/profile-edit/profile-edit.js"), "utf8");
  const editWxss = fs.readFileSync(path.join(root, "pages/profile-edit/profile-edit.wxss"), "utf8");
  assert.match(editWxml, /open-type="chooseAvatar"/);
  assert.match(editWxml, /bindchooseavatar="chooseAvatar"/);
  assert.match(editWxml, /type="nickname"/);
  assert.match(editWxml, /class="group-row" wx:if="\{\{userId\}\}" bindtap="copyUserId"[^>]*>[\s\S]*?用户 ID[\s\S]*?\{\{userId\}\}/);
  assert.match(editJs, /userId: app\.globalData\.loggedIn === true \? String\(user\.publicId \|\| ""\) : ""/);
  assert.match(editJs, /copyUserId\(\)[\s\S]*?wx\.setClipboardData\(\{ data: this\.data\.userId \}\)/);
  assert.doesNotMatch(editJs, /patch\.id\b|patch\.userId\b/);
  assert.doesNotMatch(editWxml, /\shidden(=|\s|>)/);

  // 产品负责人 2026-09-22 看真机截图后的四条修改，逐条钉住，防止回退：
  // ① 顶部不再空一整条（导航栏 fixed + 等高占位；改成 sticky 会与占位叠加）。
  assert.match(editWxss, /\.editor-nav\s*\{[^}]*position:\s*fixed/, "导航栏必须是 fixed + 等高占位，sticky 会与占位叠加在顶部空出一条");
  // ② 没有可用头像时回落绿色「薯」：老账号存的是已失效的微信外链头像，不能显示成灰色占位。
  assert.match(editWxss, /\.avatar-large-fallback\s*\{[^}]*color:\s*#0b9588/, "默认头像必须是品牌绿「薯」");
  // 老账号的失效外链头像一律回落到绿色「薯」：判断集中在 utils/avatar.js，三个渲染账号头像的页面共用，避免各自漂移。
  const avatarUtil = fs.readFileSync(path.join(root, "utils/avatar.js"), "utf8");
  assert.match(avatarUtil, /data:image\\\//, "utils/avatar.js 必须只认 data URL 头像");
  for (const [label, pageFile] of [["profile", "pages/profile/profile.js"], ["profile-edit", "pages/profile-edit/profile-edit.js"], ["community-identity", "pages/community-identity/community-identity.js"]]) {
    assert.match(fs.readFileSync(path.join(root, pageFile), "utf8"), /utils\/avatar/, `${label} 页必须用 utils/avatar 统一回落头像，不能各自写一套判断`);
  }
  assert.match(editWxml, /binderror="handleAvatarError"/);
  // ③ 「移除当前头像」行不做（产品负责人 2026-09-22 判定没必要）。
  assert.doesNotMatch(editWxml, /移除当前头像/);
  // ④ 按效果图：导航栏不再放「保存」，保存是表单后的整宽主按钮（view + role=button，不用 button 标签）。
  assert.doesNotMatch(editWxml, /nav-save/, "导航栏不再放「保存」按钮");
  assert.doesNotMatch(editWxss, /\.nav-save/, "导航栏「保存」的样式应一并删除");
  assert.match(editWxml, /class="save-button[^"]*"[^>]*bindtap="saveProfile"[^>]*role="button"[\s\S]*?保存修改/, "必须有整宽「保存修改」主按钮（view + role=button）");
  assert.match(editWxss, /\.save-button\s*\{[^}]*width:\s*100%[^}]*justify-content:\s*center/, "保存按钮必须整宽并居中文字");
  assert.match(editWxss, /\.save-button\s*\{[^}]*background:\s*#0b9588/, "保存按钮用品牌绿");
  assert.doesNotMatch(editWxml, /save-bar/, "保存不再固定在屏幕底部（真机反馈太靠下不好操作）");
  assert.doesNotMatch(editWxss, /\.save-bar/, "固定保存条的样式应一并删除");
  assert.doesNotMatch(editWxml, /check-light\.svg/, "按钮里的对勾图标按反馈去掉");
  // ⑤ 「更换头像」按效果图 + 真机反馈：白底胶囊、青绿图标与文字、内容居中。
  assert.match(editWxss, /\.avatar-change\s*\{[^}]*background:\s*#ffffff/, "「更换头像」应为白底胶囊");
  assert.match(editWxss, /\.avatar-change\s*\{[^}]*color:\s*#0b9588/, "「更换头像」文字要品牌绿");
  assert.match(editWxss, /\.avatar-change\s*\{[^}]*justify-content:\s*center/, "「更换头像」内容要居中");
  assert.match(editWxml, /\/assets\/icons\/camera-brand\.svg/, "相机图标用品牌青绿版");
  // 2026-09-22 真机反馈「太长了，文字用细一点的」：胶囊视觉归 view，采集入口是覆盖其上的透明 button。
  assert.match(editWxml, /class="avatar-change-button"[^>]*open-type="chooseAvatar"/, "chooseAvatar 只能由 button 承载，作为胶囊的点击覆盖层");
  assert.match(editWxss, /\.avatar-change-button\s*\{[^}]*position:\s*absolute/, "覆盖层必须绝对定位铺满胶囊");
  assert.match(editWxss, /\.avatar-change-label\s*\{[^}]*font-weight:\s*400/, "「更换头像」文字要细一点");
  assert.match(editWxss, /\.avatar-change-icon\s*\{[^}]*width:\s*26rpx/, "图标同步收小");
  assert.match(fs.readFileSync(path.join(root, "assets/icons/camera-brand.svg"), "utf8"), /stroke="#0b9588"/);
  // ⑥ 昵称 / 个人签名与其他行同样式：不要输入框的深色底，且五行都要有右箭头。
  assert.match(editWxss, /\.row-input\s*\{[^}]*background:\s*transparent/, "昵称/签名行不要输入框深色底");
  assert.equal((editWxml.match(/class="row-arrow"/g) || []).length, 5, "昵称/签名/所在地区/学习方向/每日目标五行都要有右箭头");
  // ⑦ 效果图红框：底部说明卡去掉。
  assert.doesNotMatch(editWxml, /你的资料由你掌控/, "说明卡按效果图去掉");
  assert.doesNotMatch(editWxss, /\.privacy-card/, "说明卡的样式应一并删除");

  // 参考图（产品负责人 2026-09-22 提供）里的每一行都必须真的落地，不许只做版式骨架：
  // 基础资料 = 昵称 / 个人签名 / 所在地区；学习偏好 = 学习方向 / 每日目标 / 公开学习数据开关。
  for (const label of ["个人签名", "所在地区", "学习方向", "每日目标", "公开学习数据"]) {
    assert.match(editWxml, new RegExp(`>${label}<`), `编辑资料页缺少「${label}」行`);
  }
  assert.match(editWxml, /<picker[^>]*mode="region"/);
  assert.match(editWxml, /<switch[^>]*checked="\{\{draftPublicLearningStats\}\}"/);
  // 六行必须真的提交给接口，而不是只在界面上改个样子。
  for (const field of ["signature", "region", "studyField", "dailyGoalMinutes", "publicLearningStats"]) {
    assert.match(editJs, new RegExp(`patch\\.${field}\\b`), `编辑资料页必须把 ${field} 交给 /api/auth/profile`);
  }
  // 学习方向只能取正式目录里的科目，不得在页面里另造一份私有清单。
  assert.match(editJs, /require\("\.\.\/\.\.\/data\/catalog"\)/);
  // 每日目标档位必须与服务端 DAILY_GOAL_CHOICES 同源（同一组值写在两处，改一处要同时改另一处）。
  const authStoreJs = fs.readFileSync(path.join(root, "../../apps/api/src/user-auth-store.js"), "utf8");
  const serverChoices = (authStoreJs.match(/DAILY_GOAL_CHOICES = \[([^\]]+)\]/) || [])[1];
  assert.ok(serverChoices, "服务端必须有 DAILY_GOAL_CHOICES 档位表");
  const pageChoices = (editJs.match(/DAILY_GOAL_CHOICES = \[([^\]]+)\]/) || [])[1];
  assert.equal(pageChoices, serverChoices, "编辑资料页与服务端的每日目标档位必须一致");

  // wxml 里绑定的每个处理函数都必须在页面 js 里存在，否则点击/输入会静默失效。
  for (const [label, markup, script] of [["profile", profileWxml, profileJs], ["profile-edit", editWxml, editJs]]) {
    const handlers = [...markup.matchAll(/bind[a-z]+="([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
    assert.equal(handlers.length > 0, true, `${label}.wxml 没有任何事件绑定`);
    for (const handler of new Set(handlers)) {
      assert.match(script, new RegExp(`\\b${handler}\\s*\\(`), `${label}.js 缺少 wxml 绑定的处理函数 ${handler}`);
    }
  }
  for (const method of ["chooseAvatar", "handleAvatarError", "inputNickname", "inputSignature", "chooseRegion", "chooseStudyField", "chooseDailyGoal", "togglePublicLearningStats", "saveProfile", "goBack"]) {
    assert.match(editJs, new RegExp(`\\b${method}\\s*\\(`));
  }
  assert.match(profileJs, /\bopenProfileEditor\s*\(/);
});
