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
| `apps/admin/` | 网页管理后台（`index.html` / `app.js` / `styles.css`，静态资源用 `?v=` 破缓存） |
| `packages/domain/` | 领域模型与 SQL 草案（`catalog.js`、`schema.sql`、`assessment-action-semantics.js`） |
| `docs/` | 现行导航、产品摘要、上线清单、模块文档、迁移与存储说明 |
| `tests/` | 126 个 `*.test.js`（`npm test` 当前 1180 个用例）+ `fixtures/`、`helpers/` |
| `scripts/` | 运维与工具脚本，2026-09-21 按用途分为四组：`scripts/db/`（数据库/文件存储迁移，3）、`scripts/classification/`（金标冻结与盲测回放链路，9）、`scripts/maintenance/`（一次性维护任务，1）、`scripts/tools/`（本地素材工具，1）。**`tests/*.test.js` 与 `package.json` 是入口**，路径改动必须同步二者；历史账本 `题库开发手册/` 中仍保留旧平铺路径（历史记录不改写） |
| `.runtime/` | 正式运行数据（JSON）与备份；**禁止手改** |
| `题库开发手册/` | 一产品手册、二变更日志、三交流文档、四链路职责矩阵 |
| `题目录入/` | 教材 PDF、试卷、录题稿等原始资料（**本地保留，不入 git / 不进镜像**，见 `.gitignore`、`.dockerignore`） |
| `Dockerfile`、`.dockerignore`、`docker/entrypoint.sh` | 容器镜像定义、构建上下文排除清单与入口脚本（操作说明正文 `docs/DOCKER.md`） |
| `docker-compose.yml`、`docker-compose.postgres.yml` | 源码构建用的单容器默认编排 / 叠加 PostgreSQL 的可选编排 |
| `docker-compose.1panel.yml`、`docker-compose.1panel-postgres.yml` | **1Panel 面板粘贴即用**编排（只拉 GHCR 现成镜像、无 `build:`、无 `.env` 依赖、命名卷持久化）；操作正文见 `docs/DOCKER.md` §9 |
| `.github/workflows/docker-publish.yml` | 推送 `main` 或 `v*` tag 时自动构建并发布镜像到 GHCR（触发与标签策略正文在该文件内） |

## 2. 已拆分模块（第一批）

| 模块 | 职责（一句话） | 代码位置 | 现行规则正文 | 模块文档 | 主要测试入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 身份、登录与后台权限 | 微信用户登录/会话；后台账号、角色、会话与操作人记录；用户侧四类限制（禁言/禁止投稿/公开限制/封禁） | `apps/api/src/user-auth-store.js`、`admin-account-store.js`、`admin-operation-store.js`、`user-restriction-store.js`、`server.js`（`/api/auth/*`、`/api/admin/*` 闸门与三档权限清单） | 产品手册 §9.2、§8.4、§11.2；后台角色模型与限制语义**待裁决** | [01-identity-auth](modules/01-identity-auth.md) | `tests/admin-auth.test.js`、`miniprogram-auth.test.js`、`auth-learning-api.test.js`、`user-restrictions.test.js` | 已实现，待口径确认 |
| 2 题目录入、校正与答案审核 | 题目导入/录入、版本、答案分层、逐字段完善、合并、裁决台 | `apps/api/src/question-store.js`、`question-text-import.js`、`exam-paper-import.js`、`exam-document-import.js`、`question-enrichment-store.js`、`question-merge-*`、`suggestion-lifecycle.js` | 产品手册 §4.6、§4.7、§8.3、§5.6；DEC-018 | [02-question-authoring](modules/02-question-authoring-answer-review.md) | `question-store`、`question-text-import`、`exam-paper-import`、`question-enrichment`、`question-merge-*`、`adjudication-queue`、`suggestion-lifecycle` | 已实现/部分实现 |
| 3 知识指纹、Agent 归类与人工采纳 | 题目正式知识指纹、Agent 1–3 候选、人工采纳提交、金标冻结与盲测 | `question-classification-features.js`、`knowledge-classification-pipeline.js`、`classification-verification-policy.js`、`classification-commit-store.js`、`classification-commit-coordinator.js`、`knowledge-classification-experience-store.js`、`classification-gold-review-store.js` | 产品手册 §4.6.1、§4.8、§4.9、§5.x、§10.4、§10.5；DEC-025/026/031–036/039/040 | [03-knowledge-fingerprint](modules/03-knowledge-fingerprint-agent-classification.md) | `rich-knowledge-fingerprint`、`option-knowledge-protocol`、`classification-commit`、`classification-verification-policy`、`classification-blind-*`、`classification-gold-*`、`knowledge-classification-api` | 首版已实现，PostgreSQL 待实现 |
| 4 题族、成员审核与用户目录投影 | 题族六组定义事实、成员贡献与审核、题族集、目录投影、归组统计 | `apps/api/src/question-family-store.js`、`question-family-relations.js`、`question-family-catalog-projection.js` | 产品手册 §4.10–4.12、§6.2、§7.3；DEC-015–024、037–039 | [04-question-family](modules/04-question-family.md) | `question-family`、`question-family-relations`、`question-family-catalog-projection`、`admin-question-family-*`、`retire-question-family-unresolved-index` | 首版已实现，待真实数据验收 |

> 模块编号仅用于本批次导航，**不是产品编号，也不对应 DEC 编号**。

## 3. 未迁移模块清单（先在旧手册中查）

以下模块本轮不拆正文，入口统一指向旧手册对应章节；迁移顺序与负责人待定（见 [`OPEN_DECISIONS.md`](OPEN_DECISIONS.md) 第 3 节）。

| 模块 | 旧文档位置（现行仍有效） | 代码位置 | 主要测试入口 |
| --- | --- | --- | --- |
| 教材、目录与知识树 | 产品手册 §2.2、§4.2–4.4、§8.2 | `textbook-catalog-store.js`、`textbook-knowledge-store.js`、`knowledge-structure-store.js`、`catalog.js` | `textbook-catalog`、`textbook-knowledge`、`knowledge-structure`、`catalog-outline` |
| 知识档案（概念、边界、关系、证据） | 产品手册 §4.5、§4.12.1；DEC-007–014、019 | `knowledge-dossier-store.js`、`question-textbook-context.js` | `knowledge-dossier-store`、`knowledge-dossier-api`、`question-textbook-context`、`admin-knowledge-inspection` |
| 试卷与模拟考试 | 产品手册 §2.1、§6.2、§6.7 | `exam-store.js`、`exam-import-store.js`、`exam-paper-import.js`、`exam-export.js`、`render-exam-pdf.py` | `exam-pack-store`、`exam-rule-builder`、`exam-export`、`exam-paper-import`、`exams-page-flow` |
| 题包与用户题库 | 产品手册 §6.2、DEC-041–046、070–075 | `pack-store.js`、小程序 `pages/packs|pack-detail|pack-collection` | `pack-collection-page`、`private-pack-page-flow`、`private-pack-store` |
| 练习、作答与判分 | 产品手册 §6.7、§7.1、§7.4 | `practice-session`、`question-assessment.js`、`learning-state-store.js` | `practice-session`、`practice-page-flow`、`question-assessment`、`learning-state`、`learning-analysis` |
| 复习与知识卡 | 产品手册 §6.4、DEC-012、027–030、047–069、076–089（变更日志） | 小程序 `pages/card-*|knowledge-card|review|analysis|wrong-book`、`card-box-store` | `card-box-store`、`card-set-page-flow`、`knowledge-card-rich-flow`、`review-page-flow`、`review-tool-pages` |
| 社区、投稿与治理 | 产品手册 §9.4；需求基线"笔记与社区"；DEC-042、057 | `community-asset-store.js`、`community-interaction-store.js`、`moderation-store.js`、`user-restriction-store.js`、小程序 `pages/favorites` | `community-asset-store`、`community-profile-page`、`community-interactions`、`user-restrictions`、`favorites-page` |
| 订阅、额度与支付 | 产品手册 §9.6、§11.3；DEC-006 | `billing-store.js`、`ai-score-cache-store.js` | `billing-store`、`miniprogram-billing`、`storefront-page-flow` |
| AI 路由、任务与额度 | 产品手册 §9.1、§5.x | `ai-config.js`、`ai-provider.js`、`ai-task-store.js`、`card-assistance.js` | `ai-provider-scoring`、`ai-task-store`、`ai-scene-catalog`、`card-assistance*` |
| 公告、反馈与客服 | 产品手册 §9.3 | `announcement-store.js`、`feedback-api`（在 `server.js`） | `announcement-store`、`feedback-api`、`help-feedback-page`、`profile-announcement-flow` |
| 存储与迁移 | 产品手册 §10.1–10.6；`docs/POSTGRES_MIGRATION.md`、`docs/KVAULT_STORAGE.md` | `postgres-persistence.js`、`object-storage.js`、`scripts/*migrate*` | `postgres-persistence`、`runtime-postgres-migration`、`file-storage-migration`、`object-storage` |
| 小程序信息架构与视觉 | 产品手册 §3.1、§6.1、§6.3、§6.5–6.6；`docs/UIUX_STANDARD.md` | `apps/miniprogram/app.json`、`custom-tab-bar/` | `mini-program-entry`、`custom-tab-bar-selection`、`library-navigation`、`discovery-page-flow`、`miniprogram-asset-budget` |

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
- 测试：`npm test`（`node --test tests/*.test.js`）。
- 数据迁移：`npm.cmd run db:import:dry` / `db:import` / `db:verify`，见 `docs/POSTGRES_MIGRATION.md`。
- 存储迁移：`npm.cmd run storage:migrate:dry` / `storage:migrate` / `storage:verify`，见 `docs/KVAULT_STORAGE.md`。
- 分类盲测：`npm.cmd run ai:blind-replay` / `ai:blind-batch` / `ai:blind-context` / `ai:blind-samples`。
- 维护脚本：`npm.cmd run maintenance:retire-ungrouped-index`。
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
