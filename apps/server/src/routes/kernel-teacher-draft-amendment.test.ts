import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  makeMigrationsFolderUpTo,
} from "../db/test-utils.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { extractSessionToken } from "../test/note-world.ts";
import {
  fetchSubmitRevisions,
  submitAttemptRequest,
} from "../test/submit-revisions.ts";

const questionId = "m04-p0-q1";
const corrected = { kind: "choice", index: 1 };
const previous = { kind: "choice", index: 0 };
const reason = "合成草稿答案勘误";
const resources: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

async function requireStatus(response: Response, status: number) {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as unknown;
}

async function world(backend: "legacy" | "kernel") {
  const dataDir = createTestDir();
  resources.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "tutor.db");
  const seed = createTestDb();
  try {
    writeFileSync(path, seed.$client.serialize());
  } finally {
    seed.$client.close();
  }
  let db = createDb(path);
  resources.push(() => db.$client.close());
  const create = () =>
    createApp({
      db,
      dataDir,
      kernelAssignmentCreationEnabled: true,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  let app = create();
  const fixture = await setupAssignment(app);
  const assignment =
    backend === "legacy"
      ? fixture.assignmentId
      : await assignKernelFixture(app, fixture);
  const attempt = attemptStartOkSchema.parse(
    await requireStatus(
      await postAssignment(app, assignment, fixture.ownerCookie),
      200,
    ),
  ).data;
  const studentPath = `/api/student/attempts/${attempt.id}`;
  const call = (path: string, cookie: string, method = "GET", body?: object) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const teacherId = db.$client
    .prepare<[string], { teacherId: string }>(
      "SELECT teacher_id AS teacherId FROM students WHERE id = ?",
    )
    .get(fixture.studentId)?.teacherId;
  expect(teacherId).toEqual(expect.any(String));

  async function connect(cookie = fixture.teacher) {
    const token = (await requireStatus(
      await call("/api/teacher/api-token", cookie, "POST"),
      200,
    )) as { data: { token: string } };
    const client = await connectMcpClientViaApp(
      app,
      "/mcp",
      token.data.token,
      "m05-teacher-draft-amendment",
    );
    resources.push(() => client.close());
    return {
      edit: (expectedAnswerRevision: number, answer = corrected) =>
        callToolJson(client, "update_response_answer", {
          attemptId: attempt.id,
          questionId,
          expectedAnswerRevision,
          reason,
          answer,
        }),
      async row() {
        const rows = await callToolJson(client, "query_student_responses", {
          studentId: fixture.studentId,
          attemptIds: [attempt.id],
          includeUnsubmitted: true,
        });
        expect(rows.isError).toBe(false);
        return (rows.data.responses as Array<{ questionId: string }>).find(
          (row) => row.questionId === questionId,
        );
      },
    };
  }
  return {
    id: attempt.id,
    dataDir,
    teacherId,
    connect,
    get db() {
      return db;
    },
    restart() {
      db.$client.close();
      db = createDb(path);
      app = create();
    },
    async foreignTeacher() {
      const registered = await call(
        "/api/public/teacher/register",
        "",
        "POST",
        { loginName: "合成其他老师", password: "test-pass-8" },
      );
      expect(registered.status, await registered.clone().text()).toBe(200);
      return connect(`tutor_session=${extractSessionToken(registered)}`);
    },
    async student() {
      return attemptDraftOkSchema.parse(
        await requireStatus(await call(studentPath, fixture.ownerCookie), 200),
      ).data;
    },
    async teacherDetail() {
      const body = await requireStatus(
        await call(`/api/teacher/attempts/${attempt.id}`, fixture.teacher),
        200,
      );
      return teacherAttemptDetailOkSchema
        .parse(body)
        .data.questions.find((row) => row.questionId === questionId);
    },
    async detailResult() {
      return attemptResultOkSchema.parse(
        await requireStatus(await call(studentPath, fixture.ownerCookie), 200),
      ).data;
    },
    async save(answer: object, baseRevision: number, status = 200) {
      const row = (
        await fetchSubmitRevisions(app, fixture.ownerCookie, attempt.id)
      ).find((item) => item.questionId === questionId);
      if (!row) throw new Error("缺冻结题");
      return requireStatus(
        await call(
          `${studentPath}/answers/${questionId}`,
          fixture.ownerCookie,
          "PUT",
          {
            answer,
            mutationId: randomUUID(),
            baseRevision,
            expectedFrozenAt: attempt.frozenAt,
            questionRevisionId: row.questionRevisionId,
          },
        ),
        status,
      );
    },
    submit: () => submitAttemptRequest(app, fixture.ownerCookie, attempt.id),
    answers() {
      return db.$client
        .prepare(
          "SELECT answer_json, answer_revision, change_count FROM responses WHERE attempt_id = ? AND question_id = ?",
        )
        .get(attempt.id, questionId);
    },
    audits() {
      return db.$client
        .prepare(`SELECT a.id, a.teacher_id, a.kind, a.previous_json, a.reason, a.answer_revision
        FROM response_edit_audits a JOIN responses r ON r.id = a.response_id
        WHERE r.attempt_id = ? ORDER BY a.answer_revision`)
        .all(attempt.id);
    },
    activity() {
      return db.$client
        .prepare(
          "SELECT status, activated_at, last_activity_at FROM attempts WHERE id = ?",
        )
        .get(attempt.id);
    },
    authority() {
      const runtime = openLearningRuntime({
        databasePath: join(dataDir, "learning-kernel.sqlite"),
      });
      try {
        const student = { role: "student", id: fixture.studentId } as const;
        return {
          activity: runtime.read(student, attempt.id),
          learningTime: runtime.readChoiceDraftActivity(student, attempt.id),
        };
      } finally {
        runtime.close();
      }
    },
  };
}

it.each(["legacy", "kernel"] as const)(
  "%s 教师的实际 SDK 改答在双方正常读取生效，并保留授权、CAS 和学生时间",
  async (backend) => {
    const env = await world(backend);
    const teacher = await env.connect();
    const outside = await env.foreignTeacher();
    expect(await outside.edit(0)).toMatchObject({
      isError: true,
      data: { error: "ATTEMPT_NOT_FOUND" },
    });
    const time = env.activity();
    expect(env.audits()).toEqual([]);
    const edit = await teacher.edit(0);
    expect(edit).toMatchObject({
      isError: false,
      data: { success: true, answerRevision: 1 },
    });
    expect.soft(await env.student()).toMatchObject({
      drafts: { [questionId]: corrected },
      draftRevisions: { [questionId]: 1 },
    });
    expect
      .soft(await env.teacherDetail())
      .toMatchObject({ answer: corrected, changeCount: 0 });
    expect(env.activity()).toEqual(time);
    expect(env.audits()).toMatchObject([
      {
        teacher_id: env.teacherId,
        previous_json: null,
        reason,
        kind: "answer",
        answer_revision: 1,
      },
    ]);
    expect(await teacher.edit(0)).toMatchObject({
      isError: true,
      data: { error: "ANSWER_REVISION_CONFLICT" },
    });
    if (backend === "kernel") {
      expect(env.answers()).toEqual({
        answer_json: null,
        answer_revision: 0,
        change_count: 0,
      });
      expect(env.authority()).toMatchObject({
        learningTime: undefined,
        activity: {
          choiceDrafts: [
            { questionId, choice: "1", revision: 1, changeCount: 0 },
          ],
        },
      });
    }
  },
);

it("已有学生 A 的内核勘误保有旧值与学生次数，旧保存基线拒绝，新版本正常交卷", async () => {
  const env = await world("kernel");
  const teacher = await env.connect();
  await env.save(previous, 0);
  const time = env.activity();
  const learningTime = env.authority().learningTime;
  expect(await teacher.edit(1)).toMatchObject({
    isError: false,
    data: { success: true, answerRevision: 2 },
  });
  expect(await env.student()).toMatchObject({
    drafts: { [questionId]: corrected },
    draftRevisions: { [questionId]: 2 },
  });
  expect(await teacher.row()).toMatchObject({
    answerRevision: 2,
    changeCount: 1,
  });
  expect(await env.teacherDetail()).toMatchObject({
    answer: corrected,
    changeCount: 1,
  });
  expect(env.audits()).toMatchObject([
    {
      previous_json: JSON.stringify(previous),
      reason,
      teacher_id: env.teacherId,
      answer_revision: 2,
    },
  ]);
  expect(env.activity()).toEqual(time);
  expect(env.authority().learningTime).toEqual(learningTime);
  expect(await env.save({ kind: "choice", index: 2 }, 1, 409)).toMatchObject({
    error: "ANSWER_REVISION_CONFLICT",
  });
  const result = attemptResultOkSchema.parse(
    await requireStatus(await env.submit(), 200),
  ).data;
  expect(result.attempt.scoreAuto).toBe(50);
  expect(await teacher.edit(2)).toMatchObject({
    isError: true,
    data: { error: "ATTEMPT_NOT_IN_PROGRESS" },
  });
  expect(env.audits()).toHaveLength(1);
});

it("内核已经确认但宿主还显示草稿时，教师工具拒绝写入及审计", async () => {
  const env = await world("kernel");
  const teacher = await env.connect();
  await env.save(corrected, 0);
  env.db.$client.exec(
    "CREATE TRIGGER fail_amend_graded_projection BEFORE UPDATE OF status ON attempts WHEN NEW.status = 'graded' BEGIN SELECT RAISE(ABORT, 'interrupt grading projection'); END",
  );
  try {
    expect((await env.submit()).status).toBe(500);
  } finally {
    env.db.$client.exec("DROP TRIGGER fail_amend_graded_projection");
  }
  expect(env.activity()).toMatchObject({ status: "draft" });
  expect(env.authority().activity.status).toBe("completed");
  expect.soft(await teacher.edit(0)).toMatchObject({
    isError: true,
    data: { error: "ATTEMPT_NOT_IN_PROGRESS" },
  });
  expect.soft(env.audits()).toEqual([]);
  expect((await env.detailResult()).attempt.scoreAuto).toBe(50);
  expect(env.activity()).toMatchObject({ status: "graded" });
});

it("内核勘误到宿主审计之间失败，重开后的真实本人读取只补一条审计", async () => {
  const env = await world("kernel");
  const teacher = await env.connect();
  await env.save(previous, 0);
  env.db.$client.exec(
    "CREATE TRIGGER fail_amend_audit BEFORE INSERT ON response_edit_audits BEGIN SELECT RAISE(ABORT, 'interrupt amendment audit'); END",
  );
  try {
    expect((await teacher.edit(1)).isError).toBe(true);
  } finally {
    env.db.$client.exec("DROP TRIGGER fail_amend_audit");
  }
  expect(env.audits()).toEqual([]);
  expect(env.authority().activity).toMatchObject({
    choiceDrafts: [{ questionId, choice: "1", revision: 2, changeCount: 1 }],
  });
  env.restart();
  expect(await env.student()).toMatchObject({
    drafts: { [questionId]: corrected },
    draftRevisions: { [questionId]: 2 },
  });
  const recovered = env.audits();
  expect(recovered).toMatchObject([
    {
      previous_json: JSON.stringify(previous),
      reason,
      teacher_id: env.teacherId,
      answer_revision: 2,
    },
  ]);
  const newTeacher = await env.connect();
  expect(await newTeacher.row()).toMatchObject({
    answerRevision: 2,
    changeCount: 1,
  });
  expect(await newTeacher.edit(1)).toMatchObject({
    isError: true,
    data: { error: "ANSWER_REVISION_CONFLICT" },
  });
  expect(env.audits()).toEqual(recovered);
});

it("内核目录不可用时教师工具拒绝，宿主不写替代答案或审计", async () => {
  const env = await world("kernel");
  const teacher = await env.connect();
  const old = env.answers();
  const file = join(env.dataDir, "learning-kernel.sqlite");
  renameSync(file, `${file}.unavailable`);
  try {
    expect(await teacher.edit(0)).toMatchObject({
      isError: true,
      data: { error: "KERNEL_ATTEMPT_UNAVAILABLE" },
    });
    expect(env.answers()).toEqual(old);
    expect(env.audits()).toEqual([]);
    expect(
      env.db.$client
        .prepare("SELECT COUNT(*) AS n FROM kernel_choice_amendments")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    renameSync(`${file}.unavailable`, file);
  }
});

it("0082 的数据库平滑加勘误意图表，外键拒绝无绑定卷与冻结行", () => {
  const db = createDb(":memory:");
  const migrations = makeMigrationsFolderUpTo("0082_kernel_attempt_refreezes");
  try {
    migrate(db, { migrationsFolder: migrations });
    db.insert(teachers)
      .values({
        id: "old-teacher",
        loginName: "old-teacher",
        isAdmin: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='kernel_choice_amendments'",
        )
        .get(),
    ).toBeUndefined();
    runMigrations(db);
    expect(
      db.$client
        .prepare("SELECT login_name FROM teachers WHERE id='old-teacher'")
        .get(),
    ).toEqual({ login_name: "old-teacher" });
    expect(
      db.$client
        .prepare("PRAGMA foreign_key_list(kernel_choice_amendments)")
        .all(),
    ).toHaveLength(3);
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO kernel_choice_amendments (attempt_id, operation_id, response_id, teacher_id, intent_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run("missing", "operation", "missing", "old-teacher", "{}"),
    ).toThrow(/FOREIGN KEY/);
  } finally {
    db.$client.close();
    rmSync(migrations, { recursive: true, force: true });
  }
});
