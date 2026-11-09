import {
  rubricFinalRequestSchema,
  rubricReviewSchema,
  rubricSelfRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import {
  saveRubricFinal,
  saveRubricSelf,
} from "../services/rubric-review-service";

/**
 * 通用量表判卷（模块 3）学生侧写接口：本人自评 / 本人裁定。校验链、拒绝码
 * 见 rubric-review-service；响应即该题最新量表视图（结果页原位刷新）。
 * Agent 意见不走 HTTP，经 MCP submit_rubric_opinion（任务租约）写回。
 */
export function createStudentRubricRoutes(db: Db) {
  return new Hono<StudentEnv>()
    .put("/attempts/:id/questions/:questionId/rubric/self", async (c) => {
      const body = await parseJsonBody(c, rubricSelfRequestSchema);
      return c.json(
        {
          ok: true,
          data: rubricReviewSchema.parse(
            saveRubricSelf(
              db,
              c.var.student.id,
              c.req.param("id"),
              c.req.param("questionId"),
              body,
            ),
          ),
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
    })
    .put("/attempts/:id/questions/:questionId/rubric/final", async (c) => {
      const body = await parseJsonBody(c, rubricFinalRequestSchema);
      return c.json(
        {
          ok: true,
          data: rubricReviewSchema.parse(
            saveRubricFinal(
              db,
              c.var.student.id,
              c.req.param("id"),
              c.req.param("questionId"),
              body,
            ),
          ),
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
    });
}
