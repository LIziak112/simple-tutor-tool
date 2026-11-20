import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BACKUP_KERNEL_ARTIFACT,
  BACKUP_KERNEL_DATABASE,
  BACKUP_KERNEL_MANIFEST,
  backupKernelManifestSchema,
} from "@tutor/contract";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { openLearningRuntime } from "learning-kernel";
import * as schema from "../db/schema.ts";
import { resolveWithinRoot } from "../lib/blob-io.ts";
import { ZipReadError } from "../lib/zip-read.ts";
import {
  readLockedBackupArtifact,
  supportsBackupArtifact,
} from "./backup-kernel-artifact.ts";
import {
  hasBackupTable,
  verifyBackupBindings,
} from "./backup-kernel-bindings.ts";
import { readNoteVersionDoc } from "./note-service.ts";

const readonlyOptions = { readonly: true, fileMustExist: true } as const;
const productKernelTables = [
  "kernel_assignment_versions",
  "kernel_assignment_openings",
  "kernel_attempt_bindings",
  "kernel_attempt_confirmations",
  "kernel_attempt_refreezes",
  "kernel_lesson_openings",
  "kernel_question_deliveries",
] as const;

function fileHash(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const bytes = Buffer.allocUnsafe(64 * 1024);
  try {
    for (let n = readSync(fd, bytes); n > 0; n = readSync(fd, bytes)) {
      hash.update(bytes.subarray(0, n));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function checkDb(db: Database.Database, table: string): void {
  if (
    !hasBackupTable(db, table) ||
    db.pragma("quick_check(1)", { simple: true }) !== "ok"
  ) {
    throw new ZipReadError("备份中的数据库不可用");
  }
}

function hasAnyRows(db: Database.Database, tables: readonly string[]): boolean {
  return tables.some(
    (table) =>
      hasBackupTable(db, table) &&
      db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined,
  );
}

function verifyOriginals(product: Database.Database, directory: string): void {
  if (!hasBackupTable(product, "kernel_attempt_bindings")) return;
  const frozen = product
    .prepare<[], { versionId: string; owned: number }>(`
    SELECT e.version_id AS versionId, IFNULL(n.attempt_id = e.attempt_id AND n.question_id = e.question_id, 0) AS owned
    FROM submission_evidence e JOIN (SELECT attempt_id FROM kernel_attempt_bindings UNION SELECT attempt_id FROM kernel_lesson_openings) b ON b.attempt_id = e.attempt_id
    LEFT JOIN note_versions v ON v.id = e.version_id LEFT JOIN notes n ON n.id = v.note_id
    WHERE e.state = 'frozen'
  `)
    .all();
  const pending = hasBackupTable(product, "attempt_original_reservations")
    ? product
        .prepare<[], { versionId: string; owned: number }>(`
      SELECT e.pending_version_id AS versionId,
        IFNULL(n.attempt_id = e.attempt_id AND n.question_id = e.question_id AND e.hash = v.hash, 0) AS owned
      FROM attempt_original_reservations e JOIN (SELECT attempt_id FROM kernel_attempt_bindings UNION SELECT attempt_id FROM kernel_lesson_openings) b ON b.attempt_id = e.attempt_id
      LEFT JOIN note_versions v ON v.id = e.pending_version_id LEFT JOIN notes n ON n.id = v.note_id
      WHERE e.state = 'pending'
    `)
        .all()
    : [];
  const productDb = drizzle(product, { schema });
  const imagePaths = product.prepare<[string], { path: string; hash: string }>(`
    SELECT path, hash FROM note_images WHERE note_version_id = ? AND state = 'ready'
  `);
  for (const { versionId, owned } of [...frozen, ...pending]) {
    try {
      if (!owned) throw new Error("原稿归属不符");
      const { rowHash, recomputedHash } = readNoteVersionDoc(
        productDb,
        directory,
        versionId,
      );
      if (rowHash !== recomputedHash) throw new Error("原稿正文摘要不符");
      for (const image of imagePaths.all(versionId)) {
        const imagePath = resolveWithinRoot(
          directory,
          join("blobs", "notes"),
          image.path,
          {
            suffix: ".png",
            violationCode: "NOTE_BODY_PATH_INVALID",
          },
        );
        if (fileHash(imagePath) !== image.hash)
          throw new Error("原稿图片摘要不符");
      }
    } catch {
      throw new ZipReadError("备份中的冻结原稿缺失、归属不符或内容不完整");
    }
  }
}

function inspectDatabases(
  productPath: string,
  directory: string,
): number | undefined {
  const product = new Database(productPath, readonlyOptions);
  try {
    checkDb(product, "teachers");
    if (
      !hasAnyRows(product, [
        "teachers",
        "students",
        "questions",
        "lectures",
        "units",
        "assignments",
        "attempts",
      ])
    ) {
      throw new ZipReadError("备份中的主库没有业务数据");
    }
    const kernelPath = join(directory, BACKUP_KERNEL_DATABASE);
    const hasKernelReferences = hasAnyRows(product, productKernelTables);
    if (!existsSync(kernelPath)) {
      if (hasKernelReferences) {
        throw new ZipReadError("主库已有内核数据引用，备份缺少内核数据库");
      }
      return undefined;
    }
    if (!hasKernelReferences) {
      throw new ZipReadError("内核数据库缺少可核对的宿主引用");
    }
    const kernel = new Database(kernelPath, readonlyOptions);
    try {
      checkDb(kernel, "schema_migrations");
      if (kernel.prepare("PRAGMA foreign_key_check").get()) {
        throw new ZipReadError("备份中的内核数据库引用不完整");
      }
      verifyBackupBindings(product, kernel, directory, (copy) =>
        verifyOriginals(copy, directory),
      );
      const version = kernel
        .prepare<[], { version: number | null }>(
          "SELECT MAX(version) AS version FROM schema_migrations",
        )
        .get()?.version;
      if (!version || !Number.isSafeInteger(version) || version < 1) {
        throw new ZipReadError("备份中的内核数据库没有有效版本");
      }
      return version;
    } finally {
      kernel.close();
    }
  } catch (error) {
    if (error instanceof ZipReadError) throw error;
    throw new ZipReadError("备份中的主库或内核库不可用");
  } finally {
    product.close();
  }
}

/** 恢复中断时验证已安装或待安装文件。归档清单已在首次替换前通过校验。 */
export function verifyBackupDirectory(
  directory: string,
  dbFilename: string,
): void {
  inspectDatabases(join(directory, dbFilename), directory);
}

export function writeKernelBackupManifest(
  productPath: string,
  directory: string,
): void {
  const kernelSchemaVersion = inspectDatabases(productPath, directory);
  if (kernelSchemaVersion === undefined) return;
  const artifact = readLockedBackupArtifact();
  const manifest = backupKernelManifestSchema.parse({
    formatVersion: 1,
    productSha256: fileHash(productPath),
    kernelSha256: fileHash(join(directory, BACKUP_KERNEL_DATABASE)),
    kernelSchemaVersion,
    kernelArtifactSha256: artifact.sha256,
  });
  writeFileSync(join(directory, BACKUP_KERNEL_ARTIFACT), artifact.bytes, {
    flag: "wx",
  });
  writeFileSync(
    join(directory, BACKUP_KERNEL_MANIFEST),
    JSON.stringify(manifest),
    { flag: "wx" },
  );
}

export function verifyKernelBackupManifest(
  productPath: string,
  directory: string,
): void {
  const manifestPath = join(directory, BACKUP_KERNEL_MANIFEST);
  const kernelPath = join(directory, BACKUP_KERNEL_DATABASE);
  const artifactPath = join(directory, BACKUP_KERNEL_ARTIFACT);
  if (
    !existsSync(kernelPath) &&
    !existsSync(manifestPath) &&
    !existsSync(artifactPath)
  ) {
    inspectDatabases(productPath, directory);
    return;
  }
  let manifest: ReturnType<typeof backupKernelManifestSchema.parse>;
  try {
    manifest = backupKernelManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    if (
      !supportsBackupArtifact(manifest.kernelArtifactSha256) ||
      manifest.kernelArtifactSha256 !== fileHash(artifactPath) ||
      manifest.productSha256 !== fileHash(productPath) ||
      manifest.kernelSha256 !== fileHash(kernelPath)
    ) {
      throw new Error("双库或内核归档摘要不符");
    }
  } catch {
    throw new ZipReadError("备份的双库摘要或固定内核产物不匹配");
  }
  if (
    manifest.kernelSchemaVersion !== inspectDatabases(productPath, directory)
  ) {
    throw new ZipReadError("备份中的内核库版本与清单不符");
  }
  // 使用部署所带运行时完成已经在副本验证过的迁移。
  openLearningRuntime({ databasePath: kernelPath }).close();
}
