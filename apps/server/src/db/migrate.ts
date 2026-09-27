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
 *
 * 外键处理（T2A.1 起 0010 迁移含 lectures/units 表重建——去 courseId 外键）：
 * SQLite 官方对「改列/删外键」类结构变更的推荐流程是 PRAGMA foreign_keys=OFF
 * 期间重建表（迁移文件里 drizzle-kit 也生成了该 PRAGMA，但 migrator 把全部语句包在
 * 单个事务里，事务内的 PRAGMA 是 no-op），因此这里在调用 migrator 前后显式切换：
 * 关外键 → 执行迁移 → 开外键 → PRAGMA foreign_key_check 全库校验，有孤儿引用即抛错。
 */
export function runMigrations(db: Db): void {
  db.$client.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  } finally {
    db.$client.pragma("foreign_keys = ON");
  }
  const violations = db.$client.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `迁移后外键完整性校验失败（foreign_key_check 发现 ${violations.length} 处孤儿引用，首条：${JSON.stringify(
        violations[0],
      )}）。请勿继续使用该数据库并检查迁移内容。`,
    );
  }
}
