import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Memo,
  MemoAgentCreate,
  MemoAnchor,
  MemoCreateMedia,
  MemoCreateText,
  MemoDevice,
  MemoMediaFormat,
  MemoSource,
} from "@tutor/contract";
import {
  MEMO_ANCHOR_NONE,
  MEMO_IMAGE_MAX_BYTES,
  MEMO_VOICE_MAX_BYTES,
  normalizeMemoTags,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { memos } from "../db/schema";
import { writeFileAtomic } from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import { resolveAgentMemoAnchor } from "./memo-anchor";
import { detectMemoMediaFormat } from "./memo-format";
import { MEMO_BLOB_DIR, type MemoRow, toMemo } from "./memo-read";

/**
 * 随笔写侧（2026-11-10，个人学习迭代模块 5 第一步「随笔记录端」）。
 *
 * - 原始随笔不可变：只有 create（本文件）/ list / soft delete / read media
 *   （memo-read），没有 update；
 * - 幂等：(studentId, clientId) 唯一——同一 clientId 再来直接返回已有行
 *   （created=false），离线补传 / 重试不产生重复；
 * - 媒体：格式只认内容（memo-format），语音 ≤ 20 MB、图片 / 手写 ≤ 10 MB，内容
 *   寻址落盘 blobs/memos/<sha256>.<ext>，同内容幂等跳过写入、软删不删 blob；
 * - 默认仅本人：所有写入以 studentId 为域；教师侧没有任何入口；
 * - Agent 转记（source=agent）：锚经 memo-anchor 核对本人可见后生成 label。
 */

function memoDir(dataDir: string): string {
  const dir = join(dataDir, "blobs", MEMO_BLOB_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function existingByClientId(
  db: Db,
  studentId: string,
  clientId: string,
): MemoRow | undefined {
  return db
    .select()
    .from(memos)
    .where(and(eq(memos.studentId, studentId), eq(memos.clientId, clientId)))
    .get();
}

interface InsertInput {
  readonly studentId: string;
  readonly clientId: string;
  readonly kind: MemoRow["kind"];
  readonly text: string | null;
  readonly media: {
    format: MemoMediaFormat;
    bytes: number;
    sha256: string;
    durationSec: number | null;
  } | null;
  readonly anchor: MemoAnchor;
  readonly tags: readonly string[];
  readonly source: MemoSource;
  readonly device: MemoDevice;
  readonly recordedAt: string | undefined;
}

/** 创建结果：created=false 表示命中幂等键、返回的是已有那条 */
export interface MemoCreateResult {
  readonly memo: Memo;
  readonly created: boolean;
}

function insertMemo(db: Db, input: InsertInput, now: Date): MemoCreateResult {
  const existing = existingByClientId(db, input.studentId, input.clientId);
  if (existing !== undefined) {
    return { memo: toMemo(existing), created: false };
  }
  const nowIso = now.toISOString();
  const recordedAt =
    input.recordedAt === undefined
      ? nowIso
      : new Date(input.recordedAt).toISOString();
  const row: MemoRow = {
    id: crypto.randomUUID(),
    studentId: input.studentId,
    clientId: input.clientId,
    kind: input.kind,
    text: input.text,
    mediaFormat: input.media?.format ?? null,
    mediaBytes: input.media?.bytes ?? null,
    mediaSha256: input.media?.sha256 ?? null,
    durationSec: input.media?.durationSec ?? null,
    anchorJson: JSON.stringify(input.anchor),
    anchorAttemptId:
      input.anchor.kind === "question" ? input.anchor.attemptId : null,
    anchorLectureId:
      input.anchor.kind === "lecture" ? input.anchor.lectureId : null,
    tagsJson: JSON.stringify(normalizeMemoTags(input.tags)),
    source: input.source,
    device: input.device,
    createdAt: nowIso,
    // 设备时间晚于服务端时间（时钟漂移）时按服务端时间收口，列表排序不穿越到未来
    recordedAt: recordedAt > nowIso ? nowIso : recordedAt,
    deletedAt: null,
  };
  try {
    db.insert(memos).values(row).run();
  } catch (err) {
    // 并发补传撞唯一键：按幂等语义返回先落的那条
    const raced = existingByClientId(db, input.studentId, input.clientId);
    if (raced !== undefined) return { memo: toMemo(raced), created: false };
    throw err;
  }
  return { memo: toMemo(row), created: true };
}

// ---------- 本人界面 ----------

export interface CreateTextMemoInput extends MemoCreateText {
  readonly studentId: string;
}

/** 文字随笔 */
export function createTextMemo(
  db: Db,
  input: CreateTextMemoInput,
  now: Date = new Date(),
): MemoCreateResult {
  return insertMemo(
    db,
    {
      studentId: input.studentId,
      clientId: input.clientId,
      kind: "text",
      text: input.text,
      media: null,
      anchor: input.anchor ?? MEMO_ANCHOR_NONE,
      tags: input.tags ?? [],
      source: "self",
      device: input.device ?? "other",
      recordedAt: input.recordedAt,
    },
    now,
  );
}

export interface CreateMediaMemoInput extends MemoCreateMedia {
  readonly studentId: string;
  readonly bytes: Uint8Array;
}

/** 语音 / 图片 / 手写：识别格式 → 限额 → 内容寻址落盘 → 插行（幂等键命中时不落盘） */
export function createMediaMemo(
  db: Db,
  dataDir: string,
  input: CreateMediaMemoInput,
  now: Date = new Date(),
): MemoCreateResult {
  const existing = existingByClientId(db, input.studentId, input.clientId);
  if (existing !== undefined) {
    return { memo: toMemo(existing), created: false };
  }
  const format = detectMemoMediaFormat(input.kind, input.bytes);
  if (format === null) {
    throw new HttpError(
      415,
      "MEMO_UNSUPPORTED_TYPE",
      input.kind === "voice"
        ? "录音格式不受支持：按文件内容识别，只接受 m4a / mp4 / webm / ogg / wav / mp3"
        : "图片格式不受支持：按文件内容识别，只接受 PNG / JPEG / WebP / GIF",
    );
  }
  const limit =
    input.kind === "voice" ? MEMO_VOICE_MAX_BYTES : MEMO_IMAGE_MAX_BYTES;
  if (input.bytes.byteLength > limit) {
    throw new HttpError(
      413,
      "MEMO_TOO_LARGE",
      input.kind === "voice"
        ? "录音超过 20 MB 上限，请拆成几条短的"
        : "图片超过 10 MB 上限，请压缩后重试",
    );
  }
  const sha256 = createHash("sha256")
    .update(
      Buffer.from(
        input.bytes.buffer,
        input.bytes.byteOffset,
        input.bytes.byteLength,
      ),
    )
    .digest("hex");
  const filePath = join(memoDir(dataDir), `${sha256}.${format}`);
  if (!existsSync(filePath)) {
    writeFileAtomic({ finalPath: filePath, bytes: input.bytes });
  }
  return insertMemo(
    db,
    {
      studentId: input.studentId,
      clientId: input.clientId,
      kind: input.kind,
      text: input.text === undefined || input.text === "" ? null : input.text,
      media: {
        format,
        bytes: input.bytes.byteLength,
        sha256,
        durationSec:
          input.kind === "voice" ? (input.durationSec ?? null) : null,
      },
      anchor: input.anchor ?? MEMO_ANCHOR_NONE,
      tags: input.tags ?? [],
      source: "self",
      device: input.device ?? "other",
      recordedAt: input.recordedAt,
    },
    now,
  );
}

// ---------- Agent 转记（MCP） ----------

/** Agent 经 MCP 代为转记：source=agent、device=agent；每次调用是新的一条（clientId 服务端生成） */
export function createAgentMemo(
  db: Db,
  studentId: string,
  input: MemoAgentCreate,
  now: Date = new Date(),
): Memo {
  const anchor =
    input.anchor === undefined
      ? MEMO_ANCHOR_NONE
      : resolveAgentMemoAnchor(db, studentId, input.anchor, now);
  return insertMemo(
    db,
    {
      studentId,
      clientId: crypto.randomUUID(),
      kind: "text",
      text: input.text,
      media: null,
      anchor,
      tags: input.tags ?? [],
      source: "agent",
      device: "agent",
      recordedAt: input.recordedAt,
    },
    now,
  ).memo;
}
