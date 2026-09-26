import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";

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
