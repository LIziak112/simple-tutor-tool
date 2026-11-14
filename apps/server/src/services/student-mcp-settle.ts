import type { StudentMcpSettleInput } from "@tutor/contract";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { settleStudentAttempt } from "./attempt-partial.ts";
import { requireStudentMcpQuestionPolicy } from "./student-mcp-policy.ts";

/** 网页分批事务是唯一写路径；当前 AI 门在同一事务中覆盖新成员及成功重放。 */
export function settleStudentMcpPractice(
  db: Db,
  studentId: string,
  input: StudentMcpSettleInput,
  now = new Date(),
  connectionId: string | null = null,
) {
  return settleStudentAttempt(db, studentId, input.practiceId, input, now, {
    origin: { channel: "mcp", connectionId },
    beforeSettlement: (existingSeq) => {
      // 网页批次会收拢此前逐题提交但未归批的成员；它们也须实时通过 AI 门。
      const rows = db
        .select({ questionId: responses.questionId })
        .from(responses)
        .where(
          and(
            eq(responses.attemptId, input.practiceId),
            existingSeq === null
              ? and(
                  isNull(responses.settlementSeq),
                  isNotNull(responses.submittedAt),
                )
              : eq(responses.settlementSeq, existingSeq),
          ),
        )
        .all();
      const ids = new Set([
        ...rows.map((row) => row.questionId),
        ...(existingSeq === null
          ? input.questions.map((q) => q.questionId)
          : []),
      ]);
      for (const questionId of ids)
        requireStudentMcpQuestionPolicy(
          db,
          studentId,
          input.practiceId,
          questionId,
        );
    },
  });
}
