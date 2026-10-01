import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, createDbHandle, staticDbHandle } from "./client";
import { runMigrations } from "./migrate";
import { teachers } from "./schema";

/** 每个用例独立的临时目录，测完整体清理（含 tutor.db / -wal / -shm） */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutor-t05-client-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createDb（文件库）", () => {
  it("WAL 与 foreign_keys 两个 PRAGMA 均生效", () => {
    const db = createDb(join(dir, "tutor.db"));
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    db.$client.close();
  });

  it("WAL 持久化在库文件中：重新打开仍是 wal 模式", () => {
    createDb(join(dir, "tutor.db")).$client.close();
    const db2 = createDb(join(dir, "tutor.db"));
    expect(db2.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    db2.$client.close();
  });
});

describe("createDbHandle（T4.5 可重启连接）", () => {
  it("db 引用在 restart 前后都读到当前数据（Proxy 转发到新底层）", () => {
    const dbPath = join(dir, "tutor.db");
    let opened = 0;
    const handle = createDbHandle(dbPath, (fresh) => {
      runMigrations(fresh);
      opened += 1;
    });
    expect(opened).toBe(1);

    // 首次连接写入一位教师，restart 前同一引用可读到
    handle.db
      .insert(teachers)
      .values({
        id: "t-handle-1",
        loginName: "a",
        isAdmin: true,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    expect(
      handle.db.select().from(teachers).where(eq(teachers.id, "t-handle-1")).get(),
    ).toBeDefined();

    handle.restart();
    expect(opened).toBe(2);
    // restart 后同一 db 引用仍可用，且读到的是磁盘上的既有数据
    expect(
      handle.db.select().from(teachers).where(eq(teachers.id, "t-handle-1")).get(),
    ).toBeDefined();
    // 迁移钩子让重开的库可直接使用（表结构就绪）
    handle.db
      .insert(teachers)
      .values({
        id: "t-handle-2",
        loginName: "b",
        isAdmin: false,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-01-02T00:00:00.000Z",
      })
      .run();
    handle.close();
  });

  it("close 释放文件：WAL 边车移除、文件可改名（Windows 文件锁解除）", () => {
    const dbPath = join(dir, "tutor.db");
    const handle = createDbHandle(dbPath, (fresh) => runMigrations(fresh));
    handle.db.select().from(teachers).all(); // 触发一次真实访问
    handle.close();
    expect(existsSync(dbPath)).toBe(true);
    // 干净关闭后 SQLite 删除 -wal/-shm 边车；库文件本身可自由改名
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    renameSync(dbPath, join(dir, "moved.db"));
    expect(existsSync(join(dir, "moved.db"))).toBe(true);
  });

  it("close 后再经 db 访问会抛错（连接确已关闭，不静默复用）", () => {
    const handle = createDbHandle(join(dir, "tutor.db"), (fresh) =>
      runMigrations(fresh),
    );
    handle.close();
    expect(() => handle.db.select().from(teachers).all()).toThrow();
  });
});

describe("staticDbHandle（缺省包装）", () => {
  it("db 原样透传；close/restart 抛明确中文错误", () => {
    const db = createDb(":memory:");
    const handle = staticDbHandle(db);
    expect(handle.db).toBe(db);
    expect(() => handle.close()).toThrow("无法执行恢复");
    expect(() => handle.restart()).toThrow("无法执行恢复");
    db.$client.close();
  });
});
