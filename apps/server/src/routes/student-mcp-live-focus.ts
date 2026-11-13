import {
  studentMcpLiveFocusCapabilitySchema,
  studentMcpLiveFocusRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StudentEnv } from "../auth/require-student.ts";
import type { Db } from "../db/client.ts";
import { HttpError, parseJsonBody } from "../lib/http-error.ts";
import { mcpLiveContextGeneration } from "../services/ai-companion/connection-service.ts";
import { updateStudentMcpLiveFocus } from "../services/ai-companion/student-ai-live-context.ts";

export function createStudentMcpLiveFocusRoutes(db: Db) {
  return new Hono<StudentEnv>()
    .get("/ai/mcp-live-focus", (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.json({
        ok: true,
        data: studentMcpLiveFocusCapabilitySchema.parse({
          generation: mcpLiveContextGeneration(db, c.var.student.id),
        }),
      });
    })
    .put(
      "/attempts/:id/mcp-live-focus",
      bodyLimit({
        maxSize: 4096,
        onError: () => {
          throw new HttpError(413, "VALIDATION_ERROR", "实时焦点请求太大");
        },
      }),
      async (c) => {
        const input = await parseJsonBody(c, studentMcpLiveFocusRequestSchema);
        updateStudentMcpLiveFocus(
          db,
          c.var.student.id,
          c.req.param("id"),
          input,
        );
        c.header("Cache-Control", "private, no-store");
        return c.json({ ok: true, data: null });
      },
    );
}
