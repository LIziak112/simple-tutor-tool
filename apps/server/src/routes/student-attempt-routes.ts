import {
  attemptActivateRequestSchema,
  attemptAnswerSaveRequestSchema,
  attemptContextDataSchema,
  attemptFlagRequestSchema,
  attemptOpenedQuerySchema,
  hintOpenRequestSchema,
  studentPaperDataSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client.ts";
import { parseJsonBody, parseJsonValue } from "../lib/http-error.ts";
import {
  activateAttempt,
  getOpenedAttempt,
} from "../services/attempt-activation.ts";
import { studentAttemptContext } from "../services/attempt-context.ts";
import {
  getStudentAttemptPaper,
  requireUsableAttempt,
  saveDraftAnswer,
  setStudentFlag,
} from "../services/attempt-service.ts";
import { openHint } from "../services/hint-service.ts";
import { respondAttemptDetail } from "./student-attempt-detail.ts";
import { createStudentLearningContextRoutes } from "./student-learning-context";
import { createStudentSettlementRoutes } from "./student-settlements.ts";

/** 作答详情、冻结上下文、公开试卷，以及草稿保存、标记、提示这几条带冻结凭据写入的契约出口。 */
export function createStudentAttemptRoutes(db: Db) {
  return (
    new Hono<StudentEnv>()
      .get("/attempts/opened", (c) =>
        c.json({
          ok: true,
          data: getOpenedAttempt(
            db,
            c.var.student.id,
            parseJsonValue(c.req.query(), attemptOpenedQuerySchema),
          ),
        }),
      )
      .post("/attempts/:id/activate", async (c) => {
        const input = await parseJsonBody(c, attemptActivateRequestSchema);
        c.header("Cache-Control", "private, no-store");
        return c.json({
          ok: true,
          data: activateAttempt(db, c.var.student.id, c.req.param("id"), input),
        });
      })
      .route("/", createStudentLearningContextRoutes(db))
      .route("/", createStudentSettlementRoutes(db))
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
            body,
          ),
        });
      })
      // #6980-4：做题时标注「不会」（进错题本）：仅 draft 可改（交卷后 409），请求/回执只有标志位、不含答案内容（泄露测试 student-flags.test.ts）
      .put("/attempts/:id/flags/:questionId", async (c) => {
        const body = await parseJsonBody(c, attemptFlagRequestSchema);
        return c.json({
          ok: true,
          data: setStudentFlag(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            body.flag,
            body,
          ),
        });
      })
      // T2.11：分步提示——按需下发被请求的那一条并记录（hint_open 事件 + 已解锁集合）
      .post("/attempts/:id/hints", async (c) => {
        const body = await parseJsonBody(c, hintOpenRequestSchema);
        return c.json({
          ok: true,
          data: openHint(
            db,
            c.var.student.id,
            c.req.param("id"),
            body.questionId,
            body.index,
            body,
          ),
        });
      })
      .get("/attempts/:id", (c) =>
        respondAttemptDetail(c, db, c.var.student.id, c.req.param("id")),
      )
      // tt-07a（QM-06）：冻结上下文公开投影（材料/组快照）读取——作答期渲染与
      // 结果回看共用，只读快照不查 live 库（教师改材料/软删不影响已开卷）；坏
      // 快照 409 ATTEMPT_CONTEXT_BROKEN 显式报错。归属校验复用
      // requireUsableAttempt（TT-05b 审查 P2-2 记账：快照读取按 attemptId 直查
      // 不过滤 teacherId，归属防线在路由层——跨域同 attempt id 不可见）
      .get("/attempts/:id/context", (c) => {
        requireUsableAttempt(db, c.var.student.id, c.req.param("id"));
        return c.json({
          ok: true,
          data: attemptContextDataSchema.parse(
            studentAttemptContext(db, c.req.param("id")),
          ),
        });
      })
      // T2A.6：通用取卷（两种来源共用；T5 鉴权口径——assignment 来源归属即
      // 权限，被移出/作业软删后已建作答仍可取卷；course 来源每次校验可见性与
      // 成员资格，D22——course draft 失去访问权 403/404，前端据此按终态停发）
      .get("/attempts/:id/paper", (c) => {
        return c.json({
          ok: true,
          data: studentPaperDataSchema.parse(
            getStudentAttemptPaper(db, c.var.student.id, c.req.param("id")),
          ),
        });
      })
  );
}
