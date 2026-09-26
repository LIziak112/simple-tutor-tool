import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client";

/** 本文件所在目录：源码运行为 src/db；esbuild 打包后内联进 dist，运行时即 dist/ */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 定位迁移文件目录（drizzle-kit 产物，见 drizzle.config.ts 的 out 配置）。
 *
 * 两种运行形态：
 * - 源码运行（tsx dev / vitest）：本文件位于 src/db → src/db/migrations；
 * - 产物运行（node dist/index.js）：全部代码内联进 dist/index.js，import.meta.url
 *   指向 dist/，构建脚本（scripts/copy-migrations.mjs）会把 src/db/migrations
 *   拷贝到 dist/migrations → dist/migrations。
 *
 * 以 meta/_journal.json 是否存在判定，避免把不相关目录误认为迁移目录。
 */
export function resolveMigrationsFolder(): string {
  const candidates = [
    join(HERE, "migrations"), // 覆盖两种形态（src/db/migrations 与 dist/migrations）
    join(HERE, "db", "migrations"), // 兜底：产物若保留目录结构时
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "meta", "_journal.json"))) {
      return dir;
    }
  }
  throw new Error(
    `未找到数据库迁移目录（已尝试：${candidates.join("；")}）。请先运行 pnpm db:generate 生成迁移，或重新构建以拷贝迁移文件。`,
  );
}

/**
 * 对目标库执行全部未应用的迁移（drizzle 官方 better-sqlite3 migrator）。
 * 幂等：已记录在 __drizzle_migrations 表中的迁移不会重复执行，启动时可放心每次调用。
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });
}
