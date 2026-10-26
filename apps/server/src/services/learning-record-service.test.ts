import type {
  AssignmentCreateRequest,
  TeacherAssignment,
} from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { questions, students, units } from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { createAssignment } from "./assignment-service.ts";
import {
  saveDraftAnswer,
  startAttempt,
  submitAttempt,
} from "./attempt-service.ts";
import {
  getStudentLearningRecord,
  getTeacherLearningRecord,
} from "./learning-record-service.ts";

/**
 * 学习记录装配与泄露测试（LR-PR3，学习记录模型设计稿 §3/§7.2；LR-PR3 验收点）：
 * - 学生记录禁携清单（attemptId/studentId/questionId/answers/solutionMd/
 *   hints/teacherMark/teacherComment/reviewSource 恒缺席——schema superRefine
 *   结构性兜底，这里再断言语义层）；
 * - 题面公开投影：stemMd 与 nodes[].text 不携带可判定答案内容（PR3 评审提醒：
 *   泄露断言用 stemMdLeaksAnswers 的 AST 语义）；
 * - 判定公布 gate：on_submit 恒公布；after_due 截止前不含 autoCorrect/
 *   finalCorrect（与结果页同一 gate，D11：course/wrong/lesson 交卷即公布）；
 * - 教师记录教师域键齐备。
 */

const T0 = "2026-09-27T00:00:00.000Z";
const BEFORE_DUE = "2026-09-27T12:00:00.000Z";
const DUE_AT = "2026-09-27T18:00:00.000Z";

/** 答案原文（题干标记内；学生侧任何投影不得携带） */
const ANSWER_TEXT = "正确";

function seed(db: Db): { studentId: string; unitId: string } {
  const studentId = crypto.randomUUID();
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "张三",
      loginName: `zhang-${studentId.slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${studentId}`,
      createdAt: T0,
    })
    .run();
  const unitId = "u-lr";
  db.insert(units)
    .values({
      id: unitId,
      teacherId: TEST_TEACHER_ID,
      courseId: null,
      folderId: null,
      lectureId: null,
      title: "有理数运算",
      topic: null,
      order: 0,
      updatedAt: T0,
      deletedAt: null,
    })
    .run();
  db.insert(questions)
    .values({
      id: "lr-q1",
      teacherId: TEST_TEACHER_ID,
      unitId,
      order: 0,
      type: "judge",
      difficulty: 1,
      stemMd: `$0$ 既不是正数，也不是负数。[[${ANSWER_TEXT}]]`,
      optionsJson: null,
      answersJson: JSON.stringify({ kind: "judge", value: true }),
      hintsJson: JSON.stringify(["提示一：想想正负的定义"]),
      solutionMd: "$0$ 是正数与负数的分界点。",
      sourceMd: "::::question",
      version: 1,
      updatedAt: T0,
      deletedAt: null,
    })
    .run();
  return { studentId, unitId };
}

function createOneAssignment(
  db: Db,
  request: AssignmentCreateRequest,
): TeacherAssignment {
  const first = createAssignment(db, TEST_TEACHER_ID, request).assignments[0];
  if (first === undefined) {
    throw new Error("创建作业未产出首份");
  }
  return first;
}

/** 布置作业并交卷（判断题答「对」：判分为 true） */
function makeSubmittedAttempt(
  db: Db,
  options: {
    answerRelease?: "on_submit" | "after_due";
    dueAt?: string;
    submitAt?: string;
  },
): { studentId: string; assignmentId: string; attemptId: string } {
  const { studentId, unitId } = seed(db);
  const assignment = createOneAssignment(db, {
    unitIds: [unitId],
    studentIds: [studentId],
    ...(options.dueAt !== undefined ? { dueAt: options.dueAt } : {}),
    ...(options.answerRelease !== undefined
      ? { answerRelease: options.answerRelease }
      : {}),
  });
  const attempt = startAttempt(db, studentId, assignment.id);
  saveDraftAnswer(db, studentId, attempt.id, "lr-q1", {
    kind: "judge",
    value: true,
  });
  submitAttempt(db, studentId, attempt.id, options.submitAt ?? BEFORE_DUE);
  return { studentId, assignmentId: assignment.id, attemptId: attempt.id };
}

describe("learning-record 服务（LR-PR3 装配与泄露）", () => {
  it("学生记录：禁携清单 + 公开投影 + 已公布判定（on_submit）", () => {
    const db = createTestDb();
    const { studentId, attemptId } = makeSubmittedAttempt(db, {
      answerRelease: "on_submit",
    });
    // 材料全缺的场景不触 blob 读取：dataDir 传一个不存在路径即可
    const record = getStudentLearningRecord(
      db,
      "/tmp/unused-data-dir",
      studentId,
      attemptId,
      "lr-q1",
    );
    // 身份面禁携（schema superRefine 结构性兜底，这里断言语义层）
    expect(record.identity.attemptId).toBeUndefined();
    expect(record.identity.studentId).toBeUndefined();
    expect(record.identity.questionId).toBeUndefined();
    // 题面公开投影：stemMd 与 nodes[].text 不携带答案原文
    expect(stemMdLeaksAnswers(record.question.stemMd)).toBe(false);
    expect(record.question.stemMd).not.toContain(ANSWER_TEXT);
    for (const node of record.question.nodes) {
      if (node.text !== undefined) {
        expect(node.text).not.toContain(ANSWER_TEXT);
      }
    }
    // 教师域键恒缺席
    expect(record.question.answers).toBeUndefined();
    expect(record.question.solutionMd).toBeUndefined();
    expect(record.question.hints).toBeUndefined();
    expect(record.grading.teacherMark).toBeUndefined();
    expect(record.grading.teacherComment).toBeUndefined();
    expect(record.grading.reviewSource).toBeUndefined();
    // 已公布（on_submit）：判定携带；学生自己的行为计数携带
    expect(record.grading.autoCorrect).toBe(true);
    expect(record.grading.finalCorrect).toBe(true);
    expect(record.grading.hintsUsed).toBe(0);
    // 材料全缺：present:false 如实
    for (const material of record.ink) {
      expect(material.present).toBe(false);
    }
    // 时间线升序
    const ats = record.timeline.entries.map((entry) => entry.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    // 学生接口通用键名泄露矩阵（answer 面豁免：学生自己的答案非秘密，
    // review-pack 的 pack.json 同口径）
    assertNoLeak(record, { allow: ["answer"] });
  });

  it("学生记录：未公布（after_due 截止前）不含判定", () => {
    const db = createTestDb();
    const { studentId, attemptId } = makeSubmittedAttempt(db, {
      answerRelease: "after_due",
      dueAt: DUE_AT,
      submitAt: BEFORE_DUE,
    });
    const record = getStudentLearningRecord(
      db,
      "/tmp/unused-data-dir",
      studentId,
      attemptId,
      "lr-q1",
      new Date(BEFORE_DUE),
    );
    expect(record.grading.autoCorrect).toBeUndefined();
    expect(record.grading.finalCorrect).toBeUndefined();
  });

  it("教师记录：教师域键齐备（含答案/解析/提示原文与定位 id）", () => {
    const db = createTestDb();
    const { studentId, attemptId } = makeSubmittedAttempt(db, {
      answerRelease: "on_submit",
    });
    const record = getTeacherLearningRecord(
      db,
      "/tmp/unused-data-dir",
      TEST_TEACHER_ID,
      attemptId,
      "lr-q1",
    );
    expect(record.identity.attemptId).toBe(attemptId);
    expect(record.identity.studentId).toBe(studentId);
    expect(record.identity.questionId).toBe("lr-q1");
    expect(record.question.answers).toEqual({ kind: "judge", value: true });
    expect(record.question.solutionMd).not.toBe("");
    expect(record.question.hints).toEqual(["提示一：想想正负的定义"]);
    // 判定域全带（含教师域键——键存在即可，未批为 null）
    expect("teacherMark" in record.grading).toBe(true);
    expect("teacherComment" in record.grading).toBe(true);
    expect("reviewSource" in record.grading).toBe(true);
    // 教师题面原文：nodes 与学生侧同一键序列（公开投影枚举），但 stemMd 是原文
    expect(record.question.stemMd).toContain(ANSWER_TEXT);
    expect(record.question.nodes.map((node) => node.key)).toEqual(
      getStudentLearningRecord(
        db,
        "/tmp/unused-data-dir",
        studentId,
        attemptId,
        "lr-q1",
      ).question.nodes.map((node) => node.key),
    );
  });

  it("域外访问：他人学生的 attempt 404（不暴露存在性）", () => {
    const db = createTestDb();
    const { attemptId } = makeSubmittedAttempt(db, {
      answerRelease: "on_submit",
    });
    const outsiderId = crypto.randomUUID();
    db.insert(students)
      .values({
        id: outsiderId,
        teacherId: TEST_TEACHER_ID,
        displayName: "李四",
        loginName: `li-${outsiderId.slice(0, 8)}`,
        passwordHash: null,
        linkToken: `link-${outsiderId}`,
        createdAt: T0,
      })
      .run();
    expect(() =>
      getStudentLearningRecord(
        db,
        "/tmp/unused-data-dir",
        outsiderId,
        attemptId,
        "lr-q1",
      ),
    ).toThrow(/只能查看自己的作答/);
  });
});
