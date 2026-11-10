import { z } from "zod";

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({ ok: z.literal(true), data: dataSchema });
}

/**
 * 资料附件契约（2026-11-10，个人学习迭代模块 6 第一步「PDF / docx 原件上传下载」）。
 *
 * 实体口径（不为公考另立实体，抽象为「教师空间里的一份原件」）：
 * - 一行 = 一份上传的原件（PDF / docx），归属教师空间（个人账号即本人空间）；
 * - 可挂到一门课程（courseId），也可不挂（本人空间里的资料）；以后挂讲义 /
 *   单元、在线预览、Agent 取件都在这张表上加列 / 加链接，不另起实体；
 * - 文件本体内容寻址：DATA_DIR/blobs/attachments/<sha256>.<pdf|docx>，同内容
 *   多行共享一个 blob（与 ::image 媒体管线同款），纳入现有备份（blobs/ 整目录）；
 * - 可见性二选一：students（授权范围内的学生可查看下载）/ teacher_only（仅教师）。
 *   学生能否下载 = 课程成员 + 课程未归档 + 本人未归档 + visibility=students。
 *
 * 请求是 multipart/form-data（字段 file + 可选 courseId / visibility / uploadId）。
 * uploadId 是客户端生成的幂等键：服务端按 (教师, uploadId) 唯一，同一键重放返回
 * 首次创建的那行（新建 201 / 命中 200，响应形状相同）——上传回执丢失后重试不会
 * 多出一份资料；不带 uploadId 的每次上传都是新的一行。失败走通用 ApiErr 壳：
 * - ATTACHMENT_TOO_LARGE（413）：超过 20 MB 上传上限；
 * - ATTACHMENT_UNSUPPORTED_TYPE（415）：按文件内容识别不是 PDF 也不是 docx
 *   （不信任扩展名 / MIME）；
 * - ATTACHMENT_NOT_FOUND（404）：不存在 / 已删除 / 不归属本教师（不暴露存在性）。
 */

/** 单文件上传上限：20 MB（第 3 版计划模块 6「建议先用 20 MB 作为单文件上限」） */
export const ATTACHMENT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 文件名长度上限（展示 + Content-Disposition；超长截断保留扩展名在服务端做） */
export const ATTACHMENT_FILE_NAME_MAX = 200;

/** 支持的原件格式（按内容魔数识别；以后加格式在此扩） */
export const attachmentFormatSchema = z.enum(["pdf", "docx"]);
export type AttachmentFormat = z.infer<typeof attachmentFormatSchema>;

/** 可见性：students = 授权范围内的学生可查看和下载；teacher_only = 仅教师可见 */
export const attachmentVisibilitySchema = z.enum(["students", "teacher_only"]);
export type AttachmentVisibility = z.infer<typeof attachmentVisibilitySchema>;

/** 教师侧一条资料（列表 / 上传响应 / 更新响应共用） */
export const attachmentSchema = z.object({
  id: z.uuid(),
  /** 所在课程；本人空间（未挂课程）为 null */
  courseId: z.uuid().nullable(),
  /** 所在课程标题（列表展示「所在课程」；未挂课程为 null） */
  courseTitle: z.string().nullable(),
  /** 展示文件名（上传时的原名，服务端去路径、去控制字符、≤200） */
  fileName: z.string().min(1).max(ATTACHMENT_FILE_NAME_MAX),
  format: attachmentFormatSchema,
  /** 文件字节数 */
  bytes: z.number().int().positive(),
  /** 页数：仅在服务端能从文件里读到时给出，否则 null（界面只在已知时显示） */
  pageCount: z.number().int().positive().nullable(),
  visibility: attachmentVisibilitySchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** GET /api/teacher/attachments?courseId= 响应 data（按上传时间倒序） */
export const attachmentListDataSchema = z.object({
  attachments: z.array(attachmentSchema),
});
export type AttachmentListData = z.infer<typeof attachmentListDataSchema>;

/** GET /api/teacher/attachments 查询：按课程过滤（缺省列本教师全部） */
export const attachmentListQuerySchema = z.object({
  courseId: z.uuid().optional(),
});

/** POST /api/teacher/attachments 的 multipart 文本字段（file 字段另取） */
export const attachmentUploadFieldsSchema = z.object({
  /** 挂到哪门课；缺省不挂（本人空间） */
  courseId: z.uuid().optional(),
  /** 缺省 students（教师上传默认学生可见；含答案提示由前端做） */
  visibility: attachmentVisibilitySchema.optional(),
  /** 客户端幂等键（crypto.randomUUID，重试复用）；同教师同键重放返回既有行 */
  uploadId: z.uuid().optional(),
});
export type AttachmentUploadFields = z.infer<
  typeof attachmentUploadFieldsSchema
>;

/** PATCH /api/teacher/attachments/:id 请求体：改可见性 / 改展示名（至少一项） */
export const attachmentUpdateSchema = z
  .object({
    visibility: attachmentVisibilitySchema.optional(),
    fileName: z.string().trim().min(1).max(ATTACHMENT_FILE_NAME_MAX).optional(),
  })
  .refine(
    (value) => value.visibility !== undefined || value.fileName !== undefined,
    { message: "至少提供 visibility 或 fileName 之一" },
  );
export type AttachmentUpdate = z.infer<typeof attachmentUpdateSchema>;

/** 学生侧一条资料（只给看得到的字段；教师可见性 / 课程归属不下发） */
export const studentAttachmentSchema = z.object({
  id: z.uuid(),
  fileName: z.string().min(1).max(ATTACHMENT_FILE_NAME_MAX),
  format: attachmentFormatSchema,
  bytes: z.number().int().positive(),
  pageCount: z.number().int().positive().nullable(),
  createdAt: z.string().min(1),
});
export type StudentAttachment = z.infer<typeof studentAttachmentSchema>;

/** GET /api/student/courses/:id/attachments 响应 data（按上传时间倒序） */
export const studentAttachmentListDataSchema = z.object({
  attachments: z.array(studentAttachmentSchema),
});
export type StudentAttachmentListData = z.infer<
  typeof studentAttachmentListDataSchema
>;

export const attachmentOkSchema = apiOkExtend(attachmentSchema);
export const attachmentListOkSchema = apiOkExtend(attachmentListDataSchema);
export const studentAttachmentListOkSchema = apiOkExtend(
  studentAttachmentListDataSchema,
);

/** 资料文件下载 URL（教师 / 学生各自前缀；两端同一函数拼，不手写字符串） */
export function attachmentFileUrl(
  side: "teacher" | "student",
  attachmentId: string,
): string {
  return `/api/${side}/attachments/${encodeURIComponent(attachmentId)}/file`;
}

/** 字节数展示（KB / MB，1 位小数；两端共用） */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 格式徽标文案 */
export const ATTACHMENT_FORMAT_LABEL: Record<AttachmentFormat, string> = {
  pdf: "PDF",
  docx: "Word",
};

/**
 * 文件名是否像「含答案」的文件（上传前提示可见性用；只看名字、只提示不拦截）。
 * 命中：答案 / 解析 / 参考 / answer / key / solution（大小写不敏感）。
 */
export const ANSWER_LIKE_FILE_NAME = /答案|解析|参考|answer|key|solution/i;
