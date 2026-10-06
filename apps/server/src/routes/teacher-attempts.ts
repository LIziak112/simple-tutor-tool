import {
  exportCsvQuerySchema,
  markRequestSchema,
  pendingMarkListQuerySchema,
  teacherAttemptListQuerySchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { TeacherEnv } from "../auth/require-teacher";
import type { Db } from "../db/client";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  beijingExportStampOf,
  CSV_UTF8_BOM,
  exportCsv,
} from "../services/export-csv";
import {
  buildReviewPackZip,
  previewReviewPack,
} from "../services/review-pack-service";
import { listPendingMarks, markResponse } from "../services/mark-response";
import { getTeacherNoteEvidence } from "../services/note-service";
import {
  getTeacherAttemptDetail,
  listTeacherAttempts,
} from "../services/teacher-attempt-service";

/**
 * 教师端作答数据路由（T3.1 + T3.2b + T3.4，需教师会话），由 teacher.ts 挂在
 * /api/teacher 之下：
 * - GET /attempts：作答卡片列表。查询参数（全可选）：studentId / courseId /
 *   assignmentId / unitId（DSL id）/ sourceType / status / from / to（时间范围按
 *   最近活动时间）/ limit（默认 50，1–200）/ offset（默认 0）；
 *   业务与域过滤在 teacher-attempt-service（attempt → student → teacherId）。
 * - GET /attempts/:id：作答详情（D7 全字段；draft 亦可用，D5——判定列语义
 *   「未交卷」）。非本人学生的 attempt → 404 ATTEMPT_NOT_FOUND（T2B 域口径）。
 * - GET /attempts/:id/evidence/:qid（T6R.5 ⑥）：域内只读证据与图片状态
 *   （题目草稿 note 头投影，业务在 note-service.getTeacherNoteEvidence）；
 *   域外统一 404；题目按 attempt 冻结行宽判定，不查当前题库存活。
 * - POST /responses/:id/mark（T3.2b，D3）：批注单题（判定 + 评语一次提交）。
 *   请求体 markRequestSchema（comment ≤2000 契约校验 + trim 空串归一 null）；
 *   draft attempt → 409 NOT_SUBMITTED；非本人教师 → 404 RESPONSE_NOT_FOUND；
 *   业务在 mark-response（事务内 D3 持久化 + D2 重算）。
 * - GET /pending-marks（T3.2b，D4）：待批队列。查询参数（全可选）：
 *   courseId / assignmentId / studentId；submittedAt 升序（先交先批）；教师域过滤。
 * - GET /export/csv（T3.4，D13）：CSV 导出（全部来源、仅已交卷 attempt、每题
 *   一行）。查询参数（全可选）：studentId / courseId / assignmentId /
 *   sourceType / from / to。文件直出（text/csv + UTF-8 BOM，非 { ok, data }
 *   统一壳，处理方式同 export.md）；CSV 组装在 export-csv 服务；publicUrl 由
 *   teacher.ts 传入（手写笔迹 PNG 绝对链接的部署根地址）。
 *
 * 路由只做「鉴权 → 校验 → 调 service → 包装响应」（api-endpoint 技能约定）；
 * GET 无 JSON body：查询参数手工过契约 schema（数值字段经 coerce 解析字符串）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType 前提）。
 */
export function createTeacherAttemptRoutes(
  db: Db,
  publicUrl: string,
  dataDir: string,
) {
  return (
    new Hono<TeacherEnv>()
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
          data: getTeacherAttemptDetail(
            db,
            c.var.teacher.id,
            c.req.param("id"),
          ),
        });
      })
      // T6R.5 ⑥：域内只读证据与图片状态（note 头投影：scratch 头 + 生效版本
      // 派生图 + submission_evidence 行）。归属链 attempt→student→teacherId
      // （requireTeacherAttempt 统一口径）；域外/不存在统一 404 不暴露存在性；
      // 题目成员资格按 attempt 自有 responses 行宽判定（软删题历史证据可读）。
      .get("/attempts/:id/evidence/:questionId", (c) => {
        return c.json({
          ok: true,
          data: getTeacherNoteEvidence(
            db,
            c.var.teacher.id,
            c.req.param("id"),
            c.req.param("questionId"),
          ),
        });
      })
      // T6R.13：教师单题完整导出预览（统一壳 + no-store；教师域文档——照常
      // 携带参考答案/判定/评语与真实 id，服务层与 schema 锁定）
      .post("/attempts/:id/questions/:questionId/review-pack/preview", (c) => {
        return c.json(
          {
            ok: true,
            data: previewReviewPack(
              db,
              dataDir,
              { kind: "teacher", id: c.var.teacher.id },
              c.req.param("id"),
              c.req.param("questionId"),
            ),
          },
          200,
          { "cache-control": "no-store" },
        );
      })
      // T6R.13：教师单题完整导出 zip 文件直出（同学情数据包口径）
      .post("/attempts/:id/questions/:questionId/review-pack", async (c) => {
        const zip = await buildReviewPackZip(
          db,
          dataDir,
          { kind: "teacher", id: c.var.teacher.id },
          c.req.param("id"),
          c.req.param("questionId"),
        );
        return new Response(zip.bytes, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${zip.filename}"`,
          },
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
      })
      // T3.4（D13）：CSV 导出文件直出——UTF-8 BOM 前缀让 Excel 直接打开中文不
      // 乱码；RFC 4180 转义与公式注入防护在 export-csv 服务。文件名时间戳 =
      // 请求时刻北京时间；导出内容随批改变化，禁缓存（与 export.md 同口径）。
      .get("/export/csv", (c) => {
        const parsed = exportCsvQuerySchema.safeParse({
          studentId: c.req.query("studentId") ?? undefined,
          courseId: c.req.query("courseId") ?? undefined,
          assignmentId: c.req.query("assignmentId") ?? undefined,
          sourceType: c.req.query("sourceType") ?? undefined,
          from: c.req.query("from") ?? undefined,
          to: c.req.query("to") ?? undefined,
        });
        if (!parsed.success) {
          const first = parsed.error.issues[0]?.message ?? "格式不正确";
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `查询参数不合法：${first}`,
          );
        }
        const csv = exportCsv(db, c.var.teacher.id, publicUrl, parsed.data);
        const filename = `tutor-export-${beijingExportStampOf()}.csv`;
        return new Response(`${CSV_UTF8_BOM}${csv}`, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="${filename}"`,
          },
        });
      })
  );
}
