import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createDb } from "../db/client.ts";
import { questions } from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { commitImport } from "../services/content-service.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = join(root, ".vitest");
const questionId = "练习四-2";

function runReparse(dataDir: string, args: "" | "--dry-run" | "--unknown") {
  const result = spawnSync(`pnpm reparse ${args}`, {
    cwd: root,
    env: { ...process.env, DATA_DIR: relative(root, dataDir) },
    shell: true,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  return result;
}

function readQuestion(dbPath: string) {
  const db = createDb(dbPath);
  try {
    const { id, difficulty, version, sourceMd } = questions;
    return db
      .select({ id, difficulty, version, sourceMd })
      .from(questions)
      .where(eq(id, questionId))
      .get();
  } finally {
    db.$client.close();
  }
}

it("根命令按相对 DATA_DIR 预览及应用重抽取，重复执行不增版本", () => {
  mkdirSync(scratch, { recursive: true });
  using dataDir = mkdtempDisposableSync(join(scratch, "reparse cli-"));
  const dbPath = join(dataDir.path, "tutor.db");
  const db = createTestDb();
  try {
    const filename = "练习样例.md";
    const markdown = readFileSync(
      join(root, "samples", "v2", filename),
      "utf8",
    );
    commitImport(db, TEST_TEACHER_ID, { markdown, filename });
    expect(
      db
        .update(questions)
        .set({ difficulty: 5 })
        .where(eq(questions.id, questionId))
        .run().changes,
    ).toBe(1);
    writeFileSync(dbPath, db.$client.serialize());
  } finally {
    db.$client.close();
  }

  const before = readQuestion(dbPath);
  expect(before).toMatchObject({ difficulty: 5, version: 1 });

  const dry = runReparse(dataDir.path, "--dry-run");
  expect(dry.status, dry.stderr).toBe(0);
  expect(dry.stdout).toContain("--dry-run 预览：未写入数据库");
  expect(dry.stdout).toContain("更新 1 题，无变化 7 题");
  expect(dry.stdout).toContain(`数据库：${dbPath}`);
  expect(readQuestion(dbPath)).toEqual(before);

  const apply = runReparse(dataDir.path, "");
  expect(apply.status, apply.stderr).toBe(0);
  expect(apply.stdout).toContain("已写入数据库");
  const after = readQuestion(dbPath);
  expect(after).toEqual({ ...before, difficulty: 1, version: 2 });

  const repeat = runReparse(dataDir.path, "");
  expect(repeat.status, repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("更新 0 题，无变化 8 题");
  expect(readQuestion(dbPath)).toEqual(after);
}, 60_000);

it("根命令在缺库与未知参数时返回退出码 2，且不创建数据库目录", () => {
  mkdirSync(scratch, { recursive: true });
  using dataDir = mkdtempDisposableSync(join(scratch, "reparse cli-"));
  const missing = join(dataDir.path, "absent");
  const noDb = runReparse(missing, "--dry-run");
  expect(noDb.status, noDb.stderr).toBe(2);
  expect(noDb.stderr).toContain(`数据库不存在：${join(missing, "tutor.db")}`);

  const unknown = runReparse(missing, "--unknown");
  expect(unknown.status, unknown.stderr).toBe(2);
  expect(unknown.stderr).toContain("未知参数：--unknown");
  expect(existsSync(missing)).toBe(false);
}, 40_000);
