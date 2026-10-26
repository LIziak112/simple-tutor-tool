import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.ts";
import {
  assignments,
  assignmentUnits,
  students,
  teachers,
  units,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { resolveNewAttemptWorkflow } from "./practice-workflow-wiring.ts";

/**
 * M5-D2 建卷工作流接线集成测试：文档推荐（units.practice_defaults_json 的
 * feedback 值）进入新建卷裁决链——assignment 多单元一致才采纳、冲突回学生
 * 偏好/缺省（预裁决⑥）、course 直取该单元推荐、wrong 恒无推荐（预裁决②）；
 * 学生显式选择恒最高优先（总计划 §5.4 档 2），教师限制最终裁决。
 * 坏 JSON/契约失败 → null + console.warn（与 M5-D1 practiceYamlLineOf 同口径）。
 */

const NOW = "2026-10-23T00:00:00.000Z";

const STUDENT_ID = "stu-wiring-0001";

function seedStudent(db: Db): void {
  db.insert(students)
    .values({
      id: STUDENT_ID,
      teacherId: TEST_TEACHER_ID,
      displayName: "接线测试学生",
      loginName: "wiring-stu",
      passwordHash: null,
      linkToken: "tok-wiring",
      createdAt: NOW,
    })
    .run();
}

function seedUnit(
  db: Db,
  practiceDefaultsJson: string | null,
  id = crypto.randomUUID(),
): string {
  db.insert(units)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      title: `单元 ${id.slice(0, 6)}`,
      order: 0,
      updatedAt: NOW,
      practiceDefaultsJson,
    })
    .run();
  return id;
}

function seedAssignment(
  db: Db,
  unitIds: string[],
  allowPerQuestionFeedback = true,
): string {
  const id = crypto.randomUUID();
  db.insert(assignments)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      title: "接线测试作业",
      dueAt: null,
      answerRelease: "on_submit",
      allowPerQuestionFeedback,
      createdAt: NOW,
    })
    .run();
  for (const [index, unitId] of unitIds.entries()) {
    db.insert(assignmentUnits)
      .values({ assignmentId: id, unitId, order: index })
      .run();
  }
  return id;
}

function feedbackColumnsOf(
  db: Db,
  input: Parameters<typeof resolveNewAttemptWorkflow>[1],
) {
  return resolveNewAttemptWorkflow(db, input);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveNewAttemptWorkflow：course 单元推荐（M5-D2）", () => {
  it("单元推荐 after_attempt 且学生未选择 → 建卷列 after_attempt", () => {
    const db = createTestDb();
    seedStudent(db);
    const unitId = seedUnit(db, JSON.stringify({ feedback: "after_attempt" }));
    expect(
      feedbackColumnsOf(db, {
        sourceType: "course",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId,
        studentChoice: null,
      }),
    ).toEqual({
      practiceWorkflowVersion: 1,
      feedbackMode: "after_attempt",
      workflowRevision: 0,
    });
  });

  it("学生显式选择优先于推荐；单元无推荐回缺省 per_question", () => {
    const db = createTestDb();
    seedStudent(db);
    const recommended = seedUnit(
      db,
      JSON.stringify({ feedback: "after_attempt" }),
    );
    expect(
      feedbackColumnsOf(db, {
        sourceType: "course",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId: recommended,
        studentChoice: "per_question",
      }).feedbackMode,
    ).toBe("per_question");
    // 无推荐（null 列）→ 缺省 per_question
    const plain = seedUnit(db, null);
    expect(
      feedbackColumnsOf(db, {
        sourceType: "course",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId: plain,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");
  });

  it("教师策略 after_attempt 收敛推荐 per_question（教师限制最终裁决）", () => {
    const db = createTestDb();
    seedStudent(db);
    db.update(teachers)
      .set({ practiceFeedbackPolicy: "after_attempt" })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    const unitId = seedUnit(db, JSON.stringify({ feedback: "per_question" }));
    expect(
      feedbackColumnsOf(db, {
        sourceType: "course",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("after_attempt");
  });

  it("坏 JSON → 无推荐 + console.warn（不抛错，回学生偏好/缺省）", () => {
    const db = createTestDb();
    seedStudent(db);
    const unitId = seedUnit(db, "{broken json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      feedbackColumnsOf(db, {
        sourceType: "course",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");
    expect(warn).toHaveBeenCalled();
  });

  it("契约失败（非法枚举值）→ 无推荐 + console.warn", () => {
    const db = createTestDb();
    seedStudent(db);
    const unitId = seedUnit(db, JSON.stringify({ feedback: "immediate" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      feedbackColumnsOf(db, {
        sourceType: "course",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");
    expect(warn).toHaveBeenCalled();
  });
});

describe("resolveNewAttemptWorkflow：assignment 多单元一致才采纳（预裁决⑥）", () => {
  it("两单元推荐一致 after_attempt → 采纳；部分单元无推荐时非空一致仍采纳", () => {
    const db = createTestDb();
    seedStudent(db);
    const a = seedUnit(db, JSON.stringify({ feedback: "after_attempt" }));
    const b = seedUnit(db, JSON.stringify({ feedback: "after_attempt" }));
    const assignmentId = seedAssignment(db, [a, b]);
    expect(
      feedbackColumnsOf(db, {
        sourceType: "assignment",
        studentId: STUDENT_ID,
        assignmentId,
        unitId: null,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("after_attempt");

    // 一个有推荐 + 一个无推荐：无推荐单元不参与，非空一致 → 采纳
    const c = seedUnit(db, JSON.stringify({ feedback: "per_question" }));
    const d = seedUnit(db, null);
    const mixed = seedAssignment(db, [c, d]);
    expect(
      feedbackColumnsOf(db, {
        sourceType: "assignment",
        studentId: STUDENT_ID,
        assignmentId: mixed,
        unitId: null,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");
  });

  it("两单元推荐冲突 → 忽略推荐回缺省；学生选择不受冲突影响", () => {
    const db = createTestDb();
    seedStudent(db);
    const a = seedUnit(db, JSON.stringify({ feedback: "after_attempt" }));
    const b = seedUnit(db, JSON.stringify({ feedback: "per_question" }));
    const assignmentId = seedAssignment(db, [a, b]);
    expect(
      feedbackColumnsOf(db, {
        sourceType: "assignment",
        studentId: STUDENT_ID,
        assignmentId,
        unitId: null,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");
    expect(
      feedbackColumnsOf(db, {
        sourceType: "assignment",
        studentId: STUDENT_ID,
        assignmentId,
        unitId: null,
        studentChoice: "after_attempt",
      }).feedbackMode,
    ).toBe("after_attempt");
  });

  it("作业全部单元无推荐 → 缺省；作业未授权逐题时推荐 per_question 被收敛", () => {
    const db = createTestDb();
    seedStudent(db);
    const a = seedUnit(db, null);
    const noRec = seedAssignment(db, [a]);
    expect(
      feedbackColumnsOf(db, {
        sourceType: "assignment",
        studentId: STUDENT_ID,
        assignmentId: noRec,
        unitId: null,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");

    const b = seedUnit(db, JSON.stringify({ feedback: "per_question" }));
    const restricted = seedAssignment(db, [b], false);
    expect(
      feedbackColumnsOf(db, {
        sourceType: "assignment",
        studentId: STUDENT_ID,
        assignmentId: restricted,
        unitId: null,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("after_attempt");
  });
});

describe("resolveNewAttemptWorkflow：wrong 来源不读推荐（预裁决②）", () => {
  it("恒按学生偏好/缺省裁决，unitId 传入也被无视", () => {
    const db = createTestDb();
    seedStudent(db);
    const unitId = seedUnit(db, JSON.stringify({ feedback: "after_attempt" }));
    expect(
      feedbackColumnsOf(db, {
        sourceType: "wrong",
        studentId: STUDENT_ID,
        assignmentId: null,
        unitId,
        studentChoice: null,
      }).feedbackMode,
    ).toBe("per_question");
  });
});
