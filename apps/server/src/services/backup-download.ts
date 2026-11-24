import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { BACKUP_KERNEL_DATABASE } from "@tutor/contract";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import { HttpError } from "../lib/http-error.ts";
import { ZipReadError } from "../lib/zip-read.ts";
import { writeKernelBackupManifest } from "./backup-kernel-pair.ts";
import { removeBackupTemp } from "./backup-process-guard.ts";

interface CaptureOptions {
  readonly dataDir: string;
  readonly backupsDir: string;
  readonly directories: ReadonlySet<string>;
  readonly secretKeyName: string;
  readonly product: Database.Database;
  readonly snapshotProduct: (reader: Database.Database) => string;
}

function openReader(path: string) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** 文件与两个 SQLite 快照都冻结在同一次主库写锁内，再用独立目录流式打包。 */
export function captureBackupArchive(options: CaptureOptions): ZipArchive {
  const {
    product,
    backupsDir,
    dataDir,
    directories,
    secretKeyName,
    snapshotProduct,
  } = options;
  mkdirSync(backupsDir, { recursive: true });
  const staging = mkdtempSync(join(backupsDir, "tutor-download-"));
  try {
    function capture(reader: Database.Database) {
      const filename = snapshotProduct(reader);
      const pairedProduct = join(staging, filename);
      cpSync(join(backupsDir, filename), pairedProduct, {
        mode: constants.COPYFILE_FICLONE,
      });

      const kernelPath = join(dataDir, BACKUP_KERNEL_DATABASE);
      if (existsSync(kernelPath)) {
        const kernel = openReader(kernelPath);
        try {
          kernel
            .prepare("VACUUM INTO ?")
            .run(join(staging, BACKUP_KERNEL_DATABASE));
        } finally {
          kernel.close();
        }
      }
      for (const name of [...directories, secretKeyName]) {
        const source = join(dataDir, name);
        if (!existsSync(source)) continue;
        cpSync(source, join(staging, name), {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          filter: (path) => {
            const entry = lstatSync(path);
            if (!entry.isFile() && !entry.isDirectory()) {
              throw new ZipReadError("数据目录含无法安全归档的特殊文件");
            }
            return true;
          },
        });
      }
      return pairedProduct;
    }

    const productPath = product.memory
      ? capture(product)
      : product
          .transaction(() => {
            // VACUUM INTO 不能在持锁连接的事务内运行。WAL 下另一个连接读取最新提交。
            const reader = openReader(product.name);
            try {
              return capture(reader);
            } finally {
              reader.close();
            }
          })
          .immediate();

    writeKernelBackupManifest(productPath, staging);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", () => {});
    archive.on("warning", (error) => archive.destroy(error));
    const clean = () => removeBackupTemp(staging);
    archive.once("end", clean);
    archive.once("close", clean);
    archive.directory(staging, false);
    void archive.finalize().catch((error: Error) => archive.destroy(error));
    return archive;
  } catch (error) {
    removeBackupTemp(staging);
    if (error instanceof ZipReadError) {
      throw new HttpError(
        500,
        "INTERNAL",
        `无法生成完整备份：${error.message}`,
      );
    }
    throw error;
  }
}
