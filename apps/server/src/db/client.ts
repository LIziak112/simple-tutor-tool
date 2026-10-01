import type { Database } from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
// 带 .ts 扩展名：本文件被 reparse CLI（Node 24 原生类型剥离运行）导入，
// 无扩展名的相对导入在原生 ESM 解析下会失败（见 tsconfig.base.json 注释）
import * as schema from "./schema.ts";

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
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
  } catch (err) {
    // pragma 失败（如文件不是数据库）：关掉句柄再抛，不泄漏 Windows 文件锁
    sqlite.close();
    throw err;
  }
  return drizzle(sqlite, { schema });
}

// ---------- 可重启数据连接（T4.5 备份恢复） ----------

/**
 * 带重启钩子的数据连接句柄（T4.5 恢复用）。
 *
 * 背景：恢复 = 整体替换 DATA_DIR 里的 tutor.db——Windows 上被打开的文件无法
 * 改名/替换，必须先 close 旧连接、换文件、再按同一路径重开；而 app 的全部
 * 路由/服务都在闭包里捕获了启动时的 Db 实例，逐个改签名代价过大。
 *
 * 方案：db 是一个转发 Proxy——任何属性访问都动态解析到**当前底层连接**
 * （函数属性绑定到当前实例，保证 drizzle 内部 this 正确）。路由闭包捕获的
 * 是这个 Proxy，restart() 换底层实例后无需重新组装 app，后续请求自动走新库。
 * 服务进程不重启（Phase4 清单 §4 T4.5 口径）。
 */
export interface DbHandle {
  /** 对外 Db：始终转发到当前底层连接（restore 前后同一引用都有效） */
  readonly db: Db;
  /** 关闭当前连接（恢复替换文件前调用；释放 Windows 文件锁与 WAL 边车） */
  close(): void;
  /** 关闭当前连接并按原路径重开（每次打开都执行 onOpen，如迁移与数据搬迁） */
  restart(): Db;
}

/** 重开连接后的初始化钩子（index.ts 传迁移 + 数据搬迁，与启动流程一致） */
export type DbOpenHook = (db: Db) => void;

export function createDbHandle(
  filename: string,
  onOpen?: DbOpenHook,
): DbHandle {
  let current = createDb(filename);
  onOpen?.(current);

  // 关闭幂等：已关闭的连接跳过（恢复回滚路径可能对同一句柄连续 restart）
  const safeClose = (): void => {
    if (current.$client.open) {
      current.$client.close();
    }
  };

  const db: Db = new Proxy({} as Db, {
    get(_target, prop): unknown {
      const value = Reflect.get(current as object, prop);
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(current)
        : value;
    },
    // 「'select' in db」之类的成员检测也转发到当前实例（防御性补齐）
    has(_target, prop): boolean {
      return Reflect.has(current as object, prop);
    },
  });

  return {
    db,
    close(): void {
      safeClose();
    },
    restart(): Db {
      safeClose();
      // createDb 自身失败已在内部关闭句柄；onOpen 失败时关掉半开的新连接再抛，
      // current 保持旧实例（已关闭）——两条路径都不泄漏文件锁
      const next = createDb(filename);
      try {
        onOpen?.(next);
      } catch (err) {
        if (next.$client.open) {
          next.$client.close();
        }
        throw err;
      }
      current = next;
      return current;
    },
  };
}

/**
 * 静态句柄（不可重启的缺省包装）。
 * createApp 未注入 dbHandle 时用它兜底：close/restart 会抛出明确中文错误——
 * 恢复在任何替换动作**之前**就调用 close，因此缺省句柄下恢复干净地失败，
 * 不会出现「文件换了、连接还是旧的」的静默不一致。生产入口（index.ts）
 * 永远传真实句柄；真实恢复行为的测试也必须自建文件库句柄。
 */
export function staticDbHandle(db: Db): DbHandle {
  const message = "该实例未配置可重启数据连接，无法执行恢复";
  return {
    db,
    close(): void {
      throw new Error(message);
    },
    restart(): Db {
      throw new Error(message);
    },
  };
}
