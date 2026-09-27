import type { StudentPasswordChangeRequest } from "@tutor/contract";
import {
  attemptAnswerSaveRequestSchema,
  attemptEventBatchRequestSchema,
  lectureEventBatchRequestSchema,
  studentPasswordChangeRequestSchema,
} from "@tutor/contract";
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
import { pngResponse } from "../lib/binary-response";
import { HttpError, parseJsonBody } from "../lib/http-error";
import {
  getStudentAssignmentPaper,
  listStudentAssignments,
} from "../services/assignment-service";
import {
  getAttemptDetail,
  saveDraftAnswer,
  startAttempt,
  submitAttempt,
} from "../services/attempt-service";
import {
  getStudentLecture,
  listStudentLectures,
} from "../services/content-service";
import {
  appendAttemptEvents,
  appendLectureEvents,
} from "../services/event-service";
import { getInkDoc, getStudentInkPng, saveInk } from "../services/ink-service";
import { changeStudentPassword } from "../services/student-service";

/**
 * 学生路由（需学生会话），挂载在 /api/student，整组套 requireStudent 守卫：
 * - GET  /me：当前登录学生信息（displayName 等，守卫已校验存在且未归档）；
 * - POST /password：自助修改密码（验证原密码）；
 * - GET  /assignments：我的作业（仅本人被指派且未删除，附完成状态，T2.2；
 *   T2.6 起状态由 attempts 推导：未开始/进行中/已交/已批）；
 * - GET  /assignments/:id/paper：作业试卷——公开题目 QuestionPublic[]（T2.4；
 *   未被指派 403，作业不存在/已删除 404）；
 * - POST /assignments/:id/attempt：创建或取回进行中的 attempt（T2.6，幂等：
 *   一人一份进行中；已交卷返回已交的那份让前端直接进结果视图）；
 * - PUT  /attempts/:id/answers/:questionId：保存草稿答案（T2.6；已交 409）；
 * - POST /attempts/:id/submit：服务端判分 + 快照冻结 + 返回结果（T2.6；
 *   重复交卷 409 ALREADY_SUBMITTED）；
 * - GET  /attempts/:id：attempt 详情（T2.6；未交=草稿视图（无答案/详解/提示），
 *   已交=结果视图（含答案与详解、剥离提示内容））；
 * - POST /attempts/:id/events：学习痕迹事件批量上报（T2.10，≤200 条/次：
 *   超限/非法 type 400，非本人 403，未登录 401；已交后仍收——交卷瞬间的前台
 *   flush 可能晚到，宽松口径见 event-service）；响应只回 accepted 计数；
 * - POST /events：无 attempt 上下文的事件批量（T2.10；目前只有 lecture_expand
 *   讲义展开，attemptId/questionId 落 NULL、归属在 payload）；
 * - PUT  /attempts/:id/ink/:questionId：上传/覆盖手写笔迹（T2.8，multipart：
 *   strokes（gzip 后 InkDoc JSON）+ snapshot（PNG），合计 ≤2MB 超 413）；
 * - GET  /attempts/:id/ink/:questionId：取回该题矢量 InkDoc（无笔迹 404）；
 * - GET  /attempts/:id/ink/:questionId.png：本人笔迹 PNG 直出（结果页缩略图）；
 * - GET  /lectures、GET /lectures/:id：讲义摘要列表与全文 markdown（T2.3）；
 * - POST /logout：删除会话行并清除 Cookie（T2.3，与教师 logout 同实现口径）。
 *
 * 路径段带后缀说明：Hono 的 path 参数会吞掉整个 segment（含 .png 后缀），
 * 因此 ink 的取回路由注册一个 /attempts/:id/ink/:questionId，handler 内按
 * .png 后缀分流 JSON（矢量文档）与 PNG（快照直出）——对外 URL 形态与任务
 * 约定一致（GET …/ink/:questionId 与 GET …/ink/:questionId.png）。
 *
 * 学生端接口永不返回答案/详解等教师侧内容（AGENTS.md 第 3 条）：/assignments
 * 只含单元公开元信息（标题/topic/题数）；/assignments/:id/paper 与草稿视图的
 * 每道题经 questionPublicSchema 输出过滤且题干已公开化（[[答案]] → [[]]）；
 * /attempts/:id 的结果视图在交卷后允许携带参考答案与详解（规则 3 限制的是
 * 「未交卷题目」），但提示内容仍不下发（T2.11 按需）。泄露测试见
 * routes/assignments.test.ts、routes/student-lectures.test.ts、
 * routes/student-paper.test.ts 与 routes/student-attempts.test.ts
 * （通用工具 src/test/assert-no-leak.ts；T2.8 ink 接口见 routes/student-ink.test.ts）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createStudentRoutes(
  db: Db,
  publicUrl: string,
  dataDir: string,
) {
  const requireStudent = createRequireStudent(db);
  return (
    new Hono<StudentEnv>()
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
      .get("/assignments/:id/paper", (c) => {
        return c.json({
          ok: true,
          data: getStudentAssignmentPaper(
            db,
            c.var.student.id,
            c.req.param("id"),
          ),
        });
      })
      .post("/assignments/:id/attempt", (c) => {
        return c.json({
          ok: true,
          data: startAttempt(db, c.var.student.id, c.req.param("id")),
        });
      })
      .put("/attempts/:id/answers/:questionId", async (c) => {
        const body = await parseJsonBody(c, attemptAnswerSaveRequestSchema);
        return c.json({
          ok: true,
          data: saveDraftAnswer(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            body.answer,
          ),
        });
      })
      .post("/attempts/:id/submit", (c) => {
        return c.json({
          ok: true,
          data: submitAttempt(db, c.var.student.id, c.req.param("id")),
        });
      })
      .get("/attempts/:id", (c) => {
        return c.json({
          ok: true,
          data: getAttemptDetail(db, c.var.student.id, c.req.param("id")),
        });
      })
      // T2.10：学习痕迹事件批量上报（attempt 上下文，≤200 条/次由契约拦截）
      .post("/attempts/:id/events", async (c) => {
        const body = await parseJsonBody(c, attemptEventBatchRequestSchema);
        return c.json({
          ok: true,
          data: appendAttemptEvents(
            db,
            c.var.student.id,
            c.req.param("id"),
            body.events,
          ),
        });
      })
      // T2.10：无 attempt 上下文的事件批量（讲义 lecture_expand 等）
      .post("/events", async (c) => {
        const body = await parseJsonBody(c, lectureEventBatchRequestSchema);
        return c.json({
          ok: true,
          data: appendLectureEvents(db, c.var.student.id, body.events),
        });
      })
      // T2.8：上传/覆盖一道手写题的笔迹（multipart：strokes + snapshot）
      .put("/attempts/:id/ink/:questionId", async (c) => {
        const body = await c.req.parseBody();
        const strokes = body.strokes;
        const snapshot = body.snapshot;
        // 两段都必须是文件（multipart 文件字段；字符串字段说明客户端组装错误）
        if (!(strokes instanceof File) || !(snapshot instanceof File)) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "请求需为 multipart/form-data，且包含 strokes 与 snapshot 两个文件",
          );
        }
        return c.json({
          ok: true,
          data: saveInk(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            new Uint8Array(await strokes.arrayBuffer()),
            new Uint8Array(await snapshot.arrayBuffer()),
          ),
        });
      })
      // T2.8：取回矢量文档（JSON）或本人 PNG（.png 后缀分流，见文件头说明）
      .get("/attempts/:id/ink/:questionId", (c) => {
        const raw = c.req.param("questionId");
        if (raw.endsWith(".png")) {
          const png = getStudentInkPng(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            // questionId 本身可能含点（来自 DSL），只剥离末尾 .png
            raw.slice(0, -".png".length),
          );
          return pngResponse(png.bytes, png.etag);
        }
        return c.json({
          ok: true,
          data: getInkDoc(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            raw,
          ),
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
      })
  );
}
