# 05 「我的收藏」与收藏目录

> 模块编号仅用于导航。规则引用**权威正文**（产品手册），不替代原文。
> 相关：DEC-096（产品手册 §0.4 索引末行）、待确认清单 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.9；AGENTS §6（小程序真机可见性由产品负责人确认）。

## 1. 职责与用户结果

- 职责：维护用户自己**怎么组织收藏**——文件夹（两级封顶）、子文件夹、收藏到文件夹的归属、全局置顶；把「社区收藏」与「题目收藏」两类真源**读**出来合成一张用户视图（不复制内容）。
- 用户结果：收藏页**导航栏左上角**的「目录」图标（深色「列表」标，导航栏中间 04:7x 起不画标题）打开左侧抽屉，点文件夹展开该文件夹的收藏并在头上给出子文件夹标签，点标签筛出该子文件夹的收藏；点收藏跳转；长按可置顶 / 移到文件夹 / 删除（＝取消收藏）；抽屉底部「分类管理」进独立页，可新建 / 重命名 / 删除文件夹与子文件夹、拖拽排序。

## 2. 当前有效规则及原决策编号

### 【已确认】（正文见产品手册）

- **DEC-096**（2026-09-23，产品负责人口述 + 四张效果图，产品手册 §0.4 索引）：
  ① 文件夹数据**存服务端**（per-user 隔离）；② 子文件夹标签＝**用户自建的子文件夹**（不是内容自带 tags 自动分组）；③「全部收藏」＝**社区收藏 + 题目收藏合并进同一列表**；④ **全局置顶**（同一内容在各文件夹都排最前）＋**删除＝取消收藏**（不引入「待整理」/回收站）；⑤ 目录入口＝**自绘导航栏左上角的图标**（返回键之后那颗，点击开抽屉）+ 标题「我的收藏」居中（**2026-09-23 04:0x 修订**，原口径"内容区左上角、不新增自绘导航栏"作废，见产品手册 §0.4 的「DEC-096 修订」行）。
- 同源补充口径（§1.9）：文件夹名 ≤20 字、**同级唯一**；**层级两级封顶**（子文件夹里不能再建）；父文件夹条数＝**直属 + 子文件夹**（rollup）；删除文件夹**连子文件夹一起删、里面的收藏退回未分类**（收藏本身不删）；卡片日期＝**收藏时间**（今天 / 昨天 / `M 月 D 日`）。

### 【实现事实·已核实】

- 效果图里**没有**"把某条收藏放进文件夹"的入口，实现时补了「**移到文件夹…**」（长按面板第二项 + 文件夹选择器），已登记待产品负责人改判（§1.9）。
- 行尾「···」菜单实现为**重命名 / 新建子文件夹（仅顶层）/ 删除文件夹**；**未做"更换图标"**（`createFolder` 的 `icon` 字段已预留但走默认）。

## 3. 状态流转与数据归属

- **归本模块（`favorite-folder-store.js`，`.runtime/favorite-folders.json`）**：`folders`（含 `parentId` 与顺序）、`members`（`{kind, refId, folderId}` 引用，**merge 不复制内容**）、`pins`（全局置顶）。`kind ∈ {community, question}`，`refKey = kind:refId`。
- **不归本模块（只读）**：社区收藏的真源＝`community-interaction-store` 的收藏引用关系；题目收藏的真源＝`learning-state-store` 的 `account.bookmarks`（客户端 `app.js` 的 `collectLearningState()` / `applyLearningState()` 已双向同步，本机 `shukao_bookmarks` 只是缓存，离线仍走它）。**"合并列表"因此不需要搬数据归属**。
- 失效规则：取消收藏后由 `prune({userId, validRefs})` 清掉残留的归属与置顶（`GET /api/favorites/folders` 每次先 prune 再返回，所以界面不会留"已取消收藏却还挂在文件夹里"的幽灵项）；`DELETE /api/account` 一并清该用户的收藏文件夹。

## 4. 跨模块输入输出及失效规则

- 输入：社区收藏引用关系（社区模块）、题目书签（学习状态模块）、社区内容元数据（标题 / 摘要 / 类型 / 科目章节列，供卡片出处行）。
- 输出：`GET /api/favorites/folders` 一次给全 `folders / counts{direct,withChildren} / membership / pins / favoritedAt / totals{community,question,all,unfiled}`；写接口 6 条。
- 跳转落点（收藏页 → 其他页）：题目 → `/pages/practice/practice?mode=review`（写 `shukao_active_review_ids`）；题包 / 卡片集 → `/pages/pack-collection/pack-collection?id=&source=public`；其余社区内容 → `/pages/knowledge/knowledge?assetId=`（知识库页 `openPendingAsset()` 支持深链展开）。
- 路由顺序硬约束：`POST /api/favorites/folders/reorder` 必须**排在** `^/api/favorites/folders/([^/]+)$` 之前，否则 `reorder` 会被当成文件夹 id。

## 5. 禁止事项

- 不得手改 `.runtime/favorite-folders.json`；只能走正式 Store / API。
- 不得把"用户怎么组织"写回内容本身（不得在社区资产、题目上新增文件夹字段）——本模块只存引用。
- 不得为「未分类」造一个系统文件夹（DEC-096 ④：不做「待整理」语义）。
- 小程序显隐一律 `wx:if`，不得用 `hidden` + 作者 `display` 的组合（AGENTS §6）。
- 带遮罩的浮层（抽屉 / 长按面板 / 文件夹选择器）必须随页面离开收拢（`utils/page-layers.js` 的 `closeTransientLayers`），否则会成为"页面能滚、按钮点不动"的隐形拦截层（`tests/page-transient-layers.test.js` 静态兜底）。

## 6. 实现状态、验收状态和已知缺口

### 【已实现】

- 2026-10-07：“我的收藏”列表入口已移到“社区与贡献”之前，仍跳转既有收藏页；顺序测试已更新，真机待验收。
- 2026-10-07：“我的”页「账户与服务」增加“我的收藏”入口，复用既有 `pages/favorites/`，同时保留复习工具入口；菜单与跳转契约已验证，真机待验收。
- 服务端：`apps/api/src/favorite-folder-store.js` + `server.js` 七条路由（均需登录）：`GET /api/favorites/folders`、`POST /api/favorites/folders`、`POST /api/favorites/folders/reorder`、`PATCH|DELETE /api/favorites/folders/:id`、`POST /api/favorites/membership`、`POST /api/favorites/pins`。拒绝码：`favorite_folder_name_required` / `_too_long` / `_duplicate`、`favorite_folder_parent_missing`、`favorite_folder_depth_exceeded`、`favorite_folder_reorder_incomplete` / `_invalid`、`favorite_folder_missing`（404）。
- 小程序：`pages/favorites/`（重建：**自绘导航栏左上角目录图标（深色「列表」标），导航栏中间不画标题** + 全高抽屉 + **搜索/筛选/排序一行** + 子文件夹标签 + 合并列表 + 长按面板）、`pages/favorite-manage/`（新增：文件夹/子文件夹管理 + ⠿ 拖拽排序 + 底部新建）、`utils/favorites-organization.js`（纯函数视图模型，含搜索匹配与类型筛选统计）、`utils/favorites-view.js`（补 `subjectName/chapterTitle/sectionTitle/tags/type` 透传）、`pages/knowledge/knowledge.js`（`?assetId=` 深链）、`app.json`（注册分类管理页）。

### 【已验证（2026-09-23 本机，含 04:0x 目录入口改判、04:1x 图标换标、04:2x 白图标落浅底根治、04:3x 横幅轻量化、04:4x 搜索/筛选/排序与书签标、04:5x 标题改细、04:6x 排序标换箭头标、04:7x 去导航栏标题、04:8x 标题字重对齐昵称九轮重跑）】

- 专项：`tests/favorite-folders.test.js` **6/0**、`tests/favorites-organization.test.js` **10/0**（04:4x 新增 2 项：搜索匹配口径、筛选叠加与自动作废）、`tests/favorites-page.test.js` **15/0**（04:4x 新增 2 项：搜索行顺序与「不要圆框」、筛选选项由数据长出来；04:5x→04:8x 收敛为 2 项：标题**字号回 34rpx**且**字重＝个人页昵称同号**（跨文件契约）、导航栏中间不再有标题节点；04:6x 增补：排序入口必须用 `sort.svg` 且不得再用滑块标）、`tests/favorite-manage-page.test.js` **7/0**；`tests/page-transient-layers.test.js` **2/0**；全站图标兜底 `tests/icon-contrast.test.js` **2/0**（① 白图标必须落深色底片——04:2x 先出红点名 6 处、修完转绿；② 04:6x 新增「同一功能用同一颗标」：按 `aria-label` 反查排序＝`sort.svg`、设置＝`settings-gear.svg`，覆盖收藏页 / 卡集页 / 练习页 / 个人页四处）。
- 全量：`tests/*.test.js` **137 文件 / pass 1306 / fail 0**（2026-09-23 跑于本轮全部改动之后；本仓库同时有另一个会话在改卡集侧文件并新增测试，故文件数与总条数会随对方改动变化——收藏页范畴的 6 个专项另有逐项实跑记录，见上一条）。
- 逐项可见性（真实 wxss + 无头 Chrome 读计算值与矩形）：`tmp/verify-favorites-redesign.js` **28 项全 PASS**，截图 10 张经人眼复核（`tmp/verify-out/favorites-{all,folder,subfolder,sheet,picker,drawer,failure,filter}.png`、`favorite-manage.png`、`icons-04-6x.png`）。导航栏逐项读到的真实值：盒子 0/0–375/87（状态栏 47 + 内容 40）、两个图标按钮左边缘 9px 与 43px（热区 34×36、图标 16px）、标题居中 187.5 且右边缘 ≤ 375−96（胶囊安全区）、首行内容 top ≥ 87（现在是搜索行的 top）、导航栏 `z-index 5` < 抽屉遮罩 20；**图标对比度按 WCAG 非文本判据 3:1 全部达标**（把真实 svg 内联进渲染稿量描边色 vs 所在底片）：导航栏目录标（`list.svg`）**7.99**、搜索框里的放大镜 **8.66**（白底）、漏斗 `filter.svg` **7.99**、排序箭头标 `sort.svg` **7.99**（04:6x 换），文件夹头书签 `bookmark.svg` **7.88**（淡青底 `#eaf7f4`）、长按面板三行 **7.77 / 7.77 / 4.24**、抽屉关闭 × **5.84**、抽屉「全部收藏」**8.66**、抽屉文件夹行 **7.88**；把导航栏那颗换回白色做反向对照＝**1.08**，V1b 如期失败（红-绿对照，日志 `tmp/verify-out/nav-icon-negative.log`）。
- 搜索 / 筛选 / 排序一行（04:4x，产品负责人「可在图2全部收藏上面加个搜索框，搜索框右边是筛选，筛选右边是排序」+「排序…可以不要那个圆框」+「筛选图标用图4」）：**V18 逐项读数**＝搜索行 top 109 < 文件夹头 top 155（在「全部收藏」上面）、搜索框 14→277（高 34＝68rpx）、筛选 285→319、排序 327→361（三格同高 34、自左向右、间距 8px＝16rpx）、两个工具按钮 `backgroundColor: rgba(0,0,0,0)` + `boxShadow: none`（**没有圆框**）、筛选生效时漏斗右下角出现青色状态点 `rgb(11,149,136)`；筛选面板 5 行（全部 6 / 题目 2 / 知识卡 1 / 共享笔记 1 / 卡片集 2），当前项青色 + ✓，面板贴底（bottom 812）且遮罩铺满（高 812）；搜索框有关键词时显示清空 ×（20px 热区）且副标题写成「6 条收藏 · 筛出 2 条」。
- 长按面板三行 / 抽屉关闭 / 抽屉与分类管理的文件夹行：**本机渲染稿里图标是灰色占位块，量不到颜色**，这几处由静态兜底 `tests/icon-contrast.test.js` 覆盖（读图标自身 stroke/fill + 页面 wxss 背景亮度），真机观感仍待产品负责人确认。
- 分类管理页顶部横幅（04:3x，产品负责人「绿框用颜色用浅绿，文字别这么粗，整体轻盈点」）：浅绿底 `#e7f6f1`、无渐变无投影、标题 `30rpx / 600 / #191f1d`、副标题灰字 `#5f6d66`、白方块底片上垫青色 `folder-brand.svg`（底片改白后，原来的白图标会立刻隐形——同一个坑，所以图标同批换掉）。**真实渲染值**（V15）：底色 `rgb(231,246,241)`、`backgroundImage: none`、`boxShadow: none`、字重 600、标题对比度 **15.02**、副标题 **4.88**、白底片上的青标 **3.70**。文案**未改**。
- 「全部收藏」标题的字重与字号（04:5x → 04:7x → 04:8x 三次真机反馈，口径已收敛）：**字号 34rpx（17px）**、**字重 500**、颜色 `#202824`；副标题保持 `#8a918c` / 22rpx / 400 不动。演进：04:5x「全部收藏用细一点的字」→ 700 降到 600；04:7x「那个全部收藏的文字能不能用昵称一样的字号」→ 我误解成字号、放大到 38rpx（**已改回**）；04:8x「感觉像加粗了一样，用和昵称一样的细字体，大小用回原来的17px」→ **字号回 34rpx、字重改 500**（＝个人页 `.nickname` 的 500/Medium）。**V2 读数**：`fontSize: "17px"`、`fontWeight: "500"`、副标题 `["11px","400","rgb(138,145,140)"]`；**V20 读数**（同一串字、同号画到 canvas 数墨迹像素）：`w400=332 / w500=332 / w600=632 / w700=632`——本机 CJK 字体只有 Regular/Bold 两面，**500 比 600 墨迹少 47%，"细一档"在本机就是可见的**（04:5x 那次 600 vs 700 像素完全相同，只能靠计算值证明）。**契约**：`tests/favorites-page.test.js` 那条**不写死 500**，而是拿个人页昵称的**当前字重**比——两处要么一起改、要么测试挂掉，不会悄悄漂开。
- 导航栏标题（04:7x，产品负责人把导航栏中间的「我的收藏」框成绿框、「去掉绿框中的文字」）：`.fav-nav-title` 节点与配套样式规则**整条撤掉**，导航栏中间不再有任何文字（左上角保留返回 + 目录两颗图标）。**V1 读数**：`titleNodes: 0`、`nav.textContent.trim() === ""`、两颗图标仍在 left 9 / 43（热区 34×36、图标 16px）、导航栏高度 87（状态栏 47 + 内容 40）、首行内容 top ≥ 87。`app.json` 的 `navigationBarTitleText` 保留（页面注册名，自绘导航栏下不渲染）。
- 排序标换成箭头标 + 跨页统一（04:6x，产品负责人「排序用图1这种，图2图3这两处」「图4的绿框中的设置，用图5这种」）：新图标 `assets/icons/sort.svg`（两根竖杆 + 左右斜头，仿他给的图 1），收藏页搜索行第三格与**卡集页抽屉「卡盒排序」**同批换成它（原来两处都是「滑块」标 `sliders.svg`）；练习页导航「练习设置」改用仓库已有的 `settings-gear.svg`（＝他给的图 5）。**V19 读数**：`sort.svg` 22px 白底对比度 **8.66**、18px on `#fbfbfa` **8.36**，`settings-gear.svg` 18px **6.56**；对照图 `tmp/verify-out/icons-04-6x.png` 经人眼复核，形状与参考图一致。**全局契约**：`tests/icon-contrast.test.js` 第 2 项按 `aria-label` 反查（排序→`sort.svg`、设置→`settings-gear.svg`，覆盖收藏 / 卡集 / 练习 / 个人四处），反向对照改回滑块标即变红。
- 复核中修掉的两个真问题：「已下架」徽标与 › 箭头重叠（改内联）；验证脚本自身把后代选择器压平、掩盖"选中/未选中"区别（工具缺陷，非页面缺陷）。

### 【待验收】

- **真机可见性（产品负责人，AGENTS §6：本机无微信运行环境）**：① 自绘导航栏是否与微信胶囊对齐（目录图标是否跟在返回键之后、是否被胶囊压住；04:7x 起中间不再有标题，不再看"标题居中"）；② 抽屉是否从左侧全高滑出、底部「分类管理」是否可点；③ 点文件夹后子文件夹标签是否出现、点标签是否真筛；④ 长按面板、置顶后回到列表是否排最前、删除后该条是否实时消失；⑤「移到文件夹…」是否好点、选完后卡片标签是否变成该子文件夹名；⑥ 四种跳转落点；⑦ ⠿ 拖拽排序是否跟手（脚本按行高 56px 换算，需真机确认手感）；⑧ 圆角 / 投影 / 青绿色号与真实 svg 图标；⑨ **04:4x 新增**：搜索行三格在真机上的排布与热区（真机输入法弹起时列表是否被顶住、「搜索收藏」占位与清空 × 是否好点）、漏斗筛选面板是否贴底且能滚动、筛选生效时漏斗右下角那颗青色状态点是否看得见、「全部收藏」的书签标在真机淡青底片上是否清楚；⑩ **04:5x→04:8x 收敛**：「全部收藏」现在是 **34rpx（17px）/ 500**（＝昵称同一号细字体），真机上**这次是否够细、是否与昵称看起来一致**（本机 500 比 600 墨迹少 47%，但真机字体面不同；若还偏粗只剩 400 Regular 一档，若偏细可回 600）；⑪ **04:7x 新增**：导航栏中间去掉「我的收藏」后，**页面是否显得没有归属**（左上角只剩返回 + 目录两颗图标；若需要身份提示，可换成小字副标题或把标题放进内容区，等他拍板）；⑫ **04:8x 观察**：17px / 500 的「全部收藏」与下面卡片标题（14px / 600）的**层级对比是否还立得住**（本机读数是 17px / 500）。
- **2026-09-23 03:5x 首次真机反馈＝接口 404（已定位，非页面缺陷）**：产品负责人真机截图显示两页都提示「收藏目录加载失败」并附「0 个文件夹 · 0 条收藏 / 文件夹 0 个」。排查：监听 3212 的 API 进程 **pid 17388 启动于 01:43:57**，而 `server.js` 改于 02:46:10、`favorite-folder-store.js` 改于 02:44:39；直接请求 `GET /api/favorites/folders` 得 **HTTP 404 `{"error":"not_found"}`**（若新代码已加载，未登录应是 401 `auth_session_required`）→ **根因是后台进程早于改动启动，`/api/favorites/*` 七条路由在跑着的进程里根本不存在**（AGENTS §8）。**处理**：① 按 §8 由产品负责人在自己终端重启 3212（Agent 沙箱启的进程写 `.runtime` 会 EPERM）；② 顺带修掉这次暴露的两个**页面缺陷**——失败态曾把两个失败塞进同一个 `communityError` 字段互相覆盖、且拿"加载失败"当"没有收藏"（见【已知缺口】与变更日志第三轮）。

### 【已知缺口】

- 「···」菜单的**更换图标**未做（`icon` 字段已预留，效果图无该入口）。
- ⇅ 排序只有「收藏时间 新→旧 / 旧→新」两向（口径待产品负责人补全，§1.9）；04:4x 起它不再是一颗白色圆按钮，而是**搜索行第三格**里的裸图标（无底色无投影）；04:6x 起图形换成**箭头标** `sort.svg`（与卡集页「卡盒排序」同一颗，见 `tests/icon-contrast.test.js` 的跨页契约）。
- **搜索是客户端过滤**（只筛"已加载的这一批"收藏，不做服务端搜索、不分页）：每敲一个字都会重算整张视图并 `setData`（当前收藏量下开销可忽略；收藏量大到需要翻页时改成服务端搜索，届时口径需产品负责人确认）。
- **筛选维度＝内容类型**（选项与条数由当前范围的数据统计出来，不写死词表）；产品负责人 04:4x 只给了图标，维度解读与面板文案已登记 `OPEN_DECISIONS.md` §1.9 待他拍板。
- 拖拽排序的落点按常量 56px（112rpx）换算，行高改动必须同步改脚本常量（有契约测试锁）。
- 收藏页的组织数据在离线时退化：目录拿不到则全部收藏列在「全部收藏」下并提示可下拉重试（不阻塞列表）。
- **失败态必须与"真的空"分开**（2026-09-23 首次真机暴露后修正）：① 两个失败各自成条（`communityError` = 收藏列表加载失败、`organizationError` = 收藏目录加载失败，各带「重试」），不再互相覆盖；② 列表没加载成功时空态说「收藏没加载出来」且**不出现**「去逛逛知识库」，目录没加载成功时副标题说「目录暂不可用」、抽屉不说「还没有文件夹」——**不能拿一次失败的加载去宣称用户没有收藏**；③ 接口 404（后台未重启）时提示「收藏目录服务未就绪（后台服务需重启后生效）」，让下一次不用靠猜。
- **自绘导航栏的四条硬约束**（改这一页时别踩）：① 状态栏高度与右上角胶囊安全区**必须实量**（`wx.getMenuButtonBoundingClientRect()`，拿不到时退回默认值），写死会被胶囊压住；② 导航栏是 `position: fixed` 且 `z-index: 5`，**必须低于抽屉/长按面板的遮罩（20 / 10）**，否则会出现"抽屉开了、导航栏还能点"；③ 固定导航栏下方要有等高占位块（`<view style="height: {{navTotalHeight}}px;">`），否则第一行内容被压住。抽屉从屏幕顶端起，标题另加状态栏高度（`drawerPaddingTop`）；④ 图标须深色（见下一条）。**04:7x 起导航栏中间不再画标题**（产品负责人「去掉绿框中的文字」）：左上角只有返回 + 目录两颗图标，中间是空白——所以"标题居中、别被胶囊压住"这条不再适用，改成"**中间不得出现任何文字节点**"（V1 读 `document.querySelectorAll('.fav-nav-title').length === 0` + `nav.textContent.trim() === ""`）；页面身份靠 `app.json` 的 `navigationBarTitleText`（注册名，自绘导航栏下不渲染）。
- **图标必须"看得见"**（2026-09-23 04:1x 真机「看不见」）：① 导航栏那颗**必须深色**——仓库里 `pack-folder.svg` 一组是 `stroke="#ffffff"`（给深色工具条/青色底片用的），画在没有底色的浅色导航栏上等于隐形；现在用 `list.svg`（`stroke="#474d49"`，对比度 7.99）。② **凡白图标必须落在深色底片上**：`tests/icon-contrast.test.js` 全站静态兜底（读图标自身 stroke/fill + 沿页面 wxss 往上找最近背景算相对亮度），新增 `folder.svg` / `pin.svg` 两个深色标供浅底片使用（长按面板三行、抽屉关闭、抽屉与分类管理的文件夹行）。③ 换图标时的判据是"**读它自己的颜色**"，不是文件名——导航栏那条测试与全站兜底都是这么写的。④ 04:4x 新增的 `filter.svg`（漏斗）与「全部收藏」改用的 `bookmark.svg` 都是**深色标**；排序那颗 04:6x 起是 `sort.svg`（深色 `#474d49`，替代原来的滑块标）——撤掉白色圆框后它们直接落在页面浅灰底（`#f5f6f5`）上，对比度 7.99（筛选用 3:1 的非文本判据）。

## 7. 代码、测试与历史决策入口

- 代码：[`favorite-folder-store.js`](../../apps/api/src/favorite-folder-store.js)、[`server.js`](../../apps/api/src/server.js)、[`pages/favorites/`](../../apps/miniprogram/pages/favorites/)、[`pages/favorite-manage/`](../../apps/miniprogram/pages/favorite-manage/)、[`utils/favorites-organization.js`](../../apps/miniprogram/utils/favorites-organization.js)、[`utils/favorites-view.js`](../../apps/miniprogram/utils/favorites-view.js)、[`utils/page-layers.js`](../../apps/miniprogram/utils/page-layers.js)。
- 测试：[`tests/favorite-folders.test.js`](../../tests/favorite-folders.test.js)、[`tests/favorites-organization.test.js`](../../tests/favorites-organization.test.js)、[`tests/favorites-page.test.js`](../../tests/favorites-page.test.js)、[`tests/favorite-manage-page.test.js`](../../tests/favorite-manage-page.test.js)；全站图标对比度兜底 [`tests/icon-contrast.test.js`](../../tests/icon-contrast.test.js)（覆盖 `pages/**` 全部 wxml，不限于本模块）。
- 验证脚本：[`tmp/verify-favorites-redesign.js`](../../tmp/verify-favorites-redesign.js)。
- 规则正文：产品手册 §0.4（DEC-096 与紧随其后的「DEC-096 修订」行）。
- 历史决策：DEC-096（2026-09-23）；过程记录见 [`二、变更日志`](<../../题库开发手册/二、变更日志（CHANGELOG.md）.txt>) 同日四条（第一轮数据层 / 第二轮页面与验证 / 第三轮真机 404 与失败态 / 第四轮目录入口改判）。
