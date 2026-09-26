import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置（在 apps/server 目录下运行）。
 * - `pnpm db:generate`（根或 server 包）：从 src/db/schema.ts 生成迁移到 src/db/migrations/，
 *   迁移文件随仓库提交（禁止手改已生成的迁移，见 db-change 技能红线）；
 * - 迁移产物随构建拷贝到 dist/migrations（scripts/copy-migrations.mjs），
 *   运行时由 src/db/migrate.ts 定位后用 drizzle 官方 migrate() 执行；
 * - dbCredentials 仅供 push / studio 等需要连库的子命令使用（generate 不连库），
 *   DATA_DIR 约定见 docs/开发任务清单.md §0.3。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: join(process.env.DATA_DIR?.trim() || "./data", "tutor.db"),
  },
});
