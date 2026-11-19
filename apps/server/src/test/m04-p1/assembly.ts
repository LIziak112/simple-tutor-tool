import { attemptIdSchema } from "@tutor/contract";
import { Hono } from "hono";
import pino from "pino";
import { type CreateAppOptions, createApp } from "../../app.ts";
import {
  createRequireStudent,
  type StudentEnv,
} from "../../auth/require-student.ts";
import { HttpError } from "../../lib/http-error.ts";
import {
  requestDiagnostics,
  requestErrorHandler,
} from "../../lib/request-diagnostics.ts";
import { createAssignmentAttemptStartRoutes } from "../../routes/student-create.ts";
import type { startAttempt } from "../../services/attempt-start.ts";

export function createTrialApp(
  options: CreateAppOptions,
  start: typeof startAttempt,
  read?: (studentId: string, activityId: string) => unknown,
) {
  const logger = options.logger ?? pino({ enabled: false });
  const requireStudent = createRequireStudent(options.db, options.publicUrl);
  const app = new Hono<StudentEnv>()
    .onError(requestErrorHandler(logger))
    .use(
      "/api/student/assignments/:id/attempt",
      requestDiagnostics(logger),
      requireStudent,
    )
    .route(
      "/api/student",
      createAssignmentAttemptStartRoutes(options.db, start),
    );
  if (read) {
    // 静态路径 /attempts/opened 仍由产品应用处理。
    app.get(
      "/api/student/attempts/:id{[0-9a-fA-F-]+}",
      requestDiagnostics(logger),
      requireStudent,
      (c) => {
        const id = attemptIdSchema.safeParse(c.req.param("id"));
        if (!id.success) {
          throw new HttpError(404, "ATTEMPT_NOT_FOUND", "作答记录不存在");
        }
        c.header("Cache-Control", "private, no-store");
        return c.json({ ok: true, data: read(c.var.student.id, id.data) });
      },
    );
  }
  return app.route("/", createApp(options));
}
