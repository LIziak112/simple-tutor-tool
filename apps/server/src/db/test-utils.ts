import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfills } from "./backfill";
import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";

/**
 * 测试数据库工厂：内存库（":memory:"）+ 跑全部迁移 + D23 数据搬迁
 * （与生产启动流程一致：runMigrations 之后执行 runBackfills，见 src/index.ts）。
 * 每次调用返回全新独立实例，互不干扰；用完可 db.$client.close() 释放，
 * 不关也会随进程退出回收。后续任务的服务层测试统一从这里取库。
 */
export function createTestDb(): Db {
  const db = createDb(":memory:");
  runMigrations(db);
  runBackfills(db);
  return db;
}

/** 测试用临时数据目录（T2.8 起笔迹文件落 DATA_DIR/blobs/ink/…；mkdtemp 每次全新） */
export function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "tutor-ink-test-"));
}
