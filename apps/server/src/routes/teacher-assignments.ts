import type {
  AssignmentCheckRequest,
  AssignmentCreateRequest,
  AssignmentUpdateRequest,
} from "@tutor/contract";
import {
  assignmentCheckRequestSchema,
  assignmentCreateRequestSchema,
  assignmentListQuerySchema,
  assignmentUpdateRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  checkAssignment,
  createAssignment,
  deleteAssignment,
  getAssignmentDetail,
  listTeacherAssignments,
  updateAssignment,
} from "../services/assignment-service";

/**
 * 作业管理路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下（T2A.7 大改）：
 * - GET    /assignments：列表。查询参数：includeDeleted=true 含已删除（默认只列
 *   未删）；courseId=UUID 只看该课程作业 / "none" 只看无课程作业（非法值 400）；
 * - GET    /assignments/:id：详情（roster 每人状态、startedCount、课程新成员）；
 * - POST   /assignments：布置作业 {title?, courseId?, unitIds[], studentIds[], dueAt?}
 *   （单元重复 400 DUPLICATE_UNIT；单元/学生/课程不存在 404）；
 * - POST   /assignments/check：D15 布置前「已做过」检查 {unitIds[], studentIds[]}；
 * - PATCH  /assignments/:id：改标题/截止（null 取消）/替换单元（锁定后 409
 *   ASSIGNMENT_CONTENT_LOCKED）/名单增删（移出已开始学生须 confirmStarted，
 *   否则 409 CONFIRM_REQUIRED 附 _students）；
 * - DELETE /assignments/:id：软删（作答保留，学生端立即不可见）。
 *
 * 业务逻辑在 AssignmentService（api-endpoint 技能约定）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createAssignmentTeacherRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/assignments", (c) => {
      // GET 无 JSON body：查询参数手工过契约 schema（stringbool 解析 "true"/"false"；
      // courseId 接受 UUID 或 "none"，其余值由契约拒绝）
      const parsed = assignmentListQuerySchema.safeParse({
        includeDeleted: c.req.query("includeDeleted") ?? undefined,
        courseId: c.req.query("courseId") ?? undefined,
      });
      if (!parsed.success) {
        const first = parsed.error.issues[0]?.message ?? "格式不正确";
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          `查询参数不合法：${first}`,
        );
      }
      return c.json({
        ok: true,
        data: listTeacherAssignments(db, {
          includeDeleted: parsed.data.includeDeleted ?? false,
          ...(parsed.data.courseId !== undefined
            ? { courseId: parsed.data.courseId }
            : {}),
        }),
      });
    })
    .get("/assignments/:id", (c) => {
      return c.json({
        ok: true,
        data: getAssignmentDetail(db, c.req.param("id")),
      });
    })
    .post("/assignments", async (c) => {
      const body: AssignmentCreateRequest = await parseJsonBody(
        c,
        assignmentCreateRequestSchema,
      );
      return c.json({ ok: true, data: createAssignment(db, body) }, 201);
    })
    .post("/assignments/check", async (c) => {
      const body: AssignmentCheckRequest = await parseJsonBody(
        c,
        assignmentCheckRequestSchema,
      );
      return c.json({ ok: true, data: checkAssignment(db, body) });
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
