import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DbHandle } from "../db/client";
import { HttpError } from "../lib/http-error";

function restoreErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^(?:E[A-Z0-9_]+|SQLITE_[A-Z0-9_]+)$/.test(error.code)
  )
    return error.code;
  return "UNKNOWN";
}

/** 尽力清理暂存目录，保留业务结果。 */
export function removeBackupTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 暂存目录清理失败不影响已经确认的恢复结果。
  }
}

export function replaceBackupFiles(
  dataDir: string,
  staging: string,
  preservedEntry: string,
  handle: DbHandle,
): void {
  const oldDir = mkdtempSync(join(dirname(staging), "tutor-restore-old-"));
  const movedOut: string[] = [];
  const movedIn: string[] = [];
  let retainOldDir = false;
  try {
    handle.close();
    let phase = "搬出旧文件";
    try {
      for (const name of readdirSync(dataDir)) {
        if (name === preservedEntry) continue;
        renameSync(join(dataDir, name), join(oldDir, name));
        movedOut.push(name);
      }
      phase = "放入新文件";
      for (const name of readdirSync(staging)) {
        renameSync(join(staging, name), join(dataDir, name));
        movedIn.push(name);
      }
      phase = "重开数据库";
      handle.restart();
    } catch (restoreError) {
      // 逐项撤销已完成的移动。其余旧文件可能仍在数据目录里。
      const rollbackErrors: { operation: string; code: string }[] = [];
      const undo = (operation: string, action: () => void) => {
        try {
          action();
        } catch (error) {
          rollbackErrors.push({ operation, code: restoreErrorCode(error) });
        }
      };
      for (const name of movedIn.reverse()) {
        undo("撤回新文件", () =>
          renameSync(join(dataDir, name), join(staging, name)),
        );
      }
      for (const name of movedOut.reverse()) {
        undo("归还旧文件", () =>
          renameSync(join(oldDir, name), join(dataDir, name)),
        );
      }
      if (rollbackErrors.length === 0)
        undo("重开旧数据库", () => handle.restart());
      if (rollbackErrors.length > 0) {
        retainOldDir = true;
        console.error("备份恢复未能完成回滚", {
          dataDir,
          oldDir,
          phase,
          code: restoreErrorCode(restoreError),
          rollbackErrors,
        });
        throw new HttpError(
          500,
          "BACKUP_ROLLBACK_FAILED",
          `恢复失败且未能完成回滚。请联系部署管理员检查暂存目录「${basename(oldDir)}」。`,
        );
      }
      throw new HttpError(
        500,
        "BACKUP_RESTORE_FAILED",
        "恢复失败，数据已回滚复原（原数据无损）；请重试或检查磁盘空间",
      );
    }
  } finally {
    if (!retainOldDir) removeBackupTemp(oldDir);
  }
}
