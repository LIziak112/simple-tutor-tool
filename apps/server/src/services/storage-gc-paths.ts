import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "../db/client";
import { BLOB_BACKUP_REF_COLUMNS } from "../db/schema";

export function storagePathKey(dataDir: string, path: string): string {
  return resolve(dataDir, path).toLowerCase();
}

export function liveStoragePaths(
  db: Db,
  dataDir: string,
  backup: readonly string[],
) {
  const keep = new Map<string, number>();
  const add = (path: string, refs: number) => {
    const file = resolve(dataDir, path);
    const key = storagePathKey(dataDir, file);
    keep.set(key, (keep.get(key) ?? 0) + refs);
    try {
      const alias = storagePathKey(dataDir, realpathSync(file));
      if (alias !== key) keep.set(alias, Infinity);
    } catch {
      // 旧引用可指向缺失的文件，仍保留其词法键。
    }
  };
  for (const path of backup) add(path, Infinity);
  for (const [table, column] of BLOB_BACKUP_REF_COLUMNS) {
    for (const { path } of db.$client
      .prepare(
        `SELECT ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`,
      )
      .iterate() as Iterable<{ path: string }>) {
      add(path, 1);
    }
  }
  return keep;
}

/** 逐级拒绝目录链接，避免词法路径与实际指向或引用对账不一致。 */
export function safeStorageFile(dataDir: string, filePath: string): boolean {
  const root = resolve(dataDir);
  const dir = dirname(filePath);
  const rel = relative(root, dir);
  if (
    rel === "" ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`)
  )
    return false;
  let current = root;
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment);
    if (!lstatSync(current).isDirectory()) return false;
  }
  return storagePathKey(root, dir) === storagePathKey(root, realpathSync(dir));
}
