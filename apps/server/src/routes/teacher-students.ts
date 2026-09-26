import type {
  StudentCreateRequest,
  StudentUpdateRequest,
} from "@tutor/contract";
import {
  studentCreateRequestSchema,
  studentListQuerySchema,
  studentUpdateRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  createStudent,
  listStudents,
  resetStudentLink,
  resetStudentPassword,
  updateStudent,
} from "../services/student-service";

/**
 * 学生管理路由（需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET  /students：列表（查询参数 includeArchived=true 含归档，默认只列未归档）；
 * - POST /students：新增（loginName 全局唯一，冲突 409 LOGIN_NAME_TAKEN；
 *   未提供密码则生成随机初始密码，响应一次性明文）；
 * - PATCH /students/:id：改名/登录名/开关两种方式/归档/备注；
 * - POST /students/:id/reset-password：重置密码（一次性明文）；
 * - POST /students/:id/reset-link：重置专属链接（旧链接立即失效）。
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
        data: listStudents(db, parsed.data.includeArchived ?? false),
      });
    })
    .post("/students", async (c) => {
      const body: StudentCreateRequest = await parseJsonBody(
        c,
        studentCreateRequestSchema,
      );
      return c.json({ ok: true, data: await createStudent(db, body) }, 201);
    })
    .patch("/students/:id", async (c) => {
      const body: StudentUpdateRequest = await parseJsonBody(
        c,
        studentUpdateRequestSchema,
      );
      return c.json({
        ok: true,
        data: updateStudent(db, c.req.param("id"), body),
      });
    })
    .post("/students/:id/reset-password", async (c) => {
      return c.json({
        ok: true,
        data: await resetStudentPassword(db, c.req.param("id")),
      });
    })
    .post("/students/:id/reset-link", (c) => {
      return c.json({
        ok: true,
        data: resetStudentLink(db, c.req.param("id")),
      });
    });
}
