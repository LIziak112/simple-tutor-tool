import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { backfillSubmissionTime } from "../src/services/backfill-submission-time.ts";

const { values } = parseArgs({
  options: { db: { type: "string" }, output: { type: "string" } },
});
if (!values.db)
  throw new Error(
    "需要 --db 指定离线快照；默认只读盘点，--output 仅生成新的补账副本",
  );
const sourcePath = resolve(values.db);
const hashOf = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceHash = hashOf(sourcePath);
const source = new Database(sourcePath, {
  readonly: true,
  fileMustExist: true,
});
let destination: string | undefined;
let copyOwned = false;
let succeeded = false;
try {
  if (source.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("源快照完整性检查失败");
  let report: ReturnType<typeof backfillSubmissionTime>;
  if (values.output) {
    destination = resolve(values.output);
    // 原子保留新文件，已有文件/硬链接/符号链接一律拒绝，绝不原地改源库。
    const fd = openSync(destination, "wx", 0o600);
    copyOwned = true;
    closeSync(fd);
    await source.backup(destination);
    const copy = new Database(destination, { fileMustExist: true });
    try {
      copy.pragma("foreign_keys = ON");
      report = backfillSubmissionTime(copy, { apply: true });
      if (copy.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error("副本完整性检查失败");
    } finally {
      copy.close();
    }
  } else report = backfillSubmissionTime(source);
  if (hashOf(sourcePath) !== sourceHash) throw new Error("源快照哈希发生变化");
  console.log(
    JSON.stringify(
      {
        mode: destination ? "copy" : "dry-run",
        sourceSha256: sourceHash,
        sourceBytes: statSync(sourcePath).size,
        integrity: "ok",
        ...(destination ? { outputSha256: hashOf(destination) } : {}),
        ...report,
      },
      null,
      2,
    ),
  );
  succeeded = true;
} finally {
  source.close();
  if (!succeeded && copyOwned && destination) unlinkSync(destination);
}
