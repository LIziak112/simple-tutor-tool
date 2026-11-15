import { createHash } from "node:crypto";
import { type MemoAgentCreate, normalizeMemoTags } from "@tutor/contract";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error";
import type { MemoRow } from "./memo-read";
/** 记录原请求语义，不从未来时间收口后的记录或自动来源文案反推。 */
export function memoOperationDigest(input: MemoAgentCreate): string {
  const anchor = input.anchor;
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        text: input.text,
        tags: normalizeMemoTags(input.tags ?? []),
        parentMemoSeq: input.parentMemoSeq ?? null,
        recordedAt:
          input.recordedAt === undefined
            ? null
            : new Date(input.recordedAt).toISOString(),
        anchor:
          anchor === undefined
            ? null
            : anchor.kind === "question"
              ? {
                  kind: anchor.kind,
                  attemptId: anchor.attemptId,
                  questionId: anchor.questionId,
                  label: anchor.label ?? null,
                }
              : {
                  kind: anchor.kind,
                  lectureId: anchor.lectureId,
                  sectionId: anchor.sectionId ?? null,
                  label: anchor.label ?? null,
                },
        // 未传上下文时保持旧摘要逐字节兼容；新上下文参与同键异内容校验。
        ...(input.context === undefined
          ? {}
          : { context: canonicalJsonOf(input.context) }),
      }),
    )
    .digest("hex");
}
/** 外层预查、事务内重查和唯一键兜底必须使用同一验证器。 */
export function assertMemoOperation(
  row: MemoRow,
  digest: string | undefined,
): void {
  if (
    digest !== undefined &&
    (row.source !== "agent" || row.agentRequestDigest !== digest)
  )
    throw new HttpError(
      409,
      "MEMO_OPERATION_CONFLICT",
      "幂等键已用于另一条随笔",
    );
}
