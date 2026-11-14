import { join } from "node:path";
import type {
  Memo,
  MemoListData,
  MemoListQuery,
  MemoMediaFormat,
} from "@tutor/contract";
import {
  learningContextSchema,
  MEMO_ANCHOR_NONE,
  MEMO_MEDIA_CONTENT_TYPE,
  memoAnchorSchema,
  memoSchema,
  memoTagsSchema,
} from "@tutor/contract";
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { memos } from "../db/schema";
import { readFileBytes } from "../lib/blob-io";
import { HttpError } from "../lib/http-error";

/**
 * 随笔读侧（模块 5 第一步）：行 → 契约投影、本人列表（游标分页 + 过滤）、
 * 软删、媒体字节读取。全部以 studentId 为域（默认仅本人）；写入见 memo-service。
 */

export const MEMO_BLOB_DIR = "memos";

export type MemoRow = typeof memos.$inferSelect;

export function memoNotFound(): HttpError {
  return new HttpError(404, "MEMO_NOT_FOUND", "随笔不存在（可能已被删除）");
}

/** 行 → 契约对象（anchor / tags 从 JSON 还原并经契约校验：漂移即编程错误） */
export function toMemo(row: MemoRow): Memo {
  const anchorParsed = memoAnchorSchema.safeParse(JSON.parse(row.anchorJson));
  const tagsParsed = memoTagsSchema.safeParse(JSON.parse(row.tagsJson));
  return memoSchema.parse({
    id: row.id,
    ...(row.seq === null ? {} : { seq: row.seq }),
    context:
      row.contextJson === null
        ? null
        : learningContextSchema.parse(JSON.parse(row.contextJson)),
    deviceId: row.deviceId,
    parentMemoSeq: row.parentMemoSeq,
    kind: row.kind,
    text: row.text,
    media:
      row.mediaFormat === null ||
      row.mediaBytes === null ||
      row.mediaSha256 === null
        ? null
        : {
            format: row.mediaFormat,
            bytes: row.mediaBytes,
            durationSec: row.durationSec,
          },
    anchor: anchorParsed.success ? anchorParsed.data : MEMO_ANCHOR_NONE,
    tags: tagsParsed.success ? tagsParsed.data : [],
    source: row.source,
    device: row.device,
    createdAt: row.createdAt,
    recordedAt: row.recordedAt,
  });
}

const DEFAULT_LIMIT = 30;

/** 游标 = `${recordedAt}|${id}`（keyset：recordedAt 倒序、id 倒序） */
function parseCursor(
  cursor: string | undefined,
): { recordedAt: string; id: string } | null {
  if (cursor === undefined) return null;
  const at = cursor.lastIndexOf("|");
  if (at <= 0 || at === cursor.length - 1) {
    throw new HttpError(400, "VALIDATION_ERROR", "cursor 无效");
  }
  return { recordedAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

/**
 * 本人随笔：记录时间倒序、游标分页；可按形态 / 标签 / 锚 / 起始时间过滤。
 * 标签存在 JSON 数组列里，过滤用 json_each 下沉到 SQL（曾「先取最近若干条再内存
 * 过滤」——稀疏标签的旧随笔会永远翻不到，#104-06），hasMore 统一按 limit + 1 判。
 */
export function listMemos(
  db: Db,
  studentId: string,
  query: MemoListQuery,
): MemoListData {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const cursor = parseCursor(query.cursor);
  const rows = db
    .select()
    .from(memos)
    .where(
      and(
        eq(memos.studentId, studentId),
        isNull(memos.deletedAt),
        query.seq === undefined ? undefined : eq(memos.seq, query.seq),
        query.parentMemoSeq === undefined
          ? undefined
          : eq(memos.parentMemoSeq, query.parentMemoSeq),
        query.questionId === undefined
          ? undefined
          : sql`json_extract(${memos.anchorJson}, '$.questionId') = ${query.questionId}`,
        query.kind === undefined ? undefined : eq(memos.kind, query.kind),
        query.tag === undefined
          ? undefined
          : sql`exists (select 1 from json_each(${memos.tagsJson}) where json_each.value = ${query.tag})`,
        query.attemptId === undefined
          ? undefined
          : eq(memos.anchorAttemptId, query.attemptId),
        query.lectureId === undefined
          ? undefined
          : eq(memos.anchorLectureId, query.lectureId),
        query.since === undefined
          ? undefined
          : gte(memos.recordedAt, new Date(query.since).toISOString()),
        cursor === null
          ? undefined
          : or(
              lt(memos.recordedAt, cursor.recordedAt),
              and(
                eq(memos.recordedAt, cursor.recordedAt),
                lt(memos.id, cursor.id),
              ),
            ),
      ),
    )
    .orderBy(desc(memos.recordedAt), desc(memos.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    memos: page.map(toMemo),
    nextCursor:
      hasMore && last !== undefined ? `${last.recordedAt}|${last.id}` : null,
  };
}

export function requireOwnMemoRow(
  db: Db,
  studentId: string,
  id: string,
): MemoRow {
  const row = db
    .select()
    .from(memos)
    .where(
      and(
        eq(memos.id, id),
        eq(memos.studentId, studentId),
        isNull(memos.deletedAt),
      ),
    )
    .get();
  if (row === undefined) throw memoNotFound();
  return row;
}

/** 本人删除（软删，blob 保留） */
export function deleteMemo(
  db: Db,
  studentId: string,
  id: string,
  now: Date = new Date(),
): void {
  requireOwnMemoRow(db, studentId, id);
  db.update(memos)
    .set({ deletedAt: now.toISOString() })
    .where(eq(memos.id, id))
    .run();
}

export interface MemoMediaFile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly format: MemoMediaFormat;
  readonly memo: Memo;
}

/** 本人读媒体字节（<audio> / <img> 直出与 MCP 取件共用）；文字随笔 / 看不到的一律 404 */
export function readMemoMedia(
  db: Db,
  dataDir: string,
  studentId: string,
  id: string,
): MemoMediaFile {
  const row = requireOwnMemoRow(db, studentId, id);
  const memo = toMemo(row);
  if (memo.media === null || row.mediaSha256 === null) throw memoNotFound();
  try {
    return {
      bytes: readFileBytes(
        join(
          dataDir,
          "blobs",
          MEMO_BLOB_DIR,
          `${row.mediaSha256}.${memo.media.format}`,
        ),
      ),
      contentType: MEMO_MEDIA_CONTENT_TYPE[memo.media.format],
      format: memo.media.format,
      memo,
    };
  } catch {
    // 行在、文件不在（磁盘被动过）：对外同「不存在」
    throw memoNotFound();
  }
}
