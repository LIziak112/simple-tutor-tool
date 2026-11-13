import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { storagePathKey } from "./storage-gc-paths";

/** 只回收本轮协议生成的旧文件，历史文件与快照引用保持原样。 */
export function gcInkFiles(
  dataDir: string,
  keep: ReadonlyMap<string, number>,
  sweep: (path: string) => boolean,
): number {
  const root = resolve(dataDir, "blobs", "ink");
  if (!existsSync(root)) return 0;
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
      if (keep.has(storagePathKey(dataDir, path))) continue;
      if (sweep(path)) removed++;
    }
  }
  return removed;
}
