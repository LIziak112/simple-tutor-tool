import { createHash } from "node:crypto";
import type { PracticeQuestionSubmitWithAnswer } from "@tutor/contract";
import { canonicalJsonOf } from "../lib/canonical-json.ts";

export function practiceRequestDigestOf(
  attemptId: string,
  questionId: string,
  req: PracticeQuestionSubmitWithAnswer,
): string {
  const evidence = `${req.evidence.state}\u0001${req.evidence.versionId ?? ""}\u0001${req.evidence.revision ?? ""}\u0001${req.evidence.questionId}`;
  return createHash("sha256")
    .update(
      [
        "practice-submit-v1",
        attemptId,
        questionId,
        String(req.workflowRevision),
        req.questionRevisionId,
        String(req.expectedAnswerRevision),
        evidence,
        ...(req.answer === undefined ? [] : [canonicalJsonOf(req.answer)]),
      ].join("\u0000"),
    )
    .digest("hex");
}
