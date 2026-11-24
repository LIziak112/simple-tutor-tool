import { DatabaseSync } from "node:sqlite";
import {
  apiErrSchema,
  apiOkSchema,
  attemptStartOkSchema,
  importCommitOkSchema,
  importLintErrorBodySchema,
  importPreviewOkSchema,
  libraryFolderSchema,
} from "@tutor/contract";
import { stemMdLeaksAnswers } from "@tutor/md-dsl";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { createChoiceOpenReadFixture } from "../test/m04-p1/open-read-fixture.ts";
import {
  assignFixture,
  postAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { nodePeerBindings } from "../test/node-peer.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";

const fallbackText = "降级后仍能读到的正文。";
const solution = "合成私有详解：3 加 4 得 7。";
const previewWarning = ["warning:UNKNOWN_DIRECTIVE"];
const dependencyErrors = [
  "error:DIRECTIVE_REF_NOT_FOUND",
  "error:VALIDATOR_REF_NOT_FOUND",
];
const plain = `---
kind: practice
unit: M02P04 合成练习
---

::::question{id=m02-p04-q1 type=choice difficulty=1}
3 + 4 等于多少？

:::future-box
${fallbackText}
:::

- [ ] 6
- [x] 7
- [ ] 8

:::solution
${solution}
:::
::::
`;
const invalid = plain
  .replace(
    "kind: practice",
    'kind: practice\nteachingPack: {name: "合成教学包", directives: [future-box], validators: [future-judge]}',
  )
  .replace(fallbackText, "坏包试图覆盖的正文。");
const filename = "M02P04.md";

let trial: ReturnType<typeof createChoiceOpenReadFixture>;
let inspection: DatabaseSync;
let teacher: string;
let otherTeacher: string;
let studentId: string;
let owner: string;
let folderId: string;

function post(path: string, body: unknown, cookie?: string) {
  return trial.app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    },
    nodePeerBindings("10.0.0.2"),
  );
}

beforeAll(async () => {
  trial = createChoiceOpenReadFixture();
  inspection = new DatabaseSync(trial.databasePath, { readOnly: true });
  const setup = await post("/api/public/teacher/setup", {
    loginName: "teacher",
    password: "teacher-pass-8",
  });
  expect(setup.status).toBe(200);
  teacher = `tutor_session=${extractSessionToken(setup)}`;
  const foreign = await post("/api/public/teacher/register", {
    loginName: "合成他师",
    password: "other-teacher-8",
  });
  expect(foreign.status).toBe(200);
  otherTeacher = `tutor_session=${extractSessionToken(foreign)}`;
  studentId = await createStudent(trial.app, teacher, "合成甲");
  owner = await loginStudent(trial.app, "合成甲");
  const folder = await post(
    "/api/teacher/library/folders",
    { name: "P04 目标目录" },
    teacher,
  );
  expect(folder.status).toBe(201);
  folderId = libraryFolderSchema.parse(
    apiOkSchema.parse(await folder.json()).data,
  ).id;
});

afterAll(() => {
  inspection?.close();
  trial?.close();
});

function snapshot() {
  return {
    content: [
      "lectures",
      "units",
      "questions",
      "library_folders",
      "course_items",
      "imports",
      "assignments",
      "attempts",
      "responses",
    ].map((table) =>
      trial.db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
    learning: [
      "practices",
      "scoring_keys",
      "activities",
      "step_attempts",
      "submissions",
      "completions",
    ].map((table) =>
      inspection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  };
}

function diagnostics(issues: readonly { level: string; code: string }[]) {
  return issues.map(({ level, code }) => `${level}:${code}`).sort();
}

async function assertBadImport(response: Response) {
  expect(response.status).toBe(422);
  const parsed = importLintErrorBodySchema.parse(await response.json());
  expect(diagnostics(parsed._issues)).toEqual(dependencyErrors);
}

const publicQuestionsSchema = z.object({
  activityId: z.string(),
  inputs: z.object({
    questions: z.object({
      questions: z.array(
        z.object({
          id: z.string(),
          prompt: z.string(),
          options: z.record(z.string(), z.string()),
        }),
      ),
    }),
  }),
});

it("正文未知指令可降级进入冻结题，缺少显式依赖的导入不改学习事实", async () => {
  const { app } = trial;
  const before = snapshot();
  expect(before.learning).toEqual([[], [], [], [], [], []]);
  const invalidPreview = await post(
    "/api/teacher/import/preview",
    { filename, folderId, markdown: invalid },
    teacher,
  );
  expect(invalidPreview.status).toBe(200);
  const missing = importPreviewOkSchema.parse(await invalidPreview.json()).data;
  expect(diagnostics(missing.issues)).toEqual([
    ...dependencyErrors,
    ...previewWarning,
  ]);
  await assertBadImport(
    await post(
      "/api/teacher/import/commit",
      { filename, folderName: "不得创建的目录", markdown: invalid },
      teacher,
    ),
  );
  expect(snapshot()).toEqual(before);

  const input = { filename, folderId, markdown: plain };
  const preview = await post("/api/teacher/import/preview", input, teacher);
  expect(preview.status).toBe(200);
  const allowed = importPreviewOkSchema.parse(await preview.json()).data;
  expect(diagnostics(allowed.issues)).toEqual(previewWarning);
  expect(allowed.summary.questionCount).toBe(1);
  expect(snapshot()).toEqual(before);

  const commit = await post("/api/teacher/import/commit", input, teacher);
  expect(commit.status).toBe(200);
  const { units, questions } = importCommitOkSchema.parse(
    await commit.json(),
  ).data;
  expect(questions).toEqual({ inserted: 1, updated: 0 });
  expect(units).toHaveLength(1);
  const [unit] = units;
  expect(snapshot().learning).toEqual(before.learning);
  if (!unit) throw new Error("导入未返回练习单元");

  const assignmentId = await assignFixture(app, teacher, unit.id, studentId);
  const opened = await postAssignment(app, assignmentId, owner);
  expect(opened.status).toBe(200);
  const { id } = attemptStartOkSchema.parse(await opened.json()).data;
  const read = async () => {
    const response = await app.request(`/api/student/attempts/${id}`, {
      headers: { cookie: owner },
    });
    expect(response.status).toBe(200);
    return apiOkSchema.parse(await response.json()).data;
  };
  const publicView = await read();
  const { activityId, inputs } = publicQuestionsSchema.parse(publicView);
  expect(activityId).toBe(id);
  expect(inputs.questions.questions).toEqual([
    {
      id: "m02-p04-q1",
      prompt: expect.stringContaining(`:::future-box\n${fallbackText}\n:::`),
      options: { "0": "6", "1": "7", "2": "8" },
    },
  ]);
  const [question] = inputs.questions.questions;
  expect(question && stemMdLeaksAnswers(question.prompt)).toBe(false);
  expect(JSON.stringify(publicView)).not.toContain(solution);
  assertNoLeak(publicView, {
    allow: ["answers"],
    forbid: ["scoringKey", "acceptedChoices", "correct"],
  });
  const frozen = snapshot();
  expect(frozen.learning.map((rows) => rows.length)).toEqual([
    1, 1, 1, 1, 0, 0,
  ]);

  for (const action of ["preview", "commit"]) {
    const denied = await post(
      `/api/teacher/import/${action}`,
      input,
      otherTeacher,
    );
    expect(denied.status).toBe(404);
    expect(apiErrSchema.parse(await denied.json()).error).toBe(
      "FOLDER_NOT_FOUND",
    );
  }
  expect(snapshot()).toEqual(frozen);
  await assertBadImport(
    await post(
      "/api/teacher/import/commit",
      { ...input, markdown: invalid },
      teacher,
    ),
  );
  expect(await read()).toEqual(publicView);
  expect(snapshot()).toEqual(frozen);
});
