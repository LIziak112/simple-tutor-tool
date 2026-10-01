import { analyticsQuerySchema } from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import {
  getAnalyticsOverview,
  getAnalyticsQuestions,
  getAnalyticsStudent,
} from "../services/analytics-service";

/**
 * 教师端学情分析路由（T4.1，需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET /analytics/overview：总览（完成矩阵 + 周趋势 + 下节课重点 + 关键计数 +
 *   离线占比 + 重做计数）；
 * - GET /analytics/student/:id：学生画像（趋势/考点/异常题/重做/离线/讲义地图）；
 *   学生不属于本教师 → 404 STUDENT_NOT_FOUND（D7 域隔离，不暴露存在性）；
 * - GET /analytics/questions：题目视角（正确率/用时/高频错误答案/异常计数）。
 * 三接口共用查询参数（全可选）：courseId（D3 课程筛选，缺省=全部）、
 * days（D5 时间范围，默认 30，取值正整数天数或 "all"）、focusDays（D5 重点
 * 卡片周期，默认 14）。业务与域过滤全部在 analytics-service。
 *
 * 路由只做「鉴权（teacher.ts 整组 requireTeacher）→ 校验 → 调 service → 包装
 * 响应」（api-endpoint 技能约定）；GET 无 JSON body：查询参数手工过契约 schema
 * （数值字段经 coerce 解析字符串）。返回类型不显式标注 Hono：链式注册把路由
 * 签名累积进推断类型（AppType 前提）。
 */
export function createTeacherAnalyticsRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/analytics/overview", (c) => {
      const parsed = analyticsQuerySchema.safeParse({
        courseId: c.req.query("courseId") ?? undefined,
        days: c.req.query("days") ?? undefined,
        focusDays: c.req.query("focusDays") ?? undefined,
      });
      if (!parsed.success) {
        throw queryError(parsed.error.issues[0]?.message);
      }
      return c.json({
        ok: true,
        data: getAnalyticsOverview(db, c.var.teacher.id, parsed.data),
      });
    })
    .get("/analytics/student/:id", (c) => {
      const parsed = analyticsQuerySchema.safeParse({
        courseId: c.req.query("courseId") ?? undefined,
        days: c.req.query("days") ?? undefined,
        focusDays: c.req.query("focusDays") ?? undefined,
      });
      if (!parsed.success) {
        throw queryError(parsed.error.issues[0]?.message);
      }
      return c.json({
        ok: true,
        data: getAnalyticsStudent(
          db,
          c.var.teacher.id,
          c.req.param("id"),
          parsed.data,
        ),
      });
    })
    .get("/analytics/questions", (c) => {
      const parsed = analyticsQuerySchema.safeParse({
        courseId: c.req.query("courseId") ?? undefined,
        days: c.req.query("days") ?? undefined,
        focusDays: c.req.query("focusDays") ?? undefined,
      });
      if (!parsed.success) {
        throw queryError(parsed.error.issues[0]?.message);
      }
      return c.json({
        ok: true,
        data: getAnalyticsQuestions(db, c.var.teacher.id, parsed.data),
      });
    });
}

/** 查询参数不合法的统一 400 壳 */
function queryError(firstMessage: string | undefined): HttpError {
  return new HttpError(
    400,
    "VALIDATION_ERROR",
    `查询参数不合法：${firstMessage ?? "格式不正确"}`,
  );
}
