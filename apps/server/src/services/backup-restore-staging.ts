import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BACKUP_MAX_UPLOAD_BYTES,
  BACKUP_SNAPSHOT_NAME_PATTERN,
} from "@tutor/contract";
import Database from "better-sqlite3";
import { HttpError } from "../lib/http-error.ts";
import { writePlannedZipEntry } from "../lib/zip-entry-stream.ts";
import {
  planZipEntries,
  ZipBudgetError,
  type ZipEntryPlan,
  ZipReadError,
} from "../lib/zip-read.ts";

interface BackupLayout {
  readonly dbFilename: string;
  readonly secretKeyName: string;
  readonly directories: ReadonlySet<string>;
}

const BACKUP_ZIP_BUDGET = {
  maxEntries: 65_534,
  maxEntryBytes: BACKUP_MAX_UPLOAD_BYTES * 4,
  maxTotalBytes: BACKUP_MAX_UPLOAD_BYTES * 16,
} as const;

function pathKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

function isWindowsPathSegment(part: string): boolean {
  const reserved =
    /[:*?"<>|]|[. ]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  return (
    !reserved.test(part) &&
    !Array.from(part).some((char) => char.charCodeAt(0) < 32)
  );
}

function validateBackupLayout(
  entries: readonly ZipEntryPlan[],
  layout: BackupLayout,
): ZipEntryPlan {
  const [database, ...extraDatabases] = entries.filter(
    (entry) =>
      !entry.name.includes("/") &&
      (entry.name === layout.dbFilename ||
        BACKUP_SNAPSHOT_NAME_PATTERN.test(entry.name)),
  );
  if (!database)
    throw new ZipReadError(
      "压缩包结构不符：缺少数据库文件（tutor.db 或 tutor-时间戳.db）",
    );
  if (extraDatabases.length > 0)
    throw new ZipReadError("压缩包结构不符：包含多个数据库文件");
  // 分隔符排在其他字符之前，同一路径及其首个子路径在排序后相邻。
  const paths = entries
    .map((entry) => pathKey(entry.name).replaceAll("/", "\0"))
    .sort();
  let previous: string | undefined;
  for (const path of paths) {
    if (
      previous !== undefined &&
      (path === previous || path.startsWith(`${previous}\0`))
    ) {
      throw new ZipReadError("压缩包包含重复或相互冲突的文件路径");
    }
    previous = path;
  }
  for (const entry of entries) {
    if (entry === database || entry.name === layout.secretKeyName) continue;
    const parts = entry.name.split("/");
    const top = parts[0] ?? "";
    if (parts.length < 2 || !layout.directories.has(top)) {
      throw new ZipReadError(
        `压缩包结构不符：不认识的顶层内容「${top}」（只允许 db 文件、blobs/、shared/、secret.key）`,
      );
    }
    if (
      process.platform === "win32" &&
      parts.some((part) => !isWindowsPathSegment(part))
    ) {
      throw new ZipReadError(`压缩包包含本机不支持的文件路径：${entry.name}`);
    }
  }
  return database;
}

function validateStagedDatabase(filename: string): void {
  try {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      const teacherTable = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'teachers'",
        )
        .get();
      if (
        !teacherTable ||
        db.pragma("quick_check(1)", { simple: true }) !== "ok"
      ) {
        throw new ZipReadError("备份中的数据库不可用");
      }
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof ZipReadError) throw error;
    throw new ZipReadError("备份中的数据库不可用");
  }
}

/** 完整预检后逐条写入同卷暂存目录，所有内容校验完成后才返回。 */
export async function stageBackupArchive(
  zipBytes: Uint8Array,
  staging: string,
  layout: BackupLayout,
) {
  if (zipBytes.byteLength > BACKUP_MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "BACKUP_TOO_LARGE", "备份文件超过 256 MB 上限");
  }
  try {
    const buffer = Buffer.from(
      zipBytes.buffer,
      zipBytes.byteOffset,
      zipBytes.byteLength,
    );
    const entries = planZipEntries(buffer, BACKUP_ZIP_BUDGET);
    const database = validateBackupLayout(entries, layout);
    const dbPath = join(staging, layout.dbFilename);
    for (const entry of entries) {
      const destination =
        entry === database ? dbPath : join(staging, entry.name);
      mkdirSync(dirname(destination), { recursive: true });
      await writePlannedZipEntry(entry, destination);
    }
    validateStagedDatabase(dbPath);
    return { dbFilename: database.name, restoredFiles: entries.length };
  } catch (error) {
    if (error instanceof ZipBudgetError)
      throw new HttpError(413, "BACKUP_TOO_LARGE", error.message);
    if (error instanceof ZipReadError) {
      throw new HttpError(
        400,
        "BACKUP_ZIP_INVALID",
        `备份压缩包无法读取：${error.message}`,
      );
    }
    throw error;
  }
}
