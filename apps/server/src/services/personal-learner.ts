import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Student, sessions, students, teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";

/** 两条记录互相指认才是个人学习者。 */
export function personalOwnerOf(
  db: Db,
  row: Pick<Student, "id" | "teacherId">,
) {
  if (row.teacherId === null) return undefined;
  return db
    .select({ loginName: teachers.loginName, disabledAt: teachers.disabledAt })
    .from(teachers)
    .where(
      and(
        eq(teachers.id, row.teacherId),
        eq(teachers.accountKind, "personal"),
        eq(teachers.personalStudentId, row.id),
      ),
    )
    .get();
}

export function assertIndependentStudent(db: Db, row: Student): void {
  if (personalOwnerOf(db, row) !== undefined) {
    throw new HttpError(
      409,
      "PERSONAL_ACCOUNT_RESTRICTED",
      "个人学习者的登录由个人账号管理，不能独立设置凭证或归档",
    );
  }
}

/** 仅在验过个人密码的签发事务内修复旧版本允许写入的异常状态。 */
export function restorePersonalLearner(
  db: Db,
  teacherId: string,
  studentId: string,
): void {
  const row = db
    .select()
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.teacherId, teacherId)))
    .get();
  if (
    !row ||
    (row.archivedAt === null && !row.linkEnabled && !row.passwordEnabled) ||
    personalOwnerOf(db, row)?.disabledAt !== null
  ) {
    return;
  }
  db.update(students)
    .set({
      archivedAt: null,
      linkEnabled: false,
      passwordEnabled: false,
      passwordHash: null,
    })
    .where(eq(students.id, studentId))
    .run();
  // 旧学生会话无法区分来自独立登录还是个人登录，修复时一并结束。
  db.delete(sessions)
    .where(
      and(
        eq(sessions.subjectType, "student"),
        eq(sessions.subjectId, studentId),
      ),
    )
    .run();
}
