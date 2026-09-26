import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 应用配置。来源与默认值见 docs/开发任务清单.md §0.3「全局固定约定」：
 * PORT(默认 8787)、DATA_DIR(默认 ./data)、PUBLIC_URL(默认 http://localhost:8787)。
 */

export interface AppConfig {
  /** HTTP 监听端口（环境变量 PORT，默认 8787） */
  port: number;
  /**
   * 运行数据目录：tutor.db / blobs/ / backups/ / secret.key 所在地
   * （环境变量 DATA_DIR，默认 ./data，相对进程 cwd 解析为绝对路径）。
   */
  dataDir: string;
  /** 对外访问的基础 URL（环境变量 PUBLIC_URL，默认 http://localhost:8787，统一去掉尾部斜杠） */
  publicUrl: string;
  /** 生产模式（NODE_ENV=production）：托管 apps/web/dist 静态资源 */
  isProduction: boolean;
}

/**
 * 从环境变量读取配置。
 * env 参数缺省取 process.env；测试通过传入自定义对象注入，不依赖真实环境。
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let port = 8787;
  const portRaw = env.PORT?.trim();
  if (portRaw) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      // 配置错误快速失败，避免带着歧义端口静默启动
      throw new Error(`PORT 配置不合法：${portRaw}（需要 1-65535 的整数）`);
    }
    port = parsed;
  }

  // DATA_DIR 相对路径按进程 cwd 解析（dev 时为 apps/server；容器/systemd 部署时另行指定绝对路径）
  const dataDir = resolve(env.DATA_DIR?.trim() || "./data");

  const publicUrl = (env.PUBLIC_URL?.trim() || "http://localhost:8787").replace(
    /\/+$/,
    "",
  );

  return {
    port,
    dataDir,
    publicUrl,
    isProduction: env.NODE_ENV === "production",
  };
}

/** 会话密钥文件名（位于 DATA_DIR 下） */
const SECRET_KEY_FILE = "secret.key";

/** 合法密钥格式：crypto 随机 32 字节的 hex 表示，共 64 个字符 */
const SECRET_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 读取或生成 DATA_DIR/secret.key（§0.3：会话密钥首次启动自动生成）。
 * - 已存在且格式合法：原样复用，避免重启后已签发数据失效；
 * - 不存在或内容损坏：重新生成并以 0600 权限写入（Windows 会忽略该权限位，属尽力而为）。
 */
export function loadOrCreateSecretKey(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, SECRET_KEY_FILE);

  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (SECRET_KEY_PATTERN.test(existing)) {
      return existing;
    }
    // 内容不合法（如被手工编辑损坏）时重新生成，不带着坏密钥运行
  }

  const secret = randomBytes(32).toString("hex");
  writeFileSync(keyPath, secret, { mode: 0o600 });
  return secret;
}
