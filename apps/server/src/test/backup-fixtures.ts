import { hashPassword } from "../auth/password";
import type { Db } from "../db/client";
import { teachers } from "../db/schema";
import { TEST_TEACHER_ID } from "../db/test-utils";
import type { BackupZip } from "../services/backup-service";

/**
 * 备份/恢复与 GC 交汇测试的共享夹具（T6R.14 /simplify T1 收敛——
 * backup-service.test 与 backup-gc.test 两份整段复制归一）：
 * - BACKUP_TEST_PASSWORD：恢复确认口的测试密码（两侧同值才可互验）；
 * - zipToBackupBuffer：备份 zip 流收整为 Buffer（与下载链路同流，测试内消费）；
 * - insertBackupTeacher：带 scrypt 密码的教师种子（恢复前密码校验/教师域
 *   授权的执行前提；async 因 hashPassword）。
 */

export const BACKUP_TEST_PASSWORD = "backup-pass-123";

/** 备份 zip 流收整为 Buffer（与下载链路同流，测试内消费） */
export async function zipToBackupBuffer(zip: BackupZip): Promise<Buffer> {
  const chunks: Buffer[] = [];
  zip.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    zip.stream.on("end", () => resolve());
    zip.stream.on("error", (err: Error) => reject(err));
  });
  await done;
  return Buffer.concat(chunks);
}

/** 带密码教师种子（TEST_TEACHER_ID；恢复密码确认与教师域授权的前提） */
export async function insertBackupTeacher(
  db: Db,
  password: string = BACKUP_TEST_PASSWORD,
): Promise<void> {
  await db
    .insert(teachers)
    .values({
      id: TEST_TEACHER_ID,
      loginName: "teacher",
      isAdmin: true,
      disabledAt: null,
      passwordHash: await hashPassword(password),
      apiToken: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
}
