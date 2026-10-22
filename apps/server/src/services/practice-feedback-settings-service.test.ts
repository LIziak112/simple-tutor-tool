import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import {
  getPracticeFeedbackSettings,
  updatePracticeFeedbackSettings,
} from "./practice-feedback-settings-service";

/**
 * M1b 教师实践反馈默认策略服务测试（2026-10-22 计划 §5.2）：
 * - 未配置（NULL）→ null（仅新普通自由练习按 student_choice 缺省，由 resolver 处理）；
 * - 异常持久化值兜底 after_attempt（保守，不意外授权逐题反馈）；
 * - 更新只写本教师行（教师域隔离）。
 */

const OTHER_TEACHER_ID = "teacher-b-m1b-practice";

function withOtherTeacher(db: Db): void {
  db.insert(teachers)
    .values({
      id: OTHER_TEACHER_ID,
      loginName: "teacher-b-m1b",
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
}

/** 直接改列（模拟手工数据/历史写入） */
function setColumn(db: Db, teacherId: string, value: string | null): void {
  db.update(teachers)
    .set({ practiceFeedbackPolicy: value as never })
    .where(eq(teachers.id, teacherId))
    .run();
}

describe("getPracticeFeedbackSettings", () => {
  it("未配置（NULL）→ policy null", () => {
    const db = createTestDb();
    expect(getPracticeFeedbackSettings(db, TEST_TEACHER_ID)).toEqual({
      practiceFeedbackPolicy: null,
    });
  });

  it("已配置枚举值原样读回", () => {
    const db = createTestDb();
    setColumn(db, TEST_TEACHER_ID, "after_attempt");
    expect(getPracticeFeedbackSettings(db, TEST_TEACHER_ID)).toEqual({
      practiceFeedbackPolicy: "after_attempt",
    });
    setColumn(db, TEST_TEACHER_ID, "student_choice");
    expect(getPracticeFeedbackSettings(db, TEST_TEACHER_ID)).toEqual({
      practiceFeedbackPolicy: "student_choice",
    });
  });

  it("异常持久化值兜底 after_attempt（fail closed，不意外授权）", () => {
    const db = createTestDb();
    setColumn(db, TEST_TEACHER_ID, "everyone_can_see");
    expect(getPracticeFeedbackSettings(db, TEST_TEACHER_ID)).toEqual({
      practiceFeedbackPolicy: "after_attempt",
    });
  });

  it("教师不存在 → 404", () => {
    const db = createTestDb();
    expect(() => getPracticeFeedbackSettings(db, "teacher-not-exist")).toThrow(
      /教师不存在/,
    );
  });
});

describe("updatePracticeFeedbackSettings", () => {
  it("写入并读回；教师域隔离（他师不受影响）", () => {
    const db = createTestDb();
    withOtherTeacher(db);
    const updated = updatePracticeFeedbackSettings(db, TEST_TEACHER_ID, {
      practiceFeedbackPolicy: "after_attempt",
    });
    expect(updated).toEqual({ practiceFeedbackPolicy: "after_attempt" });
    expect(getPracticeFeedbackSettings(db, OTHER_TEACHER_ID)).toEqual({
      practiceFeedbackPolicy: null,
    });
  });

  it("可以改回 student_choice（二选一覆盖写）", () => {
    const db = createTestDb();
    updatePracticeFeedbackSettings(db, TEST_TEACHER_ID, {
      practiceFeedbackPolicy: "after_attempt",
    });
    const updated = updatePracticeFeedbackSettings(db, TEST_TEACHER_ID, {
      practiceFeedbackPolicy: "student_choice",
    });
    expect(updated).toEqual({ practiceFeedbackPolicy: "student_choice" });
    expect(getPracticeFeedbackSettings(db, TEST_TEACHER_ID)).toEqual({
      practiceFeedbackPolicy: "student_choice",
    });
  });

  it("教师不存在 → 404，不写任何行", () => {
    const db = createTestDb();
    expect(() =>
      updatePracticeFeedbackSettings(db, "teacher-not-exist", {
        practiceFeedbackPolicy: "after_attempt",
      }),
    ).toThrow(/教师不存在/);
  });
});
