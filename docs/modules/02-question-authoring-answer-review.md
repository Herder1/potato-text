# 02 题目录入、校正与答案审核

> 模块编号仅用于导航。规则引用**权威正文**（产品手册），不替代原文。
> 相关待裁决：C5（建议层统一状态机）——见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md)。

## 1. 职责与用户结果

- 职责：把教材/试卷/文本题目变成有版本、有来源、有分层答案的正式题目；对 AI 建议**逐字段**人工裁决；合并重复题；把两条产线的建议汇入裁决台。
- 用户结果：每道题能回答"来自哪里、哪个版本、哪个答案可信、AI 是否只是补充"；AI 不会悄悄覆盖或改写权威答案。

## 2. 当前有效规则及原决策编号

### 【已确认】（正文见产品手册）

| 规则 | 来源 |
| --- | --- |
| 题目是最小内容和训练单元；判断归类时必须把题干、共享材料、全部选项、结构化正确答案、来源答案、参考答案、解析、来源、教材和版本作为整体 | §4.6 |
| 题目修改必须保留版本；历史作答绑定当时版本，不得被后续编辑静默改变 | §4.6 |
| 题目内容与知识归类在存储、接口和页面中保留来源分层：题目正式字段 / `confirmed` 知识指纹 / AI `suggested` 候选，不得合并成无来源的"当前值" | §4.6.1 |
| 正式字段与 `confirmed` 指纹冲突时可暂时并存，但必须同时显示双方原值、来源、状态和题目版本，明确提示人工处理；无 `confirmed` 指纹时显示"知识指纹待确认"，不得用 AI 候选或题族字段冒充 | §4.6.1 |
| 管理端题目编辑页是人工查看/修改题目正式知识指纹的主要入口；题族页只做只读比对，不在题族确认表单内改题目指纹 | §4.6.1、§8.2 |
| 答案分层：来源答案 / 教材答案与证据 / 平台核验答案 / 经审核的社区共识答案 / 明确标记的 AI 补充答案；不得混写 | §4.7 |
| AI 答案不得覆盖、折中或修改来源答案、教材证据或平台核验答案；冲突时停止发布/判分/归类采纳，交人工裁决 | §4.7 |
| 不得把自拟或人工核验答案称为"官方答案"；平台自营统一称"平台题库" | §4.7、§6.2、DEC-004 |
| 题目完善：AI 只生成**字段级**建议稿；人工逐项采纳、不整题覆盖；已核验来源答案必须保留 | §8.3 |
| 采纳涉及题干、选项、答案或正式知识指纹的修改后**创建题目新版本**，并使该题在受影响题族中的成员归属及贡献知识进入待审核；题族定义事实未变化时不得整族退回 | §8.3、§4.10 |
| 人工审核顺序：先确认题目知识焦点与最小充分知识集 → 再确认一个主题族/零到多个关联题族/待归组 → 修改 AI 建议须填写调整依据并原文保存 → 旧建议过期须说明原因 → 只有人工采纳后结果才进入正式指纹、题族关系和 Agent 4 经验 | §5.6 |
| 重复题合并：规范题 + 源题离线保留映射；只处理事实相同的重复实体；不得合并相似/同类/变式题；不得物理删除；不得自指/循环/多级合并链；活跃关系原子迁移；源题离线、迁移、去重、题族失效、映射与日志一次提交 | §4.6.2、DEC-018 |
| 题目知识焦点必须显式标记 `core` / `scope_anchor`，旧记录缺省 `core` | §4.8、DEC-040 |
| 题目合并 `QuestionMergeCommitV1`：唯一 `commitId`、`prepared/committed`、幂等、失败整体回滚、启动恢复；PostgreSQL 事务完成前不得宣称生产可用 | §10.6 |

### 【实现事实·依据已存在，待升格登记】

- 建议层统一状态机：`recommended`（待人工处理）→ `applied` / `rejected`，采纳时记录 `appliedFields`（采纳了哪些字段）与 `appliedVersion`（采纳到哪个题目版本）；旧巡检 `pending` 读时归一为 `recommended`。
- 依据：变更日志 2026-09-18 23:30 记录《链路职责矩阵》经产品负责人逐条确认 11/11 并转为生效口径；`apps/api/src/suggestion-lifecycle.js` 头注释明确其为该套词汇的唯一定义处。**不属"无依据待裁决"，只差把它登记为正式规则**（见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.2、C5）。

## 3. 状态流转与数据归属

```text
导入/录入 ──> 题目正式字段 + version
编辑正式字段 ──> 新 version（历史作答仍绑旧版本）
答案 ──> 五个分层字段独立保存（平台核验答案须人工审核后才可发布）
AI 建议 ──> recommended ──人工──> applied（记 appliedFields + appliedVersion） / rejected
重复题 ──> 规范题 + 源题离线（mergedIntoQuestionId，保留映射，不物理删除）
```

- **建议 → 正式数据**：题目完善与 AI 巡检两条产线共用统一词汇（`suggestion-lifecycle.js`）；裁决台把两条产线合成一张队列，同题同产线只保留最新一条（变更日志 2026-09-20 21:25）。
- **数据归属**：题目正式字段、版本与 `confirmed` 指纹 → `question-store.js`；答案分层 → `question-store.js` 与导入 Store；建议层 → `question-enrichment-store.js`（完善）与巡检结果（巡检）；合并提交 → `question-merge-commit-store.js` + `question-merge-coordinator.js`；统一建议词汇 → `suggestion-lifecycle.js`。

## 4. 跨模块输入输出及失效规则

**输入**：教材知识树与知识档案（未迁移，见 [`../PROJECT_MAP.md`](../PROJECT_MAP.md)）；后台身份与操作人（模块 01）；题族定义与成员状态（模块 04）。

**输出**：题目正式字段/版本 → 模块 03（指纹生成与归类）与模块 04（成员兼容与贡献）；分层答案 → 练习/判分（未迁移）；裁决结果 → 题族成员归属与 Agent 4 经验。

**失效规则**（单一事实源见产品手册 §4.10、§8.3、§10.5）

| 触发 | 应失效/应保留 |
| --- | --- |
| 题目内容、正式答案或 `confirmed` 知识指纹**实质**变化 | 仅该题在各题族的**成员归属与贡献知识** → `pending_fit`；题族定义保持 `confirmed` |
| 来源、标签、难度、排版等不影响题族适配的字段变化 | **不触发**题族或成员归属失效 |
| 采纳涉及题干/选项/答案/正式指纹的修改 | 创建题目新版本 + 该题成员归属待审核 |
| 题目版本、来源答案、教材 PDF/OCR、知识树、知识档案或题族语义变化 | 实际依赖受影响内容的建议、核验、确认关系进入待复核；优先精确失效，无法证明未受影响才扩大范围 |
| 重复题合并 | 受影响题族退回待审核并推进成员修订号；依赖源题或受影响题族的未采纳建议过期，注明"题目已合并/题族成员已变化" |
| 历史作答 | 永远绑定原题 ID 与原版本，不因合并或编辑改写 |

## 5. 禁止事项

- 不得把 AI 建议直接当正式字段、正式答案或正式指纹；只有人工采纳才进入权威链路（§3.4、§5.6）。
- 不得整题覆盖式采纳；不得丢失已核验来源答案。
- 不得在（盲测）金标审核记录中暗改正式业务数据，也不得保留基于旧知识摘要的题族结论（§5.8.6）。
- 不得把平台核验答案标为"官方答案"。
- 不得物理删除合并源题；不得恢复/编辑/归组合并源题；不得用"恢复"冒充"撤销合并"。
- 不得手改 `.runtime` 正式题目数据；不得绕开正式 API/Store。
- 不得在题族页直接改题目指纹（§4.6.1、§8.2）。

## 6. 实现状态、验收状态和已知缺口

### 【已实现】

- 题目 Store 与版本、答案分层字段、文本导入、试卷导入、逐字段完善、重复题合并（文件模式）、裁决台队列与逐行入口、建议统一词汇。
- 选项表格「涉及知识」节点选择器：与金标审核**共用同一份实现**（交互统一到 document 级代理 + `knowledge-picker-change` 统一事件）；2026-09-20 03:47 修掉了"编辑页面板打不开、点了没反应"——此前这两段交互只绑在 `#blind-gold-review-form` 上。
- **题库管理工作台标签行（DEC-092）**：「盲测金标」由「AI 巡检」的二级子标签提升为**平级子标签**，「AI 巡检」只保留巡检建议；原来的子标签机制（状态、切换函数、点击监听、子标签行）**整块删除**，页面显隐的唯一来源是 `state.questionLibraryTab`。标签行会随并行开发增删（当前含「题目录入」），本节只锁 DEC-092 要求的成员与相对顺序。
- 代码：`question-store.js`、`question-text-import.js`、`exam-paper-import.js`、`exam-document-import.js`、`exam-import-store.js`、`question-enrichment-store.js`、`question-merge-commit-store.js`、`question-merge-coordinator.js`、`question-merge-transform.js`、`suggestion-lifecycle.js`；标签行与各面板在 `apps/admin/app.js` 的 `setQuestionLibraryTab` / `loadCurrentQuestionLibraryContent`。

### 【已验证（历史证据，本轮未复跑）】

- [`二、变更日志`](<../../题库开发手册/二、变更日志（CHANGELOG.md）.txt>) 2026-09-20 21:25 记录第 1 批收口验收：`tmp/verify-adjudication-entry.js` 与 `tmp/acceptance-batch1.js` 退出码 0，覆盖有数据题与无数据题的降级路径、裁决台真实可用、全程 JS 报错 0；同轮全量 **1135/1135** 通过。
- 同一记录明确遗留：① 强约束的"切换到唯一入口"；② 金标页人工点击走查。
- 变更日志 2026-09-20 03:47 记录**选择器统一事件 + 编辑页修复**：`tmp/probe-picker-click.js`（面板选项 **0 → 356**、真实点击后选择与载荷同步）与 `tmp/verify-gold-picker.js`（金标侧面板可开、题族贡献回写未回归）退出码均为 0；同轮改动覆盖的 **193 条**用例通过。
- 变更日志 2026-09-21 记录 **DEC-092 拆标签**的逐项可见性验收：`tmp/verify-gold-review-tab.js` 对**当前的 8 标签 DOM** 跑 14 项断言全过（每个标签驱动一次，逐面板读 `hidden` / `getComputedStyle(display)` / `getBoundingClientRect` 尺寸，确认"只有一个面板可见、其余 hidden 且 display:none"，并核了金标页内层真的渲染出来、以及去掉 `[hidden]` 兜底会泄漏的对照）；同轮全量 **1180/1180** 通过。
- 变更日志另记录题目合并专项（如 549/549）、题目完善与巡检相关专项通过；覆盖范围以对应条目为准。
- `tests/question-store.test.js`、`question-text-import.test.js`、`exam-paper-import.test.js`、`question-enrichment.test.js`、`question-merge-*.test.js`、`adjudication-queue.test.js`、`suggestion-lifecycle.test.js` 存在。
- **本次未运行测试**，不声明当前版本通过。

### 【待验收】

- 题目合并的 PostgreSQL 事务化（R6）。
- 裁决台"强约束切换到唯一入口"。
- 金标页人工点击走查（需要连续交互会话）。

### 【已知缺口】

- 审核弹窗只能从 Agent 提供的知识候选中选择，不能直接从整棵知识树纠正漏选（§5.7）。
- 选项到知识标签的诊断关系尚未成为稳定数据，不能据此精确判断错因（§5.7）。
- 巡检旧建议对"题族名称/状态等更广泛语义变化"的精确失效仍待完善（已实现的是同题人工改归精确失效）。

## 7. 代码、测试与历史决策入口

- 代码：[`question-store.js`](../../apps/api/src/question-store.js)、[`question-text-import.js`](../../apps/api/src/question-text-import.js)、[`exam-paper-import.js`](../../apps/api/src/exam-paper-import.js)、[`exam-document-import.js`](../../apps/api/src/exam-document-import.js)、[`exam-import-store.js`](../../apps/api/src/exam-import-store.js)、[`question-enrichment-store.js`](../../apps/api/src/question-enrichment-store.js)、[`question-merge-commit-store.js`](../../apps/api/src/question-merge-commit-store.js)、[`question-merge-coordinator.js`](../../apps/api/src/question-merge-coordinator.js)、[`question-merge-transform.js`](../../apps/api/src/question-merge-transform.js)、[`suggestion-lifecycle.js`](../../apps/api/src/suggestion-lifecycle.js)。
- 测试：[`tests/question-store.test.js`](../../tests/question-store.test.js)、[`question-text-import.test.js`](../../tests/question-text-import.test.js)、[`exam-paper-import.test.js`](../../tests/exam-paper-import.test.js)、[`question-enrichment.test.js`](../../tests/question-enrichment.test.js)、[`question-merge-commit.test.js`](../../tests/question-merge-commit.test.js)、[`question-merge-api.test.js`](../../tests/question-merge-api.test.js)、[`question-merge-transform.test.js`](../../tests/question-merge-transform.test.js)、[`adjudication-queue.test.js`](../../tests/adjudication-queue.test.js)、[`suggestion-lifecycle.test.js`](../../tests/suggestion-lifecycle.test.js)。
- 规则正文：产品手册 §4.6、§4.6.1、§4.6.2、§4.7、§4.8、§4.9、§5.6、§8.3、§10.5、§10.6。
- 历史：DEC-018（合并）、DEC-034/035/040（知识标注）；[`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C5。
