# 01 身份、登录与后台权限

> 模块编号仅用于导航。本条目的规则引用**权威正文**（产品手册），不替代原文。
> 相关：C1（角色权限表待确认，见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.1）、C4（已自查为文档边界问题、非冲突，见 §2）。

## 1. 职责与用户结果

- 用户侧：微信快捷登录、跨设备学习记录同步、会话失效与账号限制（产品手册 §6.6、§9.2）。
- 后台侧：账号密码登录、角色与权限、会话管理、真实操作人记录、初始密码强制轮换。
- 用户结果：用户不必单独注册即可用微信身份进入并跨设备同步；后台每个业务动作可追溯到具体操作人，匿名请求拿不到任何后台数据。

## 2. 当前有效规则及原决策编号

### 【已确认】（正文见产品手册）

| 规则 | 来源 |
| --- | --- |
| 产品必须常驻提供隐私政策、个人信息收集清单、第三方共享清单、账号注销、客服反馈；用户可查询/更正/复制/导出/删除个人信息；注销必须撤销会话并对散落数据删除或去标识化 | 产品手册 §9.2〔已确认，部分实现〕 |
| 微信快捷登录与跨设备学习记录同步属于"我的"已实现能力 | 产品手册 §6.6 |
| 正式环境必须增加管理员登录、权限、真实操作者身份和访问限制 | 产品手册 §8.4〔待整改〕 |
| 危险操作必须二次确认并写入操作日志 | 产品手册 §8.4 |
| 管理接口不得以开放 CORS 和无鉴权状态直接暴露公网 | 产品手册 §8.4 |
| 正式上线 P0：完成管理后台鉴权、权限和正式操作人记录 | 产品手册 §11.2-2 |
| 生产使用 HTTPS、微信合法域名与正式 AppID；AI 密钥、微信 Secret、数据库密码、文件服务 Token 只在服务端环境变量保存；代码不得写死本机/局域网地址 | 产品手册 §10.2〔已确认〕 |
| 未经明确授权，私人答案、笔记、对话和反馈不得用于训练；授权默认关闭、可撤回、使用前去标识化 | 产品手册 §9.1〔已确认〕 |

**注意**：产品手册**没有定义后台角色模型**（角色名称、权限边界、会话时长、密码策略均无正文）。因此下文"实现事实"在获得产品负责人确认前，不得当作已确认产品规则（C1）。

### 【实现事实·待确认（C1）】

实现已存在且测试覆盖，但产品手册没有角色模型正文。下表请产品负责人逐行确认；确认后即升为已确认规则，未确认前按"实现事实"引用，不得对外当作承诺。

**2026-09-21 产品负责人口径（会话确认，待登记正文）**：两级角色方向认可；**取消 operator 对未知后台接口的默认放行**，要求补业务权限清单；要求验证内部导入的独立授权机制。下表已按此口径更新实现（未登记前仍属"实现事实"）。

| 接口 / 能力 | 未登录 | operator | super_admin |
| --- | --- | --- | --- |
| `POST /api/admin/auth/login` | 允许 | — | — |
| `GET /api/admin/auth/me`、`POST /auth/logout`、`POST /auth/password`（自助档） | 401 | ✓ | ✓ |
| `/api/admin/accounts*`（后台账号管理） | 401 | 403 | ✓ |
| `/api/admin/ai-config*`（模型与密钥配置） | 401 | 403 | ✓ |
| `/api/admin/ai/*`（路由、提示词、连通测试） | 401 | 403 | ✓ |
| `/api/admin/billing*`（收费、商品与额度） | 401 | 403 | ✓ |
| 运营白名单（overview、moderation、operation-logs、questions、question-catalog、question-families、question-family-sets、question-family-options、question-enrichment、knowledge-structure、knowledge-dossiers、knowledge-dossier-deltas、knowledge-classification、adjudication、textbooks、exams、packs、announcements、ai-tasks、user-restrictions、community） | 401 | ✓ | ✓ |
| **未登记的后台路径（默认）** | 401 | **403（默认拒绝）** | ✓（未登记路径对超管返回 404） |
| `/api/admin/exams/*` 内部导入（内部服务头 + 本机来源 + 限定该前缀，三者缺一不可） | 允许（记为 `system`） | — | — |

会话与凭据策略：12 小时会话；15 分钟窗口内 8 次失败锁定；密码 ≥8 位且不得等于用户名；`mustChangePassword` 时只放行 me/logout/password（服务端强制，非仅标记）；停用 / 重置密码 / 本人改密 / 登出立即撤销该账号全部会话；环境变量只用于首次建号，不能免登录。

用户侧限制（同属本模块的实现事实）：禁言 / 禁止投稿 / 公开功能限制 / 账号封禁四类，**必须带到期时间（1–365 天）**，到期自动失效，**只有超级管理员能提前解除**；封禁即时撤销该用户全部会话并拒绝登录；拦截按能力（speak / submit / publish / write）落在投稿、反馈纠错、公开分享与成套导出、学习同步、额度消费与 AI 计费上。规则正文（禁言/封禁语义）在产品手册尚无对应章节，与 C1 一并待登记。

完整表与确认项见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.1。

## 3. 状态流转与数据归属

**用户会话**（归属：`user-auth-store.js`）

```text
微信 code ──> /api/auth/wechat/login ──> 用户 + 会话 token
请求 ──> resolveRequestIdentity：有效会话 → 使用会话身份
                         无会话 → 仅非 production 且显式 test-user 时兜底，否则 401
```

**后台请求**（归属：`admin-account-store.js` 管账号与会话，`server.js` 管闸门，`admin-operation-store.js` 管操作日志）

```text
未登录 ──> /api/admin/* 一律 401 admin_session_invalid
登录 ──> 会话有效 ──> mustChangePassword ? 仅放行 /auth/me、/auth/logout、/auth/password（否则 403）
                 └─> 命中仅超管前缀且非超管 → 403 admin_permission_denied
                 └─> 否则进入业务处理，actor = 真实账号 write 操作日志
停用 / 重置密码 / 本人改密 / 登出 ──> 该账号全部会话立即失效
```

- 登录本身**不写业务操作日志**（避免审计写入失败把管理员锁在后台外）；业务动作才写。
- 密码仅以 scrypt + 随机盐保存；对外投影不含 `passwordHash`；初始密码只在首次生成时返回一次。
- 环境变量 `ADMIN_INIT_USERNAME/PASSWORD/DISPLAY_NAME` **只用于首次建号**，不是免登录后门。

## 4. 跨模块输入输出及失效规则

- **输出给模块 02/03/04**：每个 `/api/admin/*` 请求的身份、角色与真实操作人（写进操作日志）。
- **输入**：`WECHAT_APP_ID`/`WECHAT_APP_SECRET`（有值时走真实 code 换取 openid，否则开发态）；`ADMIN_INIT_*`（首次建号）。
- **失效规则**：
  - 账号停用 → 其全部会话立即撤销；重新启用**不复活**旧会话，必须重新登录；
  - 重置密码 / 本人改密 / 登出 → 旧 token 立即失效；
  - `NODE_ENV=production` → 开发态匿名兜底失效，任何无会话后台请求 401；
  - 初始凭据不合法（过短等）→ 后台保持锁定，**绝不降级成免鉴权**。
- **内部服务例外**：带内部服务头、来自本机、且路径在 `/api/admin/exams/` 下的导入任务以 `system` 身份运行，不签发会话。

## 5. 禁止事项

- 不得以"内网/本机"为由去掉后台鉴权；不得把 `ADMIN_INIT_*` 当免登录后门。
- 不得把密码哈希、会话 token、AI 密钥等敏感字段返回前端。
- 不得手改 `.runtime` 中的账号、会话或操作日志数据。
- 不得把微信 `openid`/`unionid` 用于未授权用途；未授权不得把私人内容用于训练。
- 在 C4 裁决前，不得新增用户可见的"官方题库/官方答案"文案。

## 6. 实现状态、验收状态和已知缺口

- 2026-10-07：“我的”页「账户与服务」列表末尾新增“我的收藏 / 我的资产”两行，分别进入已有收藏页和资产页；原三行顺序与上方资产统计卡入口不变。菜单绑定与跳转测试通过，微信开发者工具/真机可见性待验收。
- 2026-10-07：已按产品负责人“QQ 号码式 ID”要求新增稳定唯一 9 位 `publicId`，内部 `user-${UUID}` 保持不变；“我的”与“编辑资料”只显示/复制数字号，后台可按该号定位内部账号。文件 Store 的旧用户回填脚本 `scripts/migrate-user-public-ids.js` 默认干跑、`--write` 先备份再校验；本机 6 个旧账号已回填，用户与会话其他字段未变。隔离 Store/API 测试通过；PostgreSQL 正式环境尚未执行显式回填，微信真机展示/复制待验收。
- 2026-10-07：小程序“我的”页把用户 ID 移到昵称下方、加入天数上方，保留完整值复制；昵称区长值只做视觉省略，不更改身份。用户要求 QQ 号式数字编号，需新增与内部 UUID 分离的唯一对外号并给旧账号补发，正式数据变更及后台按数字号查找尚待确认，本轮未执行。
- 2026-10-07：小程序“我的”与“编辑资料”页只在登录后展示服务端 `user.id`，可点按复制；未登录不显示测试占位 ID，也不允许在资料表单中编辑该字段。`miniprogram-auth`、`auth-profile-api` 专项及全量测试结果见同日变更日志；微信开发者工具/真机视觉与复制交互待验收。
### 【已实现】

- 用户微信登录与会话：`apps/api/src/user-auth-store.js`、`server.js` 的 `/api/auth/*`。
- **登录门槛与注册引导（2026-10-03，DEC-109；代码+契约已验证，真机待验收）**：新增引导页 `apps/miniprogram/pages/onboarding/`（底部上滑面板，`app.json` 已注册）——未勾选「我已阅读并同意《用户隐私保护指引》」**不得发起登录**（`wx.openPrivacyContract()` 打开官方文本；同意标记 `shukao_privacy_agreed_v1` 只写本机，不上行）；登录后按服务端回的 `onboardingCompleted` 决定"直接放行"还是"就地必填四项"（性别 / 年龄段 / 目标考试项目 / 报考年份，**缺任一项不发请求**）；考试项目取值来自 `GET /api/catalog` 的 `projects`（DEC-098 登记表，拉不到只提示重试、不编造默认值）；档位唯一维护在 `apps/miniprogram/utils/onboarding-options.js`，与 `user-auth-store` 的 `GENDER_CHOICES`/`AGE_BAND_CHOICES`/`EXAM_YEAR_SPAN` 由契约用例钉住。隐私合规：`app.json` 开 `"__usePrivacyCheck__": true`；`app.js` 增 `setupPrivacyAuthorization()` 接管 `wx.onNeedPrivacyAuthorization`（本机已同意或已登录→放行，否则拒绝并给可见提示），低版本基础库无此接口时静默返回 false。闸门：`App.onShow` 与入口页 `pages/review/review.js` 的 `onShow` **各拦一次**（后者兜住"App.onShow 早于首页创建、`reLaunch` 可能被忽略"这一真机成因）；命中「先随便看看」标记后冷启动不再弹。服务端：`user-auth-store` 增 `gender`/`ageBand`/`examProjectId`/`examYear` 四个字段与校验（固定档位、登记表内的一级项目、"当年 ~ 当年+5"的 4 位年份；空串/0＝未填可清空）+ 派生 `onboardingCompleted`（不落库、不与四字段双写）；登录响应回 `isNewUser`；**未新增 openid 探测接口**（微信登录即注册，客户端用 `isNewUser`/`onboardingCompleted` 分支即可）。**退出登录（DEC-109 ④，2026-10-03 修订为「临时 B、最终混合」）**：`clearAuthSession()` 只清会话与内存里的豆币镜像复位，**不再删除本机学习数据**——卡集与知识卡、题目收藏、学习与复习进度、考试结果与诊断报告、豆币余额镜像都随**账号命名空间工作区**一起切走（数据留本机、界面切走，重登同账号恢复、换账号看不到）；账号之间严格隔离；guest → 账号登录时**学习与复习数据直接由该账号接管**（"登录才能保存进度"），**个人资产与笔记草稿改为登录时一次性确认**（弹「本机有 N 项内容，要归入当前账号吗？」：归入 → 并入并立即上行；留在本机 → 不归入且不再重复问；**取代 DEC-106 的"不自动归属"**，隐私初衷由"不静默上传"承接）；设置页退出后**直接回引导页**（旧文案"退出后本机保留的学习数据不会删除"已改写为与新口径一致的说法）。待同步状态集中在 `apps/miniprogram/utils/sync-status.js`：学习记录 / 个人资产 / 卡集三条链路，失败或未送达即标 pending、只有收到服务端成功响应才清（个人资产的设置页文案已如实；学习与卡集的 pending **尚只在簿记层，界面未露出**，属下一步）。保留期限默认值（30 天 / 7 天 / 3 个账号）与"临时 B → 终局混合"的切换条件登记在 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.26。测试：`tests/onboarding-profile.test.js` 5/5、`onboarding-page.test.js` 10/10、`onboarding-gate.test.js` 8/8、`logout-workspace.test.js` 3/3；渲染验证 `tmp/verify-onboarding-sheet.js` 25/25（真实 wxml+wxss → 无头 Chrome，逐项读计算值）。**未完成/待整改：未登录浏览"不落盘"、写操作统一登录收口**；**上线阻断见 `RELEASE_CHECKLIST.md` B8**（微信后台《用户隐私保护指引》尚未配置）。
- **引导页真机三项修复（2026-10-17；代码+契约已验证，真机待验收）**：产品负责人反馈「头像点不了，年份点不了，昵称不会读取微信昵称」。三处根因与改法：① **年份选中态**——`utils/onboarding-options.js` 的 `examYearOptions()` 给的是字符串 id，`onboarding.js` 的 `selectOption()` 却把 `examYear` 存成 `Number`，而 wxml 比较的是 `examYear === item.id`，`2026 === "2026"` 恒为 false，点年份不高亮；现改为四个档位一律按 `dataset.id` 字符串原样存，转数字只留在提交口 `onboardingPatch()`。② **头像命中区**——`.avatar-button` 原用 `position:absolute; inset:0; opacity:0`，`inset` 简写在部分安卓 X5 / 旧 iOS WebView 不生效、absolute 元素失去 size，空 button 宽度塌成 0 点不到；且点击只覆盖右侧胶囊，左侧头像本体本来没有按钮。现改为显式 `top/left/width/height:100%` + `background:transparent`（同 `profile-edit` 的既有写法），并新增 `.avatar-shot-wrap` / `.avatar-shot-button` 给头像本体再叠一枚 `open-type=chooseAvatar`，做到"命中区 = 视觉区"。③ **昵称**——`inputNickname` 原写法 `String(event.detail.value || "")` 在 blur 不带 value 的基础库上会把已填昵称清空；现只在 `detail.value` 是字符串时更新（拿不到就保留原值），并增加 `bindconfirm`；同时新增 `ensurePrivacyAuthorization()`，在展开「头像与昵称（选填）」时显式调一次 `wx.requirePrivacyAuthorize`（接口缺失/无需授权时静默跳过，失败给可见 hint），因为 `chooseAvatar` 与 `type="nickname"` 是微信隐私接口，微信侧授权没跑完时点头像会静默无反应、昵称也拿不到填充。契约用例：`tests/onboarding-page.test.js` 新增 4 条（年份同类型同值、四档统一字符串、两枚采集按钮 + 禁止 `inset`/`opacity:0`、blur 无值不清空 + 展开请求授权）。**未验证（不冒充已验收）**：真机的选图调起、年份当场高亮、键盘上方"使用微信昵称"提示、`requirePrivacyAuthorize` 弹窗与放行均待产品负责人在微信开发者工具/真机确认；另有运营侧前置条件——mp 后台《用户隐私保护指引》必须声明"微信昵称、头像"用途，未声明时平台会拦掉头像与昵称填充（代码侧管不到）。
- 后台账号、角色、会话与强制改密：`apps/api/src/admin-account-store.js`。
- 统一鉴权闸门与三档权限清单（含默认拒绝未登记路径）：`server.js`（`SUPER_ADMIN_ONLY_ADMIN_PATHS`、`OPERATOR_ADMIN_PATHS`、`adminPermissionForPath`、admin 闸门）。
- 真实操作人操作日志（含稳定账号 ID `actorId`）：`apps/api/src/admin-operation-store.js`。
- 用户侧四类限制：`apps/api/src/user-restriction-store.js` + `server.js` 的能力拦截与治理接口。
- 用户自设头像与昵称（2026-09-22）：服务端唯一写入点 `user-auth-store.updateProfile`（昵称 1–32 字；头像只收 `data:image/(jpeg|png|webp);base64` 且 ≤200KB，空串=清除）+ `POST /api/auth/profile`（需有效会话）；小程序侧采集控件在二级页 `apps/miniprogram/pages/profile-edit/`（`open-type="chooseAvatar"` + `input type="nickname"`），入口在"我的"页——**头像本身就是入口**（`tapAvatar`：已登录 → `openProfileEditor` → `wx.navigateTo` 到该页；未登录 → 直接走微信登录，不再是"请先登录"提示），"我的"页身份区 = 头像 + 昵称（2026-09-22 真机反馈删掉的三行状态文案：已连接提示 / 账号已登录 / 编辑头像与昵称）；**2026-09-22 10:3x 按其新参考图加了两个数据展示位**：头像**2026-09-22 23:4x 按真机反馈改回正圆**（`border-radius: 50%`，122rpx；10:3x 那版"圆角方形色块 `border-radius: 36rpx`"已作废，对图片头像与回落色块同样生效），色块里显示**昵称首字**（参考图给的是"林"= 林知夏的首字；没有昵称才回落「薯」）；昵称下方一行小字「身份标签 · 已加入 N 天」（标签复用**社区身份页同一套** `buildCommunityIdentity` 口径算当前档位，`GET /api/community/assets/mine` 没回来或失败时**不加前缀、不猜档位**）（N 由账号投影 `publicUser.createdAt` 现算，缺 `createdAt` 就不渲染这行）、再下一行**纯文字**显示**个性签名**（2026-09-22 23:2x 真机反馈去掉胶囊外框：白底/描边/内边距全去，签名文字因此与上一行左对齐）（`publicUser.signature` ≤40 字，为空则不渲染——该字段此前**只存不显示**；参考图那个位置原本是"本周专注力 +18%"）；三处显隐一律 `wx:if`；布局＝**横向排布**（2026-09-22 产品负责人二选一后选定：头像在左、昵称/小字/签名成列在右、整列左对齐，见 `docs/OPEN_DECISIONS.md` §1.7 第 5 点），未登录时头像右下角显示绿底白「+」引导角标、下方保留唯一一个「微信快捷登录」按钮；**退出登录的出口**从被删的"账号已登录"按钮移到右上角「设置」（`openSettings`，真正的设置页尚未立项；该入口 2026-09-22 按产品负责人给的图标从文字按钮换成**齿轮图标按钮**——`assets/icons/settings-gear.svg` 依其参考图量测重建为矢量（6 叶圆角齿轮 + 中心环，24 视口 / 线宽 2 / `#555d58`，与 `bell.svg` 同一套规范），圆形 72rpx 与左侧铃铛对称——**并自 2026-09-22 23:2x 真机反馈起去掉灰色圆底**（两颗图标按钮都只留图标本身；72rpx 点击区保留，按下改为变淡；通知小圆点的描边同步改成页面底色 `#f7f7f5`）；`data-name="设置"` + `bindtap="openMenu"` 未变）；没有可用头像时回落成浅绿底 + 青绿「薯」+ 淡绿内描边（绿色点缀，不是纯绿实心），`app.js` 的 `saveProfile` / `avatarDataUrl`（先压到 200KB 内再转 data URL）仍是唯一写通道；保存成功后 `wx.navigateBack` 回"我的"，该页 `onShow` 重读会话投影即显示新值。页面形态（2026-09-22 按产品负责人给的参考图重做 → 同日按其真机截图反馈修正四条 → 再按其**效果图**做细节对齐）：`navigationStyle: "custom"` 自定义导航栏（`arrow-left.svg` 返回 + 居中标题「编辑资料」+ `capsuleSafeRight` 让开微信胶囊；**导航栏右侧不放动作按钮**；`position: fixed` + 等高占位让位——⚠️ **不能改成 `sticky`：sticky 已占文档流，再叠加等高占位会在顶部空出一整条**，这正是真机反馈的第 1 条）→ 居中圆角头像（**只认 data URL 头像；2026-09-22 之前老账号存的微信外链头像已失效、直接渲染是灰色人像占位，一律回落到品牌绿「薯」**，`image` 的 `binderror` 也走同一回落）+ **白底胶囊**的「更换头像」——**视觉归 `view.avatar-change`（宽度只由 padding 决定，`position: relative` + flex 居中），采集入口是覆盖其上的透明 `button.avatar-change-button`**（`open-type="chooseAvatar"`，`position: absolute` 铺满、无内边距无边框、按下给 8% 淡绿底）：直接用 button 做视觉会被它自带内边距撑宽，真机上胶囊会变成屏宽的 44%（2026-09-22 真机反馈"太长了"）；品牌青绿相机图标 `camera-brand.svg`（26rpx）+ **青绿细字**（24rpx + `font-weight: 400`）→ 「基础资料」白卡（昵称/个人签名是**无底色的右对齐值 + 浅灰箭头**，与几个选择行同一套观感）→ 「学习偏好」白卡 → **表单后的整宽「保存修改」主按钮**（`view` + `role="button"`，**不用小程序 `button` 标签**——button 自带内边距/居中样式会让整宽宽度不受控，仓库既有写法见 `note-meta` 的「保存笔记」；保存中显示「保存中…」；**不固定屏幕底部**，真机反馈"太靠下不好操作"）。**「移除当前头像」行不做**（产品负责人判定没必要；服务端"空串=清除头像"的语义仍保留）；**「你的资料由你掌控」说明卡按效果图红框删除**（连同 `.privacy-*` 样式）。**头像展示的唯一判断口是 `apps/miniprogram/utils/avatar.js` 的 `usableAvatarUrl()`（只认 `data:image/…;base64,`）**：`profile`（我的）、`profile-edit`（编辑资料）、`community-identity`（社区身份）三处都走它，老账号里失效的微信外链头像一律回落到品牌绿「薯」，不允许各页各写一套。

参考图六行（2026-09-22 二次落地，产品负责人原话「你直接按照参考图做」）：**基础资料 = 昵称 / 个人签名 / 所在地区**，**学习偏好 = 学习方向 / 每日目标 / 公开学习数据开关**。六个字段全部经同一处 `app.saveProfile` → `POST /api/auth/profile` **真持久化**（不是界面壳），服务端复核：个人签名 ≤40 字、所在地区 ≤60 字（页面用微信原生 `picker mode="region"` 三级选择器，只存拼好的名字、**不存行政区划代码**）、学习方向只能取正式目录 `packages/domain/catalog` 里的科目名（不在目录里一律拒）、每日目标只收 `DAILY_GOAL_CHOICES = [10,15,20,30,45,60]` 六档（默认 20 分钟）、公开学习数据只收布尔值；文本字段空串=清空。⚠️ **「公开学习数据」默认关闭**（参考图展示的是打开态，Agent 按隐私保守取值），且**公开主页尚未上线**——该开关当前只保存偏好、不产生对外可见效果。以上三条口径待产品负责人确认，见 `docs/OPEN_DECISIONS.md` C13。
- **"我的"页资产入口（2026-09-22 真机反馈，本模块唯一记录"我的"页结构的正文）**：原「我的资产」标题 + 「管理」文字链 + 四宫格（全部资产/题目/题包/笔记）整块换成**参考图那张卡片**——白底圆角（`border-radius: 18rpx` + 极轻阴影）、三列（`grid-template-columns: repeat(3,1fr)`）、列间 1rpx 分隔线、数字（34rpx / 900 / `#252925`）+ 小灰标签（18rpx / `#8a918c`），位置紧跟身份区（个性签名正下方：**2026-09-22 23:5x 按其真机反馈"绿框的卡片可以整体下移一点，大概是学习天数那张卡片一半的高度"把上间距 8→`margin-top: 60rpx`**，≈ 半张卡片高；内边距 `20rpx 8rpx`）——**2026-09-22 23:4x 产品负责人反馈"这张卡片太大了"，整卡约 149rpx → 107rpx**（内边距 32→20、数字 44→34、标签 20→18、圆角 22→18）；**整张卡片就是入口**（`data-name="我的资产"` + `bindtap="openMenu"` + `role="button"` + `aria-label="我的资产"`，`:active` 给淡绿反馈；`openMenu` 里 `name === "我的资产"` → `/pages/assets/assets` 未变）；三列口径**已按产品负责人 2026-09-22 23:4x 的定法**（他给的理由："笔记下属于卡集"）＝**学习天数 / 卡集 / 题包**：**学习天数** = `shukao_review_history` 里 `dateKey` **去重后的天数**（记录由刷题页写入，`profile.js` 的 `studyDayCount()` 只做去重、不另造日期键，空记录为 0）；**卡集** = 知识库本地库 `loadCardSets().length`（`apps/miniprogram/utils/card-box-store.js`，**含产品自带的 4 个种子卡集**，与「知识库」页同一份数据）；**题包** = `assetStats(loadManagedAssets()).packs`。**注意这三列跨两个数据源**（本地复习记录 + 本地知识库 / 资产库），而卡片点进去是「我的资产」页——那一页没有"学习天数 / 卡集"两格，这是产品负责人明确选定并拍板的口径（参考图另给过「知识卡」一列，本轮未采用；若以后要加，知识卡数 = 各卡集 `cards` 之和）。旧的 `.asset-summary` / `.asset-heading` / `.section-more` 规则已随四宫格与「管理」文字链一起删除（`.section-title` 仍被「账户与服务」使用）。（该「待拍板」已于 2026-09-22 23:4x 拍板：见上一段的三列口径，登记在 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.7 第 6 点。）
- **顶栏与未登录入口（2026-09-22 23:42 真机反馈，两处）**：① **消息通知从句首挪到右边「设置」旁边**——`.profile-topbar` 由 `justify-content: space-between` 改为 `flex-end` + `gap: 4rpx`，两颗 72rpx 图标按钮并排靠右（DOM 顺序仍是铃铛在前、设置在后，`tests/help-feedback-page.test.js` 的顶栏顺序断言不变），铃铛上的未读红点与齿轮上的退出登录出口均未变；② **未登录态去掉占位昵称与绿色胶囊按钮，只留一条轻盈文字「点击登录」**——`<view class="login-text" bindtap="login" role="button" aria-label="点击登录">点击登录</view>`，文案按产品负责人原话（旧文案「微信快捷登录」作废），`.nickname` 改为 `wx:if="{{loggedIn}}"`（未登录时头像里仍显示回落首字「薯」，右下角绿底白「+」引导角标保留），`.login-text` 本身无底色/无边框，但 `min-height: 72rpx` 保证点击区不被"看起来只是文字"骗掉。
- **"我的"页三处字重（2026-09-22 23:5x 真机反馈「这些文字太粗了」）**：绿框点到的三处——昵称（38rpx）、资产卡片三个数字（34rpx）、「账户与服务」标题（34rpx）——由 `font-weight: 900` 统一改为 **500（Medium）**；**头像圈里的首字仍是 900**（它没被点：单字在圆里粗一点才立得住）。**为什么不是 600**：PingFang SC 一类中文字体只有 Medium(500) 与 Semibold(600+)，`600/700/900` 会落到同一字面，取 600 等于没改——本机渲染实测（`tmp/weight-probe.js`：同一段中文，400/500 一档、600/700/900 另一档）为证。三处字重由 `tests/miniprogram-auth.test.js` 钉住。
- **头像 / 昵称 / 签名三个入口都进「编辑资料」（2026-09-22 23:5x 真机反馈）**：`profile.wxml` 里三处都挂**同一个** `bindtap="tapAvatar"`（`avatar-wrap`〔原有〕、`nickname`、`identity-signature`），共 3 处、不各写一套；`tapAvatar` 的语义不变——已登录 → 二级页「编辑资料」，未登录 → 微信登录（未登录时昵称与签名整行不渲染，`wx:if="{{loggedIn}}"`）。「已加入 N 天」那行小字**不是**入口（反馈里只点了三处）。昵称与签名原本只有一行字高（约 46 / 31rpx），`profile.wxss` 给它们补了**纵向**内边距（昵称 `padding: 14rpx 0`、签名 `padding: 22rpx 0`）并用**等量负外边距**（`margin: -14rpx 0` / `margin: -12rpx 0 -22rpx`）把文字位置与行距原样抵消——横向内边距保持 0，否则文字会被推离左对齐（这是早前那轮"对齐"反馈的底线）。**几何已实测**：`tmp/verify-profile-tap-targets.js`（无头 Chrome + CDP，抽出本文件真实规则渲染后读计算值）——点击区 头像 61px = 122rpx、昵称 39px = 78rpx（改前 25px）、签名 37.39px = 74.8rpx（改前 15.39px）；补内边距前后三行文字带 top/bottom 差值 **0.00px**；三行左边缘同一 x（横向内边距 0/0/0）。
- **身份区加淡渐变背景（2026-09-23 00:12 真机反馈「绿框这块能不能给个渐变的背景色，我看看效果，要淡的」）**：绿框＝顶栏（铃铛+齿轮）＋身份区（头像/昵称/小字/签名）这一整片。做法：`profile.wxml` 把 `.profile-topbar` 与 `.identity-block` **包进一层新的 `<view class="profile-hero">`**（两个子节点的结构、事件、`wx:if` 一字未动；包一层的理由是它们是兄弟节点，各自画渐变会在接缝处断一道），渐变画在 `.profile-hero` 上：`linear-gradient(180deg, #f1fbf8 0%, #e7f6f1 46%, #f7f7f5 100%)`——**品牌青绿的极淡档**（与头像回落的 `#f4fcf9→#e3f6f1` 同色系），底部**渐回页面底色 `#f7f7f5`**，这样与下面的白色资产卡片之间不会出现硬边；左右 `margin: 0 -28rpx` 把色块通铺到屏幕两边（他圈的范围是通栏），横向 `padding` 与 `.page-shell` 的 28rpx 抵消，**文字位置与改前逐像素一致**。**同时给了另外三个候选让他挑**（`tmp/profile-hero-gradient-mock.html` + `tmp/verify-out/profile-hero-gradient-all.png`，四联预览：现状 / ②薄荷〔00:12 版采用；此后 00:2x「拉满」与 00:3x「150deg 撞色」两轮又改过，见下面两条〕/ ③雾蓝 `#f2fbfb→#e6f2f6` / ④暖米白 `#fdfcf7→#f5f1e8`）；他若挑别的，只改这一行 `background` 即可。**状态：待真机验收**（小程序真机可见性只能由产品负责人确认，见 AGENTS §6；本机只做到"预览稿渲染 + 代码/契约"层）。
- **底色「拉满」整块区域（2026-09-23 00:2x 真机反馈「要拉满这个区域」＋追问后明确「我指背景色」）**：他圈的范围＝屏幕**最上沿**（状态栏／胶囊那一条）一路到**资产卡片下沿**这一整块，指的是**背景色没铺满这块区域**——上一版只铺到身份区就淡没了，顶栏那一条还是白的（`#fbfbfa` + 1rpx 分隔线），顶栏与色块之间还露出过 `.page-shell` 的 28rpx 页面底色。这版三处一起改：① `profile.wxml` 把**资产卡片也挪进 `<view class="profile-hero">`**（卡片结构、`data-name`/`bindtap="openMenu"`/`aria-label`、三列口径一字未动，仍是整卡可点进「我的资产」）；② `.profile-hero` 的 `margin/padding` 由 `0 -28rpx` / `0 28rpx` 改成 **`-28rpx -28rpx 0` / `28rpx 28rpx 0`**（负的顶部外边距把这一层顶到顶栏下沿；同时用 28rpx 的 `padding-top` 接住原来由 `.profile-topbar` 的 `margin-top: 14rpx` 撑出来的间距——负外边距会与首个子元素的外边距合并，不接这一手内容会整体上移 14rpx）；③ `.profile-nav` 由 `#fbfbfa` + `border-bottom: 1rpx solid #e8eae7` 改为**渐变的起点色 `#f1fbf8` 且去掉分隔线**（那条线会把这块区域从中间切一道；两处色值必须同改）。渐变改为 `linear-gradient(180deg, #f1fbf8 0%, #e7f6f1 58%, #e7f6f1 88%, #f7f7f5 100%)`：100% 仍落在页面底色 `#f7f7f5`，而这一层的下沿正好是卡片下沿 → 卡片以下不会出现硬边。**布局零位移**：上一版挂在 `.profile-hero` 上的 `padding-bottom: 10rpx` 挪进了 `.identity-block`（`padding: 20rpx 0 24rpx` → `20rpx 0 34rpx`），卡片与下面所有内容（含「账户与服务」标题）的绝对位置与改前逐像素一致。**已实测**（`tmp/verify-profile-hero-bg.js`，无头 Chrome + CDP 抽本文件真实规则渲染后读计算值，17 项全 PASS）：底色层 left 0 → right 375（视口 375＝通铺到屏幕两边）；top 88 = 顶栏下沿、bottom 323.39 = 卡片下沿（盖满）；顶栏底色 `rgb(241,251,248)` == 渐变 0% 色值、`border-bottom-width: 0px`；渐变终点 == 页面底色 `rgb(247,247,245)`；上一版↔这一版 卡片／「账户与服务」标题／昵称／小字／签名／头像／右侧整列 的 top、bottom 差值全为 **0.00px**。并排截图：`tmp/verify-out/profile-hero-bg-before.png`（改前：顶栏白条 + 分隔线 + 色块在卡片前就淡没）／`profile-hero-bg.png`（改后：从最上沿连续铺到卡片下沿）。**状态：待真机验收**。
- **那块底色从「涂成一片」改成 150deg 对角撞色（2026-09-23 00:3x 真机反馈「可能的换种渐变方式，或者浅一点的颜色，或者别的颜色或撞色，否则这里就涂成一片了」）**：**根因**是上一版 180deg 竖渐变把 `#e7f6f1` 在 58% 与 88% 各写了一次 → 中间那 30% 是**没有变化的平台**，整块看上去就是一片平色。先按他给的三个方向出了**六个候选**让他挑（`tmp/render-hero-gradient-options.js` → `tmp/profile-hero-gradient-options.html` + `tmp/verify-out/profile-hero-gradient-options.png`，同时推到活体画布 `canvas-02b1e91ae869`；六稿：①现状 ②更浅·一路缓降〔去平台〕③右上角光晕〔径向〕④别的颜色·雾蓝 ⑤撞色·薄荷↔暖杏 ⑥弧形收口〔给颜色一个形状〕），他选定 **⑤**。落地：`.profile-hero` 的 `background` ＝ `linear-gradient(150deg, #e6f7f1 0%, #f4f6f2 42%, #fbeedd 72%, #f7f7f5 100%)`——冷绿在左上、暖米杏在右下、中间走中性灰白（同一块里两处色相，不再是平色），100% 仍是页面底色且这一层下沿＝卡片下沿 → 卡片以下仍无硬边；间距那三手（`margin: -28rpx -28rpx 0`、`padding: 28rpx 28rpx 0`、`.identity-block` 的 34rpx）**一字未动**，所以"布局零位移"这条继续成立。**顶栏必须跟着顶边走**：150deg 之后顶边的颜色变成**横向变化**（左端冷绿 → 右端中性灰），顶栏再刷一个平色就会在接缝处露出色差，因此 `.profile-nav` 同步换成同走向的 `linear-gradient(90deg, #e6f7f1 0%, #f4f6f2 87.6%, #f5f4ee 100%)`（百分比按 150deg 的投影算：渐变线长 L=|W·sin150°|+|H·cos150°|≈391，顶边右端 t=375×0.5/391≈0.479，即第二档落在顶边 87.6% 处）。**验证方式升级为逐像素**：`tmp/verify-profile-hero-bg.js` 把"顶栏最下一行"与"底色层最上一行"在同一 x 上的像素真采出来比（截 1×1 的 PNG 自己解出来，不是比 CSS 字符串），5 个页面内采样点（x=2/90/180/270/345）最大色差 **1/255**（左端两点为 0）；并加了一条反证断言"采到的必须明显不是页面底色"，挡掉假通过（首版就踩过：x=373 落在滚动条上，两个读数一起变成 `252,252,252`）。契约由 `tests/miniprogram-auth.test.js` 钉住：hero 必须是 `linear-gradient(150deg, #e6f7f1…)` 且必须含暖色档 `#fbeedd`（防退回一片同色）；顶栏必须是 `linear-gradient(90deg…)` 且**两侧起点色逐字符相同**（只改一处就会接缝色差）；顶栏不得有 `border-bottom`。截图 `tmp/verify-out/profile-hero-bg.png` 已目视复核：左上冷绿、右下暖米杏，卡片整张坐在色块里、与顶栏无色差接缝。**状态：待真机验收**（真机上这版撞色是否偏黄/偏重、接缝是否看得出来，只能由产品负责人确认；若嫌暖色重，把 `#fbeedd` 调浅即可，顶栏那三档要同步）。
- **未登录的「+」挪到头像正中间、头像里不再有「林」（2026-09-23 00:4x 真机反馈「➕号移动到头像中间，去掉林」，截图绿框圈的就是原来那颗贴右下角的「+」）**：改前是「右下角 44rpx 绿底白「+」角标 + 用 4rpx 页面底色描边把它从头像边缘抬起来」，而头像回落圆里同时显示昵称首字（真机截图里是「林」）——两者在右下角叠在一起，既挤又像"半张头像"。落地三处：① `profile.wxml` 把首字包进 `<text wx:if="{{loggedIn}}">`——**未登录时不渲染首字**，已登录且没有可用头像时仍然显示（否则圆里会空着）；② `.avatar-badge` 由 `right/bottom: -2rpx` 的角标定位改为 **`left: 50%; top: 50%; transform: translate(-50%, -50%)`** 的正中定位（同时删掉那圈 `border` 描边——居中的圆再套白环会变成一圈白边）；③ 尺寸 44rpx→**56rpx**、字号 30rpx→**36rpx**（居中的圆如果还维持 44rpx，在 122rpx 的头像圈里压不住）。**已实测**（本轮新增 `tmp/verify-avatar-plus-centered.js`，无头 Chrome + CDP 抽真实规则渲染两态、读真实计算值，8 项全 PASS）：态 A（未登录）「+」圆心与头像圆心 **完全重合**（66.5,151.5 对 66.5,151.5）、四周留白都是 **16.5px**、徽标 28px＝56rpx、字号 18px＝36rpx、底色 `rgb(11,149,136)`、`border-width: 0px`、DOM 里**根本没有首字节点**；态 B（已登录无头像）首字「林」仍在圆里**居中**、绿「+」整颗不存在；点击区仍是整颗头像 61px（≥72rpx 下限）。按 AGENTS §6 逐项核了可见性（`display` / `offsetParent` / 真实尺寸 / 存在性），不是只看截图。
  **同一元素的下一条反馈（2026-09-23 00:5x）：「去掉这层深色的绿」**（绿框点的是头像正中那颗 28px 深绿实心圆 `#0b9588`）：引导标志不再是一颗深绿底圆，而是**直接印在浅绿头像上的青绿「+」**——`.avatar-badge` 去掉 `background` / `border-radius` / 宽高（只留定位壳），`.avatar-badge-plus` 由白字改为 **`#0b9588`**（与回落头像的首字同色）、字号 36rpx→**56rpx**（没有底圆撑着了，字号得自己扛住 122rpx 的头像圈）。这条与 `.avatar-fallback` 那行既有注释「要的是绿色点缀，不是换成纯绿实心」是同一条口径（也曾因此驳回"纯绿实心头像"）。实测（同一脚本扩到 **9 项全 PASS**）：「+」圆心与头像圆心仍**完全重合**、左右留白 19.84px / 上下 16.5px（各自相等）、`background-color: rgba(0,0,0,0)`、`border-width: 0px`、字号 28px＝56rpx、颜色 `rgb(11,149,136)`；**像素反证**——在原深绿底圆会盖住的位置采三点的像素是 `237,249,246 / 233,248,243 / 234,248,244`（浅绿回落底色），不是深绿。**状态：待真机验收**。
  **再下一条（2026-09-23 00:58）：「这个加号感觉没居中，而且可以换成白色」**——先说"没居中"是不是真的：新增 `tmp/measure-plus-ink-center.js`（截头像区域、自己 inflate PNG、找"与底色差异大的像素"的包围盒），实测**盒子中心偏移 0.00px、但墨水中心垂直偏了 +2.63px**——字形「+」在它的行盒里本来就不居中（字体给 descender 留了空），他看到的偏下是**真的**。于是两件事一起改：① **不再用字形**，`.avatar-badge-plus` 删掉，改成两根绝对定位的小条 `.avatar-plus-h`/`.avatar-plus-v`（横条 100% 宽 6rpx 高 + `top: 50%` + `margin-top: -3rpx`；竖条 100% 高 6rpx 宽 + `left: 50%` + `margin-left: -3rpx`），交叉点由数值保证落在正中；② **「+」改白色**——白字必须落在深底上才看得见，所以绿色挪到**整颗头像**（`.avatar-badge` 改成 `top/right/bottom/left: 0` 铺满 122rpx 的绿圆 `#0b9588` + `border-radius: 50%`）。**注：这一条改写了上一条的结论**——"深绿"回来了，但不再嵌套（改前是浅绿圆里再嵌一颗 28px 小圆，两层同心圆才是别扭的原因）。实测（同一脚本扩到 **12 项全 PASS**）：绿圆与头像完全重合（61×61、四边 0 偏差）、`rgb(11,149,136)` + 正圆 + 无描边、白十字两根条的**中心线都正好过头像中心**（0.00px）、两条各 3px 粗且 `rgb(255,255,255)`、点击区仍 61px、未登录无首字、已登录首字居中；**像素反证**——横臂/纵臂采到 `255,255,255`、绿圆其他位置采到 `11,149,136`；**墨水中心**偏差 `[0.38, 0.38]px`、墨水包围盒 26×26px、墨水均色 `253,254,254`（改前那个字形是 2.63px）。**状态：待真机验收**。
  **最终定版（2026-09-23 01:05）：产品负责人指着我"整颗绿圆"那版的裁剪图说「你改错了，要原来这种颜色，中间+号改白色就行」**——即**圆底色保持浅绿回落底不动**（`linear-gradient(160deg,#f4fcf9,#e3f6f1)` + 那圈 `rgba(11,149,136,.16)` 内描边），只把「+」改成白色。于是 `.avatar-badge` 退回**透明壳**（`top/right/bottom/left: 0` + flex 居中，**不许有 `background` / `border-radius`** —— 一上色就会盖掉浅绿底、又变成整颗绿圆），十字仍是两根白色小条（26px 臂长、3px 粗、几何画法居中）。**注：这条把上一条"整颗绿圆"的结论改回去了**——三条反馈叠加后的最终形态是「浅绿圆 + 白色「+」」。实测（同一脚本 12 项全 PASS）：壳 `background-color: rgba(0,0,0,0)`、`border-width: 0px`；圆底色渐变两端的计算值正是 `rgb(244,252,249) → rgb(227,246,241)`；白十字两根条中心线各轴 0.00px 过头像中心、`rgb(255,255,255)`、26×26px；墨水中心偏差 `[0.38, 0.38]px`、墨水均色 `255,255,255`；像素反证：两臂 `255,255,255` vs 圆底色 `240,251,247`。**⚠️ 已知观感风险（已如实量过）**：白叠浅绿对比极弱——白 vs 圆底色的对比度只有 **1.058:1**（圆底色亮度 245.7/255），真机上大概率只是"隐约能看见的白色十字"。这是产品负责人明确要的形态，先按他说的做；**若真机觉得看不清，唯一旋钮是 `.avatar-plus-h/.avatar-plus-v` 的 `background`（换回青色/加深）或 `.avatar-plus` 的尺寸**。**状态：待真机验收**。
- **参考图定案（2026-09-23 01:1x）：未登录头像里改成「青绿人形轮廓图标」，右边文案由一行变两行**——产品负责人发来一张裁剪图（840×310：浅绿圆 + 青绿人形 + 两行文案）并说「把头像和点击登录的文字改成这样」。**这条把 01:05 的「白色「+」」整个作废**（「+」的设计到此为止，圆底色仍是浅绿回落底不变）。
  - **量的方法**：新增 `tmp/measure-ref-crop-login.js`——解他自己的裁剪图，用**圆直径当标尺**（圆在真机上是 122rpx，图里量到 220.5px）把像素换算成 rpx，免得靠眼睛估。量到：圆里图标墨水 **36.5×39.8rpx**、墨水中心与圆心偏差 **(0.5, 0)px**（他给的参考图里也是正中的）、线色 **(10,143,131)**（＝品牌青绿 `#0b9588` 系）；主行「点击登录」**28.2rpx**、同色；副行「登录后同步学习记录与进度」**18.3rpx**、灰 **(113,120,115) = `#717873`**；两行墨迹间距 **22.1rpx**；头像圆右缘到文字左缘 **25.5rpx**（与现有 `.identity-main` 的 `margin-left: 24rpx` 基本一致，未动）。
  - **实现**：新增图标资源 `apps/miniprogram/assets/icons/user-outline.svg`（lucide `user` 几何：头部圆 + 头肩开环；与顶栏铃铛/齿轮同一种本地 svg 引用方式）。`stroke-width` 用 **1.5**（不是其它图标的 2）——该图标只以 48rpx（24px）渲染，1.5 × 24/24 = 1.5px 实际线宽，与参考图量到的细线一致；`.avatar-user { width:48rpx; height:48rpx }`（24/24 视口里墨水占 14×18 → 渲染后 ≈14×18px＝28×36rpx）。`.avatar-badge` 仍是**透明壳**（不许上色，浅绿底由 `.avatar-fallback` 透出）。登录文案改成 `.login-entry`（`flex-direction: column` + `justify-content: center`，**点击区仍 ≥72rpx**）包 `.login-text`（28rpx / `#0b9588` / `font-weight: 700`）+ `.login-sub`（18rpx / `#717873` / `margin-top: 16rpx`）。`.avatar-plus` / `.avatar-plus-h` / `.avatar-plus-v` 三条规则与两根小条节点一并删除（全仓库已无残留）。
  - **验证（2026-09-23，`tmp/verify-avatar-plus-centered.js` 14 项全 PASS，`problems=0`）**：图标资源真的能渲染（`naturalWidth=24`）；图标方框 24px＝48rpx 且盒子中心＝头像圆心；**墨水**包围盒 **15.5×19.5px**、中心偏差 **(0.38, 0.38)px**、墨水均色 `23,154,142`；像素反证：笔画处正是 `11,149,136`、圆内非笔画处 `240,251,247`；逐项可见性（未登录：浅绿圆/图标/两行文案都存在且 `offsetParent` 非空、尺寸 >0，昵称首字不存在；已登录无头像：首字「林」居中，图标与登录文案都不存在）；两行文案的字号/颜色/行距/点击区全部核对通过；`tests/miniprogram-auth.test.js` 4/4；全量 **131 文件 / 1249 pass / 0 fail**；`tmp/render-mock-shots.js` 重新出图（未登录态与他给的参考图同形）。
  - **对比度（这轮最该记住的数）**：青绿图标 vs 浅绿圆底 **3.50:1**（对渐变最暗端 `#e3f6f1` 是 **3.30:1**）——上一版白「+」只有 **1.058:1**，所以"看不清"的风险随这次改版消失。**状态：待真机验收**（图标是否够清晰、两行字号/换行是否如他所愿）。
- 社区收藏/复制关系（按人去重，供计数与"我的收藏"）：`apps/api/src/community-interaction-store.js`。
- 社区身份**六级土豆称号 + 经验值定档**（2026-10-02）：`apps/miniprogram/utils/community-profile.js` 的 `identityLevels` 由四档扩为六档——**薯薯我呀 / 薯露头角 / 薯能生巧 / 薯一薯二 / 薯通广大 / 薯界泰斗**（称号、顺序、口径由产品负责人 2026-10-02 逐轮确认，登记见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.24）。定档改为单一**经验值**：内容分按已公开内容逐篇递减（前 10 篇 ×3、11–30 篇 ×1、31 篇以上 ×0.1）＋认可分（**按单篇**算：收藏第 1–10 次 ×8、第 11–50 次 ×4、第 51 次以上 ×1；点赞 ×1 尚无数据源恒为 0；**单篇认可分封顶 500 分**，所以 1 篇 500 次收藏的爆款只有 503 分＝第 3 档，不能"一篇封神"），门槛 **0 / 10 / 100 / 800 / 3000 / 10000 分**；全部分段与权重集中在 `experienceRules` 一处，调权重不改页面。只增不减改由**服务端**承担（2026-10-02 产品负责人定："峰值放服务端"）：`apps/api/src/community-asset-store.js` 在 asset 上维护**只增不减**的 `peakFavoriteCount` / `peakLikeCount`（`adjustFavoriteCount` 只抬高、不回落），客户端 `effectiveReactionCounts` 取 `max(当前计数, 峰值)` —— 取消收藏 / 点赞**分不回退**，同一人对同一篇**只计一次**（由既有的"用户 × 内容"关系记录保证）。⚠️ 旧数据峰值缺省 0、无法补算；**服务端改动必须重启 3212 后台进程才生效**（`apps/api/src/**` 只在启动时加载，见 AGENTS §8）。次轮已退役"峰值存本机"的 `utils/community-reaction-peak.js`（不再被任何代码引用；文件按"不得删除仓库内原文件"保留，删除待许可）。顺带补齐一个漏子：**收藏计数此前没被落盘**（`adjustFavoriteCount` 没进文件持久化包装层），重启后收藏数会回到上次 submit 的值——已修。同时把进度从 `levelIndex` 硬编码 if 链改为按分值循环：**旧写法在 `levelIndex >= 3` 时直接写死 100% 并显示"已达到当前最高身份"，档位加到六档就会对第 4、5 档的人谎报满档**。展示面复用同一算法（"我的"页身份前缀、本页、旧 community-identity 页）。
- **「社区与贡献」页（2026-10-02，原「我的贡献」）**：`apps/miniprogram/pages/contributions/` 改版——导航栏标题与页名都改「社区与贡献」（「我的」页那一行菜单也从「我的贡献」改名为「社区与贡献」），视觉按产品负责人 2026-10-02 的参考图重做（白卡圆角 + 品牌青绿 `#0b9588`）：卡片 1 = 左「当前头衔」右「下一等级 · 薯露头角」+ 大字号头衔名 + 「还需 N 分 / 经验值 N」+ 青绿进度条，整块可点开底部弹层看六档门槛；卡片 2 = 「公开 / 帖子」两类切换 + 内容卡片列表（标题 + 右侧「科目 · 类型」+ 概述 + 状态与收藏/导入数）。**点赞与评论没有数据源，一律不渲染**；**「帖子」类型尚未上线，走空态**。页首四项统计条与身份条（头像/昵称/三项数据）已删除。**待真机验收**（本机无微信运行环境）。
- **未确认、不要当规则用的部分**：旧数据的历史峰值无法补算（缺省 0，只能从第一次互动起记）；是否要年度复核（也就是掉级）；门槛分值需按真实数据校准；点赞的数据层尚未做；四处递减分段与单篇封顶值是 Agent 提议、产品负责人未逐项核数。见 §1.24。


### 【已验证（2026-09-21 00:34 本机实跑）】

- `tests/admin-auth.test.js` → **21/21**：全 `/api/admin/*` 路由匿名 401 与伪造 token、鉴权闸门必须排在所有后台路由之前（含正则写法路由）、每条后台路由必须被显式分类（未登记 → 运营 403、超管 404）、权限三档与超管专属前缀、内部导入独立授权三条件（凭证/本机来源/路径）、登录/登出/真实操作人（actorId）、运营 403、停用即撤销会话、重置/本人改密、环境变量不能当后门、初始化凭据不合法时保持锁定、账号校验规则、强制改密。
- `tests/user-restrictions.test.js` → **9/9**：期限必填/超限/过期/缺理由全部拒绝、四类档位拦截范围、到期自动失效、仅超管可解除、举报四类动作落限制、同类型重复下发为延长。
- `tests/community-interactions.test.js` → **5/5**：收藏与复制都要登录、重复收藏/复制不刷数、跨人去重、我的收藏按人隔离与回显、注销清理关系记录。
- 全量 `node --test tests/*.test.js` → **1171 / 1171 通过**（`NODE_ENV` 未设为 production；设为 production 时另有 3 个既有微信登录用例因缺密钥 503，与本模块无关）。
- 实机证据：隔离内存实例 23 项越权复现全部 PASS；标准端口 3212 重启后匿名治理接口全部 401、原「未登录可执行社区审核」已复现为 401；无头 Chrome 跑通登录/建号/停用/强制改密/限制下发（含举报单下发）/退出，`console_errors=0`（截图见 `tmp/admin-ui-shots/`）。

### 【已验证（2026-09-22 07:22 本机实跑）】

- `tests/miniprogram-auth.test.js` → **4/4**：登录只发 `code + deviceId`（**请求体里没有 `profile`**）、会话与 `globalData` 落盘、`saveProfile` 只走 `/api/auth/profile` 且带 Bearer、未登录不发请求、头像超限先压缩再由 `avatarDataUrl` 编码、**全仓 `wx.getUserProfile(` 调用为 0**、**采集控件只允许出现在二级页**（`profile-edit.wxml` 必须有 `open-type="chooseAvatar"` + `type="nickname"`，"我的"页 `profile.wxml` 反而**不得**再有这两者，且 `pages/profile-edit/profile-edit` 必须在 `app.json` 注册）、两页 wxml 里绑定的每个处理函数都必须在各自 js 中存在（"我的"页保留 `openProfileEditor` 并跳到 `/pages/profile-edit/profile-edit`）；**新增六行字段的静态契约**：「个人签名 / 所在地区 / 学习方向 / 每日目标 / 公开学习数据」五行标题必须在 wxml 里出现、`picker mode="region"` 与 `switch checked="{{draftPublicLearningStats}}"` 必须在、五个字段必须都进 `patch.*`（防止"只改界面不入库"）、学习方向必须来自 `data/catalog`（不许在页面里另造私有科目清单）、且页面的 `DAILY_GOAL_CHOICES` 必须与服务端逐字一致（跨端档位一致性）。
- `tests/auth-profile-api.test.js` → **4/4**：匿名/伪造 token 一律 401；空 patch 400 `profile_patch_required`；登录夹带的 `profile`（含外链头像）不入库；昵称非法（空/空白/控制字符/33 字）400 `nickname_invalid`、头像非 data URL 或 data URL 超 200KB 分别 400 `avatar_invalid_format` / `avatar_too_large`，被拒后原资料不动；空串 `avatarUrl` = 清除头像；再次登录**不覆盖**用户自设的昵称与头像；`communityNickname` 随昵称同步。**第 4 条用例（2026-09-22 新增，锁参考图六行字段）**：新账号默认值（三个文本字段空、`dailyGoalMinutes` 20、`publicLearningStats` false）；签名去首尾空白后真落库、`me` 回读一致；请求里没带的字段保持原值（只改签名不动昵称/头像）；非法值一律 400 且不留半截状态——签名 41 字 `signature_invalid`、地区 61 字 `region_invalid`、不在正式目录里的科目 `study_field_invalid`、目标 7 分钟 `daily_goal_invalid`、非布尔 `"true"` `public_learning_stats_invalid`、对象型签名（`String()` 会洗成 `[object Object]`）也 `signature_invalid`；空串 = 清空的显式语义。
- `tests/auth-learning-api.test.js` → **2/2**：既有登录→会话→学习状态同步链路未被签名变更破坏（登录默认昵称 `薯考同学`，改资料后回读一致）。
- 全量（逐文件独立进程）→ **131 个测试文件 / 1236 通过 / 3 失败**；3 个失败全部在考试 PDF 导出链路（`exam-export.test.js` 2 项、`object-storage.test.js` 1 项），根因是本机 Python 渲染器不可用（`python --version` 返回 9009，`apps/api/src/exam-export.js:363` 逐个候选均失败后抛 `exam_export_renderer_unavailable`），**与本次改动无关**（本次只动 `/api/auth/*` 与小程序登录页）。
- 说明：本机 `node --test tests/*.test.js` 的多进程模式在沙箱里被 `spawn EPERM` 挡住（Node 子进程管道被禁），故按"每个测试文件一个独立进程"跑，隔离级别与 runner 的单文件隔离一致。
- **2026-09-22 09:34 复跑（参考图六行字段全部落地之后）**：`tests/miniprogram-auth.test.js` **4/4**、`tests/auth-profile-api.test.js` **4/4（新增第 4 条用例）**，其余 9 个相关文件全绿（合计 11 文件 **40/40**）；全量（逐文件独立进程）→ **131 个测试文件 / 1245 通过 / 3 失败**，失败的仍是 `exam-export.test.js`(2) 与 `object-storage.test.js`(1) 这两个既有问题（本机无 Python 渲染器），**与本次改动无关**。

### 【待验收】

- **小程序头像/昵称的真机验收**（本机无微信运行环境）：从"我的"页**点头像 / 点昵称 / 点签名都应进入二级页「编辑资料」**（三处是同一个 `tapAvatar`；**已登录**才进页；**未登录**时昵称与签名整行不渲染，点头像直接走微信登录、不再弹"请先登录"；三处都应当好点——点击区已补到 ≥72rpx，实测值见上文；「已加入 N 天」那行小字**不是**入口，点它应当没反应）；"我的"页身份区应只剩头像 + 昵称 + 两个数据展示位（三行状态文案已按真机反馈删除）——**排列应是横向的**（头像在左、昵称/小字/签名在右）、**头像应是正圆**、已登录且没有可用头像时色块里是**昵称首字**（未登录时**不显示首字**，只有正中间的**白色「+」**）、昵称下面应是「身份标签 · 已加入 N 天」（形如「社区成员 · 已加入 4 天」）、再下面一行**纯文字**是**个性签名**（**不要外框**、与上一行左对齐）（没填签名时整条胶囊不出现，不是空胶囊）、未登录时头像**正中间**应当是**青绿人形轮廓图标**（2026-09-23 00:4x 反馈「➕号移动到头像中间，去掉林」；00:5x「去掉这层深色的绿」；00:58「这个加号感觉没居中，而且可以换成白色」；01:05「要原来这种颜色，中间+号改白色就行」；**01:1x 参考图定案「把头像和点击登录的文字改成这样」——最终形态：圆底色＝原来的浅绿回落底、圆里是正中的青绿人形轮廓图标 + 右边两行文案「点击登录」/「登录后同步学习记录与进度」**；「+」的设计到此全部作废，不要再出现小条十字、也不要用字形「+」画（实测字形墨水低 2.63px）；青绿图标对浅绿底对比 3.50:1，比白「+」那版的 1.058:1 清楚得多；**真机上重点看两行文案的字号/换行/颜色是否如他所愿，以及图标是否够清晰**）、顶栏铃铛与齿轮**都没有灰色圆底**、两颗图标**并排靠右**（消息通知在「设置」左边）、头像回落应是浅绿底青绿字而**不是纯绿实心**、未登录时头像右边是**两行轻盈文字**——主行「点击登录」（28rpx 青绿加粗）+ 副行「登录后同步学习记录与进度」（18rpx 灰 `#717873`），整块可点、点击区 ≥72rpx（不再摆占位昵称，也没有绿色胶囊按钮；**2026-09-23 01:1x 参考图前只有一行**）；个性签名正下方应是**白底圆角的资产卡片**（三列＝学习天数 / 卡集 / 题包，数字 + 小灰标签、列间细分隔线，**整卡高度约 107rpx，不应再显得笨重**、与身份区之间留约半张卡片高的空白（`margin-top: 60rpx`））、**昵称 / 卡片三个数字 / 「账户与服务」标题都应是 Medium 一档（明显比头像圈里的首字细，那三个字仍是粗的）**、**整张卡片可点并进入「我的资产」页**、原「我的资产」标题与「管理」文字链**都不应再出现**；**这一整块（顶栏 + 身份区 + 资产卡片）的底色应当是从屏幕最上沿连续铺到卡片下沿的一块淡渐变**——顶栏那一条与下面的色块**不应有色差**、中间**不应有分隔线或漏白的横带**，卡片**整张坐在色块里**（不是色块在卡片前就淡没），卡片以下的页面底色与渐变尽头**不应出现硬边**；已登录时点右上角**「设置」（现在是齿轮图标圆钮，消息通知已挪到它左边）应能退出登录**（退出入口从被删的"账号已登录"按钮移到这里，别让登录态无路可退；同时核对齿轮图标在真机尺寸下是否清晰、与铃铛是否同粗）；页内自定义导航栏是否正常（返回箭头、"编辑资料"标题居中、**顶部不再空出一条**、标题没有被微信胶囊压住）；头像与「更换头像」胶囊的命中区（**「更换头像」应为白底胶囊 + 品牌青绿相机图标与青绿文字、内容居中，文字要细、胶囊要短——真机上宽度应明显小于屏宽一半，绝不该被撑到屏宽四成以上**）、**无头像时是否显示品牌绿「薯」而不是灰色人像占位**（老账号的失效外链头像走同一回落）；**昵称/个人签名行是否呈现"右对齐值 + 箭头"、点进去输入时键盘态与 `bindblur` 是否正常**；**表单后的整宽「保存修改」按钮是否一屏可达（不贴屏幕最底）、保存中态是否可见**；`input type="nickname"` 的键盘态与 `bindblur`；点「保存」后是否提示"资料已保存"并返回"我的"页显示新值，"我的"与"社区身份"两页是否一致；**新增六行的真机核对**——个人签名输入框的键盘态与 40 字上限、`picker mode="region"` 三级选择与「未设置」空态回显、学习方向选择器是否列出正式科目并能回显上次选择、每日目标六档回显、公开学习数据开关的默认态（**应为关闭**）与动画。Agent 只做到"代码 + 契约"层，按 AGENTS §6 不得宣称已验收。
- mp 后台《用户隐私保护指引》勾选"微信昵称、头像"后，真机上 `chooseAvatar` / `nickname` 是否被平台额外拦截（未配置前的行为**未验证**）。
- **微信登录密钥与合法域名**：真机/体验版要真登录，必须在服务端配 `WECHAT_APP_ID` + `WECHAT_APP_SECRET` 并把 HTTPS 域名加进"request 合法域名"；本机现在两者都没有，`POST /api/auth/wechat/login` 返回 503 `wechat_credentials_not_configured`（小程序侧提示"请先配置微信登录密钥"）。**待产品负责人配置后在真机验收。**
- 角色模型、四类限制语义与"仅超管"清单的产品口径登记（C1 + 手册 §8.4/§9.4 缺正文）。
- 小程序端收藏/复制与受限提示的**真机验收**（本机无微信环境，仅代码层与服务端契约检查）。
- 生产环境 CORS 与公网暴露的独立验收（R2）。
- 隐私政策完整性、全域注销、数据留存（R4，当前为**阻断**）。

### 【已知缺口】

- 微信《用户隐私保护指引》同意流程未实现：`apps/miniprogram/app.json` 无 `__usePrivacyCheck__`，代码里无 `wx.requirePrivacyAuthorize`；头像/昵称采集依赖 mp 后台勾选对应条目（属运营侧配置，见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C12）。
- **本地登录的模式与启动方式**（排查口径，`server.js` 的 `exchangeWechatCode`）：① 有 `WECHAT_APP_ID`+`WECHAT_APP_SECRET` → 真实 `jscode2session`；② 否则 `NODE_ENV=production` 且 `WECHAT_AUTH_MODE!=="mock"` → 503 `wechat_credentials_not_configured`；③ 其余 → 开发态 mock openid（`dev-<hash>`）。本机 shell 默认 `NODE_ENV=production`，所以本机联调要么给密钥、要么 `set WECHAT_AUTH_MODE=mock`。**3212 进程必须由人在自己的终端启动**（[`../../AGENTS.md`](../../AGENTS.md) §8 ⚠️：Agent 沙箱拉起的进程写不进 `.runtime`，后台登录会以 `EPERM … admin-accounts.json.tmp` 失败）。
- 头像以 data URL 存在用户记录（`.runtime/users.json`）里，随 `/api/auth/me` 每次回传；与反馈截图同规格（≤200KB）但**未走对象存储**，用户量或图片体积上升后应迁移（C12 待定）。
- 历史账号里由旧 `wx.getUserProfile` 写入的昵称（如"微信用户"）不会被自动纠正，需用户自行改一次；服务端不再有任何来源覆盖它。
- 注销尚未覆盖全部散落数据（已覆盖学习状态、账号、社区收藏/复制关系；**未覆盖**投稿、AI 任务与对话、反馈联系方式/截图）。
- "我的收藏"已从复习工具和“我的”页菜单进入；新增菜单入口的真机点击与排版待验收。
- 操作日志在 PostgreSQL 下的一致性未纳入统一事务（产品手册 §10.4、[`../RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) R5）。

## 7. 代码、测试与历史决策入口

- 代码：[`apps/api/src/admin-account-store.js`](../../apps/api/src/admin-account-store.js)、[`admin-operation-store.js`](../../apps/api/src/admin-operation-store.js)、[`user-auth-store.js`](../../apps/api/src/user-auth-store.js)、[`user-restriction-store.js`](../../apps/api/src/user-restriction-store.js)、[`community-interaction-store.js`](../../apps/api/src/community-interaction-store.js)、[`server.js`](../../apps/api/src/server.js)（`/api/auth/*`、`/api/admin/*` 闸门与权限清单）、[`apps/admin/`](../../apps/admin/app.js)（登录闸门、后台账号、社区管理）、[`apps/miniprogram/app.js`](../../apps/miniprogram/app.js)（`loginWithWechat` / `saveProfile` / `avatarDataUrl`）与 [`apps/miniprogram/pages/profile/`](../../apps/miniprogram/pages/profile/profile.js)（登录入口、"我的"页）、[`apps/miniprogram/pages/profile-edit/`](../../apps/miniprogram/pages/profile-edit/profile-edit.js)（头像昵称编辑二级页）。
- 测试：[`tests/admin-auth.test.js`](../../tests/admin-auth.test.js)、[`user-restrictions.test.js`](../../tests/user-restrictions.test.js)、[`community-interactions.test.js`](../../tests/community-interactions.test.js)、[`miniprogram-auth.test.js`](../../tests/miniprogram-auth.test.js)、[`auth-learning-api.test.js`](../../tests/auth-learning-api.test.js)、[`auth-profile-api.test.js`](../../tests/auth-profile-api.test.js)。
- 规则正文：产品手册 §8.4、§9.1、§9.2、§10.2、§11.2（角色模型与四类限制语义仍缺正文，见 C1）。
- 历史：[`二、变更日志`](<../../题库开发手册/二、变更日志（CHANGELOG.md）.txt>) 2026-09-21 00:34 条目、[`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C1/C4；[`../RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) R1–R4。
