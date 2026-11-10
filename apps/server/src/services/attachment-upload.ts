import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Attachment, AttachmentUploadFields } from "@tutor/contract";
import { ATTACHMENT_MAX_UPLOAD_BYTES } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { attachments } from "../db/schema";
import { writeFileAtomic } from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import {
  detectAttachmentFormat,
  pdfPageCountOf,
  sanitizeAttachmentFileName,
} from "./attachment-format";
import {
  type AttachmentRow,
  attachmentDir,
  courseTitlesOf,
  requireTeacherCourse,
  toAttachment,
} from "./attachment-service";

/**
 * 资料附件的上传写路径（从 attachment-service 拆出：列表 / 改 / 删 / 读留在那边，
 * 两边按「写入规则」与「读取规则」各自变化）：
 *
 * - 幂等键 uploadId（审查 #103-04）：客户端每个上传条目生成一个（重试复用），
 *   服务端按 (teacher_id, upload_id) 唯一——回执丢失后重试不会多出一份资料。
 *   带键先查同教师同键的既有行（含已软删：重放语义是「同一次上传」，不复活不重建，
 *   与随笔 clientId 同口径），命中直接返回 created=false、不再写盘；并发重放撞
 *   唯一索引时重读返回先落的那条；不带键（NULL）每次都是新的一行；
 * - 格式只认内容（attachment-format）：不是 PDF / docx → 415；
 * - 上限 20 MB（契约 ATTACHMENT_MAX_UPLOAD_BYTES）：content-length 预检在 app.ts、
 *   流式计数在路由（parseMultipartCapped），此处按文件实际字节最后兜底 → 413；
 * - 内容寻址落盘 blobs/attachments/<sha256>.<pdf|docx>，同内容跳过写入、多行共享
 *   一个 blob；页数只在能从 PDF 读到时给。
 */

export interface CreateAttachmentInput extends AttachmentUploadFields {
  readonly teacherId: string;
  /** 上传时的原文件名（可缺） */
  readonly fileName?: string | undefined;
  readonly bytes: Uint8Array;
}

/** 创建结果：created=false 表示命中 uploadId 幂等键、返回的是既有那条 */
export interface CreateAttachmentResult {
  readonly attachment: Attachment;
  readonly created: boolean;
}

function findByUploadId(
  db: Db,
  teacherId: string,
  uploadId: string,
): AttachmentRow | undefined {
  return db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.teacherId, teacherId),
        eq(attachments.uploadId, uploadId),
      ),
    )
    .get();
}

/** 插行；带 uploadId 时按幂等键处理唯一冲突 */
function insertIdempotent(
  db: Db,
  row: AttachmentRow,
): { row: AttachmentRow; created: boolean } {
  try {
    db.insert(attachments).values(row).run();
  } catch (err) {
    if (row.uploadId !== null) {
      const raced = findByUploadId(db, row.teacherId, row.uploadId);
      if (raced !== undefined) return { row: raced, created: false };
    }
    throw err;
  }
  return { row, created: true };
}

function toCreateResult(
  db: Db,
  row: AttachmentRow,
  created: boolean,
): CreateAttachmentResult {
  return {
    attachment: toAttachment(row, courseTitlesOf(db, [row.courseId])),
    created,
  };
}

/**
 * 上传：幂等键命中直接返回 → 课程归属 → 识别格式 → 限额 → 内容寻址落盘 → 插行
 * （不带 uploadId 时同内容再传是新的一行，blob 共享）
 */
export function createAttachment(
  db: Db,
  dataDir: string,
  input: CreateAttachmentInput,
  now: Date = new Date(),
): CreateAttachmentResult {
  const existing =
    input.uploadId === undefined
      ? undefined
      : findByUploadId(db, input.teacherId, input.uploadId);
  if (existing !== undefined) return toCreateResult(db, existing, false);
  if (input.courseId !== undefined) {
    requireTeacherCourse(db, input.teacherId, input.courseId);
  }
  const format = detectAttachmentFormat(input.bytes);
  if (format === null) {
    throw new HttpError(
      415,
      "ATTACHMENT_UNSUPPORTED_TYPE",
      "文件格式不受支持：按文件内容识别，只接受 PDF 与 Word（docx）",
    );
  }
  if (input.bytes.byteLength > ATTACHMENT_MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      "ATTACHMENT_TOO_LARGE",
      "文件超过 20 MB 上传上限，请压缩或拆分后重试",
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
  const filePath = join(attachmentDir(dataDir), `${sha256}.${format}`);
  if (!existsSync(filePath)) {
    writeFileAtomic({ finalPath: filePath, bytes: input.bytes });
  }
  const nowIso = now.toISOString();
  const row: AttachmentRow = {
    id: crypto.randomUUID(),
    teacherId: input.teacherId,
    courseId: input.courseId ?? null,
    fileName: sanitizeAttachmentFileName(input.fileName, format),
    format,
    bytes: input.bytes.byteLength,
    sha256,
    pageCount: format === "pdf" ? pdfPageCountOf(input.bytes) : null,
    visibility: input.visibility ?? "students",
    createdAt: nowIso,
    updatedAt: nowIso,
    deletedAt: null,
    uploadId: input.uploadId ?? null,
  };
  const inserted = insertIdempotent(db, row);
  return toCreateResult(db, inserted.row, inserted.created);
}
