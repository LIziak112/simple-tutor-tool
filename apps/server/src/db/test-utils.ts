import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";

/**
 * 测试数据库工厂：内存库（":memory:"）+ 跑全部迁移。
 * 每次调用返回全新独立实例，互不干扰；用完可 db.$client.close() 释放，
 * 不关也会随进程退出回收。后续任务的服务层测试统一从这里取库。
 */
export function createTestDb(): Db {
  const db = createDb(":memory:");
  runMigrations(db);
  return db;
}
