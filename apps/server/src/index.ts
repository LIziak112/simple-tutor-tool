import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app";
import { loadOrCreateSecretKey, readConfig } from "./config";

/**
 * 启动入口：读配置 → 准备数据目录与密钥 → 组装 app → 监听端口。
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

const app = createApp({ isProduction: config.isProduction, logger });

serve({ fetch: app.fetch, port: config.port }, (info) => {
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
