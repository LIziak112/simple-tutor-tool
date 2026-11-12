import { BACKUP_OPERATOR_REQUIRED, type TeacherInfo } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { verifyPassword } from "./password";

export function canManageInstanceBackup(
  teacher: TeacherInfo | null,
  operatorId: string | undefined,
): boolean {
  return teacher?.isAdmin === true && teacher.id === operatorId;
}

export function assertInstanceBackupOperator(
  teacher: TeacherInfo | null,
  operatorId: string | undefined,
): void {
  if (!canManageInstanceBackup(teacher, operatorId)) {
    throw new HttpError(
      403,
      BACKUP_OPERATOR_REQUIRED,
      "该操作仅限主机配置的整站备份操作员",
    );
  }
}

export async function verifyBackupRestorePassword(
  db: Db,
  teacherId: string,
  password: string,
): Promise<void> {
  const readHash = () =>
    db
      .select({ passwordHash: teachers.passwordHash })
      .from(teachers)
      .where(eq(teachers.id, teacherId))
      .get()?.passwordHash;
  const hash = readHash();
  if (!hash || !(await verifyPassword(password, hash)) || readHash() !== hash) {
    throw new HttpError(403, "BACKUP_INVALID_PASSWORD", "登录密码不正确");
  }
}
