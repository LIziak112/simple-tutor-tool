import type { StudentPasswordChangeRequest } from "@tutor/contract";
import { studentPasswordChangeRequestSchema } from "@tutor/contract";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { createRequireStudent, type StudentEnv } from "../auth/require-student";
import {
  deleteSession,
  isSecurePublicUrl,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../auth/session";
import type { Db } from "../db/client";
import { parseJsonBody } from "../lib/http-error";
import { listStudentAssignments } from "../services/assignment-service";
import { getStudentLecture, listStudentLectures } from "../services/content-service";
import { changeStudentPassword } from "../services/student-service";

/**
 * 学生路由（需学生会话），挂载在 /api/student，整组套 requireStudent 守卫：
 * - GET  /me：当前登录学生信息（displayName 等，守卫已校验存在且未归档）；
 * - POST /password：自助修改密码（验证原密码）；
 * - GET  /assignments：我的作业（仅本人被指派且未删除，附完成状态，T2.2）；
 * - GET  /lectures、GET /lectures/:id：讲义摘要列表与全文 markdown（T2.3）；
 * - POST /logout：删除会话行并清除 Cookie（T2.3，与教师 logout 同实现口径）。
 *
 * 学生端接口永不返回答案/详解等教师侧内容（AGENTS.md 第 3 条）；/assignments
 * 只含单元公开元信息（标题/topic/题数），/lectures* 只读 lectures 表
 * （讲义里的 :::solution 是讲解内容非题目答案，属学生应见），泄露测试见
 * routes/assignments.test.ts 与 routes/student-lectures.test.ts。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createStudentRoutes(db: Db, publicUrl: string) {
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
    })
    .get("/lectures", (c) => {
      return c.json({ ok: true, data: listStudentLectures(db) });
    })
    .get("/lectures/:id", (c) => {
      return c.json({
        ok: true,
        data: getStudentLecture(db, c.req.param("id")),
      });
    })
    .post("/logout", (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) {
        deleteSession(db, token);
      }
      // Cookie 属性与写入时保持一致（尤其 Path），否则浏览器删不掉
      deleteCookie(
        c,
        SESSION_COOKIE,
        sessionCookieOptions(isSecurePublicUrl(publicUrl)),
      );
      return c.json({ ok: true, data: null });
    });
}
