import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createStudentSession } from "../auth/session.ts";
import { memos, sessions } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import {
  bindDeviceSession,
  listDevices,
  mergeDevices,
  registerDevice,
  renameDevice,
  revokeDeviceSessions,
} from "./device-service.ts";
import { deleteMemo } from "./memo-read.ts";
import { createTextMemo } from "./memo-service.ts";

describe("设备与随笔元数据", () => {
  it("设备登记按账号隔离、重复登记保留名字与首次使用时间", () => {
    const db = createTestDb();
    const owner = { type: "student" as const, id: makeStudent(db) };
    const other = { ...owner, id: makeStudent(db) };
    const deviceId = randomUUID();
    registerDevice(
      db,
      owner,
      { deviceId, type: "tablet", os: "iPad", browser: "Safari" },
      new Date("2026-01-01"),
    );
    renameDevice(db, owner, deviceId, "书桌的 iPad");
    const again = registerDevice(
      db,
      owner,
      { deviceId, type: "tablet", standalone: true },
      new Date("2026-01-02"),
    );
    expect(again).toMatchObject({
      displayName: "书桌的 iPad",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    });
    expect(listDevices(db, other).devices).toEqual([]);
    expect(() => renameDevice(db, other, deviceId, "冒用")).toThrow();
  });
  it("同设备绑定去除旧会话，合并保留引用，下线只撤销本人该设备", () => {
    const db = createTestDb();
    const owner = { type: "student" as const, id: makeStudent(db) };
    const first = randomUUID();
    const second = randomUUID();
    registerDevice(db, owner, { deviceId: first, type: "desktop" });
    registerDevice(db, owner, { deviceId: second, type: "desktop" });
    const s1 = createStudentSession(db, owner.id).token;
    const s2 = createStudentSession(db, owner.id).token;
    bindDeviceSession(db, owner, first, s1);
    bindDeviceSession(db, owner, first, s2);
    expect(
      db.select().from(sessions).where(eq(sessions.id, s1)).get(),
    ).toBeUndefined();
    const memo = createTextMemo(db, {
      studentId: owner.id,
      clientId: randomUUID(),
      text: "记录",
      deviceId: first,
    }).memo;
    mergeDevices(db, owner, first, second);
    expect(
      db.select().from(memos).where(eq(memos.id, memo.id)).get()?.deviceId,
    ).toBe(second);
    expect(listDevices(db, owner).devices).toHaveLength(1);
    expect(revokeDeviceSessions(db, owner, first)).toBe(1);
    expect(
      db.select().from(sessions).where(eq(sessions.id, s2)).get(),
    ).toBeUndefined();
  });
  it("随笔序号按本人分配、重放不占号、软删不回收，设备须本人已登记", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const clientId = randomUUID();
    const first = createTextMemo(db, {
      studentId,
      clientId,
      text: "第一条",
    }).memo;
    expect(first.seq).toBe(1);
    expect(
      createTextMemo(db, { studentId, clientId, text: "重放" }).memo.seq,
    ).toBe(1);
    deleteMemo(db, studentId, first.id);
    expect(
      createTextMemo(db, { studentId, clientId: randomUUID(), text: "第二条" })
        .memo.seq,
    ).toBe(2);
    expect(
      createTextMemo(db, {
        studentId: makeStudent(db),
        clientId: randomUUID(),
        text: "另一人",
      }).memo.seq,
    ).toBe(1);
    expect(() =>
      createTextMemo(db, {
        studentId,
        clientId: randomUUID(),
        text: "伪设备",
        deviceId: randomUUID(),
      }),
    ).toThrow();
  });
});
