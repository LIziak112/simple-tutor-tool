import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import serverPackage from "../../package.json" with { type: "json" };

function lockedArtifact() {
  const locked = /^file:(vendor\/learning-kernel-([0-9a-f]{64})\.tgz)$/.exec(
    serverPackage.dependencies["learning-kernel"],
  );
  if (!locked?.[1] || !locked[2])
    throw new Error("服务端没有锁定可验证的内核归档");
  return { relativePath: locked[1], sha256: locked[2] };
}

const restorablePredecessors = new Set([
  "3b565090f38b16dea6051cf71c63b3ebfa331291da9ccaf42e19549f162cde1d",
  "c78a36d1812d3e2d337177dbdb79d50af7c43cf9d0621ffd80f8be0b03d7ae73",
]);

/** K10 支持已实测的 K8/K9 归档。归档中的包仅用于离线比对。 */
export function supportsBackupArtifact(sha256: string): boolean {
  const current = lockedArtifact().sha256;
  return (
    sha256 === current ||
    (current ===
      "922ec7f9091aea01506a725754830765a9c394edaf1753d680210b883d8b1413" &&
      restorablePredecessors.has(sha256))
  );
}

export function readLockedBackupArtifact() {
  const { relativePath, sha256 } = lockedArtifact();
  const directory = dirname(fileURLToPath(import.meta.url));
  // 源码运行读取 vendor，构建后读取 dist/vendor。
  const path = [
    join(directory, "..", "..", relativePath),
    join(directory, relativePath),
  ].find(existsSync);
  if (!path) throw new Error("部署缺少固定内核归档");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("部署内核归档与锁定指纹不一致");
  }
  return { filename: basename(relativePath), sha256, bytes };
}
