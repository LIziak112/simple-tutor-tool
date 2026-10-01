import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BackupRestoreResult, BackupSnapshot } from "@tutor/contract";
import {
  BACKUP_KEEP_COUNT,
  BACKUP_SNAPSHOT_NAME_PATTERN,
} from "@tutor/contract";
import { ZipArchive } from "archiver";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { verifyPassword } from "../auth/password";
import type { Db, DbHandle } from "../db/client";
import { teachers } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { readZipEntries, type ZipEntry, ZipReadError } from "../lib/zip-read";
import { beijingExportStampOf } from "./export-csv";

/**
 * BackupService（T4.5，Phase4 清单 §4 / §2 D20/D21 + 架构 §5.10）——
 * 自动快照、备份 zip 打包、从 zip 恢复整库、快照列表。
 *
 * 口径（D20，备份 = 全量 DATA_DIR，下载 = 当前时刻全量）：
 * - 日常快照只做 db：`VACUUM INTO data/backups/tutor-<北京时间戳>.db`
 *   （WAL 模式下安全，快照含已提交事务），保留 14 份轮转删最旧；
 * - 下载时恒先补拍一份**当前时刻**快照再实时打包（Opus 实测③-1：
 *   快照只在启动 + 每 24h 拍，复用最新已有快照会让备份 db 最长落后
 *   24h——首启灌种后立刻下载会得到空库；VACUUM INTO 小库毫秒级，
 *   代价可忽略）：快照原名（恢复侧可解析时点）+ blobs/ + shared/ +
 *   secret.key，**排除 backups/ 自身**；
 * - 恢复是整库操作（多教师同库，无域隔离——一对一自部署既定口径，
 *   契约 backup-api.ts 注释同源）；恢复需操作者本人登录密码（D21）。
 *
 * 恢复原子性（最高优先级，任何失败路径原数据无损）：
 * ① 验密码 → ② 解析并校验 zip（动数据前完成，损坏包零副作用）→
 * ③ 恢复前自动快照（D21 回滚保险，进 14 份轮转）→ ④ 解压到**同卷**暂存目录 →
 * ⑤ close 数据连接（Windows 文件锁 + WAL 边车）→ DATA_DIR 顶层内容
 *   （除 backups/）整体挪到暂存、新内容 rename 就位，任一步失败回滚复原 →
 * ⑥ 重启数据连接（DbHandle.restart，服务进程不重启）→ ⑦ 恢复摘要
 *   （会话以恢复库为准，sessionWarning 恒 true，UI 提示重新登录）。
 * zip 未包含的顶层内容（如未打包 secret.key）按「整体替换」语义移除——
 * 下载 zip 与恢复严格往返，回到备份时点。
 */

/** DATA_DIR 内的备份目录名（恢复替换时唯一保留的顶层目录） */
export const BACKUP_DIR_NAME = "backups";
/** 库文件名（恢复落位统一重命名，与 config/index.ts 的 dbPath 约定一致） */
export const DB_FILE_NAME = "tutor.db";
/** 会话密钥文件名（D20：纳入备份与恢复） */
const SECRET_KEY_NAME = "secret.key";
/** zip 内允许的顶层目录（笔迹 / 共享发布） */
const ALLOWED_TOP_DIRS = new Set(["blobs", "shared"]);
/** 自动快照间隔：24 小时（架构 §5.10） */
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function backupsDirOf(dataDir: string): string {
  return join(dataDir, BACKUP_DIR_NAME);
}

// ---------- 自动快照（VACUUM INTO + 轮转） ----------

/**
 * 立即创建一份 db 快照（VACUUM INTO 完整库，WAL 下安全），
 * 同秒重名自动加 -2/-3 序号，随后按保留份数删最旧。
 * 返回快照文件名。目录不存在则创建。
 */
export function createSnapshot(
  dataDir: string,
  db: Db,
  now: Date = new Date(),
): string {
  const dir = backupsDirOf(dataDir);
  mkdirSync(dir, { recursive: true });

  const stamp = beijingExportStampOf(now);
  let filename = `tutor-${stamp}.db`;
  let suffix = 2;
  while (existsSync(join(dir, filename))) {
    filename = `tutor-${stamp}-${suffix}.db`;
    suffix += 1;
  }

  // VACUUM INTO 目标必须不存在（上面已保证）；参数绑定防路径注入
  try {
    db.$client.prepare("VACUUM INTO ?").run(join(dir, filename));
  } catch (err) {
    // 快照失败不该留下半个文件（目标不存在时 VACUUM 报错即未写入）
    throw new Error(
      `创建快照失败（${err instanceof Error ? err.message : String(err)}）`,
    );
  }

  pruneSnapshots(dataDir);
  return filename;
}

/** 按保留份数删最旧快照（按 mtime 排序；mtime 即创建时间） */
function pruneSnapshots(dataDir: string): void {
  const dir = backupsDirOf(dataDir);
  if (!existsSync(dir)) {
    return;
  }
  const names = readdirSync(dir).filter((name) =>
    BACKUP_SNAPSHOT_NAME_PATTERN.test(name),
  );
  if (names.length <= BACKUP_KEEP_COUNT) {
    return;
  }
  const byOldest = names
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  for (const item of byOldest.slice(0, names.length - BACKUP_KEEP_COUNT)) {
    rmSync(join(dir, item.name), { force: true });
  }
}

/** 最近快照列表（时间倒序；只列符合快照命名的文件） */
export function listSnapshots(dataDir: string): BackupSnapshot[] {
  const dir = backupsDirOf(dataDir);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => BACKUP_SNAPSHOT_NAME_PATTERN.test(name))
    .map((name) => {
      const stat = statSync(join(dir, name));
      return {
        filename: name,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 从快照文件名解析时点（北京时间戳 → UTC ISO）；非快照命名返回 null */
function snapshotTimeOf(dbFilename: string): string | null {
  const matched =
    /^tutor-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.db$/.exec(
      dbFilename,
    );
  if (matched === null) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = matched;
  // 快照名是北京时间（UTC+8，无夏令时），拼 ISO 串转回 UTC
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------- 下载（zip 实时打包） ----------

/** 下载 zip 的结果：Node 流（ZipArchive 即 Readable）与建议文件名 */
export interface BackupZip {
  stream: ZipArchive;
  filename: string;
}

/**
 * 组装完整备份 zip（D20，下载 = 当前时刻全量）：恒先补拍一份**当前时刻**
 * db 快照（Opus 实测③-1：避免复用最长落后 24h 的旧快照；VACUUM INTO
 * 小库毫秒级），再打包快照（保留原名）+ blobs/ + shared/ +
 * secret.key（各自存在才打包），排除 backups/ 自身。
 * 流式：返回未 finalize 的 archiver 流，由路由转 web 流边打包边响应，
 * 不整包进内存（blobs 可能很大）。
 * now 仅测试注入用（快照名与 zip 名的时间戳来源）。
 */
export function buildBackupZip(
  dataDir: string,
  db: Db,
  now: Date = new Date(),
): BackupZip {
  createSnapshot(dataDir, db, now);
  const latest = listSnapshots(dataDir)[0];
  if (latest === undefined) {
    // 理论不可达（刚拍完必有最新）；防御性兜底
    throw new HttpError(500, "INTERNAL", "备份快照不可用");
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });
  // 空错误监听：防止流错误成为未处理事件崩溃进程（错误仍会传给消费方）
  archive.on("error", () => {});

  archive.file(join(backupsDirOf(dataDir), latest.filename), {
    name: latest.filename,
  });
  for (const dirName of ALLOWED_TOP_DIRS) {
    const dirPath = join(dataDir, dirName);
    if (existsSync(dirPath)) {
      archive.directory(dirPath, dirName);
    }
  }
  const secretPath = join(dataDir, SECRET_KEY_NAME);
  if (existsSync(secretPath)) {
    archive.file(secretPath, { name: SECRET_KEY_NAME });
  }

  // 不 await：finalize 写入流即开始，路由把流转成响应体
  void archive.finalize();
  return {
    stream: archive,
    filename: `tutor-backup-${beijingExportStampOf(now)}.zip`,
  };
}

// ---------- 恢复（校验 → 保险快照 → 原子替换 → 重启连接） ----------

/** 恢复校验后的落位计划：唯一 db 条目 + 全部待落位条目 */
interface RestorePlan {
  dbEntry: ZipEntry;
}

/**
 * 校验 zip 结构：顶层只允许 db 文件（tutor.db 或快照命名，恰好一个）、
 * blobs/、shared/、secret.key；其余（含 backups/ 覆写尝试）→ 400 中文说明。
 */
function validateBackupEntries(entries: ZipEntry[]): RestorePlan {
  const dbEntries = entries.filter(
    (entry) =>
      !entry.name.includes("/") &&
      (entry.name === DB_FILE_NAME ||
        BACKUP_SNAPSHOT_NAME_PATTERN.test(entry.name)),
  );
  if (dbEntries.length === 0) {
    throw new HttpError(
      400,
      "BACKUP_ZIP_INVALID",
      "压缩包结构不符：缺少数据库文件（tutor.db 或 tutor-时间戳.db）",
    );
  }
  if (dbEntries.length > 1) {
    throw new HttpError(
      400,
      "BACKUP_ZIP_INVALID",
      "压缩包结构不符：包含多个数据库文件，请上传未改动过的备份",
    );
  }

  for (const entry of entries) {
    const top = entry.name.split("/")[0] as string;
    const allowed =
      top === "blobs" ||
      top === "shared" ||
      top === SECRET_KEY_NAME ||
      entry === dbEntries[0];
    if (!allowed) {
      throw new HttpError(
        400,
        "BACKUP_ZIP_INVALID",
        `压缩包结构不符：不认识的顶层内容「${top}」（只允许 db 文件、blobs/、shared/、secret.key）`,
      );
    }
  }

  return { dbEntry: dbEntries[0] as ZipEntry };
}

/** 尽力清理临时目录（失败忽略——孤儿临时目录无害，不掩盖业务结果） */
function rmTempBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Windows 上偶发 EBUSY：留着等系统临时目录清理，不影响数据正确性
  }
}

/**
 * 从备份 zip 恢复整库（D21 全流程，见文件头注释；原子性最高优先级）。
 *
 * 返回恢复摘要；失败路径：
 * - 密码错误 → 403（任何数据未动）；
 * - zip 损坏 / 结构不符 → 400（解析与校验在动数据之前）；
 * - 替换或重启连接失败 → 500 BACKUP_RESTORE_FAILED（已回滚复原，原数据无损）。
 */
export async function restoreFromBackup(
  dataDir: string,
  handle: DbHandle,
  teacherId: string,
  password: string,
  zipBytes: Uint8Array,
): Promise<BackupRestoreResult> {
  // ① 密码（D21）：操作者本人的登录密码，服务端 scrypt 校验
  const teacherRow = handle.db
    .select()
    .from(teachers)
    .where(eq(teachers.id, teacherId))
    .get();
  const passwordOk =
    teacherRow?.passwordHash !== undefined &&
    teacherRow.passwordHash !== null &&
    (await verifyPassword(password, teacherRow.passwordHash));
  if (!passwordOk) {
    throw new HttpError(403, "BACKUP_INVALID_PASSWORD", "登录密码不正确");
  }

  // ② 解析 zip（损坏在此暴露，零副作用）
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(Buffer.from(zipBytes));
  } catch (err) {
    if (err instanceof ZipReadError) {
      throw new HttpError(
        400,
        "BACKUP_ZIP_INVALID",
        `备份压缩包无法读取：${err.message}`,
      );
    }
    throw err;
  }
  const plan = validateBackupEntries(entries);

  // ③ 恢复前自动快照（D21 回滚保险；进 14 份轮转）
  createSnapshot(dataDir, handle.db);

  // ④ 解压到暂存目录：与 DATA_DIR **同父目录**（同卷）→ rename 快且原子
  const absoluteDataDir = resolve(dataDir);
  const staging = mkdtempSync(join(dirname(absoluteDataDir), "tutor-restore-"));
  const oldDir = mkdtempSync(
    join(dirname(absoluteDataDir), "tutor-restore-old-"),
  );

  try {
    for (const entry of entries) {
      const dest = join(staging, entry.name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
    }
    // db 统一落位为 tutor.db（恢复后的运行库名，与启动路径约定一致）
    if (plan.dbEntry.name !== DB_FILE_NAME) {
      renameSync(join(staging, plan.dbEntry.name), join(staging, DB_FILE_NAME));
    }

    // ⑤ 原子替换：先关连接（Windows 文件锁 + WAL 边车）
    handle.close();
    try {
      // 旧内容挪到暂存（backups/ 唯一保留：回滚快照在里面）
      for (const name of readdirSync(absoluteDataDir)) {
        if (name !== BACKUP_DIR_NAME) {
          renameSync(join(absoluteDataDir, name), join(oldDir, name));
        }
      }
      // 新内容就位；中途失败撤回已就位部分再回滚旧内容
      const movedIn: string[] = [];
      try {
        for (const name of readdirSync(staging)) {
          renameSync(join(staging, name), join(absoluteDataDir, name));
          movedIn.push(name);
        }
      } catch (err) {
        for (const name of movedIn) {
          rmSync(join(absoluteDataDir, name), { recursive: true, force: true });
        }
        throw err;
      }
      // ⑥ 重启数据连接（迁移钩子在 onOpen 里，旧版快照恢复后自动升级）
      handle.restart();
    } catch {
      // 回滚：清掉 DATA_DIR 里的新内容（若有），把旧内容原样放回
      for (const name of readdirSync(absoluteDataDir)) {
        if (name !== BACKUP_DIR_NAME) {
          rmSync(join(absoluteDataDir, name), { recursive: true, force: true });
        }
      }
      for (const name of readdirSync(oldDir)) {
        renameSync(join(oldDir, name), join(absoluteDataDir, name));
      }
      // 旧库文件已回原位，重开连接恢复服务（此时几乎不会失败）
      handle.restart();
      throw new HttpError(
        500,
        "BACKUP_RESTORE_FAILED",
        "恢复失败，数据已回滚复原（原数据无损）；请重试或检查磁盘空间",
      );
    }
  } finally {
    rmTempBestEffort(staging);
    rmTempBestEffort(oldDir);
  }

  // ⑦ 摘要：会话以恢复库为准（可能失效属预期，UI 提示重新登录）
  return {
    dbFilename: plan.dbEntry.name,
    snapshotTime: snapshotTimeOf(plan.dbEntry.name),
    restoredFiles: entries.length,
    sessionWarning: true,
  };
}

// ---------- 自动快照调度（index.ts 挂载） ----------

/**
 * 启动自动快照调度：立即拍一份（启动时）+ 每 24h 一份。
 * 失败只记日志不抛（磁盘满等不应拖垮服务）；返回停止函数（优雅退出时调用）。
 * intervalMs 仅测试注入用。
 */
export function startBackupScheduler(
  dataDir: string,
  db: Db,
  logger: Logger,
  intervalMs: number = SNAPSHOT_INTERVAL_MS,
): () => void {
  const run = (): void => {
    try {
      const filename = createSnapshot(dataDir, db);
      logger.info({ filename }, "自动快照完成");
    } catch (err) {
      logger.warn({ err }, "自动快照失败（服务继续运行）");
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  // 不阻止进程退出（优雅退出路径见 index.ts shutdown）
  timer.unref();
  return () => clearInterval(timer);
}
