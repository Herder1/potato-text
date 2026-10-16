const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildCommunityIdentity,
  buildContributionItems,
  contentScore,
  effectiveReactionCounts,
  experienceRules,
  experienceScore,
  identityLevels,
  itemRecognitionScore,
  recognitionScore,
  summarizeContributions,
} = require("../apps/miniprogram/utils/community-profile");

test("community contributions merge remote status without counting drafts or collected assets", () => {
  const localAssets = [
    { id: "local-1", type: "note", title: "现代文学笔记", ownership: "created", moderationStatus: "pending_review", updatedAt: 10 },
    { id: "local-draft", type: "note", title: "草稿", ownership: "created", moderationStatus: "draft", updatedAt: 20 },
    { id: "local-collected", type: "question", title: "导入题目", ownership: "collected", moderationStatus: "published", updatedAt: 30 },
  ];
  const remoteAssets = [
    { id: "remote-1", clientAssetId: "local-1", type: "note", title: "现代文学笔记", moderationStatus: "published", favoriteCount: 8, copyCount: 3, updatedAt: 40 },
    { id: "remote-2", clientAssetId: "remote-only", type: "question", title: "跨设备投稿", moderationStatus: "pending_review", updatedAt: 50 },
  ];
  const items = buildContributionItems(localAssets, remoteAssets);
  assert.equal(items.length, 2);
  assert.equal(items.filter((item) => item.title === "现代文学笔记").length, 1);
  assert.equal(items.find((item) => item.title === "现代文学笔记").moderationStatus, "published");
  assert.equal(items.find((item) => item.title === "现代文学笔记").localId, "local-1");
  assert.deepEqual(summarizeContributions(items), {
    total: 2,
    published: 1,
    reviewing: 1,
    attention: 0,
    favorites: 8,
    copies: 3,
  });
});

// 2026-10-02 产品负责人定：经验值 = 内容分（逐篇递减）+ 认可分（按单篇递减、到封顶为止）。
test("content score uses diminishing tiers and recognition is capped per item", () => {
  assert.equal(contentScore(0), 0);
  assert.equal(contentScore(1), 3);
  assert.equal(contentScore(10), 30);
  assert.equal(contentScore(30), 50);
  assert.equal(contentScore(100), 57);
  assert.equal(contentScore(1000), 147);

  assert.equal(itemRecognitionScore({ favoriteCount: 5 }), 40);
  assert.equal(itemRecognitionScore({ favoriteCount: 30 }), 160);
  assert.equal(itemRecognitionScore({ favoriteCount: 500 }), 500, "单篇要封顶");
  assert.equal(experienceRules.itemRecognitionCap, 500);

  // 必须先逐篇再求和：两篇各 30 次收藏 = 320 分，不能拿总量 60 次一把算（那会算成 10×8+40×4+10×1=250 之外的数）
  assert.equal(recognitionScore([{ favoriteCount: 30 }, { favoriteCount: 30 }]), 320);
  assert.equal(experienceScore({ published: 10 }, [{ favoriteCount: 30 }]), 190);
});

test("community identity levels follow the experience thresholds", () => {
  const items = (count, favoriteEach = 0) => Array.from({ length: count }, () => ({
    moderationStatus: "published",
    favoriteCount: favoriteEach,
    copyCount: 0,
  }));

  const empty = buildCommunityIdentity([]);
  assert.equal(empty.score, 0);
  assert.equal(empty.current.label, "薯薯我呀");
  assert.equal(empty.progressText, "还需 10 分");
  assert.equal(empty.levels.length, 6);

  const sprout = buildCommunityIdentity(items(5));
  assert.equal(sprout.score, 15);
  assert.equal(sprout.current.id, "contributor");
  assert.equal(sprout.current.label, "薯露头角");
  assert.equal(sprout.next.label, "薯能生巧");
  assert.equal(sprout.progressText, "还需 85 分");

  // 10 项公开（30 分）+ 每篇 2 次收藏（10×16）＝ 190 分 → 第 3 档；
  // progress 只是进度条的填充比例，对外显示的是分值。
  const skilled = buildCommunityIdentity(items(10, 2));
  assert.equal(skilled.score, 190);
  assert.equal(skilled.contentScore, 30);
  assert.equal(skilled.recognitionScore, 160);
  assert.equal(skilled.current.label, "薯能生巧");
  assert.equal(skilled.next.label, "薯一薯二");
  assert.equal(skilled.progress, 13);
  assert.equal(skilled.progressText, "还需 610 分");

  // 60 项（53 分）+ 每篇 50 次收藏（60×240）→ 第 6 档才是满档。
  const top = buildCommunityIdentity(items(60, 50));
  assert.equal(top.current.id, "legend");
  assert.equal(top.current.label, "薯界泰斗");
  assert.equal(top.next, null);
  assert.equal(top.progress, 100);
  assert.equal(top.progressText, "已达到当前最高身份");
});

// 单篇认可分封顶的作用：一篇爆款不能直接封神。
test("a single viral item cannot jump the ladder", () => {
  const viral = buildCommunityIdentity([{ moderationStatus: "published", favoriteCount: 500, copyCount: 0 }]);
  assert.equal(viral.score, 503, "内容 3 + 单篇封顶 500");
  assert.equal(viral.current.label, "薯能生巧");
  assert.ok(viral.score < identityLevels[4].score, "1 篇爆款不得直达第 5 档「薯通广大」");
});

// 防灌水：边际递减让"只堆数量"上不去。1000 篇 0 收藏只有 147 分，够不到第 4 档（800 分）。
test("volume without recognition cannot climb the ladder", () => {
  const spam = buildCommunityIdentity(Array.from({ length: 1000 }, () => ({
    moderationStatus: "published",
    favoriteCount: 0,
    copyCount: 0,
  })));
  assert.equal(spam.score, 147);
  assert.equal(spam.current.label, "薯能生巧");
  assert.ok(spam.score < identityLevels[3].score, "1000 篇水文必须够不到第 4 档「薯一薯二」");
});

// 2026-10-02 产品负责人定：点赞/收藏取消不回退分数，但同一个人对同一篇只计一次。
// 峰值放**服务端**（asset 上的 peakFavoriteCount / peakLikeCount，只增不减），客户端取 max(当前, 峰值)。
test("server-side reaction peaks keep cancelled favorites and likes from sliding the score back", () => {
  // 服务端字段缺省（旧数据）时退回当前计数，行为与改前一致
  assert.deepEqual(effectiveReactionCounts({ favoriteCount: 3 }), { favorites: 3, likes: 0 });
  // 取消收藏后当前值掉到 3，但服务端峰值仍是 12 → 算分按 12
  assert.deepEqual(effectiveReactionCounts({ favoriteCount: 3, peakFavoriteCount: 12 }), { favorites: 12, likes: 0 });
  // 反复收藏回到 12 也不会超过峰值（同一人只计一次由服务端关系记录保证，计数不会涨过峰值）
  assert.equal(effectiveReactionCounts({ favoriteCount: 12, peakFavoriteCount: 12 }).favorites, 12);
  // 点赞同样只走高
  assert.deepEqual(effectiveReactionCounts({ favoriteCount: 0, peakFavoriteCount: 12, likeCount: 4, peakLikeCount: 9 }), { favorites: 12, likes: 9 });
  // 分值因此不回退：当前收藏 3 次 + 峰值 30 次 → 按 160 分算
  assert.equal(itemRecognitionScore({ favoriteCount: 3, peakFavoriteCount: 30 }), 160);
});

// 2026-10-02 改版（第二轮，按产品负责人参考图重做）：白卡 + 青绿点缀；页名「社区与贡献」。
// 卡片 1（当前头衔 + 经验值进度条）、卡片 2（公开 / 帖子 切换 + 内容卡片）、升级门槛弹层。
test("contributions page shows the tier card, the mode tabs and the tier sheet", () => {
  const root = path.resolve(__dirname, "../apps/miniprogram");
  const profileScript = fs.readFileSync(path.join(root, "pages/profile/profile.js"), "utf8");
  const contributions = fs.readFileSync(path.join(root, "pages/contributions/contributions.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "pages/contributions/contributions.wxss"), "utf8");
  const script = fs.readFileSync(path.join(root, "pages/contributions/contributions.js"), "utf8");
  const pageConfig = JSON.parse(fs.readFileSync(path.join(root, "pages/contributions/contributions.json"), "utf8"));
  const identity = fs.readFileSync(path.join(root, "pages/community-identity/community-identity.wxml"), "utf8");
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));

  assert.match(profileScript, /name === "社区与贡献"[^\n]+\/pages\/contributions\/contributions/);
  assert.ok(appConfig.pages.includes("pages/contributions/contributions"));
  assert.ok(appConfig.pages.includes("pages/community-identity/community-identity"));
  // 2026-10-02 产品负责人要求：这一行由「客服与反馈」改名为「帮助与反馈」（点进去是该页的第一个标签「帮助中心」）；
  // 同一天他要求把「我的贡献」这一行也改名为「社区与贡献」（与本页导航标题一致）；
  // 同一天再次确认：「隐私与数据」这一行删除，内容拆分进新建的「设置」页。
  assert.match(profileScript, /menu: \["我的账户", "我的收藏", "我的资产", "社区与贡献", "帮助与反馈"\]/);
  assert.doesNotMatch(profileScript, /"隐私与数据", "客服与反馈"/, "菜单文案不应回退成「客服与反馈」");
  assert.doesNotMatch(profileScript, /menu: \[[^\]]*隐私与数据/, "「隐私与数据」已从列表移除");
  assert.match(profileScript, /name === "帮助与反馈"[\s\S]{0,80}?\/pages\/help-feedback\/help-feedback"/);
  assert.doesNotMatch(profileScript, /name === "社区身份"/);
  assert.doesNotMatch(profileScript, /pages\/community-identity\/community-identity/);

  // 页名：导航栏标题已改「社区与贡献」
  assert.equal(pageConfig.navigationBarTitleText, "社区与贡献");
  assert.doesNotMatch(contributions, /contribution-summary/, "页首四项统计条应已删除");
  assert.doesNotMatch(contributions, /identity-avatar|identity-metrics|identity-manage/, "身份条与三项数据应已删除");

  // 卡片 1：当前头衔 + 下一等级 + 经验值进度条（显示分值，不是百分比）
  assert.match(contributions, /tier-card/);
  assert.match(contributions, /当前头衔/);
  assert.match(contributions, /identity\.current\.label/);
  assert.match(contributions, /identity\.next\.label/);
  assert.match(contributions, /经验值 \{\{identity\.score\}\}/);
  assert.match(contributions, /identity\.progressText/);
  assert.match(contributions, /bindtap="openTierSheet"/);

  // 卡片 2：公开 / 帖子 两类切换 + 帖子空态
  assert.match(contributions, /mode-tabs/);
  assert.match(contributions, />公开</);
  assert.match(contributions, />帖子</);
  assert.match(contributions, /bindtap="selectMode"/);
  assert.match(contributions, /帖子还没有开放/);

  // 卡片底部只渲染真实存在的数据：收藏数与被导入数；点赞/评论不得出现计数占位
  assert.match(contributions, /收藏 \{\{item\.favoriteCount\}\}/);
  assert.match(contributions, /导入 \{\{item\.copyCount\}\}/);
  assert.doesNotMatch(contributions, /\{\{item\.(likeCount|commentCount)\}\}/, "点赞/评论没有数据源，不得渲染计数");

  // 升级门槛弹层 + 六行阶梯
  assert.match(contributions, /tierSheetVisible/);
  assert.match(contributions, /升级门槛/);
  assert.match(contributions, /wx:for="\{\{identity\.levels\}\}"/);
  assert.match(script, /buildCommunityIdentity\(items\)/, "身份数据仍走同一套算法");
  assert.match(script, /服务端历史峰值/, "只增不减改由服务端峰值字段承担");
  assert.doesNotMatch(script, /trackReactionPeaks|community-reaction-peak/, "本地峰值方案已退役，改由服务端 peakFavoriteCount 承担");
  assert.match(script, /openTierSheet/);
  assert.match(script, /selectMode/);
  assert.match(script, /activeMode: "published"/);
  // 带遮罩的浮层必须随页面离开收拢（仓库硬约定，tests/page-transient-layers.test.js）
  assert.match(script, /\n  onHide\(\) \{/);
  assert.match(script, /closeTransientLayers\(this, TIER_LAYERS\)/);
  assert.doesNotMatch(script, /openIdentity|pages\/community-identity/, "本页不再跳旧的身份页");

  // 类名兜底：本页 wxml 用到的 class，在本页 wxss 里都要有规则（防"加了结构却没样式"）
  const names = Array.from(new Set(
    (contributions.match(/class="[^"]*"/g) || [])
      .flatMap((attr) => attr.slice(7, -1).split(/\s+/))
      .filter((name) => name && !name.includes("{") && !name.includes("'"))
      .filter((name) => /^(tier|mode|feed|filter|sync-note|empty-state|sheet|level|current-label|status)/.test(name)),
  ));
  assert.ok(names.length >= 15, `应识别出本页类名，实际 ${names.length} 个`);
  for (const name of names) {
    assert.match(styles, new RegExp(`\\.${name}[\\s,{:]`), `本页类 .${name} 在 wxss 里没有规则`);
  }

  // 旧的身份独立页仍在册且内容未动（退役与否等产品负责人拍板）
  assert.match(identity, /身份阶梯/);
  assert.match(identity, /查看我的贡献/);
});
