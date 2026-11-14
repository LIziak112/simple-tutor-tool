import {
  MEMO_ANCHOR_NONE,
  MEMO_JSON_BODY_MAX_BYTES,
  MEMO_METADATA_LIMIT_MESSAGE,
  MEMO_METADATA_MAX_BYTES,
  MEMO_METADATA_TOO_LARGE,
  type MemoMetadataInput,
} from "@tutor/contract";
import { HttpError } from "../lib/http-error";

function tooLarge(): never {
  throw new HttpError(
    413,
    MEMO_METADATA_TOO_LARGE,
    MEMO_METADATA_LIMIT_MESSAGE,
  );
}

/** 固定形状的元数据 JSON 计量，系统固定字段不受客户端任意扩展。 */
function memoMetadataByteLength(input: MemoMetadataInput): number {
  return Buffer.byteLength(
    JSON.stringify({
      anchor: input.anchor ?? MEMO_ANCHOR_NONE,
      context: input.context ?? null,
      tags: input.tags ?? [],
      device: input.device ?? "other",
      deviceId: input.deviceId ?? null,
      recordedAt: input.recordedAt ?? null,
    }),
    "utf8",
  );
}

/** 本人界面、离线补传和 MCP 共用；来源展开后也要验证，超量不部分落库。 */
export function assertMemoMetadataBudget(input: MemoMetadataInput): void {
  if (memoMetadataByteLength(input) > MEMO_METADATA_MAX_BYTES) tooLarge();
}

/** multipart 文件沿用媒体限额，其余所有字段（含重复/未知字段）另计信封预算。 */
export function assertMemoMultipartEnvelope(form: FormData): void {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [key, value] of form) {
    if (typeof value !== "string") continue;
    bytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
    if (bytes > MEMO_JSON_BODY_MAX_BYTES) tooLarge();
  }
}
