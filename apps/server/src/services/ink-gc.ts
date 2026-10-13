import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "../db/client";
import { ink } from "../db/schema";

/** 只回收本轮协议生成的旧文件，历史文件与快照引用保持原样。 */
export function gcInkFiles(
  db: Db,
  dataDir: string,
  cutoffMs: number,
  backup: { paths: string[]; unreadable: number },
): number {
  if (backup.unreadable > 0) return 0;
  const root = resolve(dataDir, "blobs", "ink");
  if (!existsSync(root)) return 0;
  const keep = new Set(
    backup.paths.map((path) => resolve(dataDir, path).toLowerCase()),
  );
  for (const row of db
    .select({ body: ink.strokesPath, png: ink.pngPath })
    .from(ink)
    .all()) {
    keep.add(resolve(dataDir, row.body).toLowerCase());
    keep.add(resolve(dataDir, row.png).toLowerCase());
  }
  let removed = 0;
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const dir = join(root, directory.name);
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (
        !file.isFile() ||
        !/^q-.+-v\d+-[0-9a-f-]{36}\.(json\.gz|png)$/i.test(file.name)
      )
        continue;
      const path = join(dir, file.name);
      if (keep.has(path.toLowerCase())) continue;
      try {
        if (lstatSync(path).mtimeMs >= cutoffMs) continue;
        unlinkSync(path);
        removed++;
      } catch {
        /* 文件已消失或被占用，下轮再检查。 */
      }
    }
  }
  return removed;
}
