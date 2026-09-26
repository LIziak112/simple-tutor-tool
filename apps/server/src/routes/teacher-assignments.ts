import type {
  AssignmentCreateRequest,
  AssignmentUpdateRequest,
} from "@tutor/contract";
import {
  assignmentCreateRequestSchema,
  assignmentListQuerySchema,
  assignmentUpdateRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  createAssignment,
  deleteAssignment,
  listTeacherAssignments,
  updateAssignment,
} from "../services/assignment-service";

/**
 * 作业管理路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET    /assignments：列表（查询参数 includeDeleted=true 含已删除，默认只列未删）；
 * - POST   /assignments：布置作业 {unitId, title?, studentIds[], dueAt?}
 *   （unitId 不存在 404 UNIT_NOT_FOUND；studentIds 至少一名）；
 * - PATCH  /assignments/:id：改标题/截止（null 取消）/全量替换名单；
 * - DELETE /assignments/:id：软删（作答保留，学生端立即不可见）。
 *
 * 业务逻辑在 AssignmentService（api-endpoint 技能约定）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createAssignmentTeacherRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/assignments", (c) => {
      // GET 无 JSON body：查询参数手工过契约 schema（stringbool 解析 "true"/"false"）
      const parsed = assignmentListQuerySchema.safeParse({
        includeDeleted: c.req.query("includeDeleted") ?? undefined,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "查询参数不合法：includeDeleted 只能是 true 或 false",
        );
      }
      return c.json({
        ok: true,
        data: listTeacherAssignments(db, parsed.data.includeDeleted ?? false),
      });
    })
    .post("/assignments", async (c) => {
      const body: AssignmentCreateRequest = await parseJsonBody(
        c,
        assignmentCreateRequestSchema,
      );
      return c.json({ ok: true, data: createAssignment(db, body) }, 201);
    })
    .patch("/assignments/:id", async (c) => {
      const body: AssignmentUpdateRequest = await parseJsonBody(
        c,
        assignmentUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateAssignment(db, c.req.param("id"), body),
      });
    })
    .delete("/assignments/:id", (c) => {
      deleteAssignment(db, c.req.param("id"));
      return c.json({ ok: true, data: null });
    });
}
