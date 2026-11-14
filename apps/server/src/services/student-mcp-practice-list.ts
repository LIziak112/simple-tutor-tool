import {
  attemptPhaseOf,
  type StudentMcpPracticeListData,
  type StudentMcpPracticeListInput,
  studentMcpPracticeListDataSchema,
  studentRecordsQuerySchema,
} from "@tutor/contract";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { attemptSourceMeta } from "./attempt-rows.ts";
import { attemptWorkflowView } from "./practice-workflow-wiring.ts";
import { assertStudentMcpListMetadata } from "./student-mcp-practice-metadata.ts";
import { listStudentRecords } from "./student-records.ts";

/**
 * 复用本人记录的可见性/排序，只选择公开索引字段；不取题面、不触发冻结/激活。
 * 元数据可列出不授予后续AI读题权限，目录和单题须另外实时裁决。
 */
export function listStudentMcpPractices(
  db: Db,
  studentId: string,
  input: StudentMcpPracticeListInput,
  now: Date | string = new Date(),
): StudentMcpPracticeListData {
  return db.transaction(() => {
    const { records, total } = listStudentRecords(
      db,
      studentId,
      studentRecordsQuerySchema.parse({ ...input, limit: input.limit ?? 20 }),
      now,
    );
    const rows =
      records.length === 0
        ? []
        : db
            .select()
            .from(attempts)
            .where(
              and(
                eq(attempts.studentId, studentId),
                inArray(
                  attempts.id,
                  records.map((record) => record.attemptId),
                ),
              ),
            )
            .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const data = studentMcpPracticeListDataSchema.parse({
      schemaVersion: 1,
      total,
      practices: records.map((record) => {
        const row = byId.get(record.attemptId);
        if (row === undefined)
          throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
        return {
          practiceId: record.attemptId,
          title: attemptSourceMeta(db, row).title,
          sourceType: record.sourceType,
          status: record.status,
          activatedAt: row.activatedAt,
          frozenAt: row.frozenAt,
          phase: attemptPhaseOf(row),
          startedAt: record.startedAt,
          submittedAt: record.submittedAt,
          answerProgress: record.answerProgress ?? null,
          submissionProgress:
            record.practiceSubmittedCount === undefined ||
            record.practiceQuestionCount === undefined
              ? null
              : {
                  submittedCount: record.practiceSubmittedCount,
                  totalCount: record.practiceQuestionCount,
                },
          practiceWorkflow:
            attemptWorkflowView(db, row, now)?.practiceWorkflow ?? null,
        };
      }),
    });
    assertStudentMcpListMetadata(data);
    return data;
  });
}
