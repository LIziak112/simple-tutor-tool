import type { PracticeQuestionSubmitWithAnswer } from "@tutor/contract";
import { createDb } from "../db/client.ts";
import { submitPracticeQuestion } from "../services/attempt-question-submit.ts";
import { submitAttempt } from "../services/attempt-whole-submit.ts";

/** 真实独立进程/连接的测试执行器，仅输出错误码和成功事实。 */
const [filename, studentId, attemptId, requestJson] = process.argv.slice(2);
if (!filename || !studentId || !attemptId || !requestJson)
  throw new Error("竞争测试参数不完整");
const request: PracticeQuestionSubmitWithAnswer | null =
  JSON.parse(requestJson);
const db = createDb(filename);
process.on("message", () => {
  try {
    if (request)
      submitPracticeQuestion(
        db,
        studentId,
        attemptId,
        request.evidence.questionId,
        request,
        "2026-11-01T00:01:00.000Z",
      );
    else submitAttempt(db, studentId, attemptId, "2026-11-01T00:01:00.000Z");
    process.send?.({ ok: true });
  } catch (error) {
    process.send?.({
      ok: false,
      code: error instanceof Error && "code" in error ? error.code : "UNKNOWN",
    });
  } finally {
    db.$client.close();
    process.disconnect();
  }
});
process.send?.({ ready: true });
