# syntax=docker/dockerfile:1
# 薯考 API 运行镜像（同时提供 /admin/ 管理后台静态页）。
# 构建：docker build -t shukao-api .
# 运行：docker run --rm -p 3212:3212 -v shukao-runtime:/app/.runtime shukao-api
# 说明见 docs/DOCKER.md。

ARG NODE_VERSION=22

# ---------- 依赖层：只装生产依赖 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 运行层 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# 试卷 PDF 导出走 apps/api/src/render-exam-pdf.py（reportlab + 中文字体）；
# 缺字体时该功能会直接抛 exam_export_cjk_font_unavailable，故随镜像一并安装。
# fonts-noto-cjk 提供 /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc，
# 正是 render-exam-pdf.py 的默认查找路径之一。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
      python3 \
      python3-reportlab \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3212 \
    HOST=0.0.0.0 \
    PERSISTENCE_DRIVER=file \
    FILE_STORAGE_DRIVER=local

WORKDIR /app

# 只拷运行期真正会被 require/读取的目录：
#   apps/api            —— 服务与领域 Store
#   apps/admin          —— server.js 里 adminRoot = apps/admin
#   apps/miniprogram/utils —— server.js 直接 require 的主观题判分等纯函数
#   packages/domain     —— catalog / schema / assessment-action-semantics
#   scripts + database + knexfile.js —— PostgreSQL 模式（PERSISTENCE_DRIVER=postgres）必需
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json knexfile.js ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY database ./database
COPY docker ./docker

# 数据目录：各 Store 默认写入 <repo>/.runtime（见 apps/api/src/*-store.js）。
# 容器内以 node 用户（uid 1000）运行，故先建好并授权；挂载卷时由 entrypoint 兜底 chown。
RUN mkdir -p /app/.runtime \
 && chown -R node:node /app/.runtime \
 && chmod +x /app/docker/entrypoint.sh

VOLUME ["/app/.runtime"]
EXPOSE 3212

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3212)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "apps/api/src/server.js"]
