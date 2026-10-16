# 薯考

面向广东普通专升本汉语言文学考生的微信题库、练习记录与复习工具。首期由微信小程序、独立服务端和网页管理后台组成。

## 当前可运行内容

- 微信小程序：题库、知识库、复习、发现、个人中心与九本教材练习
- 本地服务端：健康检查、目录和演示题接口
- 管理后台起步页：教材、题目、审核和 AI 路由概览
- PostgreSQL 领域模型草案：目录、题目版本、答案方案、作答、订阅、AI 额度、社区治理

界面与交互必须遵守 [`docs/UIUX_STANDARD.md`](docs/UIUX_STANDARD.md) 中的当前基线。

## 文档导航

改代码前先读 [`AGENTS.md`](AGENTS.md)（阅读顺序、变更边界、必须确认的操作、测试与文档同步要求）。

| 你想找 | 去哪里 |
| --- | --- |
| 模块 → 代码 → 规则 → 测试入口 | [`docs/PROJECT_MAP.md`](docs/PROJECT_MAP.md) |
| 产品定位、首发范围、跨模块原则 | [`docs/PRODUCT.md`](docs/PRODUCT.md) |
| 上线阻断项与验收证据 | [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) |
| 待确认清单与已自查结论 | [`docs/OPEN_DECISIONS.md`](docs/OPEN_DECISIONS.md) |
| 第一批已拆模块文档 | [`docs/modules/`](docs/modules/01-identity-auth.md) |
| **已确认产品规则（权威正文）** | [`题库开发手册/一、产品手册（Project Blueprint）.txt`](<题库开发手册/一、产品手册（Project Blueprint）.txt>) |
| 界面基线 | [`docs/UIUX_STANDARD.md`](docs/UIUX_STANDARD.md) |

历史资料仍保留，但**不再承担现行规范正文**：

- [`题库开发手册/二、变更日志（CHANGELOG.md）.txt`](<题库开发手册/二、变更日志（CHANGELOG.md）.txt>)：历史改动账本，按时间倒序，用于溯源；
- [`题库开发手册/三、交流文档.txt`](<题库开发手册/三、交流文档.txt>)：历史决议与协作约定档案，DEC-001 起的历史决议入口；
- [`题库开发手册/四、链路职责矩阵.txt`](<题库开发手册/四、链路职责矩阵.txt>)：**生效口径**（2026-09-21 登记归档）；2026-09-18 产品负责人逐条确认 11/11，其中两项具体职责登记为 DEC-090 / DEC-091（产品手册 §0.4）；
- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)：第一阶段需求基线（历史输入，非当前规范正文）。

## 启动管理后台和 API

```powershell
npm.cmd run dev
```

打开 `http://127.0.0.1:3212/admin/`。API 健康检查地址为 `http://127.0.0.1:3212/health`。

### 本地代理与出站请求（2026-10-09）

Node 的内置 `fetch` **不读 Windows 系统代理**，而浏览器和 Codex++ 会读。因此当某个上游按地区限制访问时，会出现「浏览器能连、题库后台报错」的现象——例如 `https://api.typesafe.ai` 直连会返回 **HTTP 451 `Typesafe is not available in your region.`**，走本机代理则正常。

- 用 [`start-server.cmd`](start-server.cmd) 或 [`start-server-hidden.vbs`](start-server-hidden.vbs) 启动时，会先读取系统代理并自动带上 `NODE_USE_ENV_PROXY=1` / `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（解析逻辑集中在 [`apps/api/src/outbound-proxy.js`](apps/api/src/outbound-proxy.js)，启动脚本只做转发）。
- 手工启动（例如 AGENTS §8 里那条重启命令）时请自己带上这几个环境变量：

  ```cmd
  cmd /c cd /d "D:\龙虾工作站\题库" && set NODE_USE_ENV_PROXY=1 && set HTTPS_PROXY=http://127.0.0.1:7897 && set HTTP_PROXY=http://127.0.0.1:7897 && set NO_PROXY=localhost,127.0.0.1,::1 && node apps\api\src\server.js >> runtime-server-3212-current.log 2>> runtime-server-3212-current.err.log
  ```

- 自查：`http://127.0.0.1:3212/health` 的 `outboundProxy` 会如实报告 `active` / `mode`（`env_active`＝真的在走代理、`system_only`＝系统代理开着但服务端没走、`none`＝没有代理）；后台「AI 配置」页在 `system_only` 时会显示一条带重启方式的提示。
- `NO_PROXY` 必须包含 `127.0.0.1`，否则服务端自己的内部自调用（试卷导入流水线）会被塞进代理。`start-server.cmd` 已自动处理。

### 供应商协议支持（2026-10-09）

| 协议 | 用途 | 备注 |
| --- | --- | --- |
| OpenAI Chat Completions | 可绑定 AI 场景路由 | `POST {base}/chat/completions` |
| OpenAI Responses | 可绑定 AI 场景路由 | `POST {base}/responses` |
| Anthropic Messages | 可绑定 AI 场景路由 | `POST {base}/messages` |
| Google Gemini | 可绑定 AI 场景路由 | `POST {base}/models/{model}:generateContent` |
| **Typesafe System One（Jev）** | 只能「读取模型」+「测试」 | `POST {base}/systemone`，body = `state` + `model` + `questions`，返回 `choice` / `score` / `noul` 结构化判定；**不生成文本**，因此**不能**绑定 AI 场景路由（配置期就会被拒）。实测该上游没有 `/chat/completions` 与 `/responses`（404 Not Found）。 |

读模型列表统一走 `GET {base}/models`（Base URL 不带路径时自动补 `/v1`）。协议选的不是上游真实协议时，后台报错会带上游原话（例如 `HTTP 404`），不再只给一个状态码。

## Docker 构建与运行

推送到 `main` 或打 `v*` tag 时会自动构建并把镜像发布到 `ghcr.io/herder1/potato-text`（流水线正文 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)）。

```bash
docker compose up -d --build     # 单容器 + 文件持久化，数据挂到仓库根 .runtime
```

环境变量、可选 PostgreSQL 叠加编排、数据卷与排错见 [`docs/DOCKER.md`](docs/DOCKER.md)。

## 导入微信开发者工具

1. 在微信开发者工具中选择“导入项目”。
2. 项目目录选择本仓库的 `apps/miniprogram`。
3. 首次使用可选择测试号；正式 AppID 不写入仓库。
4. 当前演示数据可离线运行，接入本地 API 时需要在开发者工具中临时关闭合法域名校验。

## 项目结构

```text
apps/
  miniprogram/  原生微信小程序
  api/          独立服务端与静态管理后台
docs/           已确认需求与产品规则
packages/
  domain/       数据模型和共享领域规则
tests/          服务端与领域逻辑测试
Dockerfile      容器镜像定义（构建细节见 docs/DOCKER.md）
docker-compose.yml            单容器默认编排
docker-compose.postgres.yml   叠加 PostgreSQL 的可选编排
.github/workflows/docker-publish.yml   推送即构建并发布镜像到 GHCR
```

后续接入正式环境时，服务端计划使用 PostgreSQL、Redis 和对象存储；AI 密钥始终只保存在服务端。
