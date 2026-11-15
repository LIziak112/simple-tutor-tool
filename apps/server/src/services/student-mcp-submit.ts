import { createHash } from "node:crypto";
import {
  type PracticeQuestionSubmitWithAnswer,
  type StudentMcpSubmitInput,
  studentMcpSubmitReceiptSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts, responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { commitPracticeQuestion } from "./attempt-practice-submit.ts";
import { getPracticeQuestionFeedback } from "./attempt-question-feedback.ts";
import { frozenRowsInDisplayOrder } from "./attempt-rows.ts";
import { practiceRequestDigestOf } from "./practice-submit-intent.ts";
import { requireStudentMcpQuestionPolicy } from "./student-mcp-policy.ts";
import { assertStudentMcpFrozenMembers } from "./student-mcp-practice-paper.ts";

/** 请求内容确定的 UUID；不读取新草稿/证据头，不把响应版本或设备加入旧摘要。 */
export function mcpSubmissionMutationId(digest: string): string {
  const hex = createHash("sha256")
    .update(`mcp-submit-v2\0${digest}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function missing(): never {
  throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在或不可见");
}

export function submitStudentMcpQuestion(
  db: Db,
  studentId: string,
  input: StudentMcpSubmitInput,
  now = new Date(),
  connectionId: string | null = null,
) {
  // 仅题序输入仍必须携带被冻结行版本；按本人卷+行版本定位，不借新公开读门补版本。
  const questionId =
    input.questionId ??
    db
      .select({ questionId: responses.questionId })
      .from(responses)
      .innerJoin(attempts, eq(attempts.id, responses.attemptId))
      .where(
        and(
          eq(attempts.studentId, studentId),
          eq(attempts.id, input.practiceId),
          eq(responses.id, input.questionRevisionId),
        ),
      )
      .get()?.questionId;
  if (questionId === undefined) return missing();
  const request: PracticeQuestionSubmitWithAnswer = {
    workflowVersion: input.workflowVersion,
    workflowRevision: input.workflowRevision,
    questionRevisionId: input.questionRevisionId,
    expectedAnswerRevision: input.expectedAnswerRevision,
    evidence: input.evidence,
    submissionMutationId:
      input.submissionMutationId ?? "00000000-0000-4000-8000-000000000000",
    ...(input.answer === undefined ? {} : { answer: input.answer }),
  };
  request.submissionMutationId =
    input.submissionMutationId ??
    mcpSubmissionMutationId(
      practiceRequestDigestOf(input.practiceId, questionId, request),
    );
  // v2 会读取本题授权反馈，重试也须重验当前权限与 AI 设置。
  if (input.responseVersion === 2)
    requireStudentMcpQuestionPolicy(
      db,
      studentId,
      input.practiceId,
      questionId,
    );
  commitPracticeQuestion(
    db,
    studentId,
    input.practiceId,
    questionId,
    request,
    now,
    {
      origin: { channel: "mcp", connectionId },
      beforeFirstSubmission: () => {
        const policy = requireStudentMcpQuestionPolicy(
          db,
          studentId,
          input.practiceId,
          questionId,
        );
        assertStudentMcpFrozenMembers(db, input.practiceId);
        if (input.questionNo !== undefined) {
          const ordered = frozenRowsInDisplayOrder(db, policy.attempt);
          if (ordered[input.questionNo - 1]?.row.questionId !== questionId)
            throw new HttpError(
              409,
              "QUESTION_LOCATOR_MISMATCH",
              "题目id与显示题序不一致，请重新读取目录",
            );
        }
      },
    },
  );
  if (input.responseVersion !== 2) return { success: true };
  // 事实沿已提交行投影；反馈复用 HTTP 当前公布规则，绝不缓存旧秘密。
  const attempt = db
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.id, input.practiceId), eq(attempts.studentId, studentId)),
    )
    .get();
  if (!attempt) return missing();
  const ordered = frozenRowsInDisplayOrder(db, attempt).map(
    (entry) => entry.row,
  );
  const index = ordered.findIndex((row) => row.questionId === questionId);
  const row = ordered[index];
  if (!row || row.submittedAt === null) return missing();
  if (input.questionNo !== undefined && input.questionNo !== index + 1)
    throw new HttpError(
      409,
      "QUESTION_LOCATOR_MISMATCH",
      "题目id与显示题序不一致，请重新读取目录",
    );
  const next = ordered.findIndex((item) => item.submittedAt === null);
  return studentMcpSubmitReceiptSchema.parse({
    success: true,
    responseVersion: 2,
    practiceId: input.practiceId,
    questionId,
    questionRevisionId: row.id,
    questionNo: index + 1,
    submittedAt: row.submittedAt,
    submissionMutationId: request.submissionMutationId,
    settlementSeq: row.settlementSeq,
    feedback: getPracticeQuestionFeedback(
      db,
      studentId,
      input.practiceId,
      questionId,
      now,
    ).feedback,
    progress: {
      submittedCount: ordered.filter((item) => item.submittedAt !== null)
        .length,
      totalCount: ordered.length,
    },
    nextQuestion:
      next < 0
        ? null
        : { questionId: ordered[next]?.questionId, questionNo: next + 1 },
  });
}
