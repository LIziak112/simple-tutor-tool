import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const courses = sqliteTable(
  "courses",
  {
    /** 主键：crypto.randomUUID()（§0.3 主键约定） */
    id: text("id").primaryKey(),
    /**
     * 归属教师（D9：DB 可空、代码恒写非空）。课程与作业为域内私有（T2B.4 起按教师过滤）。
     */
    teacherId: text("teacher_id"),
    /** 课程名；默认课程固定「默认课程」（同名复用） */
    title: text("title").notNull(),
    /** 同级排序（小在前）；首个课程为 0 */
    order: integer("order").notNull(),
    /** 归档时间：UTC ISO 字符串；未归档为 NULL（D4：归档后学生端不可见，可恢复） */
    archivedAt: text("archived_at"),
    /** 课程简介；未填为 NULL */
    description: text("description"),
    /** 复盘展示推荐；不改变判分或答案授权。 */
    examType: text("exam_type"),
    reviewTemplateId: text("review_template_id"),
    /** 创建时间：UTC ISO 字符串 */
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("courses_teacher_idx").on(table.teacherId)],
);
