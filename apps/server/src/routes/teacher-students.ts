import type {
  StudentCreateRequest,
  StudentUpdateRequest,
} from "@tutor/contract";
import {
  questionReviewQuerySchema,
  studentCreateRequestSchema,
  studentListQuerySchema,
  studentUpdateRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import { questionReviewOf } from "../mcp/teacher-queries";
import {
  createStudent,
  listStudents,
  resetStudentLink,
  resetStudentPassword,
  updateStudent,
} from "../services/student-service";

/**
 * 学生管理路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET  /students：列表（查询参数 includeArchived=true 含归档，默认只列未归档；
 *   T2B.5 起只列本人学生）；
 * - POST /students：新增（loginName 全局唯一，冲突 409 LOGIN_NAME_TAKEN——前端提示
 *   「如：张三2」（D14 重名建议维持现状）；未提供密码则生成随机初始密码，响应一次性
 *   明文；归属会话教师）；
 * - PATCH /students/:id：改名/登录名/开关两种方式/归档/备注（T2B.5 起按归属教师，
 *   他人学生 404）；
 * - POST /students/:id/reset-password：重置密码（一次性明文）；
 * - POST /students/:id/reset-link：重置专属链接（旧链接立即失效）；
 * - GET /students/:id/question-review：学生主页「错题与存疑」聚合（T-PR4
 *   Web-2②）——查询装配在 mcp/teacher-queries.ts，与 MCP-A query_student_
 *   responses 共用同一构造器（方案 §Web-2② 口径同源要求）。
 *
 * 业务逻辑在 StudentService（api-endpoint 技能约定）。返回类型不显式标注 Hono：
 * 链式注册把路由签名累积进推断类型（AppType / hc 端到端类型前提）。
 */
export function createStudentTeacherRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/students", (c) => {
      // GET 无 JSON body：查询参数手工过契约 schema（stringbool 解析 "true"/"false"）
      const parsed = studentListQuerySchema.safeParse({
        includeArchived: c.req.query("includeArchived") ?? undefined,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          "查询参数不合法：includeArchived 只能是 true 或 false",
        );
      }
      return c.json({
        ok: true,
        data: listStudents(
          db,
          c.var.teacher.id,
          parsed.data.includeArchived ?? false,
        ),
      });
    })
    .get("/students/:id/question-review", (c) => {
      // GET 无 JSON body：查询参数手工过契约 schema（kind / limit 有契约默认）
      const parsed = questionReviewQuerySchema.safeParse({
        kind: c.req.query("kind") ?? undefined,
        courseId: c.req.query("courseId") ?? undefined,
        from: c.req.query("from") ?? undefined,
        to: c.req.query("to") ?? undefined,
        limit: c.req.query("limit") ?? undefined,
        cursor: c.req.query("cursor") ?? undefined,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          `查询参数不合法：${parsed.error.issues[0]?.message ?? "格式不正确"}`,
        );
      }
      return c.json({
        ok: true,
        data: questionReviewOf(
          db,
          c.var.teacher.id,
          c.req.param("id"),
          parsed.data,
        ),
      });
    })
    .post("/students", async (c) => {
      const body: StudentCreateRequest = await parseJsonBody(
        c,
        studentCreateRequestSchema,
      );
      return c.json(
        { ok: true, data: await createStudent(db, c.var.teacher.id, body) },
        201,
      );
    })
    .patch("/students/:id", async (c) => {
      const body: StudentUpdateRequest = await parseJsonBody(
        c,
        studentUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateStudent(db, c.var.teacher.id, c.req.param("id"), body),
      });
    })
    .post("/students/:id/reset-password", async (c) => {
      return c.json({
        ok: true,
        data: await resetStudentPassword(
          db,
          c.var.teacher.id,
          c.req.param("id"),
        ),
      });
    })
    .post("/students/:id/reset-link", (c) => {
      return c.json({
        ok: true,
        data: resetStudentLink(db, c.var.teacher.id, c.req.param("id")),
      });
    });
}
