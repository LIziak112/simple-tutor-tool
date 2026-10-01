import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { deleteReport, listStudentReports } from "../services/report-service";

/**
 * 学情报告教师路由（需教师会话，T4.6 D24），由 teacher.ts 挂在 /api/teacher 下：
 * - GET    /students/:id/reports：学生报告列表（createdAt 倒序；他人学生 404）；
 * - DELETE /reports/:id：删除报告（他人报告 404；不做编辑，D24）。
 * 学生画像页 UI 接入在 T4.7，本文件只提供接口。
 */
export function createTeacherReportRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/students/:id/reports", (c) => {
      return c.json({
        ok: true,
        data: listStudentReports(db, c.var.teacher.id, c.req.param("id")),
      });
    })
    .delete("/reports/:id", (c) => {
      deleteReport(db, c.var.teacher.id, c.req.param("id"));
      return c.json({ ok: true, data: null });
    });
}
