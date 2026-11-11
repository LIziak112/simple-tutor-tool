import type { PersonalSessionData, PersonalSessionRole } from "@tutor/contract";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { getStudentAccount } from "../services/student-service";
import { deleteSession, getStudentSession, getTeacherSession } from "./session";
import { getTeacherInfo } from "./teacher-auth-service";

type SessionTokens = Record<PersonalSessionRole, string | undefined>;

/** 以当前视角的会话为准，另一枚 Cookie 只有指向同一个人才参与操作。 */
export function readPersonalSessionPair(
  db: Db,
  tokens: SessionTokens,
  role: PersonalSessionRole,
): PersonalSessionData | null {
  const teacherId = tokens.teacher
    ? getTeacherSession(db, tokens.teacher)?.teacherId
    : undefined;
  const studentId = tokens.student
    ? getStudentSession(db, tokens.student)?.studentId
    : undefined;
  const subjectId = role === "teacher" ? teacherId : studentId;
  const owner =
    subjectId === undefined
      ? undefined
      : db
          .select({ id: teachers.id, studentId: teachers.personalStudentId })
          .from(teachers)
          .where(
            and(
              eq(teachers.accountKind, "personal"),
              isNull(teachers.disabledAt),
              isNotNull(teachers.passwordHash),
              eq(
                role === "teacher" ? teachers.id : teachers.personalStudentId,
                subjectId,
              ),
            ),
          )
          .get();
  const student =
    owner !== undefined &&
    studentId !== undefined &&
    studentId === owner.studentId
      ? getStudentAccount(db, studentId, owner.id)
      : null;
  if (
    owner === undefined ||
    (role === "student" && student?.accountKind !== "personal")
  ) {
    throw new HttpError(401, "UNAUTHORIZED", "请重新登录个人账号");
  }
  if (teacherId !== owner.id || student?.accountKind !== "personal") {
    return null;
  }
  const teacher = getTeacherInfo(db, owner.id);
  return teacher === null ? null : { teacher, student };
}

export function logoutPersonalSession(
  db: Db,
  tokens: SessionTokens,
  role: PersonalSessionRole,
): boolean {
  return db.transaction(
    () => {
      const paired = readPersonalSessionPair(db, tokens, role) !== null;
      for (const side of ["teacher", "student"] as const) {
        const token = tokens[side];
        if (token !== undefined && (side === role || paired)) {
          deleteSession(db, token);
        }
      }
      return paired;
    },
    { behavior: "immediate" },
  );
}
