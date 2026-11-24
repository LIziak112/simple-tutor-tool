import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  apiErrSchema,
  apiOkSchema,
  attemptStartOkSchema,
  importCommitDataSchema,
  questionDetailSchema,
  questionUpdateDataSchema,
  sharedPreviewDataSchema,
  sharedPublishDataSchema,
} from "@tutor/contract";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { sharedDirOf } from "../services/shared-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import frozen from "../test/m04-p1/fixtures/P0-冻结单选.json" with {
  type: "json",
};
import { createChoiceOpenReadFixture } from "../test/m04-p1/open-read-fixture.ts";
import {
  assignFixture,
  attemptFacts,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { nodePeerBindings } from "../test/node-peer.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";

let trial: ReturnType<typeof createChoiceOpenReadFixture>;
let source: Awaited<ReturnType<typeof setupAssignment>>;
let publisher: string;
let reader: string;
let studentId: string;
let studentCookie: string;

function request(
  path: string,
  cookie?: string,
  method = "GET",
  body?: unknown,
) {
  return trial.app.request(
    path,
    {
      method,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    nodePeerBindings("10.0.0.2"),
  );
}

async function ok(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return apiOkSchema.parse(await response.json()).data;
}

async function denied(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  expect(apiErrSchema.parse(body).error).toBe(code);
  expect(body).not.toHaveProperty("data");
  assertNoLeak(body);
}

beforeAll(async () => {
  trial = createChoiceOpenReadFixture();
  source = await setupAssignment(trial.app);
  publisher = source.teacher;
  const registered = await request(
    "/api/public/teacher/register",
    undefined,
    "POST",
    {
      loginName: "乙老师",
      password: "other-teacher-8",
    },
  );
  expect(registered.status).toBe(200);
  reader = `tutor_session=${extractSessionToken(registered)}`;
  studentId = await createStudent(trial.app, reader, "乙域学生");
  studentCookie = await loginStudent(trial.app, "乙域学生");
});

afterAll(() => trial?.close());

it("源题改版后乙的共享导入副本仍按原发布题面、版本和私有答键开卷", async () => {
  const [first] = frozen.questions;
  assert.ok(first);
  const questionUrl = (id: string) => `/api/teacher/questions/${id}`;
  const detail = async (id: string, cookie: string) =>
    questionDetailSchema.parse(
      await ok(await request(questionUrl(id), cookie)),
    );
  const preview = async (filename: string) =>
    sharedPreviewDataSchema.parse(
      await ok(
        await request("/api/teacher/shared/preview", reader, "POST", {
          filename,
        }),
      ),
    );

  const sourceAtPublish = await detail(first.id, publisher);
  expect(sourceAtPublish.version).toBe(first.version);
  await denied(
    await request(questionUrl(first.id), reader),
    404,
    "QUESTION_NOT_FOUND",
  );
  const { filename } = sharedPublishDataSchema.parse(
    await ok(
      await request(
        `/api/teacher/library/units/${encodeURIComponent(source.unitId)}/publish`,
        publisher,
        "POST",
      ),
      201,
    ),
  );
  const sharedPath = join(sharedDirOf(trial.dataDir), filename);
  const atPublish = readFileSync(sharedPath, "utf8");
  const before = await preview(filename);
  expect(before.markdown).toBe(atPublish);
  expect(before.actions.map(({ kind }) => kind)).toEqual(["createUnit"]);
  expect(before.summary.questionCount).toBe(2);
  const imported = importCommitDataSchema.parse(
    await ok(
      await request("/api/teacher/shared/import", reader, "POST", { filename }),
    ),
  );
  expect(imported.questions).toEqual({ inserted: 2, updated: 0 });
  expect(imported.units.map(({ id, inserted }) => ({ id, inserted }))).toEqual([
    { id: source.unitId, inserted: true },
  ]);
  const copied = await Promise.all(
    frozen.questions.map(({ id }) => detail(id, reader)),
  );
  for (const [index, item] of copied.entries()) {
    const original = frozen.questions[index];
    assert.ok(original);
    expect(item.version).toBe(original.version);
    expect(item.sourceMd).toContain(original.stemMd);
    expect(item.sourceMd).toContain(
      `- [x] ${original.options[original.answers.index]}`,
    );
  }

  const revisedStem = "2 + 4 等于多少？";
  const revisedSolution = "改版详解：2 加 4 得 6。";
  const sourceMd = sourceAtPublish.sourceMd
    .replace(first.stemMd, revisedStem)
    .replace("- [x] 5", "- [ ] 5")
    .replace("- [ ] 6", "- [x] 6")
    .replace(first.solutionMd, revisedSolution);
  const revised = questionUpdateDataSchema.parse(
    await ok(
      await request(questionUrl(first.id), publisher, "PUT", { sourceMd }),
    ),
  );
  expect(revised.version).toBe(first.version + 1);
  const currentSource = await detail(first.id, publisher);
  expect(currentSource.sourceMd).toContain(revisedStem);
  expect(currentSource.sourceMd).toContain("- [x] 6");
  expect(readFileSync(sharedPath, "utf8")).toBe(atPublish);
  expect((await preview(filename)).markdown).toBe(atPublish);
  expect(
    await Promise.all(frozen.questions.map(({ id }) => detail(id, reader))),
  ).toEqual(copied);

  const assignmentId = await assignFixture(
    trial.app,
    reader,
    source.unitId,
    studentId,
  );
  await denied(
    await request(`/api/teacher/assignments/${assignmentId}`, publisher),
    404,
    "ASSIGNMENT_NOT_FOUND",
  );
  const opened = await postAssignment(trial.app, assignmentId, studentCookie);
  expect(opened.status).toBe(200);
  const { id } = attemptStartOkSchema.parse(await opened.json()).data;
  const detailUrl = `/api/student/attempts/${id}`;
  const publicView = await ok(await request(detailUrl, studentCookie));
  expect(publicView).toMatchObject({
    activityId: id,
    status: "active",
    inputs: {
      questions: {
        questions: frozen.questions.map(({ id, version, stemMd, options }) => ({
          id,
          version,
          prompt: stemMd,
          options: Object.fromEntries(
            options.map((option, index) => [String(index), option]),
          ),
        })),
      },
    },
  });
  const serialized = JSON.stringify(publicView);
  expect(serialized).not.toContain(revisedStem);
  expect(serialized).not.toContain(revisedSolution);
  expect(serialized).not.toContain("[x]");
  for (const question of frozen.questions)
    expect(serialized).not.toContain(question.solutionMd);
  assertNoLeak(publicView, {
    allow: ["answers"],
    forbid: [
      "scoringKey",
      "acceptedChoice",
      "acceptedChoices",
      "keyRef",
      "correct",
    ],
  });
  await denied(await request(detailUrl, source.ownerCookie), 403, "FORBIDDEN");
  expect(attemptFacts(trial.db)).toMatchObject({
    attempts: 0,
    responses: 0,
    scores: 0,
  });

  // 答键仅在测试的服务端 SQLite 连接上核对，学生响应不携带。
  using inspection = new DatabaseSync(trial.databasePath, { readOnly: true });
  const { definition } = z
    .object({ definition: z.string() })
    .parse(
      inspection
        .prepare("SELECT definition FROM scoring_keys WHERE id=? AND version=?")
        .get(`${assignmentId}-key`, 1),
    );
  expect(JSON.parse(definition)).toMatchObject({
    acceptedChoices: Object.fromEntries(
      frozen.questions.map(({ id, answers }) => [id, String(answers.index)]),
    ),
  });
});
