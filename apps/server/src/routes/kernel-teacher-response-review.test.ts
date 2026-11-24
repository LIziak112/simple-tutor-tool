import { rmSync } from "node:fs";
import { attemptStartOkSchema, questionReviewOkSchema } from "@tutor/contract";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { submitAttemptRequest } from "../test/submit-revisions.ts";

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
let attemptId: string;

beforeAll(async () => {
  world = await setupAssignment(app);
  const assignment = await assignKernelFixture(app, world);
  const opened = await postAssignment(app, assignment, world.ownerCookie);
  expect(opened.status, await opened.clone().text()).toBe(200);
  attemptId = attemptStartOkSchema.parse(await opened.json()).data.id;
});
afterAll(() => {
  db.$client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("恢复后的正式判定在 SDK 计数分页前生效，学生页错题排除未答", async () => {
  const request = await app.request(
    `/api/student/attempts/${attemptId}/answers/m04-p0-q2`,
    {
      method: "PUT",
      headers: {
        cookie: world.ownerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ answer: { kind: "choice", index: 0 } }),
    },
  );
  expect(request.status, await request.clone().text()).toBe(200);
  db.$client.exec(`
    CREATE TRIGGER interrupt_response_review_test BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted response review test'); END
  `);
  try {
    const interrupted = await submitAttemptRequest(
      app,
      world.ownerCookie,
      attemptId,
    );
    expect(interrupted.status).toBe(500);
  } finally {
    db.$client.exec("DROP TRIGGER interrupt_response_review_test");
  }

  const token = await app.request("/api/teacher/api-token", {
    method: "POST",
    headers: { cookie: world.teacher },
  });
  expect(token.status, await token.clone().text()).toBe(200);
  const { data } = (await token.json()) as { data: { token: string } };
  const client = await connectMcpClientViaApp(
    app,
    "/mcp",
    data.token,
    "kernel-response-review",
  );
  try {
    const tool = await callToolJson(client, "query_student_responses", {
      studentId: world.studentId,
      attemptIds: [attemptId],
      correct: "false",
      limit: 1,
    });
    expect(tool.isError, JSON.stringify(tool.data)).toBe(false);
    expect(tool.data).toMatchObject({ total: 2, nextCursor: "1" });
    const answered = await callToolJson(client, "query_student_responses", {
      studentId: world.studentId,
      attemptIds: [attemptId],
      correct: "false",
      answered: true,
      limit: 1,
    });
    expect(answered.data).toMatchObject({
      total: 1,
      nextCursor: null,
      responses: [
        {
          questionId: "m04-p0-q2",
          answerRevision: 1,
          answered: true,
          finalCorrect: false,
        },
      ],
    });
  } finally {
    await client.close();
  }
  const review = await app.request(
    `/api/teacher/students/${world.studentId}/question-review?kind=wrong&limit=1`,
    {
      headers: { cookie: world.teacher },
    },
  );
  expect(review.status, await review.clone().text()).toBe(200);
  expect(questionReviewOkSchema.parse(await review.json()).data).toMatchObject({
    total: 1,
    nextCursor: null,
    questions: [
      {
        attemptId,
        questionId: "m04-p0-q2",
        effectiveVerdict: { source: "auto", value: false },
        redoCount: 0,
      },
    ],
  });
});
