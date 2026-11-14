import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { students } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { makeStudent } from "../test/note-fixtures";
import { deleteMemo } from "./memo-read";
import { createTextMemo } from "./memo-service";
import {
  listSharedMemos,
  revokeMemoShare,
  sharedMemoRow,
  shareMemo,
} from "./memo-sharing";

describe("逐条分享权限", () => {
  it("默认私密、逐条授权、撤回/软删即时生效，不投影设备和上下文", () => {
    const db = createTestDb();
    const studentId = makeStudent(db);
    const add = (text: string) =>
      createTextMemo(db, { studentId, clientId: randomUUID(), text }).memo;
    const memo = add("分享内容");
    add("私人哨兵");
    expect(listSharedMemos(db, TEST_TEACHER_ID, studentId).memos).toEqual([]);
    expect(() =>
      sharedMemoRow(db, TEST_TEACHER_ID, studentId, memo.id),
    ).toThrow();
    shareMemo(db, studentId, memo.id, TEST_TEACHER_ID);
    const list = listSharedMemos(db, TEST_TEACHER_ID, studentId);
    expect(list.memos.map((m) => m.text)).toEqual(["分享内容"]);
    expect(list.memos[0]).not.toHaveProperty("context");
    expect(list.memos[0]).not.toHaveProperty("deviceId");
    revokeMemoShare(db, studentId, memo.id);
    expect(() =>
      sharedMemoRow(db, TEST_TEACHER_ID, studentId, memo.id),
    ).toThrow();
    shareMemo(db, studentId, memo.id, TEST_TEACHER_ID);
    deleteMemo(db, studentId, memo.id);
    expect(listSharedMemos(db, TEST_TEACHER_ID, studentId).memos).toEqual([]);
  });
  it("跨教师、跨学生、归档后拒绝读取和授权", () => {
    const db = createTestDb();
    const a = makeStudent(db);
    const b = makeStudent(db);
    const memo = createTextMemo(db, {
      studentId: a,
      clientId: randomUUID(),
      text: "哨兵",
    }).memo;
    expect(() => shareMemo(db, b, memo.id, TEST_TEACHER_ID)).toThrow();
    expect(() => shareMemo(db, a, memo.id, "other")).toThrow();
    shareMemo(db, a, memo.id, TEST_TEACHER_ID);
    expect(() => listSharedMemos(db, "other", a)).toThrow();
    db.update(students)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(students.id, a))
      .run();
    expect(() => sharedMemoRow(db, TEST_TEACHER_ID, a, memo.id)).toThrow();
  });
});
