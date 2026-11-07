import {
  QUESTION_PROCESS_MAX_BATCH_BYTES,
  questionProcessBatchSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  appendQuestionProcess,
  deleteQuestionProcess,
  questionProcessStatus,
  startQuestionProcess,
} from "../services/question-process";

export function createStudentQuestionProcessRoutes(db: Db, enabled: boolean) {
  return new Hono<StudentEnv>()
    .get("/attempts/:id/question-process", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({
        ok: true,
        data: questionProcessStatus(
          db,
          c.var.student.id,
          c.req.param("id"),
          enabled,
        ),
      });
    })
    .post("/attempts/:id/question-process", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({
        ok: true,
        data: startQuestionProcess(
          db,
          c.var.student.id,
          c.req.param("id"),
          enabled,
        ),
      });
    })
    .delete("/attempts/:id/question-process", (c) => {
      deleteQuestionProcess(db, c.var.student.id, c.req.param("id"));
      return c.json({ ok: true, data: null });
    })
    .put(
      "/attempts/:id/question-process",
      bodyLimit({
        maxSize: QUESTION_PROCESS_MAX_BATCH_BYTES,
        onError: () => {
          throw new HttpError(413, "QUESTION_PROCESS_LIMIT", "过程批次太大");
        },
      }),
      async (c) => {
        const batch = await parseJsonBody(c, questionProcessBatchSchema);
        return c.json({
          ok: true,
          data: appendQuestionProcess(
            db,
            c.var.student.id,
            c.req.param("id"),
            enabled,
            batch,
          ),
        });
      },
    );
}
