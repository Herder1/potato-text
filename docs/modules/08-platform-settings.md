# 08 平台设置（用户协议与平台文本）

> 导航文档，不是规则正文。规则来源＝产品负责人 2026-10-05 要求 + 当日 7 项决策（**已登记为 DEC-110**，见产品手册 §0.4）；
> 本文件只写"实现状态、验收状态和已知缺口"；与规则正文冲突时以产品手册为准。

## 1. 职责

- 用户端可见的 **7 份平台文本**的唯一维护处：正文、版本号、生效日期、发布/下架、当前版本查询。
- 用户端（关于页、法律页、个人信息页、登录确认入口、商品页入口）**只读"已发布"版本**；没有已发布版本时显式显示「尚未发布」，不得拿占位或硬编码文本伪装成正式协议。
- 记录用户对**某一版**协议的同意（按账号、只追加），协议改版不覆盖用户过去同意过的版本记录。
- 公告、商品管理、帮助中心 FAQ **不在本模块**（公告与商品已有后台；FAQ 迁移是第二阶段）。

## 2. 有效规则（产品负责人 2026-10-05 确认）

1. **文档集合固定 7 份**（key → 标题）：
   `terms` 用户协议、`privacy` 隐私政策、`ai-service` AI 服务说明、`refund` 退款政策、
   `account-deletion` 账号注销说明、`operator` 运营主体与客服信息（含营业执照号/图片的落点）、
   `personal-info` 个人信息收集清单（独立成篇，供「个人信息」页读取）。
2. **只读已发布版本**：未发布时用户端接口返回 `published:false`（HTTP 200，不是 404），且**不下发任何正文**；页面显示「尚未发布」。
3. **发布即锁死，草稿可改写**（2026-10-05 追加确认「选项 A」）：草稿可以反复改写（同版本号重存＝更新草稿，历史不新增条目，因为草稿没人同意过、也没下发过）；**一旦发布，正文与生效日期都不可再改写**，改版＝新增一版 + 发布。发布新版时旧的已发布版转 `retired`，**正文与生效日期永久保留**；下架只把当前版转 `retired`，不删任何版本；曾发布过的版本可以重新发布（回滚），但其正文、生效日期与首次发布时间都不被改写。
4. **同一文档同时只有一版是"当前版本"**（`currentVersion`），它是用户端唯一读到的版本。
5. **后台权限只放超级管理员**：`/api/admin/platform-content` 登记在 `server.js` 的 `SUPER_ADMIN_ONLY_ADMIN_PATHS`，不为运营操作员开放（协议文本有法律效力，改协议是治理边界）。
6. **登录确认不阻断登录**：勾选框继续引用微信侧《用户隐私保护指引》，另加两个可点入口指向我们的《用户协议》《隐私政策》（未发布则显示「尚未发布」）。
7. **同意记录＝服务端按账号 + 本机缓存**：服务端只追加 `{docKey, version, agreedAt, source}`；同一版本重复同意幂等，换版本才追加。
8. 发布必须带**生效日期**：可以在保存草稿时就填，也可以在点「发布此版」时补填；重存草稿时留空生效日期＝沿用该版原有日期（不静默清空）。版本号在同一文档内唯一（草稿可覆盖同号草稿，已发布/已下架版本号不可复用）。

## 3. 数据归属（一处维护）

| 数据 | 真源 | 位置 |
| --- | --- | --- |
| 7 份文档的版本历史（正文/版本号/生效日期/状态/发布人/时间） | 服务端 | `apps/api/src/platform-content-store.js` → `.runtime/platform-content.json`（postgres 模式：`runtime_store_documents.platform-content`） |
| 用户同意记录 | 服务端（本机为缓存） | `apps/api/src/user-auth-store.js` 的 `user.agreements` → `.runtime/users.json` |
| 各文档"该显示哪一版" | 本模块 | 用户端只认 `GET /api/platform-content/:key` 的返回 |
| 旧硬编码法务文案 | —— | 已于切片 3 清理：`app-meta.js` 的假主体与写死目录、`pages/legal/`（原「内容待补充」占位）、`pages/personal-info/`（原写死清单与三段说明）均已改为读接口；`pages/privacy/` 是已下线页（不打包），保留供追溯 |
| AI 扣费单价口径 | DEC-107 | `apps/miniprogram/utils/bean-pricing.js`（**不在本模块**，本模块只提供展示入口） |
| 公告 / 商品 / FAQ | 各自既有归属 | 公告与商品已有后台；FAQ 见第二阶段 |

## 4. 接口

用户端（公开读、无需登录）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/platform-content` | 已发布文档清单（key/title/group/version/effectiveDate/publishedAt，不含正文） |
| GET | `/api/platform-content/:key` | 已发布版本详情；未发布返回 `{success:true,published:false,document:{...}}` |
| GET | `/api/auth/agreements` | 我的同意记录（需登录） |
| POST | `/api/auth/agreements` | 记录同意 `{docKey,version,source}`；只认**当前已发布**版本（非当前版本返回 409 + `currentVersion`） |

后台（仅超级管理员）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/platform-content` | 7 份文档摘要（状态/当前版本/生效日期/版本数/草稿数） |
| GET | `/api/admin/platform-content/:key` | 单文档（含全部版本正文）+ 历史版本列表 |
| POST | `/api/admin/platform-content/:key/versions` | 新增或更新**草稿**：`version`/`body`/`effectiveDate?`/`note?`（同版本号的草稿＝改写；已发布/已下架版本号返回 422 `platform_content_version_conflict`） |
| POST | `/api/admin/platform-content/:key/publish` | 发布指定版本（旧版转 retired）：`{version, effectiveDate?}`——草稿没填日期时可在这一步补填 |
| POST | `/api/admin/platform-content/:key/unpublish` | 下架当前版本（保留历史） |

后台界面入口（切片 2，2026-10-05）：左侧一级菜单「平台设置」（`data-view="平台设置"`，仅超级管理员可见后台独有的接口）→ 面板 `#platform-content-admin`（摘要 + 7 份文档表）→ 编辑器对话框 `#platform-content-editor-dialog`（版本号/生效日期/备注/正文 + 历史版本表，历史行可「载入正文」「发布此版」「下架」）。

错误码：`platform_content_unknown_document`(404)、`platform_content_version_conflict`(422，同版本号不可覆盖)、
`platform_content_version_not_found`(404)、`platform_content_effective_date_required`(422)、
`platform_content_not_published`(422)、`platform_content_version_not_current`(409)、
`agreement_doc_required`/`agreement_version_required`(400)。

## 5. 禁止事项

- 不得在用户端页面硬编码或"临时占位"法务正文；未发布就显示「尚未发布」。
- 不得在读取失败时回落到旧文本或本机缓存冒充当前版本：失败就显示「暂时读不到」并给重试（`platform-content.js` 的失败态**不写缓存**，就是这条的落地）。
- 不得提供"改写/删除已发布版本"的任何入口；改版只能新增版本 + 发布。
- 不得删除或覆盖用户同意记录（含协议改版后）。
- 不得把 `/api/admin/platform-content` 加进运营白名单（协议维护仅超级管理员）。
- 不得在未发布时下发正文（`published:false` 时响应里不得有 `body`）。
- 不得手改 `.runtime/platform-content.json`（正式数据只能经 API/Store 修改）。
- 不得让本模块复制公告/商品/FAQ 的既有能力（避免双写）。

## 6. 实现状态、验收状态和已知缺口

- **已实现（切片 1，2026-10-05，纯后端）**：`platform-content-store.js`（7 份固定文档骨架、版本 append-only、发布/下架、当前版本查询、归一化 `replaceState`、文件 store tmp+rename 0o600）；持久化接入 `STORE_SPECS`（28→29 条，含 `platform-content`，写方法 `replaceState/saveVersion/publish/unpublish`）与运维导入清单 `PRIMARY_RUNTIME_FILES`（22→23，`platform-content.json`）；`server.js` 8 条路由（4 用户端 + 5 后台动作）；`user-auth-store.js` 的 `agreements` 只追加同意记录（`recordAgreement`/`listAgreements`，并登记进 users 的写方法清单）。
- **已验证（本机，2026-10-05，`NODE_ENV` 已清）**：`platform-content-store` **7/7**（新增）、`platform-content-api` **5/5**（新增：未发布态不下发正文、草稿→发布→改版历史、同版本号被拒、发布无生效日期被拒、后台权限、操作日志、同意记录只追加/幂等/跨账号隔离）、`postgres-persistence` **11/11**（含新增装载用例：写回 `platform-content` 文档、历史版本落库）；邻接回归 `admin-auth` 20/20、`auth-profile-api` 4/4、`onboarding-profile` 5/5、`runtime-postgres-migration` 5/5。全量 `node --test tests\*.test.js`：**1770 用例、1769 通过、1 失败**——唯一失败是 `page-transient-layers` 的 `store`（与本次改动无关：`apps/miniprogram/pages/store/store.js` 当时正被另一会话编辑，mtime 2026-10-05 03:35，缺少 `onHide` 收浮层）。
- **已实现（切片 2，2026-10-05，后台面板）**：后台一级菜单「平台设置」（`apps/admin/index.html` 的 `data-view="平台设置"`；`app.js` 的 `isPlatformContent` 显隐切换 + `loadPlatformContent`）＋面板 `#platform-content-admin`（摘要四格 + 7 份文档表）＋编辑器对话框 `#platform-content-editor-dialog`（版本号/生效日期/备注/正文 + 历史版本表：载入正文 / 发布此版 / 下架）；`styles.css` 配套样式与 `[hidden]` 兜底；静态资源版本号 `20261004.81 → 20261005.82`（`tests/admin-platform-content-ui.test.js` 锁住同值与已抬版）。同轮按「选项 A」放宽草稿语义：同版本号重存＝更新草稿（已发布/已下架版本号仍 422 冲突）、发布时可补填生效日期、重存草稿留空生效日期＝沿用原值、曾发布版本回滚不改写正文/生效日期/首次发布时间。
- **已验证（本机，2026-10-05，`NODE_ENV` 已清；切片 1+2）**：`platform-content-store` **9/9**、`platform-content-api` **5/5**、`admin-platform-content-ui` **5/5**、`postgres-persistence` **11/11**（含本模块装载/写回用例）；邻接回归 `admin-auth` 20/20、`admin-hidden-toggle-css`、`auth-profile-api` 4/4、`onboarding-profile` 5/5、`runtime-postgres-migration` 5/5；全量 `node --test tests\*.test.js` **1779 用例 / 1778 通过 / 1 失败**，唯一失败是 `storefront-page-flow` 的 `store` 页布局断言（`pages/store/store.wxml` 正被另一会话编辑：其 `bean-tile` 改名 `recharge-option`，该会话自己的日志记 03:43 已同步；与本模块无关，本轮未触碰该文件）。**后台面板逐项可见性**（AGENTS §6，无头 Chrome + 独立端口 65232，内存 store，不写 `.runtime`）：`tmp/verify-platform-content-admin-ui.js` **32/32 PASS**，逐项读 `hidden`/`getComputedStyle().display`/`offsetParent`/`dialog.open`/`innerText`，覆盖"未进入→不可见、进入→可见、其它视图收起"、7 份文档与「尚未发布」口径、编辑器打开/关闭、草稿→发布→补填生效日期→改版→下架全流程、用户端接口同步（`published` 与正文）、页面零 JS 报错；截图 `tmp/screenshots/platform-content-panel.png`、`tmp/screenshots/platform-content-editor.png`（人工复核）。
- **已实现（切片 3，2026-10-05，用户端接通）**：新增 `apps/miniprogram/utils/platform-content.js`（7 份文档登记表 + 读取接口 + 5 分钟本机缓存 + 四态归一：`published`/`unpublished`/`failed`/`loading`，**失败态不缓存**）；新增共用渲染模板 `apps/miniprogram/templates/platform-doc.wxml`（法律页与个人信息页共用一处口径，样式放 `app.wxss` 的 `.platform-doc-*`）；`pages/legal/` 由占位页改为**只读已发布版本**（已发布显示正文分段 + 「版本 x · 生效 y」、未发布显示「尚未发布」、读不到显示「暂时读不到」+「点这里重试」）；`pages/personal-info/` 改为读独立文档 `personal-info`（原写死六级清单与三段说明删除）；`utils/app-meta.js` 删掉假主体（`教育科技有限公司`）与写死法务目录 `LEGAL_DOCS/findLegalDoc`，应用名改为产品自己的 `薯考`；关于页入口改为从登记表生成**全部 7 份**（含退款政策、账号注销说明），带一行入口说明；登录引导加 DEC-110 ③ 的双入口（微信《用户隐私保护指引》勾选不变 + 我们的《用户协议》《隐私政策》可点，未发布显示「尚未发布」，**不阻断登录**）；删除 `pages/settings/settings.js` 的死代码 `openLegal`。
- **已验证（本机，2026-10-05，`NODE_ENV` 已清；切片 3）**：`miniprogram-platform-content` **5/5**（新增：7 键登记表与入口文案、图标真实存在、版本行与分段、只认已发布载荷、接口路径/缓存/force/失败不缓存/无 `wx` 不抛错、引导双入口跳转）；`settings-pages` **7/7**（重写三条：关于页 7 份入口与假文案清零、法律页已发布/未发布/读不到三态与重试、个人信息页读接口且写死文本清零）；`platform-content-store` 9/9、`platform-content-api` 5/5、`admin-platform-content-ui` 5/5、`postgres-persistence` 11/11 仍全绿；全量 `node --test tests\*.test.js` **1784 用例 / 1784 通过 / 0 失败**（上一轮那 1 条 `storefront-page-flow` 失败由并行会话自行修复）。
- **已验证（本机，2026-10-05；切片 3 逐项可见性，非真机）**：`tmp/verify-miniprogram-platform-doc.js` **29/29 PASS**，逐项读真实渲染结果——已发布＝标题/版本行/三段正文/字号 13px（26rpx）证明确实吃到 `app.wxss` 的 `.platform-doc-*`；未发布＝「尚未发布」+ 说明 + 零正文；读不到＝「暂时读不到」+ 重试可见 + 点击真的派发 `retryLoadDoc`；个人信息页＝同模板两段 + 客服按钮复位；登录确认＝微信指引勾选行不变、新增两份文档入口（22rpx→11px 灰字）、点《用户协议》只派发 `openDoc`（catchtap 不误触勾选）、勾选后主按钮仍可登录。截图存 `tmp/screenshots/miniprogram-platform-doc/`（4 张，人工复核）。**该脚本第一次跑就抓到"四态分支同时渲染"的假象**——根因在脚本自己的 WXML 解析器把无值属性 `wx:else` 漏了（顺手补上"只有一个分支进 DOM"的断言），真模板本身无此问题；这正是"截图要人看"的价值所在。
- **本轮修掉的两个真实缺陷（无头复核发现，非猜测）**：① 历史版本表里的按钮缺 `type="button"` 且在 `<form>` 内 → 点「载入正文」会连带提交表单、**悄悄存出一版草稿**（接口轨迹里多出一次 `POST /versions 201`；已修 + 加静态断言"表单内按钮必须显式 type"）；② 重存草稿时表单留空生效日期会把**已填日期清空**（改为留空＝沿用原值，并在保存提示里回显最终日期）。
- **未实现（后续切片）**：① 登录确认的版本化同意落到页面（切片 4，**接口已就绪**：`GET|POST /api/auth/agreements`，本机缓存键 `shukao_privacy_agreed_v1` 仍是"本机同意过"的弱标记）；② 帮助中心 FAQ 迁移（切片 5 / 第二阶段）；③ 商品页的 `购买须知 · 退款说明` 目前是**并行会话写的弹窗硬编码文案**（`pages/store/store.js` 的 `openPurchaseNotice`），尚未指向本模块的 `refund` 文档——该文件由另一会话在改，本轮**未触碰**，待合并时改成"打开退款政策文档"（一行改动）。
- **未验证（明确列出）**：① **小程序真机可见性**——本机无微信运行环境，Agent 只能核到"代码 + 契约"层（`wx:if` 分支、空态/错误态、`wx:for` key、接口失败提示），须产品负责人在微信开发者工具/真机确认（待真机验收）；② **postgres 真实库**——本轮只用本机 fake-knex 与内存 store 验证，真实 `runtime_store_documents` 的装载/写回待部署时验证；③ 本模块的后台面板**只在本机无头 Chrome（Chromium 内核）核过**，未在其它浏览器/真机后台核过布局（Windows Chrome 与小程序无关，风险低）；④ 用户端页面**只在本机 Node 里按页面契约跑过**（假 `wx`），未在开发者工具里渲染过布局。
- **已知缺口 / 待裁决**：① `RELEASE_CHECKLIST` **A2/A6** 行是否改判（用户端本轮已接通，本模块是其落地手段）——**改判需产品负责人确认，本轮未改清单**；② 顺带发现：`userAuthStore.updateProfile` **未**登记进 `STORE_SPECS` 的 `mutations`，即 postgres 模式下资料页修改不触发落库（本次**未改**，需产品负责人定是否一并修）；③ 文档正文当前为纯文本（换行分段），图片/附件（如营业执照扫描件）只能用外链 URL，尚未支持正文内嵌图片。

## 7. 代码与测试入口

- 服务端：`apps/api/src/platform-content-store.js`、`apps/api/src/server.js`（搜 `platform-content`，用户端路由在公告路由之后、后台路由在公告后台块之后）、`apps/api/src/user-auth-store.js`（`recordAgreement` / `listAgreements`）、`apps/api/src/postgres-persistence.js`（`STORE_SPECS`）
- 运维导入清单：`scripts/db/runtime-migration-lib.js`（`PRIMARY_RUNTIME_FILES`）
- 测试：`tests/platform-content-store.test.js`、`tests/platform-content-api.test.js`、`tests/admin-platform-content-ui.test.js`（后台面板契约：导航/面板/对话框接线、必填与 `maxlength`、错误码中文覆盖、`?v=` 抬版）、`tests/miniprogram-platform-content.test.js`（用户端读取口径：登记表/版本行/分段/只认已发布/缓存与失败不缓存/引导双入口）、`tests/settings-pages.test.js`（关于页 7 份入口、法律页三态与重试、个人信息页读接口）、`tests/postgres-persistence.test.js`（装载与写回用例）
- 后台界面：`apps/admin/index.html`（搜 `platform-content`）、`apps/admin/app.js`（搜 `platformContent`）、`apps/admin/styles.css`（搜 `platform-content`）
- 用户端界面：`apps/miniprogram/utils/platform-content.js`（唯一读取入口）、`apps/miniprogram/templates/platform-doc.wxml`（两页共用的渲染模板）、`apps/miniprogram/pages/legal/`、`apps/miniprogram/pages/personal-info/`、`apps/miniprogram/pages/about/`、`apps/miniprogram/pages/onboarding/`（登录确认双入口）、`apps/miniprogram/utils/app-meta.js`
- 逐项可见性复核脚本：`tmp/verify-platform-content-admin-ui.js`（后台面板：无头 Chrome，独立端口，内存 store）、`tmp/verify-miniprogram-platform-doc.js`（用户端：**真模板 + 真 WXSS + 真模块数据**在浏览器里按 375pt（1rpx=0.5px）等价渲染，逐项读 `innerText`/`getComputedStyle`/`offsetParent`/点击派发，四种状态截图存档——**不是真机渲染**，真机验收仍归产品负责人）
