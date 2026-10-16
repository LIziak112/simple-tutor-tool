import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Db } from "../db/client.ts";
import {
  aiConnections,
  assignments,
  attempts,
  responses,
} from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";

/**
 * 学生端 AI 伴学测试共享夹具（SAI-11/12 收敛；直插行形态）。
 *
 * student-ai-materials.test.ts 与 student-ai-queue.test.ts 此前各持一份
 * 逐字/近似拷贝（insertResponse、expectHttpError、insertAssignment/
 * insertAttempt）；student-ai-context.test.ts 与 teaching-policy-
 * service.test.ts 的同形态拷贝归后续批次迁移，本模块不强制一次收编。
 * 时间基准固定 2026-06-01T00:00:00.000Z（两文件原常量同瞬）。
 */

/** 夹具固定时间基准（NOW / iso(0) 的公共值） */
export const AI_TEST_AT = "2026-06-01T00:00:00.000Z";

export function insertAssignment(db: Db, teacherId = TEST_TEACHER_ID): string {
  const id = randomUUID();
  db.insert(assignments)
    .values({
      id,
      teacherId,
      title: "作业",
      dueAt: null,
      answerRelease: "on_submit",
      createdAt: AI_TEST_AT,
    })
    .run();
  return id;
}

export function insertAttempt(
  db: Db,
  row: {
    studentId: string;
    /** 缺省自动新建一份作业（单卷场景） */
    assignmentId?: string;
    status?: "draft";
  },
): string {
  const id = randomUUID();
  db.insert(attempts)
    .values({
      id,
      studentId: row.studentId,
      sourceType: "assignment",
      assignmentId: row.assignmentId ?? insertAssignment(db),
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo: 1,
      status: row.status ?? "draft",
      startedAt: AI_TEST_AT,
      frozenAt: AI_TEST_AT,
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return id;
}

/**
 * 给学生插一条 active 连接（mcp 形态最简——无密文装配）：create 路由的
 * 知情门只看连接存在性（status firstUseRequired 同口径），测试需要构造
 * 无连接态时自行删除该行。
 */
export function insertAiConnectionFixture(
  db: Db,
  studentId: string,
): string {
  const id = randomUUID();
  db.insert(aiConnections)
    .values({
      id,
      studentId,
      channel: "mcp",
      isDefault: true,
      configJson: JSON.stringify({
        tokenHash: `test-hash-${studentId}`,
        tokenFingerprint: `test-fp-${studentId}`,
      }),
      verifyStatus: "unverified",
      verifiedAt: null,
      createdAt: AI_TEST_AT,
      updatedAt: AI_TEST_AT,
      archivedAt: null,
    })
    .run();
  return id;
}

export function insertResponse(
  db: Db,
  attemptId: string,
  questionId: string,
): string {
  const id = randomUUID();
  db.insert(responses)
    .values({
      id,
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: "题干",
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: "解析",
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson: null,
      submittedAt: null,
      teacherComment: null,
    })
    .run();
  return id;
}

/** 断言 fn 抛出指定 status/code 的 HttpError 并返回该错误（可续断言消息） */
export function expectHttpError(
  fn: () => unknown,
  status: number,
  code: string,
): HttpError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const httpError = error as HttpError;
    expect(httpError.status).toBe(status);
    expect(httpError.code).toBe(code);
    return httpError;
  }
  throw new Error(`期望抛出 HttpError ${status} ${code}，实际未抛出`);
}
