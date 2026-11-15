import {
  type LearningContext,
  type StudentMcpCurrentData,
  studentMcpCurrentDataSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { attempts } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import { mcpLiveContextGeneration } from "./ai-companion/connection-service.ts";
import { studentMcpFocusCandidates } from "./ai-companion/mcp-live-focus-registry.ts";
import {
  canLocateStudentMcpQuestion,
  getStudentMcpCurrentContext,
} from "./ai-companion/student-ai-live-context.ts";
import { contextFromMemoAnchor } from "./learning-context-projection.ts";
import { assertMetadataByteBudget } from "./memo-budget.ts";
import { listStudentMcpPractices } from "./student-mcp-practice-list.ts";

/** 只读取定位；不自动创建/领取求助，不把最近练习伪装成当前题。 */
export function getStudentMcpCurrentV2(
  db: Db,
  studentId: string,
  connectionId?: string,
  now = new Date(),
): StudentMcpCurrentData {
  return db.transaction(() => {
    const taskContext = getStudentMcpCurrentContext(
      db,
      studentId,
      connectionId,
    );
    const liveEnabled =
      connectionId !== undefined &&
      mcpLiveContextGeneration(db, studentId, connectionId) !== null;
    const output = (location: StudentMcpCurrentData["location"]) => {
      const data = studentMcpCurrentDataSchema.parse({
        responseVersion: 2,
        taskContext,
        liveEnabled,
        location,
      });
      assertMetadataByteBudget(Buffer.byteLength(JSON.stringify(data), "utf8"));
      return data;
    };
    if (liveEnabled) {
      const focus = studentMcpFocusCandidates(db, studentId, now.getTime());
      if (focus.overflow) return output({ status: "overflow" });
      const contexts: LearningContext[] = [];
      for (const candidate of focus.candidates) {
        if (
          !canLocateStudentMcpQuestion(
            db,
            studentId,
            candidate.attemptId,
            candidate.questionId,
          )
        )
          return output({ status: "unavailable" });
        try {
          const context = contextFromMemoAnchor(
            db,
            studentId,
            {
              kind: "question",
              attemptId: candidate.attemptId,
              questionId: candidate.questionId,
              label: "作答",
            },
            now,
            false,
            {
              surface:
                db
                  .select({ sourceType: attempts.sourceType })
                  .from(attempts)
                  .where(
                    and(
                      eq(attempts.id, candidate.attemptId),
                      eq(attempts.studentId, studentId),
                    ),
                  )
                  .get()?.sourceType === "lesson"
                  ? "lesson"
                  : "attempt",
            },
          );
          if (context?.session == null)
            return output({ status: "unavailable" });
          contexts.push(context);
        } catch (error) {
          if (
            error instanceof HttpError &&
            [403, 404, 409].includes(error.status)
          )
            return output({ status: "unavailable" });
          throw error;
        }
      }
      if (contexts.length > 1)
        return output({ status: "candidates", contexts });
      const context = contexts[0];
      if (context) return output({ status: "current", context });
    }
    const recent = listStudentMcpPractices(
      db,
      studentId,
      { status: "draft", limit: 1 },
      now,
    ).practices[0];
    return recent
      ? output({ status: "recent_practice", practice: recent })
      : output({ status: "none" });
  });
}
