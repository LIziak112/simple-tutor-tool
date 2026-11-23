import { rmSync } from "node:fs";
import {
  attemptStartOkSchema,
  learningPackPreviewOkSchema,
  learningPackV2Schema,
} from "@tutor/contract";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { submitAttemptRequest } from "../test/submit-revisions.ts";
import { unzipEntries } from "../test/unzip.ts";

const db = createTestDb();
const dataDir = createTestDir();
const app = createApp({
  db,
  dataDir,
  kernelAssignmentCreationEnabled: true,
  isProduction: false,
  logger: pino({ enabled: false }),
  publicUrl: "http://localhost:8787",
});
let world: Awaited<ReturnType<typeof setupAssignment>>;
let assignmentId: string;
let attemptId: string;

beforeAll(async () => {
  world = await setupAssignment(app);
  assignmentId = await assignKernelFixture(app, world);
  const opened = await postAssignment(app, assignmentId, world.ownerCookie);
  expect(opened.status, await opened.clone().text()).toBe(200);
  attemptId = attemptStartOkSchema.parse(await opened.json()).data.id;
});

afterAll(() => {
  db.$client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("整卷预览首次恢复已确认作答，下载使用同一截止时刻及正式逐题判定", async () => {
  const saved = await app.request(
    `/api/student/attempts/${attemptId}/answers/m04-p0-q1`,
    {
      method: "PUT",
      headers: {
        cookie: world.ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ answer: { kind: "choice", index: 1 } }),
    },
  );
  expect(saved.status, await saved.clone().text()).toBe(200);

  db.$client.exec(`
    CREATE TRIGGER interrupt_learning_pack_test BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted learning pack test'); END
  `);
  try {
    const interrupted = await submitAttemptRequest(
      app,
      world.ownerCookie,
      attemptId,
    );
    expect(interrupted.status).toBe(500);
  } finally {
    db.$client.exec("DROP TRIGGER interrupt_learning_pack_test");
  }
  const host = () =>
    db.$client
      .prepare("SELECT status,score_auto,score_final FROM attempts WHERE id=?")
      .get(attemptId);
  expect(host()).toMatchObject({ status: "draft" });

  const path = "/api/teacher/export/learning-pack";
  const request = {
    packVersion: 2,
    scope: { assignmentId, days: "all" },
    goal: "diagnose-weakness",
    modules: { responses: true, summaries: true },
  };
  const post = (url: string, body: object) =>
    app.request(url, {
      method: "POST",
      headers: { cookie: world.teacher, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const preview = await post(`${path}/preview`, request);
  expect(preview.status, await preview.clone().text()).toBe(200);
  const { asOf } = learningPackPreviewOkSchema.parse(await preview.json()).data;
  expect(host()).toEqual({
    status: "graded",
    score_auto: null,
    score_final: null,
  });
  const downloaded = await post(path, { ...request, asOf });
  expect(downloaded.status, await downloaded.clone().text()).toBe(200);
  const zip = unzipEntries(new Uint8Array(await downloaded.arrayBuffer()));
  const pack = learningPackV2Schema.parse(
    JSON.parse(zip.get("pack.json")?.toString() ?? ""),
  );
  expect(pack.meta.to).toBe(asOf);
  expect(pack.attempts?.summaries).toMatchObject([
    { attemptId, scoreFinal: 50, questionCount: 2, pendingCount: 0 },
  ]);
  expect(pack.attempts?.responses).toMatchObject([
    { no: 1, answerText: "B", finalCorrect: true },
    { no: 2, answerText: null, finalCorrect: false },
  ]);
});
