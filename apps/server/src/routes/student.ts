import type { StudentPasswordChangeRequest } from "@tutor/contract";
import { studentPasswordChangeRequestSchema } from "@tutor/contract";
import { Hono } from "hono";
import { createRequireStudent, type StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import { changeStudentPassword } from "../services/student-service";

/**
 * 学生路由（需学生会话），挂载在 /api/student，整组套 requireStudent 守卫：
 * - GET  /me：当前登录学生信息（displayName 等，守卫已校验存在且未归档）；
 * - POST /password：自助修改密码（验证原密码）。
 *
 * 学生端接口永不返回答案/详解等教师侧内容（AGENTS.md 第 3 条）；本任务两个接口
 * 只涉及账号信息，无题目数据（assertNoLeak 泄露测试自 T2.4 起覆盖学生端题目接口）。
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
    });
}
