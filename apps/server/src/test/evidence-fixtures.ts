import { randomUUID } from "node:crypto";
import type { Question } from "@tutor/contract";
import { questionSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  attempts as attemptsTable,
  responses as responsesTable,
} from "../db/schema.ts";
import { newDraftAttempt } from "../services/attempt-service.ts";

/**
 * T6R.12 证据装配测试共享夹具（复审 D14：question-evidence.test 与
 * export-service.test 的 v2 describe 原各自手写四件套收敛）：
 * - snapshotJsonOf：合法 Question 快照 JSON（questionSchema.parse 锁定）；
 * - frozenDraftAttempt：直插 draft attempt + 逐题冻结 responses 行
 *   （questionSnapshotJson=null 的升级遗留行也走这里——正路写入器
 *   insertFrozenResponse 不接受空快照，历史行只能直插）；
 * - submitAttemptStatus：attempt 直插已交卷状态（不经 submitAttempt——
 *   证据行由夹具自管，T6R.10 起有笔记的卷走服务端交卷会被证据校验拒绝）。
 */

/** 构造合法 Question 快照 JSON（缺省 fill/难度 2/单考点/无提示；按覆盖片段合并） */
export function snapshotJsonOf(
  question: Partial<Question> & { id: string },
): string {
  return JSON.stringify(
    questionSchema.parse({
      type: "fill",
      difficulty: 2,
      knowledge: ["考点"],
      stemMd: `题干 ${question.id}`,
      hints: [],
      sourceMd: `::::question{id="${question.id}"}\n:::\n`,
      ...question,
    }),
  );
}

/** 直插 draft attempt + 冻结行；返回 attempt id 与行 id 序（= 插入序 = 展示序） */
export function frozenDraftAttempt(
  db: Db,
  studentId: string,
  questions: ReadonlyArray<{
    questionId: string;
    snapshotJson: string | null;
  }>,
): { attemptId: string; rowIds: string[] } {
  const attempt = newDraftAttempt({
    id: randomUUID(),
    studentId,
    sourceType: "assignment",
    assignmentId: null,
    courseId: null,
    unitId: null,
    attemptNo: 1,
    startedAt: "2026-10-01T00:00:00.000Z",
  });
  const rowIds: string[] = [];
  db.insert(attemptsTable).values(attempt).run();
  for (const question of questions) {
    const rowId = randomUUID();
    db.insert(responsesTable)
      .values({
        id: rowId,
        attemptId: attempt.id,
        questionId: question.questionId,
        questionVersion: 1,
        questionSnapshotJson: question.snapshotJson,
        unitId: null,
        answerJson: null,
        autoCorrect: null,
        finalCorrect: null,
        teacherMark: null,
        teacherComment: null,
        activeSec: null,
        hintsUsed: 0,
        changeCount: 0,
        inkId: null,
        hintsOpenedJson: null,
      })
      .run();
    rowIds.push(rowId);
  }
  return { attemptId: attempt.id, rowIds };
}

/** attempt 直插已交卷状态（submittedAt 为 UTC ISO） */
export function submitAttemptStatus(
  db: Db,
  attemptId: string,
  submittedAt = "2026-10-02T00:00:00.000Z",
): void {
  db.update(attemptsTable)
    .set({ status: "submitted", submittedAt })
    .where(eq(attemptsTable.id, attemptId))
    .run();
}
