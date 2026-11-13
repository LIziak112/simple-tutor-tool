import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { attempts, responses } from "../db/schema.ts";
import {
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";

const paths: string[] = [];
afterEach(() => {
  closeTimingFixtures();
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const cli = (source: string, output?: string) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
      ),
      fileURLToPath(
        new URL("../../scripts/backfill-submission-time.ts", import.meta.url),
      ),
      "--db",
      source,
      ...(output ? ["--output", output] : []),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
async function snapshot() {
  const env = timingFixture();
  env.event("question_focus", 1, "q1");
  env.event("question_blur", 9, "q1");
  env.submit("q1", 10);
  env.event("question_focus", 11, "q2");
  env.event("question_blur", 15, "q2");
  env.submit("q2", 16);
  env.db
    .update(responses)
    .set({ activeSec: null })
    .where(eq(responses.attemptId, env.attemptId))
    .run();
  env.db
    .update(attempts)
    .set({ activeSec: null })
    .where(eq(attempts.id, env.attemptId))
    .run();
  const dir = mkdtempSync(join(tmpdir(), "timing-copy-"));
  paths.push(dir);
  const source = join(dir, "source.db");
  await env.db.$client.backup(source);
  chmodSync(source, 0o400);
  return { source, dir };
}

it("CLI默认只读；仅新副本可补账，源哈希和内容不变，副本再次盘点零计划", async () => {
  const { source, dir } = await snapshot();
  const hash = sha(source);
  const dry = cli(source);
  expect(dry.status, dry.stderr).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    mode: "dry-run",
    plannedRows: 2,
    writtenRows: 0,
  });
  const output = join(dir, "copy.db");
  const copied = cli(source, output);
  expect(copied.status, copied.stderr).toBe(0);
  expect(JSON.parse(copied.stdout)).toMatchObject({
    mode: "copy",
    writtenRows: 2,
    writtenAttempts: 1,
    integrity: "ok",
  });
  expect(sha(source)).toBe(hash);
  const copy = new Database(output, { readonly: true });
  try {
    expect(copy.prepare("SELECT active_sec FROM attempts").pluck().get()).toBe(
      12,
    );
  } finally {
    copy.close();
  }
  const again = cli(output);
  expect(again.status, again.stderr).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({
    plannedRows: 0,
    writtenRows: 0,
    plannedAttempts: 0,
  });
}, 30_000);

it("CLI拒绝源路径、已有文件和硬链接作为输出，失败也不得删除它们", async () => {
  const { source, dir } = await snapshot();
  const hash = sha(source);
  const same = cli(source, source);
  expect(same.status).not.toBe(0);
  expect(sha(source)).toBe(hash);
  const existing = join(dir, "existing.db");
  writeFileSync(existing, "保留已有文件");
  const refused = cli(source, existing);
  expect(refused.status).not.toBe(0);
  expect(readFileSync(existing, "utf8")).toBe("保留已有文件");
  const hard = join(dir, "hard.db");
  linkSync(source, hard);
  expect(cli(source, hard).status).not.toBe(0);
  expect(sha(hard)).toBe(hash);
  expect(sha(source)).toBe(hash);
}, 30_000);
