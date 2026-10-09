import { join } from "node:path";
import { serve } from "@hono/node-server";
import { assertValidatorCoverage } from "@tutor/grading";
import pino from "pino";
import { createApp } from "./app";
import { loadOrCreateSecretKey, readConfig } from "./config";
import { runBackfills } from "./db/backfill";
import { createDbHandle } from "./db/client";
import { runMigrations } from "./db/migrate";
import { handleServerError, installCrashHandlers } from "./lib/startup-errors";
import { startBackupScheduler } from "./services/backup-service";

/**
 * 启动入口：读配置 → 准备数据目录与密钥 → 打开数据库并迁移 → 组装 app → 监听端口。
 * app 的定义在 src/app.ts（无副作用）；本文件只做启动，测试不导入它。
 */

// 崩溃兜底要最先装（2026-10-08 立项）：未处理异常同步写 stderr 横幅后退出，
// 避免被 pnpm/tsx 链吞成"零输出起不来"（当天实测 stdout 会被缓冲丢失）
installCrashHandlers();

// T7.5：判分注册完备性检查——契约题型表引用的校验器缺实现即启动失败
// （注册遗漏属开发错误，不能让正常题静默换成另一种判分）。放在
// installCrashHandlers 之后：此处抛错走 stderr 横幅 + exit 1 的友好崩溃路径。
assertValidatorCoverage();

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
// 用可重启句柄（T4.5 恢复用）：onOpen 每次打开（含恢复后的重开）都执行
// 迁移 + D23 数据搬迁，二者幂等（__drizzle_migrations / data_migrations
// 完成标记防重跑）——从旧版本备份恢复的库也自动升级到当前结构。
const dbPath = join(config.dataDir, "tutor.db");
const dbHandle = createDbHandle(dbPath, (fresh) => {
  runMigrations(fresh);
  runBackfills(fresh);
});
const db = dbHandle.db;
logger.info({ dbPath }, "数据库已就绪（迁移与数据搬迁已执行）");

// 自动备份快照（T4.5，架构 §5.10）：启动立即一份 + 每 24h 一份，保留 14 份。
// 失败只记日志（磁盘满等不拖垮服务）；句柄 db 让快照始终对着当前连接。
const stopBackupScheduler = startBackupScheduler(config.dataDir, db, logger);

const app = createApp({
  isProduction: config.isProduction,
  logger,
  db,
  dataDir: config.dataDir,
  publicUrl: config.publicUrl,
  dbHandle,
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
// 端口被占等 listen 错误：默认是未处理 error 事件裸崩（纯英文栈），
// 换成含端口号/占用进程/清理命令的友好报错后以码 1 退出
server.on("error", (err: Error) => handleServerError(err, config.port));

// —— 优雅退出（T2.13 E2E teardown 根因修复；systemd/docker stop 同样走这条路）——
// 背景：E2E 的 webServer 直接 spawn 本进程（node + tsx cli），POSIX 上 Playwright
// 结束时向进程组发 SIGTERM；pnpm 壳不转发信号导致 server 挂住、teardown 等满
// globalTimeout（CI 实测 900s）。Node 默认收到 SIGTERM 即终止（无清理机会），
// 显式处理让 server.close 先停止接新连接。
// 数据安全：better-sqlite3 同步写 + WAL 已提交事务即时落盘，无需额外 flush；
// close 回调可能被 keep-alive 空闲连接拖住，3 秒后强制退出兜底。
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "收到退出信号，正在关闭服务");
  stopBackupScheduler();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
