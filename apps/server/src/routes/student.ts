import type { StudentPasswordChangeRequest } from "@tutor/contract";
import { studentPasswordChangeRequestSchema } from "@tutor/contract";
import { Hono } from "hono";
import { createRequireStudent, type StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import { listStudentAssignments } from "../services/assignment-service";
import { changeStudentPassword } from "../services/student-service";

/**
 * 学生路由（需学生会话），挂载在 /api/student，整组套 requireStudent 守卫：
 * - GET  /me：当前登录学生信息（displayName 等，守卫已校验存在且未归档）；
 * - POST /password：自助修改密码（验证原密码）；
 * - GET  /assignments：我的作业（仅本人被指派且未删除，附完成状态，T2.2）。
 *
 * 学生端接口永不返回答案/详解等教师侧内容（AGENTS.md 第 3 条）；/assignments
 * 只含单元公开元信息（标题/topic/题数），泄露测试见 routes/assignments.test.ts。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createStudentRoutes(db: Db) {
  const requireStudent = createRequireStudent(db);
  return new Hono<StudentEnv>()
    .use("*", requireStudent)
    .get("/me", (c) => {
      return c.json({ ok: true, data: c.var.student });
    })
    .post("/password", async (c) => {
      const body: StudentPasswordChangeRequest = await parseJsonBody(
        c,
        studentPasswordChangeRequestSchema,
      );
      return c.json({
        ok: true,
        data: await changeStudentPassword(db, c.var.student.id, body),
      });
    })
    .get("/assignments", (c) => {
      return c.json({
        ok: true,
        data: listStudentAssignments(db, c.var.student.id),
      });
    });
}
