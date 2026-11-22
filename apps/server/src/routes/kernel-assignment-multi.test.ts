import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  assignKernelFixture,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";

const multiMarkdown = [
  "---",
  "kind: practice",
  "unit: K16 合成多选",
  "---",
  "",
  ...Array.from({ length: 5 }, (_, index) => [
    `::::question{id=k16-multi-${index + 1} type=multi}`,
    `合成多选 ${index + 1}。`,
    "",
    "- [x] 甲",
    "- [ ] 乙",
    "- [x] 丙",
    "- [ ] 丁",
    "::::",
    "",
  ]).flat(),
].join("\n");

it("经正常教师入口创建纯多选内核整卷", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "ownclass-k16-multi-"));
  const handle = createDbHandle(join(data.path, "tutor.db"), (db) => {
    runMigrations(db);
    runBackfills(db);
  });
  const app = createApp({
    db: handle.db,
    dbHandle: handle,
    dataDir: data.path,
    kernelAssignmentCreationEnabled: true,
    isProduction: false,
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
  });
  try {
    const world = await setupAssignment(app);
    const response = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { cookie: world.teacher, "content-type": "application/json" },
      body: JSON.stringify({ markdown: multiMarkdown, filename: "K16 合成多选.md" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { data: imported } = z
      .object({ data: z.object({ units: z.array(z.object({ id: z.string() })).nonempty() }) })
      .parse(await response.json());
    const [unit] = imported.units;
    if (!unit) throw new Error("没有导入多选单元");
    const assignment = await assignKernelFixture(app, { ...world, unitId: unit.id },
      { dueAt: "2099-01-01T00:00:00.000Z", answerRelease: "after_due" });
    expect(assignment).toBeTruthy();
  } finally {
    handle.db.$client.close();
  }
});
