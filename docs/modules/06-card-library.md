# 06 卡集与知识卡（服务端归属）

> 导航文档，不是规则正文。规则正文＝[产品手册 §0.4 DEC-097](<../题库开发手册/一、产品手册（Project Blueprint）.txt>)；
> 待确认小口径见 [`OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C15（2026-09-23 已确认并实现）；
> 本文件只写"实现状态、验收状态和已知缺口"，与规则冲突时以产品手册为准。

## 1. 职责

- **卡集**：标题、简介、副标题、科目、作者、颜色、所属文件夹、目录顺序（`sectionOrder` / `sectionLevels`）与**排序**（数组顺序即置顶顺序）。
- **知识卡本体**：卡集内的卡片（问答卡 / 笔记卡）内容与字段；卡片对题目的引用（`questionId` 等）只做透传。
- **跨设备对齐**：登录后把本机副本与服务端库按 DEC-097 的口径合并，结果回写本机。
- **分享**：把卡集冻结成服务端只读快照并给出可匿名读取的链接；接收方"导入到我的卡集"。

## 2. 有效规则（DEC-097 摘要，正文以产品手册为准）

1. **归属**：卡集与知识卡本体**存服务端、按用户隔离**；本机存储降级为**可离线读写的工作副本**，登录后自动对齐。
2. **首登上传**：第一次登录把本机已有卡集整库上行，成为该用户在服务端的第一份。
3. **新设备从空库开始**：本机为空（无卡集、无文件夹、无墓碑）时**只拉不推**，空库上行不得抹掉服务端数据。
4. **本地优先合并**：并集 + 每项按 `updatedAt` 取较新，时间戳相同以请求方（本地）为准。
5. **删除写墓碑**：卡集、卡内单卡、文件夹各一套墓碑（只增不删），否则另一台设备上的旧副本会把删掉的内容带回来。
6. **排序即内容**：置顶＝数组顺序，改顺序也要打时间戳，否则传不到服务端。
7. **分享＝服务端快照**：随机 `shareId`、匿名可读、不可枚举；快照与源卡集解耦；接收方导入时**换新 id**。

## 3. 数据归属（一处维护）

| 数据 | 真源 | 位置 |
| --- | --- | --- |
| 卡集与卡内卡片本体、目录顺序、分享快照 | 服务端（本机为工作副本） | `apps/api/src/card-library-store.js`、`.runtime/card-library.json` |
| 「这张卡是否加入复习」 | 服务端**学习状态**（`savedKnowledgeIds`） | `apps/api/src/learning-state-store.js` — **本模块不存、不改** |
| 题目内容与解析 | 题库 | `apps/api/src/question-store.js` |
| 题目收藏/书签 | 各自既有归属 | DEC-097 不改变学习状态与收藏模块 |
| 私人题包、独立笔记、AI 对话 | 归属规则见产品手册 §9.2.1 / DEC-106 | 后续实现与缺口只在 [模块 07 §6](07-personal-cloud-assets.md) 维护；DEC-097 当轮“未动”不再表示永远只存本机 |
| 刷题笔记卡 | 本模块的卡集内卡片 | `question-note-store.js` 调用卡集 Store；不因 DEC-106 再复制一份正文 |

## 4. 跨模块进出

- **进入**：卡集页 / 卡盒页（本机读写）→ 登录后 `POST /api/card-library/sync` 上行并取回合并结果；
  分享链接 `?share=<id>` → 匿名 `GET /api/card-library/share/:id` → 只读页 → 「导入到我的卡集」写回本机库。
- **跳出**：卡片里的题目引用按 id 去题库取内容；「是否加入复习」写学习状态，不写本库。
- **注销**：`DELETE /api/account` 一并 `cardLibraryStore.deleteUser()` → 卡库与已分享快照同时回收（分享链接随即 404）。

## 5. 禁止事项

- 不得在页面里**绕过 store 直写** `shukao_card_box_sets`（删除/置顶会因此丢失墓碑与时间戳——本次已修掉两处）。
- 不得把"是否加入复习"复制进本 store（会与学习状态双写）。
- 不得在未登录时上行（未登录只读本机）；不得用空库上行覆盖服务端。
- 不得让分享快照跟随源卡集变化（快照一旦生成即冻结）。
- 不得手改 `.runtime/card-library.json`（正式数据只能经 API/Store 修改）。

## 6. 实现状态、验收状态和已知缺口

- **2026-10-02 范围核对**：刷题笔记的 `saveQuestionNote()` 已调用本模块的 `addCardToSet` / `updateCardInSet`；新云端资产决议只复用此链路，不重建笔记卡真源。私人题包、独立笔记与 AI 对话的新增范围和待办只见 [模块 07 §6](07-personal-cloud-assets.md)，不能用本模块既有测试数宣称三类资产上云已验收。

- **已实现（2026-09-23）**：服务端 store（合并语义 / 墓碑 / 空库只拉不推 / 分享快照 / 注销回收）＋四条路由（`GET /api/card-library`、`POST /api/card-library/sync`、`POST /api/card-library/share`、匿名 `GET /api/card-library/share/:id`）＋小程序侧（`updatedAt` 戳记与墓碑、防抖自动上行、登录/启动同步、只读分享页与导入）。适配器规格同 DEC-096 的收藏文件夹（文件 tmp+rename 0o600；测试用内存 store）。
- **已验证（本机，2026-09-23）**：`card-library-store` 12/12、`card-library-sync` 11/11（均为新增）、`card-box-store` 22/22、`card-box-folder-flow` 22/22、`card-set-page-flow` 70/70、`api` 22/22、`auth-learning-api` 2/2、`auth-profile-api` 4/4（`NODE_ENV=development`）。**全量 `node --test` 在本机沙箱跑不起来（`spawn EPERM`），上列不代表全量。**
- **图标口径（2026-09-23 04:6x，产品负责人真机截图指出两处「排序」要统一）**：卡集页抽屉「卡盒排序」原来用的是画三条竖杆 + 短横线的「滑块」标 `sliders.svg`，与他给的新参考图（两根竖杆 + 左右斜头的箭头标）不一致 → 换成新画的 `assets/icons/sort.svg`（同批：收藏页搜索行的排序入口也换同一颗，两处语义与图形从此一致）。**全局契约**：`tests/icon-contrast.test.js` 新增一项按 `aria-label` 反查——凡语义是「排序」的入口必须用 `sort.svg`、语义是「设置」的必须用 `settings-gear.svg`（现在覆盖收藏页 / 卡集页 / 练习页 / 个人页四处）。颜色与对比度：`#474d49` 白底 **8.66**、卡集抽屉 44rpx 白底片同值（由 `tests/icon-contrast.test.js` 与 `tmp/verify-favorites-redesign.js` V19 共同覆盖）。**真机观感待产品负责人确认**。
- **待真机验收（Agent 无法验证，小程序无本机运行环境）**：① 登录后本机卡集是否真的上行、换一台设备是否拉到；② 分享链接在好友设备上的只读页观感、编辑入口是否确实点不动、底部是否只留「导入到我的卡集」；③ 导入后的落点（跳到自己那份新卡集）与作者标记「来自分享」。**真机可见性必须由产品负责人确认，本文件不得据此宣称"界面已验收"。**
- **已知缺口**：① 体验版/正式版上同步与分享**事实上不生效**——API 地址仍写死内网 IP（[`OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) C14；[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) **B7**）；② 本 store 仅文件持久化，**未纳入** `postgres-persistence.js` 的 `STORE_SPECS`（与 DEC-096 同批处理）；③ 墓碑只增不减，量大后需按用户裁剪；④ 卡片内容里若含大体积富文本，本机 4MB 上行上限可能不够（当前未触发）。

## 7. 代码与测试入口

- 服务端：`apps/api/src/card-library-store.js`、`apps/api/src/server.js`（搜 `/api/card-library`）
- 小程序：`apps/miniprogram/utils/card-box-store.js`、`apps/miniprogram/pages/card-box/card-box.js`、`apps/miniprogram/pages/card-set/card-set.js|wxml|wxss`、`apps/miniprogram/app.js`（`configureCardLibrarySync` / `syncCardLibrary`）
- 测试：`tests/card-library-store.test.js`、`tests/card-library-sync.test.js`、`tests/card-box-store.test.js`、`tests/card-box-folder-flow.test.js`、`tests/card-set-page-flow.test.js`
