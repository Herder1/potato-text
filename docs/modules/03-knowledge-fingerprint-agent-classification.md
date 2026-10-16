# 03 知识指纹、Agent 归类与人工采纳

> 模块编号仅用于导航。规则引用**权威正文**（产品手册），不替代原文。
> 相关：C3 / C5（历史依据已存在，待升格登记，非重新裁决）——见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) §1.2。

## 1. 职责与用户结果

- 职责：维护题目正式知识指纹（焦点、角色、最小充分知识集）；运行 Agent 1–3 产出候选；人工裁决并**原子采纳**；冻结金标快照并做隔离盲测回放。
- **操作入口【已确认 2026-09-26，DEC-100】**：归类产线（Agent 1–4＋原子采纳）仍是本模块的能力，但**界面入口归「完善题目」**；「AI 巡检」标签只做**只读体检**（诊断题库错题、给证据清单），不做任何写库动作。职责边界正文见产品手册 §4.6.12（此处不复制）。
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

### 分科目、分题型考法试行（2026-10-16，DEC-112）

- **已确认**：唯一规则正文为产品手册 §4.6.14；不替代既有归族合同或盲测门禁。
- **已实现**：`assessment-mode-seeds.js` 提供古代文学 30 个试行条目的初始定义；`assessment-mode-standards.js` 读取默认条目与管理员修订，编辑器和独立 AI 建议同源。标准与题目标注复用 `knowledge-classification-experience` 的文件/数据库持久化文档，分别放在 `assessmentModes` / `questionAssessmentModes`，不把考法混入普通纠错规则。标准版本与标注修订均带人工操作人及历史，题目/标准变化派生待复核；读默认条目不落盘，不迁移已有题目。
- **接口与界面**：`assessment-mode-routes.js` 提供标准列表/创建/编辑/引用题目，以及题目考法读取/人工确认/独立 AI 建议；后台入口为「教研规则 → 考法标准」及题目编辑「知识与教材 → 考法」。前端 `assessment-modes.js` / `.css` 按科目、题型过滤，搜索、多选、标准定义/正反例展开，AI 候选需显式填入并确认；旧动作只读。AI 使用已有 `question_enrichment` 路由但独立提示词，不接入自动归族。
- **已验证（2026-10-16）**：新增专项 `assessment-mode-standards` / `assessment-mode-api` / `admin-assessment-modes` **16/16**，覆盖 14/8/8 候选、范围与 ID 校验、并发版本冲突、只读过期派生、历史保留、文件重启、数据库包装层回写、鉴权、模拟供应商同源提示词与非法标签拒收。浏览器隔离内存后台 `tmp/verify-assessment-modes-ui.cjs` **21 项 PASS**：读取 hidden/display/offsetParent 和实际尺寸，实点多选确认、改标准/查看引用/跳回重新确认、新建/停用/移除、模拟 AI 填入不保存、读失败禁止误清空与重试；1440px / 390px 截图逐张复核，新增区域无横向溢出、页面错误为 0。证据 `tmp/verify-out/assessment-modes/`。全量证据见变更日志本日条目。
- **同行布局复验（2026-10-16，同日后续）**：定义入口移到名称后，正文按需在下方展开，修正通用表单 `min-height` 对复选框的撑高；点击说明不改变勾选，重绘保留展开态、焦点与列表滚动位置。沿用上述脚本，`--before-layout` 留存改前位置与显隐；改后 **23 项 PASS**，新增 1440px / 390px 文字位置、16px 复选框、展开/收起、键盘 Enter/Space、多选重绘、无横向溢出的真实核验，截图逐张复核。三个考法专项现为 **17/17**，加既有显隐专项合计 **19/19**；全量记录见变更日志「考法定义入口同行化」。本次仅改静态前端，不新增综合类、不重标题目，刷新即可加载这次布局。
- **按钮右移复验（2026-10-16，同日后续）**：选择框与三个操作按钮改为同一行、按钮靠右；700px 以下换行靠右，不变更保存/建议规则。三个考法专项 **18/18**，连同显隐专项 **20/20**；上述浏览器脚本 **29 项 PASS**，新增 1440px / 390px 展开及收起时的按钮位置、尺寸、显隐与无横向溢出检查，以及作品赏析题空候选状态。按钮改前证据 `tmp/verify-out/assessment-modes-actions-before/`，改后沿用 `tmp/verify-out/assessment-modes/`。窄屏几何检查在 390×844，展开长面板的补充截图用 390×1200，避免既有吸顶参考区遮住截图内容。全量证据见同日变更日志。
- **作品赏析范围缺口已处理（2026-10-16，同日后续，DEC-113）**：负责人确认取消独立题型后，按产品手册 §4.6.15 合并为材料分析题。旧题及旧考法适用范围只读归一，古代文学旧赏析题可见材料题 8 项；不自动标注、不改题目版本，其他科目不套古代文学标准。普通教研规则检索兼容旧题型值，不重写规则历史。题型合并的实现、测试、正式数据及真机验收边界统一见 [模块 02 §6](02-question-authoring-answer-review.md)。原截图两题 ID 与 `g49` 的只读核查见同日变更日志「考法按钮右移与作品赏析空选项核查」。
- **考法建议等待态与空响应诊断（2026-10-16）**：点击 AI 建议后按钮显示“生成中…”、禁用并标记忙碌，成功或失败后恢复；空响应按上游 `finish_reason`、仅思考内容与 token 用量区分原因，返回可操作提示，不自动重试、不把失败结果写入标注。隔离 API 与模拟上游专项 15/15，全量 `npm test` 1915/1915；隔离 Chrome 实点 36 项 PASS（含等待/失败按钮的计算样式、尺寸与不写库），证据 `tmp/verify-out/material-type-after/assessment-mode-generating.png`。正式路由只读核查为 `question_enrichment` 绑定 `deepseek-v4.1-flash`、输出上限 3072、超时 30 秒；历史任务存在空响应与超时。未真实调用付费模型，模型是否恢复待负责人核验。
- **待验收/风险**：未调用真实付费供应商、未进行正式题库批量标注、未跑金标/盲测或 95% 教研一致性测评；真实 PostgreSQL 重启与多进程并发未验（当前数据库包装层仍沿用整份文档持久化），不能宣称数据库跨 Store 事务已解决。正式 3212 后台须负责人重启后体验。当前工具目录未提供 `delivery_check`，不宣称该门禁 PASS。首版仅覆盖古代文学选择/简答/材料小问，其他科目/题型无标准时留空；C06/C07、Q3/Q7 等边界仍为试行。

### 旧知识主题范围锚点退出日常编辑（2026-10-09）

- **已确认／已实现**：规则正文见产品手册 §4.12。旧知识节点字段及别名保留于存储、旧接口、检索、选项只读分组、AI 候选与冻结金标；新页面不再让审核员手填，日常保存省略该字段并沿用旧值。只有显式提交旧字段才沿用原校验；作答核心、必需知识与问题范围仍独立校验，不迁移或回写正式数据。测试与待验收边界见模块 02 §6。

### DEC-104 补缺入口（2026-09-27）

- **已实现**：`question-completion.js` 通过来源目录及显式映射提出缺失指纹；未映射、多重映射、已有无效指纹只提示，不强行覆盖。确认令牌复核题目、目录及映射、知识证据和题族事实；原有指纹保持不变，不走整树重算。
- **已验证／待验收**：预览无写入、旧值保护、过期请求、回滚、旧客户端阻断已覆盖；完整本轮证据、部署状态及 PostgreSQL 限制统一见 [模块 02 §6](02-question-authoring-answer-review.md)。本次不替代 Agent 归类、金标或盲测验收。

### 【已实现】

- Agent 1 特征提取、Agent 2 分层归类与一次合同纠正、Agent 3 独立核验与合同约束。
- 逐选项知识三态与 `option-knowledge-v2` 协议；候选新题族草稿链路；`family_knowledge_v3` 首版链路。
- `ClassificationCommitV1` 文件模式：持久提交日志、幂等重试、失败状态、启动恢复；管理端整弹窗冻结。
- 金标审核（阶段式长页、防锚定、`prepare/commit` 冻结、不可变快照 + SHA-256 sidecar）。
- **DEC-092：盲测金标审核页已从「AI 巡检」二级子标签提升为题库管理的平级子标签**（标签名「盲测金标」）。本次**只搬容器**：金标页 DOM 原样移入独立面板 `#blind-gold-review-panel`，内部结构、阶段式长页、防锚定与冻结逻辑**一律未动**。实现状态与可见性验收见 [`modules/02-question-authoring-answer-review.md`](02-question-authoring-answer-review.md) §6（不在此重复）。
- 金标审核与编辑页共用的节点选择器已改为**统一事件**（`knowledge-picker-change`，组件不再写任何页面状态），交互在 document 级代理、页面各自监听回写；实现状态与验收证据见 [`modules/02-question-authoring-answer-review.md`](02-question-authoring-answer-review.md) §6（不在此重复）。
- 盲测脚本：`run-classification-blind-replay.js`、`run-classification-blind-batch.js`、`prepare-classification-blind-replay-context.js`、`select-classification-blind-samples.js`。
- **缺教材上下文的归类任务必须明确跳过（2026-09-21，DEC-093 配套）**：`textbookUnknown`（= 缺教材上下文且未解析出教材）时，教材上下文返回 `book: null` / `missingCondition: "missing_textbook_context"` / `nodes: []` / `chapterNode: null`，**不伪造教材**；知识归类任务接口对这类题返回 `knowledge_classification_book_required` 并把它记进 `skipped[].missing_textbook_context`（`classificationOutcomes` 增加同名取值），**不计为可重试失败、不无限重试**；后台归类任务因此只处理有教材的题，待归类题等待人工补归属后再进任务。

- **AI 巡检列表新增「题族状态」筛选（2026-09-25，产品负责人要求「筛出还没有题族的题」）**：工具栏多一个下拉，取值 `全部题族状态 / 未成族（没有题族） / 已进题族`；后端 `/api/admin/knowledge-classification/results` 新增 `family` 参数，判据来自该接口**已经实时算好**的 `currentMembershipMap`（`questionFamilyStore.memberships`），**不落库、不新增取数、不读巡检结果里的历史快照**；未知取值按 `all` 处理。口径：**「未成族」＝当前没有任何题族把它算作成员**——待审核题族也算"已进题族"，因此它严格等于产品手册的「无题族关系」，**不是**更宽的「待归组」（有题族关系但未形成有效、已确认目录投影）；两种口径的取此舍彼已登记为**待产品负责人确认项**（见下文【待验收】）。
- **金标审核、Agent 4 经验、题目合并提交记录已接入 PostgreSQL 持久化（2026-09-22，产品负责人选「组合 1：接可写线」）**：`postgres-persistence.js` 的 `STORE_SPECS` 新增三条 —— `classification-gold-reviews`、`knowledge-classification-experience`、`question-merge-commits`（共 27 条）。此前这三类在 postgres 模式下退回内存实现，**重启即丢**，且服务器上采纳产生的经验无法回流本地（无「库 → 文件」导出能力）。接线后服务器上的人工采纳会正常沉淀案例/纠错/规则，并随启动装载恢复。**本次只解决「单类不丢」**：跨 Store 原子提交（同一事务／事务发件箱）仍未实现（见下文【待验收】）。
- **口径（产品负责人 2026-09-22 确认：「以服务器为准」）**：这三类的权威源是**服务器**。本地历史只做**一次性**引导导入（`--runtime-root` 指向只含这两个文件的目录），此后本地**不再发布** `classification-gold-reviews.json` / `knowledge-classification-experience.json` —— 因为落库是**整份覆盖写**，再导一次会用本地旧快照冲掉服务器积累的批次/案例/纠错/规则。操作正文见 [`docs/POSTGRES_MIGRATION.md`](../../docs/POSTGRES_MIGRATION.md) 的「Runtime documents that must not be re-imported」（一处维护，此处不复制）。

### 【已验证（历史证据，本轮未复跑）】

- 相关用例文件：`tests/classification-commit.test.js`、`classification-verification-policy.test.js`、`classification-blind-replay.test.js`、`classification-blind-replay-context.test.js`、`classification-blind-batch.test.js`、`classification-blind-sample-selector.test.js`、`classification-gold-review-store.test.js`、`classification-gold-gate-contract.test.js`、`classification-gold-review-api.test.js`、`classification-gold-review-import.test.js`、`classification-gold-family-contribution-regression.test.js`、`rich-knowledge-fingerprint.test.js`、`option-knowledge-protocol.test.js`、`knowledge-fingerprint-range.test.js`、`knowledge-classification-api.test.js`、`knowledge-classification-store.test.js`、`knowledge-classification-pipeline.test.js`、`knowledge-classification-experience-store.test.js`、`suggestion-lifecycle.test.js`、`adjudication-queue.test.js`。
- [`二、变更日志`](<../../题库开发手册/二、变更日志（CHANGELOG.md）.txt>) 2026-09-20 23:22 记录全量 **1155/1155 通过**；更早条目记录分类相关 102/102、1045/1046、1091/1091 等分段通过。
- 产品手册 §5.8.10/§5.8.11：V1 金标已冻结，但**计分资格因题族语义门禁缺口被暂停**；§5.8.13 记录 V3 冻结基线；**§5.8.14 记录 V4 冻结基线与不计数校准**（2026-09-18 冻结，`countsTowardGate=false`，20/20 可评估，主题族命中 10/20、严格全命中 6→9（45%），仍**不构成计分通过**）。
- **本轮（2026-09-25）已复跑全量**：`NODE_ENV=test node --test` → **1414/1414 通过、0 失败**（新增 `tests/knowledge-inspection-family-filter.test.js`：接口级筛选行为 + 前端静态契约）；逐项可见性与真实交互核对 `tmp/verify-inspection-family-filter.js` → **9/9 通过**，截图 `tmp/verify-out/inspection-family-none.png`。
- **本次未运行任何盲测**，盲测门禁结论不因本轮改动变化。
- **DEC-100 产线拆开改造（2026-09-26）**：口径正文见产品手册 §4.6.12（此处只写实现状态，不复制规则）；施工中状态按「已确认／已实现／已验证／进行中」分开写：
  - 【已确认】巡检只诊断、改库归完善题目；10 项体检项；巡检记录四态；任务处理方式是「只读清单＋一键『送去完善题目』生成建议稿」。依据：产品手册 §0.4 DEC-100 行＋§4.6.12。
  - 【已实现·后端】①巡检记录四态状态机（`pending_review`／`reviewed`／`repaired`／`ignored`，写入 `POST /api/admin/knowledge-classification/results/:resultId/audit-review`，留痕 `{state,note,actor,actorLabel,at}`）；②一键送去 `…/:resultId/send-to-enrichment`，**复用**既有完善建议产线内部函数 `createQuestionEnrichmentJob(payload, options)`（原 `POST /api/admin/question-enrichment/jobs` 与它同一实现，未抄第二份），并带来源标记 `origin/originLabel`；③列表读取时对「题目在巡检之后被改过」的记录**只读派生**退回待复核，并给出 `invalidated`／`invalidatedReason`／`recordedState`，**绝不回写**；④确定性体检规则三件套：`question-audit-rules.js`（怎么判）＋`question-audit-context.js`（事实从哪来）＋`question-audit-service.js`（Store 接线，重复题索引建在整本书上）。
  - 【已验证·本轮 2026-09-26】①巡检面板只读化与四态交互：无头逐项可见性＋真实点击（`tmp/verify-inspection-readonly-ui.js`）→ **43/43 通过**，截图 `tmp/verify-out/inspection-{toolbar-four-state,dialog-readonly,marked-reviewed,sent-to-enrichment}.png` **已逐张人工复核**（弹窗内无「采纳」、只读区可用控件数为 0、四态按钮与「送去完善题目」均可点并拿到真实 `jobId`）；②四态状态机接口级**独立**核对（`tmp/verify-audit-review-api.js`，不共用实现者自己的单测）；③体检规则单测 **14/14**（`tests/question-audit-rules.test.js`／`question-audit-context.test.js`／`question-audit-service.test.js`）。
  - 【已验证·2026-09-26 收口】⑤体检项进入巡检清单并在前端分来源展示：每行 `ruleFindings`（**是数组**，空数组＝体检跑过且通过）、`summary.ruleFindingsByCode`／`ruleFindingsPassed`，未体检的书给 `summary.ruleFindingsUnavailable={reason,books}`（**"没查"绝不计入"通过"**）。独立核对 `tmp/verify-audit-review-api.js` **30/30**（就绪教材）＋ **26/26**（`AUDIT_UNAVAILABLE=1`，断言每行**没有** `ruleFindings` 键、未体检计数不出现）；`tmp/verify-inspection-readonly-ui.js` 两种夹具各 **51/51**（三态都在真实渲染里读到：命中「分值缺失或异常·严重度：高·证据 maxScore=0」／「已留档·无问题」／「未体检…不等于通过」），截图 12 张逐张人工复核；性能实测整册 1673 题 **131ms**（`tmp/verify-out/audit-perf.log`）⇒ **不加缓存**。⑥「完善题目」承接两栏：`tmp/verify-enrichment-adopt-ui.js` **23/23**（真实界面＋真实 `/apply` 200，写入落在知识结构与题族修订上；无巡检记录时不发请求、给中文原因——产品负责人 2026-09-26 决定"暂不放开"）；`/api/admin/knowledge-classification/apply` 行为不变，但 `apps/admin/app.js` 里它的**唯一** UI 调用点已在完善题目侧，巡检侧零可提交控件（回归 `tmp/verify-inspection-readonly-ui.js` 51/51）。全量 **1466/1466、exit 0**（`tmp/full-suite-round7.log`）。
  - 【仍待验收】3212 真机可见性：监听 3212 的进程启动于 **09:14:47**，早于本轮全部源码改动（`/health` 回报 `apiSourceStale:true`），须产品负责人按 AGENTS §8 在**自己的终端**重启后硬刷新到 `?v=20260926.27`；真实 1673 行数据上的端到端走查（本轮运行时验收均用内存 Store 夹具）。

### 【待验收】

- 连续 5 次可计分隔离盲测门禁（R13）。
- PostgreSQL 原子事务（跨 Store 一致提交，R5 的另一半）：`ClassificationCommitV1` 事务方案与历史数据迁移计划仍未冻结（§13-6）。
- **本次只做到"单类不丢"的验收**：金标/经验/合并记录已能在 postgres 模式下重启恢复（代码与单测层面，2026-09-22），但**服务器实际重启后的持久化效果尚未实测**（需发布新镜像后验证）；`Agent 4 经验 Store 纳入统一持久化`（手册 §10.4 L1395-1396 / `RELEASE_CHECKLIST` B5）因此只能写「已实现，待验收」。
- **题族筛选的口径取舍待产品负责人确认**：当前「未成族」＝完全没有题族成员关系（＝手册的「无题族关系」）。产品手册另有更宽的「待归组」口径（有题族关系、但没有形成有效、已确认的主题族目录投影）——若他要的是那一档，需再加一个选项并改走 `questionFamilyCatalogProjectionForBook()`，**本轮不擅自改口径**。
- 金标页人工点击走查（变更日志 2026-09-20 21:25 明确遗留）。
- `family_knowledge_v3` 的真实《现代汉语》迁移预演与人工验收（§11.1-10）。

### 【已知缺口】

- Agent 3 独立结果、Agent 4 三例聚合、档案修订建议尚未全部稳定落库（§5.7）。
- 题族名称/状态等更广泛语义变化的精确失效待完善（§5.7、§10.5）。
- 审核弹窗只能从 Agent 候选里选，不能整树纠错；选项到知识标签的诊断关系未稳定（§5.7）。
- `ClassificationCommitV1` 最终字段、事务方案与历史数据迁移计划未冻结（§13-6）。
- **`classification-commit-store` 仍未纳入 `STORE_SPECS`**：postgres 模式下 `ClassificationCommitV1` 提交记录（`prepare/markCommitted/markFailed`）只存内存 → 幂等重试与"启动恢复"在该模式下失效；且补偿回写依赖的 `replaceState` 目前只在 `questions` / `question-families` / 本次新增的两类里登记，`knowledge-structures`、`knowledge-classification`、`knowledge-dossiers`、`admin-actions`（operationLog）**未登记** → 即使恢复流程触发，回写也不会落库。这属于 R5「跨 Store 原子提交」的剩余部分。
- **服务器经验"只进不出"**：目前 `db:import` 单向（文件 → 库），仓库内没有"库 → 文件"导出命令；若将来要求把服务器上积累的案例/纠错回流本地训练集，需新增导出能力（产品负责人 2026-09-22 已知悉）。
- 缺教材上下文的题只做"跳过 + 说明"（上述 DEC-093 配套），当前**没有**"从题干反推教材"的自动补全路径；补归属仍由人工在题库管理里完成。

## 7. 代码、测试与历史决策入口

- 代码：[`question-classification-features.js`](../../apps/api/src/question-classification-features.js)、[`knowledge-classification-pipeline.js`](../../apps/api/src/knowledge-classification-pipeline.js)、[`knowledge-classification-store.js`](../../apps/api/src/knowledge-classification-store.js)、[`knowledge-classification-experience-store.js`](../../apps/api/src/knowledge-classification-experience-store.js)、[`classification-verification-policy.js`](../../apps/api/src/classification-verification-policy.js)、[`classification-commit-store.js`](../../apps/api/src/classification-commit-store.js)、[`classification-commit-coordinator.js`](../../apps/api/src/classification-commit-coordinator.js)、[`classification-gold-review-store.js`](../../apps/api/src/classification-gold-review-store.js)、[`suggestion-lifecycle.js`](../../apps/api/src/suggestion-lifecycle.js)、[`apps/admin/knowledge-inspection-apply-guard.js`](../../apps/admin/knowledge-inspection-apply-guard.js)。
- 测试：见第 6 节清单，均在 [`tests/`](../../tests)。
- 脚本：[`scripts/classification/run-classification-blind-replay.js`](../../scripts/classification/run-classification-blind-replay.js)、[`run-classification-blind-batch.js`](../../scripts/classification/run-classification-blind-batch.js)、[`prepare-classification-blind-replay-context.js`](../../scripts/classification/prepare-classification-blind-replay-context.js)、[`select-classification-blind-samples.js`](../../scripts/classification/select-classification-blind-samples.js)。
- 规则正文：产品手册 §4.6.1、§4.6.3、§4.8、§4.9、§5.1–5.8、§10.4、§10.5。
- 历史决策：DEC-005、025、026、031–036、039、040、093（索引见产品手册 §0.4；076+ 缺口见 [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C2）。
