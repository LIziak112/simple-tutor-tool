import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attemptStartOkSchema,
  studentMcpPracticeDataSchema,
  studentMcpPracticeListDataSchema,
  studentMcpPracticeQuestionDataSchema,
} from "@tutor/contract";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions.ts";

const resources: Array<() => void> = [];
afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
});

async function status(response: Response, expected: number) {
  expect(response.status, await response.clone().text()).toBe(expected);
  return (await response.json()) as unknown;
}

async function world(backend: "legacy" | "kernel") {
  const dataDir = createTestDir();
  resources.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = join(dataDir, "product.sqlite");
  const seed = createTestDb();
  try {
    writeFileSync(file, seed.$client.serialize());
  } finally {
    seed.$client.close();
  }
  let db = createDb(file);
  resources.push(() => db.$client.close());
  const open = () =>
    createApp({
      db,
      dataDir,
      kernelAssignmentCreationEnabled: true,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  let app = open();
  const fixture = await setupAssignment(app);
  const assignmentId =
    backend === "legacy"
      ? fixture.assignmentId
      : await assignKernelFixture(app, fixture);
  const call = (
    path: string,
    method = "GET",
    body?: object,
    cookie = fixture.ownerCookie,
  ) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const start = attemptStartOkSchema.parse(
    await status(
      await postAssignment(app, assignmentId, fixture.ownerCookie),
      200,
    ),
  ).data;
  const root = `/api/student/attempts/${start.id}`;
  const revisions = () =>
    fetchSubmitRevisions(app, fixture.ownerCookie, start.id);
  const [first, second] = await revisions();
  if (!first || !second) throw new Error("没有两道冻结题");
  const connections = "/api/student/ai/connections";

  async function connection(cookie = fixture.ownerCookie) {
    const body = (await status(
      await call(connections, "POST", { channel: "mcp" }, cookie),
      201,
    )) as {
      data: { credential: { token: string }; connection: { id: string } };
    };
    return { token: body.data.credential.token, id: body.data.connection.id };
  }
  const owner = await connection();
  const other = await connection(fixture.otherCookie);
  return {
    start,
    first,
    second,
    connect(token = owner.token) {
      return connectMcpClientViaApp(
        app,
        "/mcp/student",
        token,
        "m04-student-practice",
      );
    },
    otherToken: other.token,
    restart() {
      db.$client.close();
      db = createDb(file);
      app = open();
    },
    async save(index: number) {
      const [row] = await revisions();
      if (!row) throw new Error("没有冻结题");
      await status(
        await call(`${root}/answers/${row.questionId}`, "PUT", {
          answer: { kind: "choice", index },
          mutationId: randomUUID(),
          baseRevision: row.expectedAnswerRevision,
          expectedFrozenAt: start.frozenAt,
          questionRevisionId: row.questionRevisionId,
        }),
        200,
      );
    },
    async submit() {
      await status(
        await call(`${root}/submit`, "POST", { revisions: await revisions() }),
        200,
      );
    },
    async release(released: boolean) {
      const setting = released
        ? { answerRelease: "on_submit" }
        : { answerRelease: "after_due", dueAt: "2099-01-01T00:00:00.000Z" };
      await status(
        await call(
          `/api/teacher/assignments/${assignmentId}`,
          "PATCH",
          setting,
          fixture.teacher,
        ),
        200,
      );
    },
    async revoke() {
      await status(await call(`${connections}/${owner.id}`, "DELETE"), 200);
    },
  };
}

it.each(["legacy", "kernel"] as const)(
  "%s 的学生 SDK 按本人当前草稿显示列表进度、目录状态和选项",
  async (backend) => {
    const env = await world(backend);
    const initial = await env.connect();
    try {
      const empty = await callToolJson(initial, "list_my_practices", {});
      expect(empty.isError).toBe(false);
      expect(studentMcpPracticeListDataSchema.parse(empty.data)).toMatchObject({
        total: 0,
        practices: [],
      });
    } finally {
      await initial.close();
    }
    await env.save(1);
    env.restart();
    const client = await env.connect();
    try {
      const listed = await callToolJson(client, "list_my_practices", {});
      expect(listed.isError).toBe(false);
      expect
        .soft(studentMcpPracticeListDataSchema.parse(listed.data))
        .toMatchObject({
          total: 1,
          practices: [
            {
              practiceId: env.start.id,
              answerProgress: { answeredCount: 1, totalCount: 2 },
            },
          ],
        });
      const paper = await callToolJson(client, "get_practice", {
        practiceId: env.start.id,
      });
      expect(paper.isError).toBe(false);
      expect
        .soft(studentMcpPracticeDataSchema.parse(paper.data).questions)
        .toMatchObject([
          {
            questionId: env.first.questionId,
            questionRevisionId: env.first.questionRevisionId,
            state: "answered",
          },
          {
            questionId: env.second.questionId,
            questionRevisionId: env.second.questionRevisionId,
            state: "unanswered",
          },
        ]);
      const question = await callToolJson(client, "get_practice_question", {
        practiceId: env.start.id,
        questionNo: 1,
        includeImages: false,
      });
      expect(question.isError).toBe(false);
      expect
        .soft(studentMcpPracticeQuestionDataSchema.parse(question.data))
        .toMatchObject({
          question: {
            questionRevisionId: env.first.questionRevisionId,
            options: ["4", "5", "6"],
          },
          currentAnswer: { kind: "choice", index: 1 },
        });
      for (const { data } of [listed, paper, question]) {
        assertNoLeak(data, {
          forbid: [
            "scoringKey",
            "keyRef",
            "acceptedChoice",
            "evaluation",
            "finalCorrect",
          ],
        });
        expect(JSON.stringify(data)).not.toContain("合成详解");
      }
    } finally {
      await client.close();
    }
  },
);

it.each(["legacy", "kernel"] as const)(
  "%s 交卷后只读本人正式选项，公布收紧、他人和撤销令牌继续严格",
  async (backend) => {
    const env = await world(backend);
    await env.save(1);
    await env.submit();
    env.restart();
    const client = await env.connect();
    const other = await env.connect(env.otherToken);
    const question = {
      practiceId: env.start.id,
      questionId: env.first.questionId,
      includeImages: false,
    };
    try {
      const listed = await callToolJson(client, "list_my_practices", {});
      expect(listed.isError).toBe(false);
      expect(studentMcpPracticeListDataSchema.parse(listed.data)).toMatchObject(
        {
          total: 1,
          practices: [
            {
              practiceId: env.start.id,
              phase: "finished",
              answerProgress: null,
              submissionProgress: { submittedCount: 2, totalCount: 2 },
            },
          ],
        },
      );
      for (const released of [true, false]) {
        await env.release(released);
        const result = await callToolJson(
          client,
          "get_practice_question",
          question,
        );
        expect(result.isError).toBe(false);
        expect
          .soft(studentMcpPracticeQuestionDataSchema.parse(result.data))
          .toMatchObject({
            practiceId: env.start.id,
            phase: "finished",
            currentAnswer: { kind: "choice", index: 1 },
            submission: { available: false },
            settlement: { available: false },
          });
        assertNoLeak(result.data, {
          forbid: [
            "scoringKey",
            "keyRef",
            "acceptedChoice",
            "evaluation",
            "finalCorrect",
          ],
        });
        expect(JSON.stringify(result.data)).not.toContain("合成详解");
      }
      const otherList = await callToolJson(other, "list_my_practices", {});
      expect(otherList.data).toEqual({
        schemaVersion: 1,
        total: 0,
        practices: [],
      });
      const denied = await callToolJson(
        other,
        "get_practice_question",
        question,
      );
      expect(denied).toMatchObject({
        isError: true,
        data: { error: "FORBIDDEN" },
      });
      expect(denied.data).not.toHaveProperty("currentAnswer");
      await env.revoke();
      await expect(env.connect()).rejects.toMatchObject({ code: 401 });
    } finally {
      await other.close();
      await client.close();
    }
  },
);
