import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  attemptStartOptionsRequestSchema,
  courseAttemptStartOptionsRequestSchema,
  lessonRestartRequestSchema,
  replayableWrongPracticeRequestSchema,
  studentLectureDetailQuerySchema,
} from "@tutor/contract";
import { type Context, Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import {
  HttpError,
  parseJsonBody,
  parseJsonBodyOrEmpty,
} from "../lib/http-error";
import type { AttemptStartClient } from "../services/attempt-opened-refresh.ts";
import { startAttempt, startCourseAttempt } from "../services/attempt-start.ts";
import {
  restartLessonAttempt,
  startLessonAttempt,
} from "../services/lesson-service";
import { startWrongPractice } from "../services/wrong-practice";

/**
 * 开卷请求方的能力：只有带凭据头的新前端包，再次进入未激活的卷时才会重冻。
 * 升级前仍在运行的旧包不带这个头，拿到的还是原来冻结的那一版，行为不变。
 */
const startClientOf = (c: Context): AttemptStartClient => ({
  snapshotProof: c.req.header(ATTEMPT_SNAPSHOT_PROOF_HEADER) === "1",
});

/** 作业开卷的 HTTP 契约与已认证学生身份由同一个处理器提供。 */
export function createAssignmentAttemptStartRoutes(
  db: Db,
  startAssignmentAttempt = startAttempt,
) {
  return new Hono<StudentEnv>().post("/assignments/:id/attempt", async (c) => {
    const options =
      (await parseJsonBodyOrEmpty(c, attemptStartOptionsRequestSchema)) ?? {};
    return c.json({
      ok: true,
      data: startAssignmentAttempt(
        db,
        c.var.student.id,
        c.req.param("id"),
        options,
        startClientOf(c),
      ),
    });
  });
}

/** 开卷与建卷入口：作业、课程单元、讲练的开始与重开，错题重练组卷。 */
export function createStudentCreateRoutes(db: Db, dataDir: string) {
  const startAssignment: typeof startAttempt = (
    current,
    student,
    assignment,
    options,
    client,
  ) => startAttempt(current, student, assignment, options, client, dataDir);
  return (
    new Hono<StudentEnv>()
      .route("/", createAssignmentAttemptStartRoutes(db, startAssignment))
      // T2A.6：课程练习入口（存在未交卷作答返回它；否则新建 attemptNo+1，
      // 新一次从空白开始；事务保证并发只得一份 draft）
      .post("/courses/:id/units/:unitId/attempts", async (c) => {
        const options =
          (await parseJsonBodyOrEmpty(
            c,
            courseAttemptStartOptionsRequestSchema,
          )) ?? {};
        return c.json(
          {
            ok: true,
            data: startCourseAttempt(
              db,
              c.var.student.id,
              c.req.param("id"),
              c.req.param("unitId"),
              options,
              startClientOf(c),
            ),
          },
          201,
        );
      })
      // 2026-10 讲练一体：讲练开卷（幂等 create-or-return——进行中返回同一份
      // draft、已完成返回最新那份，绝不重开；无作答才建卷冻结）。访问判定与
      // GET /lectures/:id 同一三分谓词（?courseId= 可选课程上下文，契约未定义
      // start 请求体 schema，复用详情查询 schema 的 query 形态）；响应是讲练
      // 安全投影（blocks 切段 + 冻结题公开投影 + released/summary），原文与
      // 未提交题的答案/详解/提示内容绝不下发（泄露矩阵 routes/student-lesson.test.ts）
      .post("/lectures/:id/lesson/start", (c) => {
        const parsed = studentLectureDetailQuerySchema.safeParse({
          courseId: c.req.query("courseId") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "查询参数不合法：courseId 必须是 UUID 格式",
          );
        }
        return c.json({
          ok: true,
          data: startLessonAttempt(
            db,
            c.var.student.id,
            c.req.param("id"),
            parsed.data.courseId,
            startClientOf(c),
          ),
        });
      })
      // 按前端选题顺序冻结错题。响应仅携带新卷摘要。
      .post("/wrong-practice", async (c) => {
        const body = await parseJsonBody(
          c,
          replayableWrongPracticeRequestSchema,
        );
        const { attempt } = startWrongPractice(
          db,
          c.var.student.id,
          body.questionIds,
          {
            workflowVersion: body.workflowVersion,
            feedbackMode: body.feedbackMode,
          },
          body.scope,
          body.operationId,
          dataDir,
        );
        return c.json({ ok: true, data: attempt }, 201);
      })
      // 旧调用可省略请求体。新客户端确认时固定原卷与操作标识。
      .post("/lectures/:id/lesson/restart", async (c) => {
        const body = await parseJsonBodyOrEmpty(c, lessonRestartRequestSchema);
        const data = restartLessonAttempt(
          db,
          c.var.student.id,
          c.req.param("id"),
          body,
          startClientOf(c),
        );
        return c.json({ ok: true, data }, 201);
      })
  );
}
