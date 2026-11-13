import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { storagePathKey } from "./storage-gc-paths";

/** 圈画文件是内容寻址的，同一文件可被多个活行或快照引用。 */
export function sweepAnnotationFiles(
  dataDir: string,
  keep: ReadonlyMap<string, number>,
  sweep: (path: string) => boolean,
): number {
  let removed = 0;
  for (const [name, pattern] of [
    ["annotations", /^[a-f0-9]{64}\.png$/u],
    ["annotation-bodies", /^[a-f0-9]{64}\.json\.gz$/u],
  ] as const) {
    const root = resolve(dataDir, "blobs", name);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (
        entry.isFile() &&
        pattern.test(entry.name) &&
        !keep.has(storagePathKey(dataDir, path)) &&
        sweep(path)
      )
        removed++;
    }
  }
  return removed;
}
