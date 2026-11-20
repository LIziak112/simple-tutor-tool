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
  "daeda182a5e2a423f636edb121027f9bddf978d8c37cd845d69d0a4c2b988cb2",
  "f7d7d26bde2d0173db6a7e6661bf61384bba56e2267b8fd351c26983a55c8826",
  "c87fecad78eff549a23f5424d91872e584b3cee1ee633b29ad0dd2c1422fce4f",
  "d24068a9ab2f533d1e2dd49d691ce0d177ba34271200b993fab821f1c8ecae78",
  "2dafb580124e3a1531aed21845c26f3e107faa21d10552509647d4c9c52ba8f4",
  "3b565090f38b16dea6051cf71c63b3ebfa331291da9ccaf42e19549f162cde1d",
  "c78a36d1812d3e2d337177dbdb79d50af7c43cf9d0621ffd80f8be0b03d7ae73",
  "922ec7f9091aea01506a725754830765a9c394edaf1753d680210b883d8b1413",
  "1968b032742f9626b5d8270984965b39c27ea67541c36ec51a8e12ed9c40d5d5",
  "7bc836b57ec9140d3ee898a489e03b414490c89de491690c981580548a87c1f3",
  "baaea5f3ed29fd75f1bc06c3727a2ac311c0bebe6b6188619678cca994a5af07",
  "4576ef7bb755ef71e80deef3d5016a197415e72f26d8fd169bc5de269c32b00e",
  "aa78e0410b5b13f35b422e143a46fb045cb3c8b30497835c3217f57198fd3414",
  "b7bf4ce182647546cc2bd6576af744257a7938100a0486675e2ff7516db11a8f",
  "2c8255c8ad471ef3cb52d206b3ae854312497b275f20f27a86329e25cc3b834f",
]);

/** K27 支持已验旧归档。归档中的包仅用于离线比对。 */
export function supportsBackupArtifact(sha256: string): boolean {
  const current = lockedArtifact().sha256;
  return (
    sha256 === current ||
    (current ===
      "20908afb18deb0f71a3a13e5904565c54946cac3b8643d29241c7ae6ea87e838" &&
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
