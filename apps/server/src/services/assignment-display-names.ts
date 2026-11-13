import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { courses, students } from "../db/schema";

/** 学生 id → 姓名（CONFIRM_REQUIRED 附带名单、check 提示行共用；id 全局唯一） */
export function studentNamesById(db: Db): Map<string, string> {
  return new Map(
    db
      .select({ id: students.id, displayName: students.displayName })
      .from(students)
      .all()
      .map((row) => [row.id, row.displayName] as const),
  );
}

/** 课程 id → 标题（T2B.4 域内读：列表/详情/check 的课程名展示只用本人课程） */
export function courseNamesOf(db: Db, teacherId: string): Map<string, string> {
  return new Map(
    db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(eq(courses.teacherId, teacherId))
      .all()
      .map((r) => [r.id, r.title] as const),
  );
}
