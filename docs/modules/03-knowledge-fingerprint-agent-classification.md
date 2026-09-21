# 03 知识指纹、Agent 归类与人工采纳

> 模块编号仅用于导航。规则引用**权威正文**（产品手册），不替代原文。
> 相关：C3 / C5（历史依据已存在，待升格登记，非重新裁决）——见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.2。

## 1. 职责与用户结果

- 职责：维护题目正式知识指纹（焦点、角色、最小充分知识集）；运行 Agent 1–3 产出候选；人工裁决并**原子采纳**；冻结金标快照并做隔离盲测回放。
- 用户结果：用户看到的归类与知识范围有版本、有来源、有教材证据、可审计；AI 永远只是候选，不能自己变成正式事实。

## 2. 当前有效规则及原决策编号

### 【已确认】（正文见产品手册）

| 规则 | 来源 |
| --- | --- |
| 题目正式知识指纹只保存一个焦点，但必须显式标记 `core` / `scope_anchor`；旧记录缺省 `core`，不得自动猜测 | §4.8、DEC-040 |
| `scope_anchor` 只组织跨知识范围，不自动进入最小充分知识集、不参与联合覆盖、不要求主题成员贡献承载 | §4.8 |
| 作答的最小充分知识集 = 可靠推出或判定答案时实际调用的最小节点集合；必须逐项做删除检验；不得因名词出现覆盖式全收 | §4.9 |
| Agent 1 只产结构化特征，不改正式数据；每个选项先给 `question_only` / `option_specific` / `undetermined` 候选，只有 `option_specific` 才输出选项知识 | §5.1、DEC-034/035 |
| Agent 2 分层归类，每层最多 5 个直接子节点，必须保留"已足够/涉及多个/无法确定/候选均不合适/上一层可能选错"出口；非法输出最多一次定向纠正 | §5.2、DEC-031 |
| Agent 3 回教材原文独立核验，可重新检索整棵树、不受 Agent 2 前五候选限制；只看真实题目与全部选项，只提建议，不自动合并/建族/落库；合同冲突最多一次纠正，第二次非法则题族降为 `unresolved` | §5.3、DEC-031 |
| Agent 4 先沉淀审核事件；同类问题累计 ≥3 个独立案例才允许生成规则草稿或档案修订建议；单个案例不得泛化为规则 | §5.4 |
| 只有人工采纳后，结果才进入正式知识指纹、题族关系和 Agent 4 经验 | §5.6 |
| 盲测采用留一法遮蔽被测题的人工归类、自身案例、题族成员身份及由本题直接产生的规则，并在隔离内存环境运行，不得写入正式巡检与经验数据 | §5.8、DEC-025 |
| 自动补桥只能形成 `riskHints`/候选/审核说明，不得改写最小充分知识集；"作答必需"关联题族必须通过删除检验 | §5.8.1、DEC-026 |
| 盲测三种模式分开报告：成熟题族留一、单题题族整族隐藏、无匹配建族；有争议的人工金标准不得计入准确率 | §5.8.2、§5.8.3 |
| 归类链路调整后必须连续取得 5 次可计分隔离盲测通过方可验收；任何代码/提示词/模型/路由/金标准/教材/知识结构/题族变化都清零重来 | §5.8.4、DEC-031 |
| 金标在运行前独立冻结并记录教材证据与审核状态；冻结后只能读取快照并校验，不得从当前正式题库临时拼装，也不得冻结后自动启动盲测 | §5.8.6、DEC-032 |
| 盲测金标采用阶段式长页与防锚定协议：首次判断提交前服务端不得返回 AI 候选；冻结采用 `prepare/commit` 两步并保证预览哈希与最终文件一致 | §5.8.7、DEC-033 |
| 统一落库协议 `ClassificationCommitV1`：唯一 `commitId` + `schemaVersion`、`prepared/committed/failed`、同 ID 重试幂等、全部业务写入成功后才把巡检标记为已采纳；文件模式样板已实现，PostgreSQL 待实现 | §10.4、DEC-005 |
| 采纳前逐题复核：同题知识归属或题族成员关系在巡检后发生人工变化时，旧建议过期且不得覆盖人工结果；缺逐题基线的历史记录必须重新巡检 | §10.4 |
| 过期优先按引用片段、事实声明、档案版本、题族定义版本、成员归属版本精确传播；无法证明未受影响时再扩大复核；过期记录保留历史并说明原因 | §10.5、DEC-009 |
| 所有归类场景统一 `verified_source_or_platform`；历史 `verified_official` 与"官方答案"肯定式说明必须迁移 | §5.8 |

### 【已确认规则（2026-09-21 登记）】

- 建议层统一词汇 `recommended → applied / rejected` + `appliedFields` / `appliedVersion`（与模块 02 共用）＝ **DEC-090**；规则正文见产品手册 §0.4。
- 裁决台"形态 B"边界（本页不出现采纳/驳回动作）＝ **DEC-091**；设计与实施条件见《四、链路职责矩阵》第十三节。
- 《四、链路职责矩阵》已于 2026-09-21 去掉"（待确认草案）"并登记归档（历史依据：变更日志 2026-09-18 23:30 记录产品负责人逐条勾选确认 11/11 并转为生效口径）；`apps/api/src/suggestion-lifecycle.js` 已按其实施。

## 3. 状态流转与数据归属

```text
Agent 1 特征 → Agent 2 分层候选 → Agent 3 教材/题族核验 → 建议（suggested / pending）
                                                            │ 人工裁决
                                                   confirmed 题目知识指纹（绑定题目版本）
                                                            │
                                              题族成员贡献与联合覆盖门禁（模块 04）

采纳提交：prepared ──6 类写入全部成功──> committed
              └──任一步失败──> failed（整体回滚；启动时优先恢复/回滚遗留 prepared）
金标批次：reviewing ──prepare（预览哈希）──> commit（不可变冻结快照 + SHA-256 sidecar）──> frozen
                                                                  │
                                                     盲测只读快照，不得回写正式 .runtime
```

- **数据归属**：题目正式指纹与版本 → `question-store.js`；Agent 1 特征 → `question-classification-features.js`；Agent 2/3 管线 → `knowledge-classification-pipeline.js`；答案/题族建议核验策略 → `classification-verification-policy.js`；采纳提交与协调 → `classification-commit-store.js`、`classification-commit-coordinator.js`；巡检经验/Agent 4 沉淀 → `knowledge-classification-experience-store.js`；金标批次与冻结 → `classification-gold-review-store.js`；建议词汇 → `suggestion-lifecycle.js`。
- **越界保护**：`apps/admin/knowledge-inspection-apply-guard.js` 在保存期间冻结审核弹窗，拦截改选、关闭、取消、`Esc` 与切题，并以请求与弹窗双重身份校验异步响应。

## 4. 跨模块输入输出及失效规则

**输入**：题目正式字段与版本（模块 02）；知识树节点、教材正文与知识档案（未迁移）；题族定义、成员关系与贡献（模块 04）；后台身份与操作人（模块 01）。

**输出**：`confirmed` 题目知识指纹 → 模块 04 的成员贡献与联合覆盖门禁、模块 02 的目录/训练/统计；采纳结果 → 题目版本与成员归属修订号；盲测报告 → 验收门禁（R13）。

**失效规则**

| 触发 | 应失效 |
| --- | --- |
| 同题知识归属或题族成员在巡检后被人工修改 | 旧建议过期，不得覆盖人工结果；缺逐题基线的历史记录必须重新巡检 |
| 别题自动成族或重算 | **不得**使本题建议误过期 |
| 冻结 `prepare → commit` 之间任一（首次判断、终裁、题目版本、正式答案、正式知识、题族审核依据、审核人、金标集版本、批次修订）变化 | 旧令牌与预览哈希立即失效，必须重新 prepare |
| 代码、提示词、模型、供应商路由、金标准、教材、知识结构、题族数据任一变化 | 连续 5 次门禁清零，重新校准 |
| 题目版本、教材 PDF/OCR、知识树、档案版本、题族语义变化 | 依赖它的建议/核验/确认关系进入待复核（优先精确，无法证明再扩大） |

## 5. 禁止事项

- 不得自动采纳 AI 建议；不得用隐藏金标准冒充人工审核；盲测脚本不得自动采纳结果（§5.8）。
- 不得把程序补桥结果伪装成 Agent 原始结论；程序只能给风险提示（§5.8.1）。
- 不得从当前正式题库临时拼装金标；冻结后不得自动启动盲测（DEC-032）。
- 回放的巡检结果、AI 任务、操作日志与经验不得写入正式 `.runtime`（§5.8）。
- PostgreSQL 模式尚无跨 Store 原子事务，**不得**在该模式下执行采纳接口并宣称生产落库完成（§10.4）。
- 不得把 AI 补充答案或未核验答案当作已核验答案参与盲测评分（§5.8）。
- 不得手改 `.runtime`、冻结快照或盲测金标文件。
- 不得让 `suggested` 候选替代人工裁决，或据此确认题族关系、成员贡献、改写任何正式事实（§4.11）。

## 6. 实现状态、验收状态和已知缺口

### 【已实现】

- Agent 1 特征提取、Agent 2 分层归类与一次合同纠正、Agent 3 独立核验与合同约束。
- 逐选项知识三态与 `option-knowledge-v2` 协议；候选新题族草稿链路；`family_knowledge_v3` 首版链路。
- `ClassificationCommitV1` 文件模式：持久提交日志、幂等重试、失败状态、启动恢复；管理端整弹窗冻结。
- 金标审核（阶段式长页、防锚定、`prepare/commit` 冻结、不可变快照 + SHA-256 sidecar）。
- **DEC-092：盲测金标审核页已从「AI 巡检」二级子标签提升为题库管理的平级子标签**（标签名「盲测金标」）。本次**只搬容器**：金标页 DOM 原样移入独立面板 `#blind-gold-review-panel`，内部结构、阶段式长页、防锚定与冻结逻辑**一律未动**。实现状态与可见性验收见 [`modules/02-question-authoring-answer-review.md`](02-question-authoring-answer-review.md) §6（不在此重复）。
- 金标审核与编辑页共用的节点选择器已改为**统一事件**（`knowledge-picker-change`，组件不再写任何页面状态），交互在 document 级代理、页面各自监听回写；实现状态与验收证据见 [`modules/02-question-authoring-answer-review.md`](02-question-authoring-answer-review.md) §6（不在此重复）。
- 盲测脚本：`run-classification-blind-replay.js`、`run-classification-blind-batch.js`、`prepare-classification-blind-replay-context.js`、`select-classification-blind-samples.js`。

### 【已验证（历史证据，本轮未复跑）】

- 相关用例文件：`tests/classification-commit.test.js`、`classification-verification-policy.test.js`、`classification-blind-replay.test.js`、`classification-blind-replay-context.test.js`、`classification-blind-batch.test.js`、`classification-blind-sample-selector.test.js`、`classification-gold-review-store.test.js`、`classification-gold-gate-contract.test.js`、`classification-gold-review-api.test.js`、`classification-gold-review-import.test.js`、`classification-gold-family-contribution-regression.test.js`、`rich-knowledge-fingerprint.test.js`、`option-knowledge-protocol.test.js`、`knowledge-fingerprint-range.test.js`、`knowledge-classification-api.test.js`、`knowledge-classification-store.test.js`、`knowledge-classification-pipeline.test.js`、`knowledge-classification-experience-store.test.js`、`suggestion-lifecycle.test.js`、`adjudication-queue.test.js`。
- [`二、变更日志`](<../../题库开发手册/二、变更日志（CHANGELOG.md）.txt>) 2026-09-20 23:22 记录全量 **1155/1155 通过**；更早条目记录分类相关 102/102、1045/1046、1091/1091 等分段通过。
- 产品手册 §5.8.10/§5.8.11：V1 金标已冻结，但**计分资格因题族语义门禁缺口被暂停**；§5.8.13 记录 V3 冻结基线；**§5.8.14 记录 V4 冻结基线与不计数校准**（2026-09-18 冻结，`countsTowardGate=false`，20/20 可评估，主题族命中 10/20、严格全命中 6→9（45%），仍**不构成计分通过**）。
- **本次未运行任何盲测或测试**，不声明当前通过。

### 【待验收】

- 连续 5 次可计分隔离盲测门禁（R13）。
- PostgreSQL 原子事务与 Agent 4 经验 Store 纳入统一持久化（R5）。
- 金标页人工点击走查（变更日志 2026-09-20 21:25 明确遗留）。
- `family_knowledge_v3` 的真实《现代汉语》迁移预演与人工验收（§11.1-10）。

### 【已知缺口】

- Agent 3 独立结果、Agent 4 三例聚合、档案修订建议尚未全部稳定落库（§5.7）。
- 题族名称/状态等更广泛语义变化的精确失效待完善（§5.7、§10.5）。
- 审核弹窗只能从 Agent 候选里选，不能整树纠错；选项到知识标签的诊断关系未稳定（§5.7）。
- `ClassificationCommitV1` 最终字段、事务方案与历史数据迁移计划未冻结（§13-6）。

## 7. 代码、测试与历史决策入口

- 代码：[`question-classification-features.js`](../../apps/api/src/question-classification-features.js)、[`knowledge-classification-pipeline.js`](../../apps/api/src/knowledge-classification-pipeline.js)、[`knowledge-classification-store.js`](../../apps/api/src/knowledge-classification-store.js)、[`knowledge-classification-experience-store.js`](../../apps/api/src/knowledge-classification-experience-store.js)、[`classification-verification-policy.js`](../../apps/api/src/classification-verification-policy.js)、[`classification-commit-store.js`](../../apps/api/src/classification-commit-store.js)、[`classification-commit-coordinator.js`](../../apps/api/src/classification-commit-coordinator.js)、[`classification-gold-review-store.js`](../../apps/api/src/classification-gold-review-store.js)、[`suggestion-lifecycle.js`](../../apps/api/src/suggestion-lifecycle.js)、[`apps/admin/knowledge-inspection-apply-guard.js`](../../apps/admin/knowledge-inspection-apply-guard.js)。
- 测试：见第 6 节清单，均在 [`tests/`](../../tests)。
- 脚本：[`scripts/classification/run-classification-blind-replay.js`](../../scripts/classification/run-classification-blind-replay.js)、[`run-classification-blind-batch.js`](../../scripts/classification/run-classification-blind-batch.js)、[`prepare-classification-blind-replay-context.js`](../../scripts/classification/prepare-classification-blind-replay-context.js)、[`select-classification-blind-samples.js`](../../scripts/classification/select-classification-blind-samples.js)。
- 规则正文：产品手册 §4.6.1、§4.8、§4.9、§5.1–5.8、§10.4、§10.5。
- 历史决策：DEC-005、025、026、031–036、039、040（索引见产品手册 §0.4；076+ 缺口见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C2）。
