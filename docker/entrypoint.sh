#!/bin/sh
# 薯考 API 容器入口：以 root 启动时先修好数据目录属主，再降权到 node 用户运行。
set -eu

DATA_DIR=/app/.runtime

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # 只为顶层目录改属主，不做递归：数据量大时递归会很慢，
  # 而子目录/文件在首次运行时本就由 node 用户创建，属主天然正确。
  chown node:node "$DATA_DIR" 2>/dev/null || true
  exec gosu node "$@"
fi

# 已指定 --user 的场景（如只读根文件系统 + 预授权卷）：直接执行，不做任何提权动作。
mkdir -p "$DATA_DIR" 2>/dev/null || true
exec "$@"
