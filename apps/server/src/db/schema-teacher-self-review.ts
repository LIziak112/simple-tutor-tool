import type { StudentSelfReviewScoring } from "@tutor/contract";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { teachers } from "./teacher-schema.ts";

/**
 * 教师的学生自评计分设置（G47）：无行 = countAsCorrect（缺省，自评为对计入答对）；
 * separate = 答对只含自动与教师判定，自评单列。建卷时冻结进内核练法声明。
 * 独立成表：不改 teachers 行形，老库与按旧迁移建的测试库照常插入教师。
 */
export const teacherSelfReviewScorings = sqliteTable(
  "teacher_self_review_scorings",
  {
    teacherId: text("teacher_id")
      .primaryKey()
      .references(() => teachers.id),
    scoring: text("scoring").$type<StudentSelfReviewScoring>().notNull(),
  },
);
