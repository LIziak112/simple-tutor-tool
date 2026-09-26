# syntax=docker/dockerfile:1
# ============================================================================
# 多阶段构建（T0.7 部署文件）。配套：compose.yaml、docker/Caddyfile、docs/部署.md
#
#   阶段一 build      —— 全量依赖安装 + server / web 构建产物
#   阶段二 prod-deps  —— 仅 server 生产依赖（pnpm 过滤安装，独立成层）
#   阶段三 runner     —— 最终镜像：server 产物 + web dist + 生产依赖，非 root 运行
#
# 与架构文档 §4 目录图的差异：Dockerfile 与 compose.yaml 放在仓库根而非 docker/。
# 原因：构建上下文必须是整个 pnpm workspace（server / web / packages 相互依赖，
# 要在容器内完整安装并构建），`docker compose up -d --build` 需要在检出根目录直接
# 可用；Caddyfile 不参与镜像构建（由 compose 只读挂载进 caddy 容器），保留在 docker/。
# 详见 docs/部署.md。
# ============================================================================

# ----------------------------------------------------------------------------
# 阶段一：构建
# ----------------------------------------------------------------------------
# 基底必须用 glibc 的 slim（Debian），不要换成 alpine/musl：
# better-sqlite3 v13 的原生绑定是按平台分发的预编译二进制（包内 prebuilds/*.node），
# glibc 环境加载 linux-x64.node；musl 与 glibc 的 ABI 不通用，alpine 下预编译
# 无法加载、需自行准备工具链编译，因此固定 glibc 基底。
# node:24 与仓库约定一致（根 package.json engines: >=24、.nvmrc: 24）。
FROM node:24-slim AS build

# pnpm 由 corepack 按根 package.json 的 packageManager 字段（pnpm@12.6.0）解析安装；
# 非交互构建环境需关闭 corepack 的下载确认提示。
# （若基础镜像变动导致没有 corepack，等价写法：RUN npm install -g pnpm@12.6.0）
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

# 先只拷贝清单文件装依赖：清单不变时这一层走缓存，源码改动不触发重装。
# pnpm-workspace.yaml 声明了 apps/* 与 packages/*，frozen-lockfile 要求全部
# importer 的 package.json 在场，因此五个工作区清单都要先拷进来。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/md-dsl/package.json packages/md-dsl/package.json
COPY packages/grading/package.json packages/grading/package.json
RUN pnpm install --frozen-lockfile

# 再拷全部源码并构建两个产物（.dockerignore 已剔除 node_modules/dist/data 等，
# 但放行 docs/dsl：server 构建脚本把它拷进 dist/spec 供 /api/public/spec 使用）：
# - apps/server/dist/：esbuild bundle（dist/index.js）+ dist/migrations/ + dist/spec/
#   （server 的 build 脚本末尾由 scripts/copy-migrations.mjs 把迁移拷到 dist/migrations，
#     scripts/copy-spec.mjs 把仓库根 docs/dsl 拷到 dist/spec，运行时均按
#     dist/index.js 同级目录定位，见 src/db/migrate.ts 与 src/spec-files.ts）
# - apps/web/dist/：Vite 前端静态产物
COPY . .
RUN pnpm --filter server build && pnpm --filter web build

# ----------------------------------------------------------------------------
# 阶段二：server 生产依赖（不含 devDependencies，最终镜像不携带构建工具链）
# ----------------------------------------------------------------------------
FROM node:24-slim AS prod-deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# 过滤安装：只装 server 及其 workspace 依赖（@tutor/contract）的生产依赖。
# 说明：@tutor/contract 与 zod 会被 esbuild 打进 bundle，运行时实际用不到；
# 仍拷贝 contract 清单是因为 pnpm 过滤安装要求被依赖的 workspace 包在场。
# better-sqlite3 走包内 linux-x64 预编译（pnpm-workspace.yaml 的 allowBuilds
# 已设为不执行其构建脚本），无需 gcc/make/python 工具链。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contract/package.json packages/contract/package.json
RUN pnpm install --frozen-lockfile --prod --filter "server..." \
    # @tutor/contract 是 workspace 符号链接，目标目录不在本阶段，
    # 已被 bundle 进 dist/index.js，运行时不会解析，删掉悬空链接避免误导
    && rm -f apps/server/node_modules/@tutor/contract

# ----------------------------------------------------------------------------
# 阶段三：运行镜像
# ----------------------------------------------------------------------------
FROM node:24-slim AS runner

# §0.3 环境变量：PORT 默认 8787；DATA_DIR 指向挂载卷（compose 里 ./data:/app/data）；
# PUBLIC_URL 属部署环境差异，不在此写死，由 compose 的 environment 提供
# （默认 http://localhost:8787，域名 + HTTPS 时改成 https://你的域名）。
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/app/data

WORKDIR /app/apps/server

# 生产依赖原样拷入：保持与 prod-deps 阶段相同的相对结构，
# pnpm 的符号链接（apps/server/node_modules/* → ../../node_modules/.pnpm/…）
# 在 COPY 后仍然有效，Node 从 dist/index.js 逐级上溯即可解析。
COPY --from=prod-deps /repo/node_modules /app/node_modules
COPY --from=prod-deps /repo/apps/server/node_modules /app/apps/server/node_modules

# server 产物（dist/index.js + dist/migrations/ + dist/spec/；启动时自动建库并执行迁移；
# dist/spec 为 DSL 规范文档，/api/public/spec 的数据源，见 src/spec-files.ts）
COPY --from=build /repo/apps/server/dist /app/apps/server/dist
# web 产物：src/static.ts 按 import.meta.url 上溯两级解析 ../../web/dist，
# 因此 apps/server 与 apps/web 的平级结构必须保持
COPY --from=build /repo/apps/web/dist /app/apps/web/dist

# 非 root 运行：官方镜像自带 uid/gid 1000 的 node 用户。
# 挂载卷 ./data 的宿主目录属主需为 1000:1000，见 docs/部署.md §1.2。
USER node

EXPOSE 8787

# slim 镜像没有 curl/wget，用 Node 24 原生 fetch 请求公开健康检查接口
# （GET /api/public/health，见 apps/server/src/app.ts）；2xx 视为健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/public/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
