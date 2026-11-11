import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 资料附件表（2026-11-10，个人学习迭代模块 6 第一步：PDF / docx 原件上传下载）。
 * 一行 = 教师空间里的一份原件；可挂一门课程（courseId，无外键——D4 删除 / 归档
 * 课程不连带资料，读侧按课程当前状态判可见），也可不挂（本人空间）。文件本体
 * 内容寻址存 blobs/attachments/<sha256>.<ext>，多行可共享一个 blob（与 ::image
 * 媒体管线同款，纳入 blobs/ 整目录备份）；删除为软删（deletedAt），blob 留给 GC。
 * 以后挂讲义 / 单元、在线预览副本、Agent 取件都在本表加列 / 加链接，不另起实体。
 */
export const attachments = sqliteTable(
  "attachments",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /** 归属教师空间（teachers.id；个人账号即本人空间） */
    teacherId: text("teacher_id").notNull(),
    /** 所在课程（courses.id；无外键）；NULL = 未挂课程 */
    courseId: text("course_id"),
    /** 展示文件名（上传原名，服务端去路径 / 控制字符，≤200） */
    fileName: text("file_name").notNull(),
    /** 原件格式：按内容魔数识别（契约 attachmentFormatSchema） */
    format: text("format").$type<"pdf" | "docx">().notNull(),
    /** 文件字节数 */
    bytes: integer("bytes").notNull(),
    /** 内容哈希（小写 sha256 hex）；blob 文件名 = <sha256>.<format> */
    sha256: text("sha256").notNull(),
    /** 页数：服务端能从文件里读到才写，否则 NULL（界面只在已知时显示） */
    pageCount: integer("page_count"),
    /** 可见性：students 授权学生可查看下载 / teacher_only 仅教师 */
    visibility: text("visibility")
      .$type<"students" | "teacher_only">()
      .notNull()
      .default("students"),
    /** 上传时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
    /** 最近更新时间（改名 / 改可见性）：UTC ISO 字符串 */
    updatedAt: text("updated_at").notNull(),
    /** 软删时间：UTC ISO 字符串；未删除为 NULL */
    deletedAt: text("deleted_at"),
    /**
     * 客户端上传幂等键（#103-04，0059 起）：(teacher_id, upload_id) 唯一，同键重放
     * 返回既有行；NULL = 未带键的上传（历史行 / 不要求幂等的调用），SQLite 唯一索引
     * 允许多个 NULL。
     */
    uploadId: text("upload_id"),
  },
  (table) => [
    index("attachments_teacher_idx").on(table.teacherId, table.deletedAt),
    index("attachments_course_idx").on(table.courseId, table.deletedAt),
    uniqueIndex("attachments_teacher_upload_uk").on(
      table.teacherId,
      table.uploadId,
    ),
  ],
);
