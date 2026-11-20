import {
  lessonQuestionSubmitRequestSchema,
  practiceQuestionSubmitDataSchema,
  practiceQuestionSubmitRequestSchema,
} from "@tutor/contract";
import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student.ts";
import type { Db } from "../db/client.ts";
import { parseJsonValue, readJsonBody } from "../lib/http-error.ts";
import { submitPracticeQuestion } from "../services/attempt-service.ts";
import { submitBoundLessonQuestion } from "../services/kernel-lesson-question-submit.ts";

export function createStudentQuestionSubmissionRoutes(db: Db, dataDir: string) {
  return (
    new Hono<StudentEnv>()
      // 2026-10 讲练一体 + M2 新协议分流（2026-10-22 计划 §5.3/§10.1）：
      // 同一 URL 按请求形态分流——携带 workflowVersion 字段走新协议路径
      //（practiceQuestionSubmitRequest strict 契约；仅普通来源新协议卷，
      // 回执四键白名单 + private,no-store）；否则 lesson 旧协议形态沿用既有
      // 契约与行为。两套契约互不放宽：新协议请求打到 lesson/历史卷、旧协议
      // 形态打到新协议卷都被服务层 409 拒绝并提示刷新（§5.3 不退回整卷无
      // 版本写入）；是否允许逐题提交由工作流与教师规则裁决（409
      // WORKFLOW_RESTRICTED 等，详见 attempt-service.submitPracticeQuestion）
      .post("/attempts/:id/questions/:questionId/submit", async (c) => {
        const raw = await readJsonBody(c);
        if (
          typeof raw === "object" &&
          raw !== null &&
          "workflowVersion" in raw
        ) {
          const parsed = parseJsonValue(
            raw,
            practiceQuestionSubmitRequestSchema,
          );
          return c.json(
            {
              ok: true,
              data: practiceQuestionSubmitDataSchema.parse(
                submitPracticeQuestion(
                  db,
                  c.var.student.id,
                  c.req.param("id"),
                  c.req.param("questionId"),
                  parsed,
                ),
              ),
            },
            200,
            { "Cache-Control": "private, no-store" },
          );
        }
        const legacy = parseJsonValue(raw, lessonQuestionSubmitRequestSchema);
        return c.json({
          ok: true,
          data: submitBoundLessonQuestion(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            legacy,
          ),
        });
      })
  );
}
