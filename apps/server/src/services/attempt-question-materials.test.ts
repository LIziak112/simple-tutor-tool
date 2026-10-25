import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { materialPublicSchema } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import {
  attemptContextSnapshots,
  courseItems,
  courseStudents,
  courses,
  questions,
  responses,
  students,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { frozenMaterialsForQuestion } from "./attempt-question-materials.ts";
import { startCourseAttempt } from "./attempt-service.ts";
import { commitImport } from "./content-service.ts";
import { snapshotOfRow } from "./snapshot.ts";

/**
 * QM-16/QM-17 共用闭包单源测试：组材料 ∪ 题级引用 → 全版本材料公开投影，
 * 正文槽位编号（{{slot-id}} → **（N）**，md-dsl 单源）、多版本徽标、
 * 无依赖空闭包。快照行由真实建卷链路（startCourseAttempt）冻结。
 */

const QM_MD = [
  "---",
  "kind: practice",
  "unit: 阅读单元",
  "---",
  "",
  "# 阅读练习",
  "",
  '::::material{title="阅读材料 A"}',
  "Passage with slot {{slot-1}} and second {{slot-2}}.",
  "::::",
  "",
  "::::material",
  "题级引用目标材料。",
  "::::",
  "",
  "::::group{title=阅读组}",
  "::ref{material=mat-阅读单元-1}",
  "::ref{question=阅读单元-1}",
  "::ref{question=阅读单元-2}",
  "::::",
  "",
  ":::::question{type=matching difficulty=2}",
  "按材料配对。",
  "::ref{material=mat-阅读单元-1 slots=slot-1..slot-2}",
  "",
  "::::options",
  ":::option{id=opt-1}",
  "甲项",
  ":::",
  ":::option{id=opt-2}",
  "乙项",
  ":::",
  ":::option{id=opt-3}",
  "干扰项",
  ":::",
  "::::",
  "",
  ":::answer",
  "slot-1 = opt-1",
  "slot-2 = opt-2",
  ":::",
  ":::::",
  "",
  "::::question{type=judge difficulty=1}",
  "组内独立判断题。[[正确]]",
  "::::",
  "",
  "::::question{type=solve difficulty=3}",
  "::ref{material=mat-阅读单元-2}",
  "题级引用材料的解答题。",
  "::::",
  "",
  "::::question{type=fill difficulty=2}",
  "无依赖填空题 [[42]]。",
  "::::",
].join("\n");

interface Env {
  db: Db;
  attemptId: string;
  matchingQuestionId: string;
  solveQuestionId: string;
  fillQuestionId: string;
}

function makeEnv(): Env {
  const db = createTestDb();
  const committed = commitImport(
    db,
    TEST_TEACHER_ID,
    { markdown: QM_MD, filename: "阅读.md" },
    undefined,
    undefined,
    true,
  );
  const unitId = committed.units[0]?.id ?? "";
  const byType = new Map(
    db
      .select({ id: questions.id, type: questions.type })
      .from(questions)
      .where(eq(questions.unitId, unitId))
      .all()
      .map((row) => [row.type, row.id]),
  );
  const courseId = "course-qm16-1";
  const studentId = "student-qm16-1";
  const now = "2026-10-25T10:00:00.000Z";
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "qm16 学生",
      loginName: "qm16-stu",
      passwordHash: null,
      linkToken: `link-${studentId}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: now,
    })
    .run();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "qm16 课程",
      order: 0,
      archivedAt: null,
      description: null,
      createdAt: now,
    })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId,
      kind: "unit",
      refId: unitId,
      title: null,
      order: 0,
      visible: true,
      publishAt: null,
      createdAt: now,
    })
    .run();
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: now })
    .run();
  const started = startCourseAttempt(db, studentId, courseId, unitId, {}, true);
  return {
    db,
    attemptId: started.id,
    matchingQuestionId: byType.get("matching") ?? "",
    solveQuestionId: byType.get("solve") ?? "",
    fillQuestionId: byType.get("fill") ?? "",
  };
}

function snapshotOfQuestion(db: Db, attemptId: string, questionId: string) {
  const row = db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all()
    .find((candidate) => candidate.questionId === questionId);
  return row === undefined ? null : snapshotOfRow(row);
}

describe("frozenMaterialsForQuestion（QM-16/QM-17 闭包单源）", () => {
  it("组成员题：组材料全版本投影，正文槽位编号与材料面板同口径", () => {
    const env = makeEnv();
    const materials = frozenMaterialsForQuestion(
      env.db,
      env.attemptId,
      env.matchingQuestionId,
      snapshotOfQuestion(env.db, env.attemptId, env.matchingQuestionId),
    );
    expect(materials).toHaveLength(1);
    expect(materials[0]?.title).toBe("阅读材料 A");
    expect(materials[0]?.contentMd).toBe(
      "Passage with slot **（1）** and second **（2）**.",
    );
  });

  it("题级引用题：materialRefs 的材料进闭包；无依赖题闭包为空", () => {
    const env = makeEnv();
    const solveMaterials = frozenMaterialsForQuestion(
      env.db,
      env.attemptId,
      env.solveQuestionId,
      snapshotOfQuestion(env.db, env.attemptId, env.solveQuestionId),
    );
    expect(solveMaterials.map((material) => material.contentMd)).toEqual([
      "题级引用目标材料。",
    ]);
    expect(
      frozenMaterialsForQuestion(
        env.db,
        env.attemptId,
        env.fillQuestionId,
        snapshotOfQuestion(env.db, env.attemptId, env.fillQuestionId),
      ),
    ).toEqual([]);
  });

  it("同 id 双版本：逐版成条、title 附历史版本说明、按版本升序", () => {
    const env = makeEnv();
    const base = env.db
      .select()
      .from(attemptContextSnapshots)
      .where(eq(attemptContextSnapshots.attemptId, env.attemptId))
      .all()
      .find((row) => row.kind === "material");
    if (base === undefined) throw new Error("建卷未冻结材料快照");
    const parsed = materialPublicSchema.parse(JSON.parse(base.snapshotJson));
    env.db
      .insert(attemptContextSnapshots)
      .values({
        id: "acs-qm16-v2",
        attemptId: env.attemptId,
        kind: "material",
        sourceId: base.sourceId,
        sourceVersion: base.sourceVersion + 1,
        snapshotJson: JSON.stringify({
          ...parsed,
          contentMd: "第二版正文 {{slot-1}}。",
        }),
        frozenAt: "2026-10-25T11:00:00.000Z",
      })
      .run();
    const materials = frozenMaterialsForQuestion(
      env.db,
      env.attemptId,
      env.matchingQuestionId,
      null,
    );
    expect(materials).toHaveLength(2);
    expect(materials.map((material) => material.title)).toEqual([
      "阅读材料 A（历史版本 1）",
      "阅读材料 A（历史版本 2）",
    ]);
    expect(materials[1]?.contentMd).toBe("第二版正文 **（1）**。");
  });

  it("坏快照跳过不抛错（导出侧防御口径）", () => {
    const env = makeEnv();
    env.db
      .update(attemptContextSnapshots)
      .set({ snapshotJson: "{not json" })
      .where(eq(attemptContextSnapshots.kind, "material"))
      .run();
    expect(
      frozenMaterialsForQuestion(
        env.db,
        env.attemptId,
        env.matchingQuestionId,
        null,
      ),
    ).toEqual([]);
  });
});
