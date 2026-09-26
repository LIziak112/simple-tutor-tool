/**
 * reparse CLI 入口（T1.14）：`pnpm reparse [--dry-run]`。
 * 依据：docs/技术架构与实施方案.md §5.1.1(4)（原文是真相：升级涉及结构化字段时
 * 用当前解析器从原文重新抽取，题目 id 不变）、docs/开发任务清单.md T1.14。
 *
 * - Node 24 原生类型剥离直接运行（相对导入带 .ts 扩展名，零额外依赖）；
 * - 数据库路径复用 readConfig() 的 DATA_DIR（默认 ./data）下的 tutor.db，
 *   测试与 CI 用 DATA_DIR 环境变量覆盖；
 * - 库文件不存在时报错退出（不自动创建空库，避免在错误目录误建数据）；
 * - 业务逻辑全部在 src/services/reparse-service.ts（reparseAll 纯服务函数，
 *   有完整测试），本脚本只负责连库、调函数、打印摘要；
 * - --dry-run：只输出变更摘要不写库；退出码 0 正常完成、2 用法/环境错误。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { readConfig } from "../src/config.ts";
import { createDb } from "../src/db/client.ts";
import {
  renderReparseReport,
  reparseAll,
} from "../src/services/reparse-service.ts";

const USAGE =
  "用法：pnpm reparse [--dry-run]（重抽取 questions.sourceMd / lectures.markdown 的结构化字段）";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--dry-run");
if (unknown.length > 0) {
  console.error(`未知参数：${unknown.join(" ")}\n${USAGE}`);
  process.exit(2);
}
const dryRun = args.includes("--dry-run");

const config = readConfig(process.env);
const dbPath = join(config.dataDir, "tutor.db");
if (!existsSync(dbPath)) {
  console.error(
    `数据库不存在：${dbPath}\n请确认 DATA_DIR 指向正确的数据目录（当前：${config.dataDir}），或先启动一次服务完成初始化。`,
  );
  process.exit(2);
}

const db = createDb(dbPath);
try {
  const report = reparseAll(db, { dryRun });
  console.log(renderReparseReport(report));
  console.log(`数据库：${dbPath}`);
} finally {
  db.$client.close();
}
