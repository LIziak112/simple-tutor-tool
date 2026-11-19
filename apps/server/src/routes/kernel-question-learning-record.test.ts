import { rmSync } from "node:fs";
import {
  attemptStartOkSchema,
  learningRecordSchema,
  reviewPackSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
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
const questionId = "m04-p0-q2";
const answer = { kind: "choice", index: 0 };
const recordOk = z.object({ ok: z.literal(true), data: learningRecordSchema });
let world: Awaited<ReturnType<typeof setupAssignment>>;
let attemptId: string;

beforeAll(async () => {
  world = await setupAssignment(app);
  const assignmentId = await assignKernelFixture(app, world, {
    dueAt: "2099-01-01T00:00:00.000Z",
    answerRelease: "after_due",
  });
  const opened = await postAssignment(app, assignmentId, world.ownerCookie);
  expect(opened.status, await opened.clone().text()).toBe(200);
  attemptId = attemptStartOkSchema.parse(await opened.json()).data.id;
});

afterAll(() => {
  db.$client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("单题记录与 ZIP 读取冻结卷的草稿和正式判定，并按当前公布规则投影", async () => {
  const saved = await app.request(
    `/api/student/attempts/${attemptId}/answers/${questionId}`,
    {
      method: "PUT",
      headers: {
        cookie: world.ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ answer }),
    },
  );
  expect(saved.status, await saved.clone().text()).toBe(200);

  const teacherQuestion = `/api/teacher/attempts/${attemptId}/questions/${questionId}`;
  const draft = await app.request(`${teacherQuestion}/record`, {
    headers: { cookie: world.teacher },
  });
  expect(draft.status, await draft.clone().text()).toBe(200);
  const draftRecord = recordOk.parse(await draft.json()).data;
  expect(draftRecord.answer).toMatchObject({
    current: answer,
    answerRevision: 1,
  });
  expect(draftRecord.grading).toMatchObject({
    answered: false,
    finalCorrect: null,
  });

  const submitted = await submitAttemptRequest(
    app,
    world.ownerCookie,
    attemptId,
  );
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  const exported = await app.request(`${teacherQuestion}/review-pack`, {
    method: "POST",
    headers: { cookie: world.teacher },
  });
  expect(exported.status, await exported.clone().text()).toBe(200);
  const zip = unzipEntries(new Uint8Array(await exported.arrayBuffer()));
  const pack = reviewPackSchema.parse(
    JSON.parse(zip.get("pack.json")?.toString() ?? ""),
  );
  const record = learningRecordSchema.parse(
    JSON.parse(zip.get("record.json")?.toString() ?? ""),
  );
  expect(pack.response).toMatchObject({ answerText: "A", finalCorrect: false });
  expect(record.grading).toMatchObject({ answered: true, finalCorrect: false });
  expect(record.identity.questionRevisionId).toBe(
    draftRecord.identity.questionRevisionId,
  );

  const unpublished = await app.request(
    `/api/student/attempts/${attemptId}/questions/${questionId}/record`,
    { headers: { cookie: world.ownerCookie } },
  );
  expect(unpublished.status, await unpublished.clone().text()).toBe(200);
  const studentRecord = recordOk.parse(await unpublished.json()).data;
  expect(studentRecord.answer.current).toEqual(answer);
  expect(studentRecord.grading).not.toHaveProperty("finalCorrect");
});
