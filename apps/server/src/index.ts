import { join } from "node:path";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app";
import { loadOrCreateSecretKey, readConfig } from "./config";
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";

/**
 * 启动入口：读配置 → 准备数据目录与密钥 → 打开数据库并迁移 → 组装 app → 监听端口。
 * app 的定义在 src/app.ts（无副作用）；本文件只做启动，测试不导入它。
 */

const config = readConfig(process.env);

// 开发时开 debug 日志方便排查，生产保持 info
const logger = pino({ level: config.isProduction ? "info" : "debug" });

// 会话密钥（§0.3：首次启动自动生成到 DATA_DIR/secret.key）。
// 只记录长度不记录内容——密钥不进日志（后续任务用于 API Key 加密等场景）。
const secretKey = loadOrCreateSecretKey(config.dataDir);
logger.info(
  { dataDir: config.dataDir, secretKeyBytes: secretKey.length / 2 },
  "数据目录与密钥已就绪",
);

// 数据库：打开（或创建）DATA_DIR/tutor.db 并执行未应用的迁移。
// runMigrations 幂等（已应用过的迁移记录在 __drizzle_migrations 表），每次启动都可安全调用。
const dbPath = join(config.dataDir, "tutor.db");
const db = createDb(dbPath);
runMigrations(db);
logger.info({ dbPath }, "数据库已就绪（迁移已执行）");

const app = createApp({
  isProduction: config.isProduction,
  logger,
  db,
  dataDir: config.dataDir,
  publicUrl: config.publicUrl,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    {
      port: info.port,
      publicUrl: config.publicUrl,
      dataDir: config.dataDir,
      production: config.isProduction,
    },
    "服务已启动",
  );
});

// —— 优雅退出（T2.13 E2E teardown 根因修复；systemd/docker stop 同样走这条路）——
// 背景：E2E 的 webServer 直接 spawn 本进程（node + tsx cli），POSIX 上 Playwright
// 结束时向进程组发 SIGTERM；pnpm 壳不转发信号导致 server 挂住、teardown 等满
// globalTimeout（CI 实测 900s）。Node 默认收到 SIGTERM 即终止（无清理机会），
// 显式处理让 server.close 先停止接新连接。
// 数据安全：better-sqlite3 同步写 + WAL 已提交事务即时落盘，无需额外 flush；
// close 回调可能被 keep-alive 空闲连接拖住，3 秒后强制退出兜底。
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "收到退出信号，正在关闭服务");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
