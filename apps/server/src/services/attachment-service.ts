import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Attachment,
  AttachmentFormat,
  AttachmentUpdate,
  AttachmentUploadFields,
  AttachmentVisibility,
  StudentAttachment,
} from "@tutor/contract";
import {
  ATTACHMENT_MAX_UPLOAD_BYTES,
  attachmentSchema,
  studentAttachmentSchema,
} from "@tutor/contract";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { attachments, courses } from "../db/schema";
import { readFileBytes, writeFileAtomic } from "../lib/blob-io";
import { HttpError } from "../lib/http-error";
import {
  detectAttachmentFormat,
  pdfPageCountOf,
  sanitizeAttachmentFileName,
} from "./attachment-format";
import { requireStudentCourseAccess } from "./student-course-service";

/**
 * 资料附件服务（2026-11-10，个人学习迭代模块 6 第一步「PDF / docx 原件上传下载」）。
 *
 * - 格式只认内容：PDF 看文件头 `%PDF-`；docx 看 ZIP 本地头 `PK\x03\x04` 且中央
 *   目录里有 [Content_Types].xml 与 word/document.xml 两个条目——扩展名 / MIME
 *   一概不信（与 media-service 同纪律）；
 * - 上限 20 MB（契约 ATTACHMENT_MAX_UPLOAD_BYTES；app.ts 另有 21 MB content-length
 *   粗防线，此处按实际字节兜底 chunked）；
 * - 内容寻址落盘 blobs/attachments/<sha256>.<pdf|docx>，同内容幂等跳过写入；
 *   多行可共享一个 blob，软删不删 blob（留给以后的 GC，与媒体一致）；
 * - 页数只在能读到时给：PDF 取 /Type /Pages 字典里最大的 /Count（根节点即总页数；
 *   对象流压缩的 PDF 可能读不到 → null），docx 不解析 → null；
 * - 学生侧可见 = 课程访问权（成员 + 课程未归档 + 本人未归档，复用
 *   requireStudentCourseAccess）+ visibility=students + 未软删。
 */

export const ATTACHMENT_BLOB_DIR = "attachments";

const ATTACHMENT_CONTENT_TYPES: Record<AttachmentFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function attachmentDir(dataDir: string): string {
  const dir = join(dataDir, "blobs", ATTACHMENT_BLOB_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

type AttachmentRow = typeof attachments.$inferSelect;

function requireTeacherCourse(
  db: Db,
  teacherId: string,
  courseId: string,
): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.id, courseId), eq(courses.teacherId, teacherId)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
}

function courseTitlesOf(
  db: Db,
  courseIds: readonly (string | null)[],
): Map<string, string> {
  const ids = [...new Set(courseIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(inArray(courses.id, ids))
      .all()
      .map((row) => [row.id, row.title] as const),
  );
}

function toAttachment(
  row: AttachmentRow,
  courseTitles: Map<string, string>,
): Attachment {
  return attachmentSchema.parse({
    id: row.id,
    courseId: row.courseId,
    courseTitle:
      row.courseId === null ? null : (courseTitles.get(row.courseId) ?? null),
    fileName: row.fileName,
    format: row.format,
    bytes: row.bytes,
    pageCount: row.pageCount,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function notFound(): HttpError {
  return new HttpError(
    404,
    "ATTACHMENT_NOT_FOUND",
    "资料不存在（可能已被删除）",
  );
}

function requireOwnRow(db: Db, teacherId: string, id: string): AttachmentRow {
  const row = db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, id),
        eq(attachments.teacherId, teacherId),
        isNull(attachments.deletedAt),
      ),
    )
    .get();
  if (row === undefined) throw notFound();
  return row;
}

// ---------- 教师侧 ----------

export interface CreateAttachmentInput extends AttachmentUploadFields {
  readonly teacherId: string;
  /** 上传时的原文件名（可缺） */
  readonly fileName?: string | undefined;
  readonly bytes: Uint8Array;
}

/** 上传：识别格式 → 限额 → 内容寻址落盘 → 插行（同内容再传是新的一行，blob 共享） */
export function createAttachment(
  db: Db,
  dataDir: string,
  input: CreateAttachmentInput,
  now: Date = new Date(),
): Attachment {
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
  };
  db.insert(attachments).values(row).run();
  return toAttachment(row, courseTitlesOf(db, [row.courseId]));
}

/** 本教师的资料（可按课程过滤；上传时间倒序） */
export function listTeacherAttachments(
  db: Db,
  teacherId: string,
  courseId?: string,
): Attachment[] {
  if (courseId !== undefined) requireTeacherCourse(db, teacherId, courseId);
  const rows = db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.teacherId, teacherId),
        isNull(attachments.deletedAt),
        courseId === undefined ? undefined : eq(attachments.courseId, courseId),
      ),
    )
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .all();
  const titles = courseTitlesOf(
    db,
    rows.map((row) => row.courseId),
  );
  return rows.map((row) => toAttachment(row, titles));
}

/** 改可见性 / 改展示名 */
export function updateAttachment(
  db: Db,
  teacherId: string,
  id: string,
  patch: AttachmentUpdate,
  now: Date = new Date(),
): Attachment {
  const row = requireOwnRow(db, teacherId, id);
  const next: AttachmentRow = {
    ...row,
    visibility: patch.visibility ?? row.visibility,
    fileName:
      patch.fileName === undefined
        ? row.fileName
        : sanitizeAttachmentFileName(patch.fileName, row.format),
    updatedAt: now.toISOString(),
  };
  db.update(attachments)
    .set({
      visibility: next.visibility,
      fileName: next.fileName,
      updatedAt: next.updatedAt,
    })
    .where(eq(attachments.id, id))
    .run();
  return toAttachment(next, courseTitlesOf(db, [next.courseId]));
}

/** 软删（blob 保留） */
export function deleteAttachment(
  db: Db,
  teacherId: string,
  id: string,
  now: Date = new Date(),
): void {
  requireOwnRow(db, teacherId, id);
  db.update(attachments)
    .set({ deletedAt: now.toISOString() })
    .where(eq(attachments.id, id))
    .run();
}

/** 下载直出需要的三件：字节、Content-Type、展示文件名 */
export interface AttachmentFile {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
}

function readRowFile(dataDir: string, row: AttachmentRow): AttachmentFile {
  try {
    return {
      bytes: readFileBytes(
        join(
          dataDir,
          "blobs",
          ATTACHMENT_BLOB_DIR,
          `${row.sha256}.${row.format}`,
        ),
      ),
      contentType: ATTACHMENT_CONTENT_TYPES[row.format],
      fileName: row.fileName,
    };
  } catch {
    // 行在、文件不在（磁盘被动过）：对外同「不存在」，日志由上层按 404 记
    throw notFound();
  }
}

export function readTeacherAttachmentFile(
  db: Db,
  dataDir: string,
  teacherId: string,
  id: string,
): AttachmentFile {
  return readRowFile(dataDir, requireOwnRow(db, teacherId, id));
}

// ---------- 学生侧 ----------

function toStudentAttachment(row: AttachmentRow): StudentAttachment {
  return studentAttachmentSchema.parse({
    id: row.id,
    fileName: row.fileName,
    format: row.format,
    bytes: row.bytes,
    pageCount: row.pageCount,
    createdAt: row.createdAt,
  });
}

/** 某课程里学生可见的资料（课程访问权 + visibility=students） */
export function listStudentCourseAttachments(
  db: Db,
  studentId: string,
  courseId: string,
): StudentAttachment[] {
  const { teacherId } = requireStudentCourseAccess(db, studentId, courseId);
  return db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.courseId, courseId),
        eq(attachments.teacherId, teacherId),
        eq(attachments.visibility, "students" satisfies AttachmentVisibility),
        isNull(attachments.deletedAt),
      ),
    )
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
    .all()
    .map(toStudentAttachment);
}

/** 学生下载：行存在且学生可见、所在课程当前可访问；否则一律 404（不暴露存在性） */
export function readStudentAttachmentFile(
  db: Db,
  dataDir: string,
  studentId: string,
  id: string,
): AttachmentFile {
  const row = db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), isNull(attachments.deletedAt)))
    .get();
  if (
    row === undefined ||
    row.visibility !== "students" ||
    row.courseId === null
  ) {
    throw notFound();
  }
  try {
    const { teacherId } = requireStudentCourseAccess(
      db,
      studentId,
      row.courseId,
    );
    if (teacherId !== row.teacherId) throw notFound();
  } catch {
    throw notFound();
  }
  return readRowFile(dataDir, row);
}
