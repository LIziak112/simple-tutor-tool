import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { BACKUP_KERNEL_DATABASE } from "@tutor/contract";
import Database from "better-sqlite3";
import { z } from "zod";
import { HttpError } from "../lib/http-error.ts";

export const BACKUP_RESTORE_MARKER = ".restore-in-progress.json";
const processMarker = /^\.server-(\d+)-[0-9a-f-]+$/;
const topEntry = z
  .string()
  .min(1)
  .refine((name) => name !== "." && name !== ".." && !/[\\/:\0]/u.test(name));

const restoreJournal = z.strictObject({
  old: z.string().regex(/^tutor-restore-old-[a-zA-Z0-9]+$/u),
  staging: z.string().regex(/^tutor-restore-[a-zA-Z0-9]+$/u),
  plan: z
    .strictObject({ before: z.array(topEntry), incoming: z.array(topEntry) })
    .optional(),
});

export function removeBackupTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 暂存目录清理失败不影响已经确认的恢复结果。
  }
}

function lockBackupOperations(backupsDir: string): () => void {
  // 独立文件只协调启动与恢复。进程退出时 SQLite 会自动释放文件锁。
  const lock = new Database(join(backupsDir, ".restore-coordination.sqlite"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    return () => lock.close();
  } catch (error) {
    lock.close();
    throw error;
  }
}

function isOtherActiveProcess(name: string): boolean {
  const peer = processMarker.exec(name)?.[1];
  if (peer === undefined || Number(peer) === process.pid) return false;
  try {
    process.kill(Number(peer), 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function hasOtherActiveProcess(backupsDir: string): boolean {
  return readdirSync(backupsDir).some(isOtherActiveProcess);
}

function writeJournal(
  path: string,
  content: z.input<typeof restoreJournal>,
): void {
  const temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(restoreJournal.parse(content)), {
    flag: "wx",
    flush: true,
  });
  renameSync(temp, path);
}

function recoverInterruptedBackup(
  backupsDir: string,
  dbFilename: string,
  verify: (dir: string) => void,
): void {
  const marker = join(backupsDir, BACKUP_RESTORE_MARKER);
  if (!existsSync(marker)) return;
  try {
    if (hasOtherActiveProcess(backupsDir))
      throw new Error("仍有进程正在使用数据目录");
    const dataDir = dirname(backupsDir);
    const { old, staging, plan } = restoreJournal.parse(
      JSON.parse(readFileSync(marker, "utf8")),
    );
    const oldDir = join(backupsDir, old);
    const incomingDir = join(backupsDir, staging);
    if (plan) {
      if (
        plan.before.includes(basename(backupsDir)) ||
        plan.incoming.includes(basename(backupsDir))
      ) {
        throw new Error("恢复计划目录冲突");
      }
      const before = new Set(plan.before);
      const incoming = new Set(plan.incoming);
      const sidecars = [dbFilename, BACKUP_KERNEL_DATABASE].flatMap((name) => [
        `${name}-wal`,
        `${name}-shm`,
        `${name}-journal`,
      ]);
      const returnToStaging = (name: string) => {
        const live = join(dataDir, name);
        if (!existsSync(live)) return;
        // 新库重开可能生成 SQLite 边车，一并保留供候选库再次验证。
        if (existsSync(join(incomingDir, name))) {
          throw new Error("恢复文件位置不明确");
        }
        renameSync(live, join(incomingDir, name));
      };
      for (const name of before) {
        const saved = join(oldDir, name);
        const live = join(dataDir, name);
        if (!existsSync(saved)) {
          if (!existsSync(live)) throw new Error("原数据文件缺失");
          continue;
        }
        returnToStaging(name);
        renameSync(saved, live);
      }
      for (const name of [...incoming, ...sidecars]) {
        if (!before.has(name)) returnToStaging(name);
      }
      try {
        verify(dataDir);
      } catch {
        // 旧库本来就无法使用时，只有暂存的新库完整可用才采用。
        if (
          [...incoming].some((name) => !existsSync(join(incomingDir, name)))
        ) {
          throw new Error("新数据文件缺失");
        }
        verify(incomingDir);
        for (const name of before)
          renameSync(join(dataDir, name), join(oldDir, name));
        for (const name of readdirSync(incomingDir))
          renameSync(join(incomingDir, name), join(dataDir, name));
        verify(dataDir);
      }
    }
    rmSync(marker);
    removeBackupTemp(oldDir);
    removeBackupTemp(incomingDir);
  } catch (cause) {
    throw new Error(`无法判定中断前后的完整数据，请检查 ${marker} 后再启动`, {
      cause,
    });
  }
}

/** 正式启动前恢复中断的替换。仍在运行的同目录进程阻止恢复，但可共同提供服务。 */
export function registerBackupProcess(
  backupsDir: string,
  dbFilename: string,
  verify: (dir: string) => void,
): void {
  mkdirSync(backupsDir, { recursive: true });
  const release = lockBackupOperations(backupsDir);
  try {
    recoverInterruptedBackup(backupsDir, dbFilename, verify);
    const lease = join(backupsDir, `.server-${process.pid}-${randomUUID()}`);
    writeFileSync(lease, "", { flag: "wx" });
    process.once("exit", () => {
      try {
        rmSync(lease, { force: true });
      } catch {
        // 下次恢复用 PID 存活性识别退出的进程。
      }
    });
  } finally {
    release();
  }
}

export function beginBackupReplacement(oldDir: string, staging: string) {
  const backupsDir = dirname(staging);
  const release = lockBackupOperations(backupsDir);
  const marker = join(backupsDir, BACKUP_RESTORE_MARKER);
  const journal = { old: basename(oldDir), staging: basename(staging) };
  try {
    if (existsSync(marker)) {
      throw new HttpError(
        409,
        "BACKUP_RESTORE_FAILED",
        "数据目录正在恢复或存在未完成的恢复",
      );
    }
    if (hasOtherActiveProcess(backupsDir)) {
      throw new HttpError(
        409,
        "BACKUP_RESTORE_FAILED",
        "另一个服务进程仍在使用此数据目录，请先停止该进程",
      );
    }
    writeJournal(marker, journal);
    return {
      plan(before: string[], incoming: string[]) {
        writeJournal(marker, { ...journal, plan: { before, incoming } });
      },
      finish: () => rmSync(marker),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
