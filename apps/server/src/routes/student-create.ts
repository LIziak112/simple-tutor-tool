import {
  lessonRestartRequestSchema,
  replayableWrongPracticeRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { parseJsonBody, parseJsonBodyOrEmpty } from "../lib/http-error";
import { restartLessonAttempt } from "../services/lesson-service";
import { startWrongPractice } from "../services/wrong-practice";

export function createStudentCreateRoutes(db: Db) {
  return (
    new Hono<StudentEnv>()
      // 按前端选题顺序冻结错题。响应仅携带新卷摘要。
      .post("/wrong-practice", async (c) => {
        const body = await parseJsonBody(
          c,
          replayableWrongPracticeRequestSchema,
        );
        const { attempt } = startWrongPractice(
          db,
          c.var.student.id,
          body.questionIds,
          {
            workflowVersion: body.workflowVersion,
            feedbackMode: body.feedbackMode,
          },
          undefined,
          body.scope,
          body.operationId,
        );
        return c.json({ ok: true, data: attempt }, 201);
      })
      // 旧调用可省略请求体。新客户端确认时固定原卷与操作标识。
      .post("/lectures/:id/lesson/restart", async (c) => {
        const body = await parseJsonBodyOrEmpty(c, lessonRestartRequestSchema);
        const data = restartLessonAttempt(
          db,
          c.var.student.id,
          c.req.param("id"),
          body,
        );
        return c.json({ ok: true, data }, 201);
      })
  );
}
