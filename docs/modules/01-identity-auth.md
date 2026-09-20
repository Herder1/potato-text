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

### 【已实现】

- 用户微信登录与会话：`apps/api/src/user-auth-store.js`、`server.js` 的 `/api/auth/*`。
- 后台账号、角色、会话与强制改密：`apps/api/src/admin-account-store.js`。
- 统一鉴权闸门与三档权限清单（含默认拒绝未登记路径）：`server.js`（`SUPER_ADMIN_ONLY_ADMIN_PATHS`、`OPERATOR_ADMIN_PATHS`、`adminPermissionForPath`、admin 闸门）。
- 真实操作人操作日志（含稳定账号 ID `actorId`）：`apps/api/src/admin-operation-store.js`。
- 用户侧四类限制：`apps/api/src/user-restriction-store.js` + `server.js` 的能力拦截与治理接口。
- 社区收藏/复制关系（按人去重，供计数与"我的收藏"）：`apps/api/src/community-interaction-store.js`。

### 【已验证（2026-09-21 00:34 本机实跑）】

- `tests/admin-auth.test.js` → **21/21**：全 `/api/admin/*` 路由匿名 401 与伪造 token、鉴权闸门必须排在所有后台路由之前（含正则写法路由）、每条后台路由必须被显式分类（未登记 → 运营 403、超管 404）、权限三档与超管专属前缀、内部导入独立授权三条件（凭证/本机来源/路径）、登录/登出/真实操作人（actorId）、运营 403、停用即撤销会话、重置/本人改密、环境变量不能当后门、初始化凭据不合法时保持锁定、账号校验规则、强制改密。
- `tests/user-restrictions.test.js` → **9/9**：期限必填/超限/过期/缺理由全部拒绝、四类档位拦截范围、到期自动失效、仅超管可解除、举报四类动作落限制、同类型重复下发为延长。
- `tests/community-interactions.test.js` → **5/5**：收藏与复制都要登录、重复收藏/复制不刷数、跨人去重、我的收藏按人隔离与回显、注销清理关系记录。
- 全量 `node --test tests/*.test.js` → **1171 / 1171 通过**（`NODE_ENV` 未设为 production；设为 production 时另有 3 个既有微信登录用例因缺密钥 503，与本模块无关）。
- 实机证据：隔离内存实例 23 项越权复现全部 PASS；标准端口 3212 重启后匿名治理接口全部 401、原「未登录可执行社区审核」已复现为 401；无头 Chrome 跑通登录/建号/停用/强制改密/限制下发（含举报单下发）/退出，`console_errors=0`（截图见 `tmp/admin-ui-shots/`）。

### 【待验收】

- 角色模型、四类限制语义与"仅超管"清单的产品口径登记（C1 + 手册 §8.4/§9.4 缺正文）。
- 小程序端收藏/复制与受限提示的**真机验收**（本机无微信环境，仅代码层与服务端契约检查）。
- 生产环境 CORS 与公网暴露的独立验收（R2）。
- 隐私政策完整性、全域注销、数据留存（R4，当前为**阻断**）。

### 【已知缺口】

- 注销尚未覆盖全部散落数据（已覆盖学习状态、账号、社区收藏/复制关系；**未覆盖**投稿、AI 任务与对话、反馈联系方式/截图）。
- "我的收藏"独立列表页尚未进入小程序信息架构（服务端接口已就绪）。
- 操作日志在 PostgreSQL 下的一致性未纳入统一事务（产品手册 §10.4、[`../RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) R5）。

## 7. 代码、测试与历史决策入口

- 代码：[`apps/api/src/admin-account-store.js`](../../apps/api/src/admin-account-store.js)、[`admin-operation-store.js`](../../apps/api/src/admin-operation-store.js)、[`user-auth-store.js`](../../apps/api/src/user-auth-store.js)、[`user-restriction-store.js`](../../apps/api/src/user-restriction-store.js)、[`community-interaction-store.js`](../../apps/api/src/community-interaction-store.js)、[`server.js`](../../apps/api/src/server.js)（`/api/auth/*`、`/api/admin/*` 闸门与权限清单）、[`apps/admin/`](../../apps/admin/app.js)（登录闸门、后台账号、社区管理）。
- 测试：[`tests/admin-auth.test.js`](../../tests/admin-auth.test.js)、[`user-restrictions.test.js`](../../tests/user-restrictions.test.js)、[`community-interactions.test.js`](../../tests/community-interactions.test.js)、[`miniprogram-auth.test.js`](../../tests/miniprogram-auth.test.js)、[`auth-learning-api.test.js`](../../tests/auth-learning-api.test.js)。
- 规则正文：产品手册 §8.4、§9.1、§9.2、§10.2、§11.2（角色模型与四类限制语义仍缺正文，见 C1）。
- 历史：[`二、变更日志`](<../../题库开发手册/二、变更日志（CHANGELOG.md）.txt>) 2026-09-21 00:34 条目、[`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C1/C4；[`../RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) R1–R4。
