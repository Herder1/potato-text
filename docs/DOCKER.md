# Docker 构建与运行（DOCKER）

- 用途：说明薯考 API 镜像**怎么构建、怎么跑、数据在哪、更新怎么发**。
- 单一维护点约定：**自动发布流水线的正文在 [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)**（触发条件与标签策略写在那里，本文只写引用与操作步骤）。
- 相关文件：[`Dockerfile`](../Dockerfile)、[`.dockerignore`](../.dockerignore)、[`docker/entrypoint.sh`](../docker/entrypoint.sh)、[`docker-compose.yml`](../docker-compose.yml)、[`docker-compose.postgres.yml`](../docker-compose.postgres.yml)。

## 1. 镜像内容边界

| 进镜像 | 用途 |
| --- | --- |
| `apps/api/` | 服务与领域 Store（含 `render-exam-pdf.py`） |
| `apps/admin/` | `server.js` 里 `adminRoot = apps/admin`，即 `/admin/` 管理后台 |
| `apps/miniprogram/utils/` | `server.js` 直接 `require` 的判分等纯函数（不是小程序运行环境） |
| `packages/domain/`、`scripts/`、`database/`、`knexfile.js` | 领域数据与 PostgreSQL 迁移/导入 |
| `node_modules`（`npm ci --omit=dev`） | 生产依赖 |
| `python3` + `python3-reportlab` + `fonts-wqy-zenhei`（另装 `fonts-noto-cjk`） | 试卷 PDF 导出。reportlab 只能嵌入 TrueType 轮廓，而 Noto CJK 的 `.ttc` 是 OTTO(CFF/PostScript) 集合、注册即抛错，实际生效的是 wqy-zenhei；两处都找不到可用字体时报 `exam_export_cjk_font_unavailable` |

| 不进镜像 | 原因 |
| --- | --- |
| `.runtime/` | 正式运行数据，容器里一律用卷挂载，绝不烘进镜像 |
| `题目录入/`、`tmp/` | 原始资料与临时产物，体积大且与运行无关（见 `.dockerignore`） |
| `tests/`、`docs/`、`题库开发手册/` | 运行期用不到 |
| `.env*` | 密钥只从环境变量注入 |

> 本镜像**只跑 API + 管理后台**。`apps/miniprogram/` 是微信小程序源码，必须用微信开发者工具上传，不能靠 Docker 部署。

## 2. 从 GHCR 拉取

```bash
docker pull ghcr.io/herder1/potato-text:latest
docker pull ghcr.io/herder1/potato-text:sha-<完整 commit sha>
```

仓库私有则镜像默认私有，拉取前先登录（用有 `read:packages` 权限的 PAT）：

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
```

## 3. 本地构建与运行

```bash
# 构建
docker build -t shukao-api .

# 运行（文件模式，数据落在仓库根 .runtime，映射到 3212）
docker run -d --name shukao-api \
  -p 3212:3212 \
  -v "$PWD/.runtime:/app/.runtime" \
  shukao-api

# 验证
curl -fsS http://127.0.0.1:3212/health
```

管理后台：`http://127.0.0.1:3212/admin/`。

用 compose（推荐，参数都写在文件里）：

```bash
docker compose up -d            # 拉 GHCR 的 latest
docker compose up -d --build    # 用当前源码本地构建
docker compose logs -f api
docker compose down
```

## 4. 环境变量

| 变量 | 默认值（镜像内） | 说明 |
| --- | --- | --- |
| `PORT` | `3212` | 监听端口 |
| `HOST` | `0.0.0.0` | 容器内**必须**是 `0.0.0.0`，否则端口映射不通（仓库本地默认是 `[IP]`） |
| `NODE_ENV` | `production` | 生产态；注意开发态鉴权用例在该值下会返回 401（见 `AGENTS.md` §8） |
| `PERSISTENCE_DRIVER` | `file` | 值必须**精确等于** `postgres` 才走数据库模式（`server.js` 就是这么判的），其他值都是文件模式 |
| `FILE_STORAGE_DRIVER` | `local` | `kvault` 仅在 `PERSISTENCE_DRIVER=postgres` 下可用，否则启动即抛错 |
| `DATABASE_URL` / `DATABASE_SSL` / `DATABASE_POOL_*` | 空 / `false` | 仅 PostgreSQL 模式使用 |
| `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` / `ADMIN_INIT_DISPLAY_NAME` | `admin` / 空 / 空 | **仅当账号表为空时**用它创建首个超级管理员（只在这一次读环境变量）；密码留空则生成随机密码，并只在容器日志里打印一次 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 空 | 不配则微信登录不可用，其余功能不受影响 |
| `SHUKAO_PDF_FONT_PATH` | 空 | 留空时脚本按内置候选逐个"真注册一次"挑选，镜像内命中 `/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc`；指到 OTTO/CFF 字体（如 Noto CJK）会被自动跳过而不是整链失败 |

密钥只从运行环境注入，**不要**写进镜像或提交进仓库。

## 5. 数据与持久化

- 数据目录固定为容器内 `/app/.runtime`（各 Store 用 `__dirname/../../../.runtime` 解析，**没有**环境变量可改）。
- compose 默认把它绑到宿主机仓库根的 `.runtime/`，备份就是拷贝该目录；换成命名卷也可以：把 `docker-compose.yml` 的 `volumes` 改成 `shukao-runtime:/app/.runtime` 并声明顶层卷。
- 容器以非 root 的 `node`（uid 1000）运行；入口脚本 [`docker/entrypoint.sh`](../docker/entrypoint.sh) 在 root 启动时先 `mkdir -p` 并 `chown node:node` 顶层数据目录，再 `gosu node` 降权执行，因此**宿主机上 root 拥有的挂载目录也能直接用**。
- 用 `--user` 指定别的 uid 时，入口脚本不做 chown，请自行保证数据目录可写。

## 6. PostgreSQL 模式

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

- 启动顺序：`postgres` 通过 `pg_isready` 健康检查后，API 先执行 `npm run db:migrate`（幂等），再启动服务。
- 把现有 `.runtime/*.json` 导入数据库（先 dry-run 校验，再正式导入并逐条校验）：

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm api npm run db:import:dry
docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm api npm run db:import
```

- 切库窗口与安全前提以 [`POSTGRES_MIGRATION.md`](POSTGRES_MIGRATION.md) 为准（那里是正文）。

## 7. 自动发布流水线

- 文件：[`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)（触发条件、标签策略、权限、平台矩阵都在该文件内，改行为改那里）。
- 首次启用前需要在 GitHub 仓库 `Settings → Actions → General` 确认 workflow 权限允许读写（默认的 `GITHUB_TOKEN` 配合文件里的 `permissions: packages: write` 即可推送 GHCR，**不需要额外配置任何 Secret**）。
- 镜像落点：`ghcr.io/herder1/potato-text`（仓库名含大写，GHCR 要求全小写，故镜像名在 workflow 里显式写死）。
- 构建平台默认 `linux/amd64`；要出 ARM 镜像，改 workflow 里的 `PLATFORMS`（arm64 走 QEMU 模拟，构建会明显变慢）。
- 流水线里的 `test` 任务**刻意不阻塞镜像发布**（`continue-on-error: true` 且不是 `docker` 任务的依赖），避免无关的测试抖动把"提交即出镜像"堵死；要改成发布门禁的做法写在文件注释里。

## 8. 排错

| 现象 | 排查 |
| --- | --- |
| 容器 `unhealthy` | `docker logs shukao-api`；再 `docker exec shukao-api node -e "fetch('http://127.0.0.1:3212/health').then(r=>console.log(r.status))"` |
| 宿主机连不上 | 确认 `HOST=0.0.0.0`，且 `docker run -p` 的映射端口与 `PORT` 一致 |
| 写入报 EACCES | 挂载目录属主不对；入口脚本只 chown 顶层目录，必要时手动 `docker exec -u 0 shukao-api chown -R node:node /app/.runtime` |
| 试卷导出报 `exam_export_renderer_unavailable` | 容器内确认 `python3 -c "import reportlab"` 与 `ls /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` |
| 构建上下文过大/极慢 | 检查 `.dockerignore` 是否仍然排除 `题目录入/`、`tmp/`、`.runtime/` |
| 拉镜像 `unauthorized` / `denied` | GHCR 上的包是私有的：在 1Panel「容器 → 仓库」添加 ghcr.io 账号（用户名 = GitHub 用户名，密码 = 带 `read:packages` 的 PAT），或把 GitHub Packages 里 `potato-text` 的可见性改成 public |
| 编排里报 `failed to solve` / 找不到 `Dockerfile` | 用的是仓库根 `docker-compose.yml`（含 `build:`）；1Panel 的编排目录里没有源码 → 改用 `docker-compose.1panel.yml` |
| `exec format error`（ARM 服务器） | 镜像目前只构建 `linux/amd64`；要跑 ARM 需改 workflow 的 `PLATFORMS` 加上 `linux/arm64`（走 QEMU，构建变慢） |

## 9. 在 1Panel 里部署

面板的「容器 → 编排」是在它自己的目录（`/opt/1panel/docker/compose/<项目>/`）里执行 `docker compose up -d`，那里**没有本仓库源码**，也没有 `.env`，所以根目录那份 `docker-compose.yml`（带 `build:`、相对路径绑定挂载、`${VAR:-默认值}`）在面板里会构建失败或把数据落到面板目录里。

为此专门提供两份"粘贴即用"的编排（**只拉现成镜像，不带 build，全字面量，不依赖 .env**）：

| 文件 | 用途 | 数据 |
| --- | --- | --- |
| [`docker-compose.1panel.yml`](../docker-compose.1panel.yml) | 单容器 + 文件持久化（默认，最省事） | 命名卷 `shukao-runtime` → `/app/.runtime` |
| [`docker-compose.1panel-postgres.yml`](../docker-compose.1panel-postgres.yml) | 追加 `postgres:16-alpine`，API 切 `PERSISTENCE_DRIVER=postgres`，起来前先跑 `npm run db:migrate` | 命名卷 `shukao-postgres` + `shukao-runtime` |

步骤：

1. **先让镜像拉得动**：本仓库私有 → GHCR 包默认也私有。在「容器 → 仓库」新增 `ghcr.io` 账号，或在 GitHub 把包可见性改成 public。
2. 「容器 → 编排 → 创建编排」，名称随意（如 `shukao`），把整份 YAML 粘进去，确认。面板会自己建项目目录与网络。
3. 起来后看「容器 → 日志」，找这一行拿首次登录用的随机密码：
   `[薯考后台] 初始密码（仅本次显示，请登录后立即修改）：……`
   想自己定账号密码，就取消 YAML 里 `ADMIN_INIT_USERNAME` / `ADMIN_INIT_PASSWORD` 两行的注释（**只在账号表为空时生效**）。
4. 反代：在「网站 → 反向代理」指向 `127.0.0.1:3212`；同时把 YAML 里的端口改成 `"127.0.0.1:3212:3212"`，避免公网直连。
5. 备份：「容器 → 存储卷」里的 `shukao-runtime` 就是全部业务数据（JSON 库 + 上传件 + 导出件），面板可直接备份；也可以改成绑定挂载到固定目录（如 `/opt/1panel/apps/shukao/runtime`），入口脚本会自动把顶层目录 chown 给容器内的 `node`。
6. 升级：镜像更新后用编排里的「拉取镜像 → 重新部署」；要可回滚就把 `image:` 的 `:latest` 换成具体 `:sha-<commit>` 标签。

> 两份编排都**不要**加 `user:`——镜像靠 root 入口脚本先把 `/app/.runtime` 授权给 `node(uid 1000)` 再降权，指定 `user:` 会让这一步失效并导致写入 EACCES。
