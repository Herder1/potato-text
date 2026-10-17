# 项目地图（PROJECT_MAP）

- 用途：给出"要改 X → 读哪份规则、改哪些文件、跑哪些测试"的**唯一索引**。
- 本次重组日期：2026-09-20（渐进式文档重组第一批）。
- 维护约定：新增/移动模块、改变规则正文位置或测试入口时必须同步本文件；**规则内容本身不写在这里**，只放入口。
- 约束入口：根目录 [`AGENTS.md`](../AGENTS.md)；待裁决冲突见 [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md)。

## 0. 权威与状态标签

权威层级见 [`AGENTS.md`](../AGENTS.md) 第 2 节：产品手册"已确认"规则 > 交流文档已形成结论的决议 > 变更日志已执行改动 > 当前代码/测试 > `docs/` 与历史材料。

| 标签 | 含义 |
| --- | --- |
| 已确认 | 产品负责人已确认，后续开发必须遵守（正文在产品手册） |
| 已实现 | 当前开发版本有对应代码与基本测试，**不代表生产可用** |
| 已验证 | 有仓库内可追溯、带日期与覆盖范围的测试/验收证据 |
| 部分实现 | 只有部分链路可用，不得对外宣称完整能力 |
| 规划中 | 方向已记录，尚未进入稳定交付 |
| 待验收 | 已实现但没有可追溯验收证据，或证据只覆盖历史版本 |
| 待裁决 | 规范与实现/文档之间存在冲突，需产品负责人定口径 |
| 待整改 | 当前实现与已确认目标不一致 |

## 1. 仓库结构

| 路径 | 内容 |
| --- | --- |
| `apps/miniprogram/` | 原生微信小程序（用户端） |
| `apps/api/src/` | Node.js API、领域 Store、领域规则（`server.js` 为路由与总装配） |
| `apps/admin/` | 网页管理后台（`index.html` / `app.js` / `styles.css`，静态资源用 `?v=` 破缓存）；备案号页脚及登录页可见性测试见 `tests/admin-site-filing.test.js`，上线核验状态见 `RELEASE_CHECKLIST.md` A1 |
| `packages/domain/` | 领域模型与 SQL 草案（`catalog.js`、`schema.sql`、`assessment-action-semantics.js`） |
| `docs/` | 现行导航、产品摘要、上线清单、模块文档、迁移与存储说明 |
| `tests/` | 222 个 `*.test.js`（2026-10-17 **本机实测 1943 个用例、1943 通过、0 失败**。⚠️ 计数是**移动靶**，同日多轮在建改动会漂动；须 `NODE_ENV=development`，否则开发态鉴权/API 用例会失败）+ `fixtures/`、`helpers/` |
| `scripts/` | 运维与工具脚本，2026-09-21 按用途分为四组：`scripts/db/`（数据库/文件存储迁移，3）、`scripts/classification/`（金标冻结与盲测回放链路，9）、`scripts/maintenance/`（一次性维护任务，1）、`scripts/tools/`（本地素材工具，1）。**`tests/*.test.js` 与 `package.json` 是入口**，路径改动必须同步二者；历史账本 `题库开发手册/` 中仍保留旧平铺路径（历史记录不改写） |
| `.runtime/` | 正式运行数据（JSON）与备份；**禁止手改** |
| `题库开发手册/` | 一产品手册、二变更日志、三交流文档、四链路职责矩阵 |
| `题目录入/` | 教材 PDF、试卷、录题稿等原始资料（**本地保留，不入 git / 不进镜像**，见 `.gitignore`、`.dockerignore`） |
| `删除件归档/` | 按"要删的东西先归档、不直删"规则保留的移除件（**本地保留，不入 git / 不进镜像**）。当前：`2026-09-21-工程整理/微信小程序历史残留`（仓库根历史 `project.config.json`，appid 与真实小程序不一致）、`…/测试夹具残留`（1394 个被测试写进 `.runtime` 的上传夹具，根因已修）。每个归档目录内含 `README.txt` 说明判据与恢复方法 |
| `Dockerfile`、`.dockerignore`、`docker/entrypoint.sh` | 容器镜像定义、构建上下文排除清单与入口脚本（操作说明正文 `docs/DOCKER.md`） |
| `docker-compose.yml`、`docker-compose.postgres.yml` | 源码构建用的单容器默认编排 / 叠加 PostgreSQL 的可选编排 |
| `docker-compose.1panel.yml`、`docker-compose.1panel-postgres.yml` | **1Panel 面板粘贴即用**编排（只拉 GHCR 现成镜像、无 `build:`、无 `.env` 依赖、命名卷持久化）；操作正文见 `docs/DOCKER.md` §9 |
| `.github/workflows/docker-publish.yml` | 推送 `main` 或 `v*` tag 时自动构建并发布镜像到 GHCR（触发与标签策略正文在该文件内）；静态契约检查 `tests/docker-publish.test.js`，发布操作见 `docs/DOCKER.md` §7 |

## 2. 已拆分模块

**作品赏析并入材料分析（2026-10-16，模块 02/03）**：规则正文产品手册 §4.6.15 / DEC-113。兼容别名唯一工具 `apps/miniprogram/utils/question-type.js`（API 与小程序共用）；主读写入口 `apps/api/src/question-store.js`，并接入文本/试卷导入、导出、教材出题、考法范围及用户端缓存/练习。测试 `tests/material-question-type.test.js`、`tests/practice-page-flow.test.js`；浏览器 `tmp/verify-assessment-modes-ui.cjs`。实现与验收状态见模块 02 §6，考法范围见模块 03 §6。

**考法标准与题目标注（2026-10-16，模块 02/03）**：规则正文为产品手册 §4.6.14 / DEC-112；标准初值 `apps/api/src/assessment-mode-seeds.js`，共享服务 `assessment-mode-standards.js`，接口 `assessment-mode-routes.js`（由 `server.js` 在后台鉴权后装配），持久化复用 `knowledge-classification-experience-store.js`。界面 `apps/admin/assessment-modes.js` / `.css`，挂载于 `index.html` / `app.js`；上游空响应诊断在 `apps/api/src/ai-provider.js`。测试 `tests/assessment-mode-standards.test.js`、`assessment-mode-api.test.js`、`admin-assessment-modes.test.js`、`ai-provider-empty-response.test.js`；隔离浏览器 `tmp/verify-assessment-modes-ui.cjs`。状态及验收边界只在模块 03 §6 维护。

> 01–04 为第一批（2026-09-20 拆分）；05（「我的收藏」与收藏目录）为 2026-09-23 随 DEC-096 落地后补拆。

| 模块 | 职责（一句话） | 代码位置 | 现行规则正文 | 模块文档 | 主要测试入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 身份、登录与后台权限 | 微信用户登录/会话；后台账号、角色、会话与操作人记录；后台用户目录、注册/注销总览与当前限制；用户侧四类限制（禁言/禁止投稿/公开限制/封禁） | `apps/api/src/user-auth-store.js`、`admin-account-store.js`、`admin-operation-store.js`、`user-restriction-store.js`、`server.js`（`/api/auth/*`、`/api/admin/*` 闸门与三档权限清单、`GET /api/admin/users`）、后台 `apps/admin/{index.html,app.js,styles.css}`（「用户管理」）、`apps/miniprogram/app.js` + `pages/profile/`（登录入口）、`pages/profile-edit/`（自设头像昵称的二级页）、`pages/onboarding/`（注册引导三步向导、隐私授权勾选与登录闸门） | 产品手册 §9.2、**§9.2.2（DEC-109 登录门槛与注册引导）**、§8.4、§11.2；后台角色模型与限制语义**待裁决** | [01-identity-auth](modules/01-identity-auth.md) | `tests/admin-auth.test.js`、`admin-user-management.test.js`、`miniprogram-auth.test.js`、`auth-learning-api.test.js`、`auth-profile-api.test.js`、`user-restrictions.test.js`、`onboarding-profile.test.js`、`onboarding-page.test.js`、`onboarding-gate.test.js`、`logout-workspace.test.js`；逐项可见性 `tmp/verify-onboarding-steps.js`（引导三步） | 已实现，待口径确认；用户目录代码+接口与本机逐项可见性已验证（2026-10-17），3212 重启待执行；注册引导已按产品负责人要求改成三步（同一页内 step 1..3），**真机未验收** |
| 2 题目录入、校正与答案审核 | 题目导入/录入、版本、答案分层、逐字段完善、合并、裁决台；**归属字段可暂缺与「待归类」派生状态（DEC-093）**；**归属判断四级链：考试项目（专业）→ 科目 → 教材 → 知识树（AI 只建议、逐级人工确认；DEC-098）**；**导入查重三档（事实相同/疑似重复/择优补充）与材料题拆分（DEC-094）**；**材料题组分值分配（DEC-099）：原卷分值优先 → 按得分点分配到题组、整组一次采纳、`scoreBasis`／`scoreNeedsReview` 标记（`apps/api/src/material-score-allocation.js` 内核 ＋ `material-group-score.js` 整组层）；「入库」口径＝只有"确认写入"那一步才算（手册 §4.6.9）；**后台题目序号：派生不落库、按题目单元编号（`question-serial.js`，手册 §4.6.10）**；**完善中心按题组呈现＋整组勾选为主操作（`app.js` `questionEnrichmentUnits()`／`questionEnrichmentGroupHeadHtml()`，手册 §4.6.11）**；**完善题目筛选行＝六个「勾选式下拉」（科目／教材／导入批次／题型／待完善项／建议状态，可多选；同字段内 OR、跨字段 AND、不勾＝不筛，2026-10-12）；原「归类状态」下拉与教材哨兵项已从界面撤掉（等价入口＝「待完善项 → 归属」组／「待定教材」；服务端参数 `classification`、`bookId=__unassigned__` 仍接受）**；**本页是唯一改库入口（DEC-100）：题目知识归属＋题族归属都在此确认，AI 巡检只诊断不改库**；**「疑似重复」在预览里的可见性与定位入口（2026-09-22：色片 + 左侧色条 + 「只看疑似重复」开关 + 默认排序把疑似行聚到重复题旁 + 点色片打开既有题 / 跳到本批相似行 + 右侧「疑似与…重复 N% · 点击对比」逐字段核对，配套只读 `GET /api/admin/questions/:id`）**；**导入批次撤销（入口 + 删除前影响面 + 确认码闸门，DEC-095）**；**判重归一化补「剥来源标注 + 半角标点」、疑似提示加「选项重合 ≥50%」与「最短 4 字」门槛、疑似提示新增第二条依据（选项与答案完全一致 + 剥标注后题干 ≥5 字连续公共片段且占较短一版 ≥40%，2026-09-22 同日第二次）、对比弹窗「答案处置」（2026-09-22 同日第四次改为**表格里就地选中/勾选（选中整格高亮）+ 底部按钮**：「用导入稿替换所选」/「参考答案合并两版」，`mode:"absorb"`；**同日第五次：这两颗按钮也开给"疑似重复"行——必须先点「确认是同一道题」才出现，可写字段与"事实相同"一致（正确答案／参考答案／来源名＋页码），服务端新增第二条授权 `operator_confirmed_suspicion` 并仍用同一个 `strongEvidenceBetween()` 独立复核，未确认的疑似行照旧没有任何写入入口，原错误码 `question_absorb_requires_identical` 退役**；**同日第六次仅改文案：底部按钮标签压到 4～6 字（「替换所选（N）」「合并两版」「择优补充」「定位原文」），"只补空缺""会覆盖非空字段/版本+1/答案降待核对"等限定条件移到 `title` 悬停提示，动作集合与写入后果不变**）——2026-09-22 口径修订见产品手册 §4.6.4 与 §0.4「DEC-094 修订」行；答案处置的口径正文待确认（OPEN_DECISIONS §1.6 C11）**；**疑似重复的「人工裁决」两个动作（2026-09-22 同日第三次：「确认是同一道题（不导入）」＝该行不导入并解锁**只补空缺**、「确认不是重复」＝照常导入，二者仅作用本次预览、导入前可撤销；裁决随导入请求以 `decisions` 提交，服务端只认自己标过疑似的行、并在写入前用与预览提示同一个 `strongEvidenceBetween()` 独立复核，覆盖非空字段仍要求事实相同；留痕 `question.suspicion_verdict`）** | `apps/api/src/question-store.js`、`exam-project-registry.js`（考试项目一级与科目/教材查询的**唯一读取入口**，DEC-098）、`question-classification-state.js`（「待归类」唯一定义处）、`question-text-import.js`、`material-question-split.js`（材料题拆分唯一定义处）、`material-score-allocation.js`（材料题组分值分配唯一定义处，DEC-099；测试 `tests/material-score-allocation.test.js` 13 条）、科目默认材料题组满分（现代汉语 14／其余四科 20，值在 `packages/domain/catalog.js`、唯一读取入口 `apps/api/src/exam-project-registry.js#materialGroupTotalForSubject`）、题型默认分值（单选 2／多选 3，唯一维护处 `apps/api/src/question-score-defaults.js`）、`exam-paper-import.js`、`exam-document-import.js`、`question-enrichment-store.js`、`question-merge-*`、`suggestion-lifecycle.js` | 产品手册 §4.6、**§4.6.3**、**§4.6.4**、**§4.6.5**、§4.7、§8.3、§5.6、**§4.6.6**；DEC-018、**DEC-093**、**DEC-094（含 2026-09-22 修订）**、**DEC-095**、**DEC-098** | [02-question-authoring](modules/02-question-authoring-answer-review.md) | `question-store`、`question-text-import`、`exam-paper-import`、`question-enrichment`（本轮 8 条）、**`exam-project-registry`（3 条）**、**`admin-duplicate-element-ids`（静态 2 条：全页重复 id 守卫）**、**`question-classification`（Store 17 条）、`question-classification-api`（接口 5 条）**、**`admin-enrichment-filter-controls`（完善题目筛选行：静态契约 2 条 + 多选筛选语义与生成范围 2 条，2026-10-12）**、**`question-import-dedupe-api`（接口 17 条：查重三档 + 口径三项修订 + 疑似第二条依据（选项与答案一致）正反例 + 择优补充 + 对比处置 absorb + 单题详情 + 疑似逐字段对比 + **人工裁决（确认同一道题不导入 / 确认不是重复照常导入 / 无效下标忽略 / 人工确认后才允许只补空缺且覆盖仍拒绝）**）**、**`question-batch-undo-api`（接口 5 条：批次/选择影响面 + 确认码）**、`question-merge-*`、`adjudication-queue`、`suggestion-lifecycle` | 已实现/部分实现 |
| 3 知识指纹、Agent 归类与人工采纳 | 题目正式知识指纹、Agent 1–3 候选、人工采纳提交、金标冻结与盲测 | `question-classification-features.js`、`knowledge-classification-pipeline.js`、`classification-verification-policy.js`、`classification-commit-store.js`、`classification-commit-coordinator.js`、`knowledge-classification-experience-store.js`、`classification-gold-review-store.js`、`question-audit-rules.js`（确定性体检规则的**判定**）、`question-audit-context.js`（体检的**事实来源**：教材正文就绪、知识锚点）、`question-audit-service.js`（体检的 **Store 接线**，重复题索引建在整本书上）、`apps/admin/knowledge-inspection-apply-guard.js`（**改库载荷的唯一定义处**：DEC-100 后由「完善题目」调用，纯函数 `buildApplyRequest`／校验，`app.js` 里 `/apply` 地址只出现一次） | 产品手册 §4.6.1、§4.8、§4.9、§5.x、§10.4、§10.5；DEC-025/026/031–036/039/040 | [03-knowledge-fingerprint](modules/03-knowledge-fingerprint-agent-classification.md) | **DEC-100（2026-09-26）：归类产线的操作入口归「完善题目」，AI 巡检标签只做只读体检**；`rich-knowledge-fingerprint`、`option-knowledge-protocol`、`classification-commit`、`classification-verification-policy`、`classification-blind-*`、`classification-gold-*`、`knowledge-classification-api`、`knowledge-inspection-family-filter`（巡检「题族状态」筛选；口径取舍见 [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md) §1.20）、`question-audit-rules`／`question-audit-context`／`question-audit-service`（体检规则三层，14 条）、`knowledge-inspection-audit-review`（巡检记录四态状态机 API＋静态契约）、`admin-inspection-readonly`（巡检面板只读化静态契约）、`admin-inspection-rule-findings`（体检项三态前端展示与逐题措辞）、`admin-enrichment-classification-adopt`（**完善题目承接改库能力**：唯一调用点／阻断原因／载荷契约）；端到端验收脚本 `tmp/verify-audit-review-api.js`、`tmp/verify-inspection-readonly-ui.js`、`tmp/verify-enrichment-adopt-ui.js` | 首版已实现，PostgreSQL 待实现 |
| 4 题族、成员审核与用户目录投影 | 题族六组定义事实、成员贡献与审核、题族集、目录投影、归组统计 | `apps/api/src/question-family-store.js`、`question-family-relations.js`、`question-family-catalog-projection.js` | 产品手册 §4.10–4.12、§6.2、§7.3；DEC-015–024、037–039 | [04-question-family](modules/04-question-family.md) | `question-family`、`question-family-relations`、`question-family-catalog-projection`、`admin-question-family-*`、`retire-question-family-unresolved-index` | 首版已实现，待真实数据验收 |
| 5 「我的收藏」与收藏目录 | 用户对收藏的组织方式（文件夹/子文件夹/归属/全局置顶）；把社区收藏与题目收藏两类真源合成一张视图（只读、不复制内容）；收藏页抽屉、搜索/筛选/排序一行与「分类管理」页 | `apps/api/src/favorite-folder-store.js`、`server.js`（`/api/favorites/*` 七条路由）、小程序 `pages/favorites/`、`pages/favorite-manage/`、`pages/profile/profile.js`（“我的”菜单入口）、`utils/favorites-organization.js` | 产品手册 §0.4（**DEC-096**）；待确认小口径见 [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md) §1.9 | [05-favorites](modules/05-favorites.md) | `favorite-folders`、`favorites-organization`、`favorites-page`、`favorite-manage-page`、`page-transient-layers` | 已实现，已本机逐项可见性验证（26/26），**待真机验收** |
| 6 卡集与知识卡（服务端归属） | 卡集、目录、知识卡本体的服务端归属与跨设备合并（并集 + `updatedAt` 取较新 + 删除墓碑 + 空库只拉不推）；「分享卡集」改服务端只读快照链接 + 好友「导入到我的卡集」 | `apps/api/src/card-library-store.js`、`server.js`（`/api/card-library` 四条路由：GET 拉取 / sync 合并 / share 建快照 / 匿名 `share/:id` 读取）、小程序 `utils/card-box-store.js`、`pages/card-set/`、`app.js`（登录与启动同步） | 产品手册 §0.4（**DEC-097**） | [06-card-library](modules/06-card-library.md) | `card-library-store`、`card-library-sync`、`card-box-store`、`card-box-folder-flow`、`card-set-page-flow` | 服务端与本地库已实现（本机 **165** 用例通过，2026-09-23），**待真机验收** |
| 7 个人云端资产 | 私人题包、独立笔记、AI 对话的云端归属；笔记卡复用模块 06，不另存正文 | `apps/api/src/personal-cloud-asset-store.js`、`apps/miniprogram/utils/personal-cloud-sync.js`、`utils/private-pack-store.js`、`utils/asset-store.js`、`pages/practice/practice.js`、`pages/privacy/`、`pages/assets/`、`app.js` | 产品手册 §9.2.1（**DEC-106**） | [07-personal-cloud-assets](modules/07-personal-cloud-assets.md) | `personal-cloud-asset-store`、`personal-cloud-sync`、`personal-cloud-asset-api`、`personal-cloud-page`、`personal-cloud-lifecycle`、`assets-page`、`private-pack-entry-source` + 既有回归 | 实现/验收与附件、历史归属缺口只在模块 §6 维护 |
| 8 平台设置 | 7 份用户端文本（用户协议/隐私政策/AI 服务说明/退款政策/账号注销说明/运营主体与客服信息/个人信息收集清单）的正文、版本号、生效日期、发布与下架、当前版本查询；用户端只读已发布版本，未发布显示「尚未发布」；按账号只追加记录同意版本 | `apps/api/src/platform-content-store.js`、`server.js`（`/api/platform-content`、`/api/auth/agreements`、`/api/admin/platform-content`）、`user-auth-store.js`（`agreements`）、`postgres-persistence.js`（`STORE_SPECS`）、`scripts/db/runtime-migration-lib.js`、后台 `apps/admin/{index.html,app.js,styles.css}`（「平台设置」面板）、小程序 `utils/platform-content.js` + `templates/platform-doc.wxml` + `pages/{legal,personal-info,about,onboarding,store,store-order}/`、统一图标组 `assets/icons/doc-*.svg` | 产品手册 §0.4 **DEC-110**（2026-10-05，含「选项 A」草稿可改写·发布即锁死） | [08-platform-settings](modules/08-platform-settings.md) | `platform-content-store`、`platform-content-api`、`admin-platform-content-ui`、`miniprogram-platform-content`、`platform-doc-links-icons`、`settings-pages`、`postgres-persistence`；邻居回归 `admin-auth`、`auth-profile-api`；逐项可见性 `tmp/verify-platform-content-admin-ui.js`（后台面板）、`tmp/verify-about-icons-settings-buttons.js`（关于页图标 / 商店页退款入口 / 设置页按钮不重叠） | 切片 1 后端 + 切片 2 后台面板 + 切片 3 用户端读取 + 切片 4（2026-10-17：商品页退款入口改为打开 `refund` 文档、关于页七份图标统一）已落地；**真机未验收**，版本化同意落页面与 FAQ 迁移未做——详见模块 §6 |

| 9 订阅商品与套餐组 | 订阅商品按套餐组共享课程范围、按规格配置期限/价格/赠币；订单引用具体规格 ID；豆币充值归入唯一的「豆币充值」组（组标识固定、组名可改，组内规格独立购买） | `apps/api/src/billing-store.js`、`server.js`（`/api/admin/billing/packages/:key`）、`postgres-persistence.js`；后台 `apps/admin/{index.html,app.js,styles.css}`；小程序 `pages/store-order/`；一次性落盘迁移 `scripts/migrate-bean-recharge-group.js` | 产品手册 §9.3、§9.6、§0.4 DEC-107 | [09-billing-products](modules/09-billing-products.md) | `billing-store`、`api`、`admin-billing-ui`、`billing-bean-group`、`postgres-persistence`、`storefront-page-flow`；`tmp/verify-billing-group-ui.js`、`tmp/verify-bean-recharge-group.js` | 后台分组（含豆币组）已实现，真实支付与真机验收待完成；详见模块 §6 |

> 模块编号仅用于本批次导航，**不是产品编号，也不对应 DEC 编号**。

**数字用户 ID 与跨用户收费管理（2026-10-07）**：规则见产品手册 §9.2、§9.6；账号分配与查找在 `apps/api/src/user-auth-store.js`，文件回填入口 `scripts/migrate-user-public-ids.js`，订单/权益汇总在 `apps/api/src/billing-store.js` 与 `server.js`，后台入口 `apps/admin/{index.html,app.js,styles.css}`。测试 `tests/user-public-id.test.js`、`tests/admin-billing-management.test.js`、`tests/admin-billing-ui.test.js`，隔离浏览器 `tmp/verify-billing-management-ui.js`；状态与缺口见模块 01、09 §6。

**后台用户目录与注册/注销总览（2026-10-17）**：超管专属 `GET /api/admin/users` 由 `apps/api/src/server.js` 提供，账号总览与匿名注销事件在 `user-auth-store.js`，分页限制状态在 `user-restriction-store.js`，页面入口 `apps/admin/{index.html,app.js,styles.css}`。测试 `tests/admin-user-management.test.js`，逐项可见性 `tmp/verify-user-management-ui.js`；实现边界与历史注销无法补算的缺口见 [模块 01 §6](modules/01-identity-auth.md)。

**题库五项共享筛选（2026-09-28）**：规则入口产品手册 §8.2；只读浏览状态在 `apps/api/src/question-workspace-filter.js`，题目／题族请求在 `server.js`，共享控件与成员显示在 `apps/admin/{app.js,index.html,styles.css}`，全教材目录导航在 `library-workspace.js`。测试 `tests/question-workspace-filter.test.js`、`tests/admin-workspace-book-filter.test.js`；隔离夹具 `tests/helpers/question-workspace-fixture.js`，浏览器 `tmp/verify-workspace-filters.cjs`。实现与证据在 [模块 02 §6](modules/02-question-authoring-answer-review.md)，题族边界在 [模块 04 §6](modules/04-question-family.md)。

**题目所属题族集（2026-10-09）**：规则正文产品手册 §4.12；只读派生 `apps/api/src/question-family-set-membership.js` 与 `server.js` 题目装饰，编辑区 `apps/admin/{app.js,index.html,styles.css}`，旧锚点兼容 `knowledge-structure-store.js`。测试 `tests/question-family-set-membership.test.js`、`knowledge-fingerprint-range.test.js`、`admin-knowledge-scope.test.js`；状态与验收见模块 02–04 §6。

**原题库恢复与冗余功能删除（DEC-103／105）**：规则入口为产品手册 §10.3.1；`apps/admin/{index.html,app.js,styles.css}` 只保留原题库，新题库与裁决台专属页面、事件、样式及后端业务实现已删除。旧接口只返回 410，无工作副本 Store 初始化或聚合队列读取。回归入口 `tests/admin-library-restoration.test.js`、`tests/admin-library-cleanup.test.js`、`tests/admin-question-library-tabs.test.js`。实现与证据只在 [模块 02 §6](modules/02-question-authoring-answer-review.md) 维护。

**原题库双目录／只补缺（DEC-104）**：规则入口为产品手册 §4.4.1、§4.6.12；界面模块 `apps/admin/library-workspace.js`；后端 `library-directories.js`、`question-completion.js` 及 `server.js` 中 `/knowledge-structure/directories`、`/directory-mapping`、`/question-enrichment/completion-preview`／`completion-commit`。测试入口 `tests/library-completion.test.js`、`tests/library-completion-api.test.js`、`tests/helpers/library-completion-fixture.js`，页面验证 `tmp/verify-library-completion.js`。实现与证据见 [模块 02 §6](modules/02-question-authoring-answer-review.md)，指纹／题族边界见模块 03／04 §6。

**完善页统一查看／裁决（2026-09-28）**：规则入口产品手册 §10.3.1；状态与默认页签纯函数 `apps/admin/question-review-model.js`，原弹窗整合在 `apps/admin/{app.js,index.html,styles.css}`；单题权威读取在 `server.js` 的 `GET /api/admin/question-enrichment?questionId=...`，已有定义保护在 `question-family-store.js#normalizeFamily`。测试入口 `tests/admin-question-review.test.js`、`tests/admin-enrichment-classification-adopt.test.js`、`tests/admin-enrichment-question-grouping.test.js`、`tests/question-classification-api.test.js`、`tests/question-family.test.js`；浏览器 `tmp/verify-question-review.cjs`。实现与证据见 [模块 02 §6](modules/02-question-authoring-answer-review.md)，题族修复边界见 [模块 04 §6](modules/04-question-family.md)。

**重复建议／重复归属去重（2026-09-28）**：产品手册 §10.3.1；共享内容比较 `apps/admin/question-enrichment-diff.js`（浏览器与 API 共用），指纹内容比较与新增题族选择 `question-review-model.js`，重读后只新增在 `app.js#applyEnrichmentFamilyMembershipOnly`，统计筛选与采纳防空转在 `apps/api/src/server.js`。回归 `tests/admin-question-review.test.js`、`tests/question-enrichment-dedup.test.js`；浏览器增加 `--duplicate-suggestions`。实现及验收证据只在模块 02 §6维护。

**题目详情说明提示（2026-09-28）**：`apps/admin/question-editor-help.js` 处理悬停／键盘提示及空白富文本占位状态，原 HTML 提供说明源，`app.js` 区分必须直接显示的动态状态；不另存数据。回归 `tests/admin-question-editor-help.test.js`，浏览器 `tmp/verify-question-editor-help.cjs`；实现与验收证据见 [模块 02 §6](modules/02-question-authoring-answer-review.md)。

**题目教材目录锚点编辑（2026-09-28）**：规则正文产品手册 §10.3.1；前端 `app.js#renderQuestionCatalogAnchor`／`loadQuestionCatalogAnchors`／`questionCatalogAnchorPayload`、`index.html#question-catalog-anchor`；后端复用题目 POST／PUT，`server.js#resolveQuestionCatalogAnchor` 校验教材来源节点，`questionFamilySensitiveSnapshot` 比较真实内容变化。新测试 `tests/admin-question-catalog-anchor.test.js`；浏览器 `tmp/verify-question-review.cjs --two-blocks --catalog-anchor`。实现、证据与已知边界见 [模块 02 §6](modules/02-question-authoring-answer-review.md)。

**题库载入性能与切换保护（2026-09-28）**：实现 `apps/api/src/server.js`（空知识树结果复用）、`apps/admin/app.js`／`library-workspace.js`（加载状态、取消与过期结果隔离）；回归 `tests/admin-workspace-loading.test.js`、`tests/question-workspace-filter.test.js`；实际页面验证 `tmp/verify-workspace-loading.cjs`，真实性能测量 `tmp/diagnose-family-workspace-latency.cjs --browser`。实现与验收详情只在模块 02 §6「题库载入提速与切换保护」维护。

题目列表来源目录与独立统计（2026-09-28）的代码／测试导航：`apps/api/src/question-source-directory.js`、`server.js`（题目只读查询），`apps/admin/library-workspace.js`／`app.js`（视图目录与映射）；测试 `tests/question-source-directory.test.js`、`tests/admin-source-directory.test.js`、`tests/admin-workspace-loading.test.js`；浏览器 `tmp/verify-source-directory.cjs`，真实数据只读核验 `tmp/verify-source-directory-real.cjs`。规则正文产品手册 §4.4.1／§8.2，实施证据只在模块02 §6「题目列表来源目录与独立统计」维护。

**作答方式统一「文字作答」、下线「原文标记」（2026-10-10，DEC-111）**：规则正文产品手册 §4.6.13（索引 §0.4 DEC-111）。后台编辑器与试卷导入校对卡在 `apps/admin/{index.html,app.js}`；`responseMode` 归一点在 `apps/api/src/question-store.js`，导入链路 `exam-import-store.js`／`exam-paper-import.js`／`server.js` 同口径；用户端作答界面在 `apps/miniprogram/pages/practice/practice.{js,wxml,wxss}` 与 `utils/question-sync.js`（属 §3 未迁移的「练习、作答与判分」）。测试入口 `tests/question-store.test.js`、`exam-paper-import.test.js`、`practice-page-flow.test.js`；逐项可见性 `tmp/verify-answer-mode-removal.js`。实现与证据见 [模块 02 §6](modules/02-question-authoring-answer-review.md)。

**题目详情「AI 补充答案 / 得分点」与「前端隐藏」标题行化（2026-10-10）**：规则正文产品手册 §8.3（2026-10-10 产品负责人确认三条：只填表单不写库／只填空缺／客观题不写得分成）。按钮与回执在 `apps/admin/{index.html,app.js,styles.css}`；新接口 `POST /api/admin/questions/:id/ai-supplement-answer` 在 `apps/api/src/server.js`，提示词契约与试卷导入草稿路由共用同一组 `answerSupplementPromptSpec()` 等辅助函数（唯一定义处）。测试入口 `tests/admin-question-ai-answer-supplement.test.js`（+ 既有 `exam-paper-import` 草稿路由回归）；逐项可见性 `tmp/verify-question-ai-supplement.js`。实现与证据见 [模块 02 §6](modules/02-question-authoring-answer-review.md)。

## 3. 未迁移模块清单（先在旧手册中查）

以下模块本轮不拆正文，入口统一指向旧手册对应章节；迁移顺序与负责人待定（见 [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md) 第 3 节）。

| 模块 | 旧文档位置（现行仍有效） | 代码位置 | 主要测试入口 |
| --- | --- | --- | --- |
| 教材、目录与知识树 | 产品手册 §2.2、§4.2–4.4、§8.2 | `textbook-catalog-store.js`、`textbook-knowledge-store.js`、`knowledge-structure-store.js`、`chapter-path-normalizer.js`（题目章节文本→目录路径写法的唯一匹配实现；回填脚本 `scripts/normalize-question-chapters.js`）、`catalog.js` | `textbook-catalog`、`textbook-knowledge`、`knowledge-structure`、`chapter-path-normalizer`、`catalog-outline` |
| 知识档案（概念、边界、关系、证据） | 产品手册 §4.5、§4.12.1；DEC-007–014、019 | `knowledge-dossier-store.js`、`question-textbook-context.js` | `knowledge-dossier-store`、`knowledge-dossier-api`、`question-textbook-context`、`admin-knowledge-inspection` |
| 试卷与模拟考试 | 产品手册 §2.1、§6.2、§6.7 | `exam-store.js`、`exam-import-store.js`、`exam-paper-import.js`、`exam-export.js`、`render-exam-pdf.py`；小程序导出后的本机复用入口 `apps/miniprogram/utils/exam-export-cache.js` | `exam-pack-store`、`exam-rule-builder`、`exam-export`、`exam-export-cache`、`exam-paper-import`、`exams-page-flow` |
| 题包与用户题库 | 产品手册 §6.2、DEC-041–046、070–075 | `pack-store.js`、小程序 `pages/packs|pack-detail|pack-collection` | `pack-collection-page`、`private-pack-page-flow`、`private-pack-store` |
| 练习、作答与判分 | 产品手册 §6.7、§7.1、§7.4 | `practice-session`、`question-assessment.js`、`learning-state-store.js`、小程序 `pages/practice/practice.js`（综合训练题池 / 目录抽屉 / 答题卡 / 两段式载入 C17-F5A） | `practice-session`、`practice-page-flow`、`practice-page-payload-contract`（视图层 setData 负载契约，C17）、`practice-page-progressive-bank`（综合训练两段式载入契约，C17-F5A）、`question-assessment`、`learning-state`、`learning-analysis` |
| 复习与知识卡 | 产品手册 §6.4、DEC-012、027–030、047–069、076–089（变更日志） | 小程序 `pages/card-*|knowledge-card|review|analysis|wrong-book`、`card-box-store` | `card-box-store`、`card-set-page-flow`、`knowledge-card-rich-flow`、`review-page-flow`、`review-tool-pages`、`wrong-book-page` |
| 社区、投稿与治理 | 产品手册 §9.4；需求基线"笔记与社区"；DEC-042、057 | `community-asset-store.js`、`community-interaction-store.js`、`moderation-store.js`、`user-restriction-store.js`、小程序 `pages/favorites` | `community-asset-store`、`community-profile-page`、`community-interactions`、`user-restrictions`、`favorites-page` |
| 我的收藏（文件夹与置顶，DEC-096） | 产品手册 §0.4 DEC-096 | `favorite-folder-store.js`（文件夹/子文件夹/归属/置顶，只存"怎么组织"）、`learning-state-store.js` 的 `account.bookmarks`（题目收藏真源）、`community-interaction-store.js`（社区收藏真源）、小程序 `pages/favorites`、`utils/favorites-organization.js` | `favorite-folders`、`favorites-organization`、`favorites-page`、`community-interactions` |
| 卡集与知识卡的服务端归属（DEC-097） | 产品手册 §0.4 DEC-097 | `card-library-store.js`（per-user 卡集/卡片/墓碑/分享快照；「是否加入复习」真源仍在 `learning-state-store.js` 的 `savedKnowledgeIds`）、`server.js` 的 `/api/card-library/*`、小程序 `utils/card-box-store.js`（`updatedAt` 戳记 + 删除墓碑 + 同步客户端）、`app.js`（登录与启动同步） | `card-library-store`、`card-library-sync`、`card-box-store`、`card-box-folder-flow`、`card-set-page-flow` |
| 订阅、豆币与支付 | 产品手册 §9.6、§11.3；§0.4 **DEC-107**（账户只有豆币） | `billing-store.js`（豆币单位 + 幂等折算迁移 + 订单/赠币分账 + 永久订阅 + 套餐变体续期 + 测试订单幂等）、`server.js`（`/api/billing/test-purchase`、`/api/billing/beans/consume`、`/api/admin/billing/users/:id/grant-beans`、`/api/admin/billing/orders/:id/refund`；测试订购仅开发环境且需登录，旧额度路径保留兼容）、`postgres-persistence.js`（billing mutations，兼容对象/字符串快照回读）、后台 `apps/admin/{index.html,app.js}`（商品分组与按用户权益操作）、小程序 `pages/store`（会员功能权益 / 题库订阅 / 豆币）、`pages/store-order`（会员 / 题库切换、项目筛选与期限变体） | `billing-store`、`billing-bean-migration`、`miniprogram-billing`、`storefront-page-flow`、`store-order-page-flow`、`admin-billing-ui`、`postgres-persistence`、`api`；干跑 `tmp/verify-bean-migration.js`、后台 UI 逐项核验 `tmp/verify-bean-admin-ui.js` |
| AI 路由、任务与计费 | 产品手册 §9.1、§5.x | `ai-config.js`、`ai-provider.js`、`ai-provider-batch.js`（供应商批量接入：清单文档解析 → 逐条连通性测试 → 只把通过的写进配置）、`ai-task-store.js`、`card-assistance.js`；供应商列表的浏览器本地分组在 `apps/admin/{app.js,index.html,styles.css}` | `ai-provider-scoring`、`ai-provider-batch`、`ai-task-store`、`ai-scene-catalog`、`card-assistance*`；后台 UI `tmp/verify-provider-batch-ui.cjs`、供应商分组 `tests/admin-provider-groups.test.js` 与 `tmp/verify-provider-groups.cjs` |
| 公告、反馈与客服 | 产品手册 §9.3。**注意**：用户协议/隐私政策等 7 份平台文本的维护入口是 [模块 08 平台设置](modules/08-platform-settings.md)，本行只覆盖公告、反馈与客服入口 | `announcement-store.js`、`feedback-messages.js`、`feedback-conversation.js`（通知与沟通投影）、`server.js`（反馈、沟通及 `/api/messages`，后台 `GET/POST /api/admin/moderation/:id/messages`）、`apps/admin/app.js#jumpToFeedbackQuestion`、小程序 `utils/message-center.js` 与 `pages/messages`（公告及当前账号反馈通知）、`pages/help-feedback`（处理进度与补充信息）、`apps/admin/{app.js,index.html,styles.css}`（反馈沟通窗口与完整记录） | `announcement-store`、`feedback-api`、`feedback-messages`、`admin-feedback-conversation`、`admin-feedback-jump`、`feedback-question-context`、`practice-feedback-submission`（输入校验、失败留痕与重试契约）、`help-feedback-page`、`profile-announcement-flow`、`message-center`；浏览器 `tmp/verify-feedback-jump.cjs`、`tmp/verify-feedback-conversation.cjs` |
| 存储与迁移 | 产品手册 §10.1–10.6；`docs/POSTGRES_MIGRATION.md`、`docs/KVAULT_STORAGE.md` | `postgres-persistence.js`、`object-storage.js`、`scripts/*migrate*` | `postgres-persistence`、`runtime-postgres-migration`、`file-storage-migration`、`object-storage` |
| 小程序信息架构与视觉 | 产品手册 §3.1、§6.1、§6.3、§6.5–6.6；§0.4 **DEC-108**（设置页立项 + 隐私与数据拆分）；`docs/UIUX_STANDARD.md` | `apps/miniprogram/app.json`、`custom-tab-bar/`、`pages/settings`（设置）、`pages/about`（关于我们）、`pages/legal`（法务占位）、`pages/practice-settings`、`pages/personal-info`、`pages/device-info`、`utils/app-meta.js`（版本号与法务目录的单一维护点）；`pages/privacy` 已下线（文件保留） | `mini-program-entry`、`custom-tab-bar-selection`、`library-navigation`、`discovery-page-flow`、`miniprogram-asset-budget`、`settings-pages` |

## 4. 跨模块依赖关系

```text
[01 后台账号/会话]
      └─ 鉴权所有 /api/admin/*  ──> [02 题目录入与答案] / [03 分类与采纳] / [04 题族]
                                      └─ 操作日志记录真实操作人（admin-operation-store）

[未迁移：教材知识树 / 知识档案]
      └─ 提供节点、范围锚点与教材证据 ──> [03 指纹与归类] ──> [04 题族定义/成员/投影]

[02 题目正式字段 + 版本]
      └─ 人工确认 ──> confirmed 题目知识指纹（[03] 归属：question-store）
                        └─ 作为成员贡献依据 ──> [04] 成员归属与联合覆盖门禁
                                                  └─ 目录投影 ──> 用户端题库/复习/专项训练

失效传播（单向、精确优先）：
  02 题目内容/正式答案/指纹实质变化 ──> 仅该题在各题族的成员归属 pending_fit（[04]）
  04 题族定义事实变化 ──────────────> 整族退回待审核并重校全部成员
  03 人工采纳 ──────────────────────> 走统一提交协议（ClassificationCommitV1）
```

统一建议词汇：`apps/api/src/suggestion-lifecycle.js` 是"建议 → 逐字段采纳 → 落正式数据"这套状态词汇的唯一定义处，题目完善与 AI 巡检两条产线共用。

## 5. 全局入口与命令

- 启动：`npm.cmd run dev` → `http://127.0.0.1:3212/admin/`，健康检查 `http://127.0.0.1:3212/health`（产品手册 §10.1）。
- 健康检查的附加字段（2026-09-25）：`/health` 除原有 `status/service/version/fileStorage` 外，还回报 `startedAt`/`startedAtLabel`/`bootDate`/`uptimeMs` 与 `apiSourceStale`（`apps/api/src` 下有没有比本进程启动更新的源码）+ `apiSourceNewest*`；后台页头据此显示「后端未重启，改动未生效」红条（判据 `apps/api/src/api-freshness.js`，测试 `tests/admin-backend-stale-banner.test.js`）。规则正文在 `AGENTS.md` §8。
- 测试：`npm test`（`node --test tests/*.test.js`）。
- 数据迁移：`npm.cmd run db:import:dry` / `db:import` / `db:verify`，见 `docs/POSTGRES_MIGRATION.md`。
- 存储迁移：`npm.cmd run storage:migrate:dry` / `storage:migrate` / `storage:verify`，见 `docs/KVAULT_STORAGE.md`。
- 分类盲测：`npm.cmd run ai:blind-replay` / `ai:blind-batch` / `ai:blind-context` / `ai:blind-samples`。
- 维护脚本：`npm.cmd run maintenance:retire-ungrouped-index`。
- 定向恢复历史题族关系：`node scripts/maintenance/restore-question-family-memberships.js --plan <明确关系清单.json> --runtime <数据目录>` 默认预演；仅获人工授权后追加 `--execute --confirm <预演哈希>`。回归入口 `tests/restore-question-family-memberships.test.js`，范围／成员审核边界见 [模块 04 §6](modules/04-question-family.md)。
- 容器构建与运行：`docker build -t shukao-api .`、`docker compose up -d --build`；环境变量、数据卷、PostgreSQL 叠加编排见 [`DOCKER.md`](DOCKER.md)；镜像自动发布策略见 [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)。

## 6. 单一维护点（一处维护、其余引用）

改文档前先看这张表：同一事实只在一个地方写正文，其他位置只写引用（详见 [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md) §5）。

| 事实 | 唯一维护点 | 其他位置怎么写 |
| --- | --- | --- |
| 已确认产品规则 | 产品手册（【已确认】章节） | 模块文档写摘要 + 来源链接 |
| DEC 编号与索引 | 产品手册 §0.4 | 只引用编号 |
| 模块实现状态 / 已知缺口 | `docs/modules/*.md` 第 6 节 | 上线清单只引用结论 |
| 上线阻断与证据 | `docs/RELEASE_CHECKLIST.md` | 模块文档只引用条目号（R*） |
| 待确认事项 | `docs/OPEN_DECISIONS.md` §1 | 模块文档只引用编号（C*） |
| 历史改动过程 | 《二、变更日志》 | 不在别处复述 |
| 路由 / 字段 / 常量 | 源码本身 | 文档只写入口路径，不写死清单 |
