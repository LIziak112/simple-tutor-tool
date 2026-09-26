import type { Database } from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/**
 * 数据库实例类型：绑定全部表定义。
 * 注意 drizzle() 的返回类型是 BetterSQLite3Database 与 { $client } 的交叉类型
 * （$client 不在类上），这里保持一致，才能用 db.$client 拿底层连接（pragma、close 等）。
 */
export type Db = BetterSQLite3Database<typeof schema> & {
  $client: Database;
};

/**
 * 打开（或创建）SQLite 数据库并包装为 Drizzle 实例。文件库与 ":memory:" 走同一入口：
 * - `PRAGMA journal_mode = WAL`：读写不互相阻塞、崩溃安全（内存库无持久化，自动回落 memory 模式，属正常）；
 * - `PRAGMA foreign_keys = ON`：SQLite 默认关闭外键约束，每个连接都要显式开启。
 *
 * 同步 API（better-sqlite3 特性），无需 await；连接随进程退出或显式 `db.$client.close()` 释放。
 */
export function createDb(filename: string): Db {
  const sqlite = new DatabaseCtor(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}
