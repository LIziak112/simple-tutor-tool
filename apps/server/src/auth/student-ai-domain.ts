import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { students, teachers } from "../db/schema.ts";
import { getStudentAccount } from "../services/student-service.ts";

/** 外部 AI 通道共用的学生与所属教师账号裁决。 */
export function studentAiDomainOf(db: Db, studentId: string) {
  if (getStudentAccount(db, studentId) === null) return null;
  const domain = db
    .select({
      teacherId: teachers.id,
      accountKind: teachers.accountKind,
      personalStudentId: teachers.personalStudentId,
      disabledAt: teachers.disabledAt,
    })
    .from(students)
    .innerJoin(teachers, eq(students.teacherId, teachers.id))
    .where(eq(students.id, studentId))
    .get();
  if (!domain || domain.disabledAt !== null) return null;
  const personal =
    domain.accountKind === "personal" && domain.personalStudentId === studentId;
  return {
    teacherId: domain.teacherId,
    accountKind: personal ? ("personal" as const) : ("class" as const),
  };
}
