import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { courseStudents, students } from "../db/schema";
import { HttpError } from "../lib/http-error";

/** 他人名下的学生按不存在处理。 */
export function requireStudentsExist(
  db: Db,
  teacherId: string,
  studentIds: readonly string[],
): void {
  const found = new Set(
    db
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.teacherId, teacherId),
          inArray(students.id, [...studentIds]),
        ),
      )
      .all()
      .map((row) => row.id),
  );
  if (studentIds.some((id) => !found.has(id))) {
    throw new HttpError(
      404,
      "STUDENT_NOT_FOUND",
      "指派名单中包含不存在的学生，请刷新学生列表后重试",
    );
  }
}

/** 在写入事务内核对已去重的指派名单，防止提交使用旧课程成员。 */
export function requireCurrentCourseMembers(
  tx: Pick<Db, "select">,
  courseId: string,
  studentIds: string[],
): void {
  const members = tx
    .select({ id: courseStudents.studentId })
    .from(courseStudents)
    .where(
      and(
        eq(courseStudents.courseId, courseId),
        inArray(courseStudents.studentId, studentIds),
      ),
    )
    .all();
  if (members.length !== studentIds.length) {
    throw new HttpError(
      409,
      "COURSE_ROSTER_CHANGED",
      "课程名单已变更，请重新确认指派学生",
    );
  }
}
