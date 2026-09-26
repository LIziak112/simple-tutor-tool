// 构建后处理：把 src/db/migrations 拷贝到 dist/migrations。
// 运行时（node dist/index.js）由 src/db/migrate.ts 的 resolveMigrationsFolder()
// 按 dist/migrations 找到迁移文件（drizzle 官方 migrate() 需要 .sql 文件在磁盘上，
// 无法打进 esbuild bundle），因此构建产物旁必须带上迁移目录。
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "db", "migrations");
const dest = join(here, "..", "dist", "migrations");

if (!existsSync(join(src, "meta", "_journal.json"))) {
  // 迁移文件随仓库提交，正常不会缺失；缺失说明有人在未生成迁移的情况下构建
  console.error(
    `迁移源目录不存在或不完整：${src}（请先运行 pnpm db:generate）`,
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`已拷贝迁移文件：${src} -> ${dest}`);
