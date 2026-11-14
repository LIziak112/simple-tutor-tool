import { attemptPartialRequestSchema } from "@tutor/contract";
import { createDb } from "../db/client.ts";
import { settleStudentAttempt } from "../services/attempt-partial.ts";
import { submitAttempt } from "../services/attempt-whole-submit.ts";

const [filename, studentId, attemptId, requestJson] = process.argv.slice(2);
if (!filename || !studentId || !attemptId || !requestJson)
  throw new Error("竞争测试参数不完整");
const raw: unknown = JSON.parse(requestJson);
const request = raw === null ? null : attemptPartialRequestSchema.parse(raw);
const db = createDb(filename);
process.on("message", () => {
  try {
    if (request) settleStudentAttempt(db, studentId, attemptId, request);
    else submitAttempt(db, studentId, attemptId);
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
