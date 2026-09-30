import {
  markRequestSchema,
  pendingMarkListQuerySchema,
  teacherAttemptListQuerySchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import { listPendingMarks, markResponse } from "../services/mark-response";
import {
  getTeacherAttemptDetail,
  listTeacherAttempts,
} from "../services/teacher-attempt-service";

/**
 * 教师端作答数据路由（T3.1 + T3.2b，需教师会话），由 teacher.ts 挂在 /api/teacher 之下：
 * - GET /attempts：作答卡片列表。查询参数（全可选）：studentId / courseId /
 *   assignmentId / unitId（DSL id）/ sourceType / status / from / to（时间范围按
 *   最近活动时间）/ limit（默认 50，1–200）/ offset（默认 0）；
 *   业务与域过滤在 teacher-attempt-service（attempt → student → teacherId）。
 * - GET /attempts/:id：作答详情（D7 全字段；draft 亦可用，D5——判定列语义
 *   「未交卷」）。非本人学生的 attempt → 404 ATTEMPT_NOT_FOUND（T2B 域口径）。
 * - POST /responses/:id/mark（T3.2b，D3）：批注单题（判定 + 评语一次提交）。
 *   请求体 markRequestSchema（comment ≤2000 契约校验 + trim 空串归一 null）；
 *   draft attempt → 409 NOT_SUBMITTED；非本人教师 → 404 RESPONSE_NOT_FOUND；
 *   业务在 mark-response（事务内 D3 持久化 + D2 重算）。
 * - GET /pending-marks（T3.2b，D4）：待批队列。查询参数（全可选）：
 *   courseId / assignmentId / studentId；submittedAt 升序（先交先批）；教师域过滤。
 *
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定）；
 * GET 无 JSON body：查询参数手工过契约 schema（数值字段经 coerce 解析字符串）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType 前提）。
 */
export function createTeacherAttemptRoutes(db: Db) {
  return new Hono<TeacherEnv>()
    .get("/attempts", (c) => {
      const parsed = teacherAttemptListQuerySchema.safeParse({
        studentId: c.req.query("studentId") ?? undefined,
        courseId: c.req.query("courseId") ?? undefined,
        assignmentId: c.req.query("assignmentId") ?? undefined,
        unitId: c.req.query("unitId") ?? undefined,
        sourceType: c.req.query("sourceType") ?? undefined,
        status: c.req.query("status") ?? undefined,
        from: c.req.query("from") ?? undefined,
        to: c.req.query("to") ?? undefined,
        limit: c.req.query("limit") ?? undefined,
        offset: c.req.query("offset") ?? undefined,
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
        data: listTeacherAttempts(db, c.var.teacher.id, parsed.data),
      });
    })
    .get("/attempts/:id", (c) => {
      return c.json({
        ok: true,
        data: getTeacherAttemptDetail(db, c.var.teacher.id, c.req.param("id")),
      });
    })
    .post("/responses/:id/mark", async (c) => {
      const req = await parseJsonBody(c, markRequestSchema);
      return c.json({
        ok: true,
        data: markResponse(db, c.var.teacher.id, c.req.param("id"), req),
      });
    })
    .get("/pending-marks", (c) => {
      const parsed = pendingMarkListQuerySchema.safeParse({
        courseId: c.req.query("courseId") ?? undefined,
        assignmentId: c.req.query("assignmentId") ?? undefined,
        studentId: c.req.query("studentId") ?? undefined,
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
        data: listPendingMarks(db, c.var.teacher.id, parsed.data),
      });
    });
}
