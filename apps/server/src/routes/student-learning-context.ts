import {
  LEARNING_CONTEXT_BODY_MAX_BYTES,
  type LearningContext,
  learningContextOkSchema,
  learningContextRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import { guardBodyLimit } from "../lib/request-body-limit";
import { requireUsableAttempt } from "../services/attempt-service";
import { contextFromMemoAnchor } from "../services/learning-context-projection";
import { assertMemoMetadataBudget } from "../services/memo-budget";

/** 纯坐标读出口：真实可见门在前，不借历史随笔兼容分支提供读权限。 */
export function createStudentLearningContextRoutes(db: Db) {
  return new Hono<StudentEnv>()
    .use(
      "/learning-context/resolve",
      guardBodyLimit({
        method: "POST",
        limit: LEARNING_CONTEXT_BODY_MAX_BYTES,
        code: "LEARNING_CONTEXT_TOO_LARGE",
        message: "来源信息过大，请精简后重试",
      }),
    )
    .post("/learning-context/resolve", async (c) => {
      const target = await parseJsonBody(c, learningContextRequestSchema);
      let context: LearningContext | null;
      try {
        if (target.kind === "question") {
          requireUsableAttempt(db, c.var.student.id, target.attemptId);
          context = contextFromMemoAnchor(
            db,
            c.var.student.id,
            {
              kind: "question",
              attemptId: target.attemptId,
              questionId: target.questionId,
              label: "作答",
            },
            new Date(),
            false,
            { surface: target.surface },
          );
        } else {
          context = contextFromMemoAnchor(
            db,
            c.var.student.id,
            {
              kind: "lecture",
              lectureId: target.lectureId,
              sectionId: target.sectionId ?? null,
              label: "讲义",
            },
            new Date(),
            false,
            target.courseId === undefined ? {} : { courseId: target.courseId },
          );
        }
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        throw new HttpError(
          404,
          "LEARNING_CONTEXT_NOT_FOUND",
          "来源不存在或不可见",
        );
      }
      if (context === null)
        throw new HttpError(
          404,
          "LEARNING_CONTEXT_NOT_FOUND",
          "来源不存在或不可见",
        );
      if (
        target.kind === "question" &&
        target.expectedQuestionRevisionId !== undefined &&
        context.session?.questionRevisionId !==
          target.expectedQuestionRevisionId
      )
        throw new HttpError(
          409,
          "LEARNING_CONTEXT_STALE",
          "题目来源已变化，请保留记录并刷新题目后核对",
        );
      assertMemoMetadataBudget({ context });
      c.header("Cache-Control", "private, no-store");
      return c.json(learningContextOkSchema.parse({ ok: true, data: context }));
    });
}
