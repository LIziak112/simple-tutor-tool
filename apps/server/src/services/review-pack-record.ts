import { learningRecordJsonSchema } from "@tutor/contract";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import { assembleQuestionLearningRecord } from "./learning-record-service.ts";
import type { QuestionRecordScope } from "./question-record-scope.ts";

/** 给单题包附上与单题详情同角色、同冻结题的学习记录。 */
export function reviewPackRecordOf(
  db: Db,
  dataDir: string,
  scope: QuestionRecordScope,
  now: Date,
  questionRef: string,
) {
  try {
    const learningRecord = assembleQuestionLearningRecord(
      db,
      dataDir,
      scope,
      now,
    );
    const recordJson = `${JSON.stringify(learningRecord, null, 2)}\n`;
    const recordSchemaJson = `${JSON.stringify(learningRecordJsonSchema, null, 2)}\n`;
    return {
      recordJson,
      recordSchemaJson,
      recordNote: null,
      recordEntries: [
        {
          path: "record.json",
          kind: "record" as const,
          bytes: Buffer.byteLength(recordJson, "utf8"),
          refs: [questionRef],
        },
        {
          path: "record-schema.json",
          kind: "record" as const,
          bytes: Buffer.byteLength(recordSchemaJson, "utf8"),
          refs: [questionRef],
        },
      ],
    };
  } catch (err) {
    // 遗留缺快照等业务错误如实列入清单；契约错误仍中止装配。
    if (!(err instanceof HttpError)) throw err;
    return {
      recordJson: null,
      recordSchemaJson: null,
      recordNote: `record.json 未装配：${err.code}: ${err.message}`,
      recordEntries: [],
    };
  }
}
