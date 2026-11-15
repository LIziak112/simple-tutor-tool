import { reviewV2CreateSchema } from "@tutor/contract";
import { createDb } from "../db/client.ts";
import { createReviewV2Run } from "../services/ai-companion/review-v2.ts";

const [filename, studentId, attemptId, requestJson] = process.argv.slice(2);
if (!filename || !studentId || !attemptId || !requestJson)
  throw new Error("竞争参数不完整");
const input = reviewV2CreateSchema.parse(JSON.parse(requestJson));
const db = createDb(filename);
process.on("message", () => {
  try {
    createReviewV2Run(db, studentId, attemptId, input, {
      hmacSecret: "review-v2-race-test-secret",
    });
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
