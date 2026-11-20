import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  questionSchema,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
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
import { putNoteReceipt } from "../test/note-fixtures.ts";
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
      snapshot: (snapshot: object, expectedAnswerRevision: number) =>
        callToolJson(client, "update_response_snapshot", {
          attemptId: attempt.id,
          questionId,
          expectedAnswerRevision,
          reason: "合成草稿题面勘误",
          snapshot,
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
    async otherStudent() {
      const started = attemptStartOkSchema.parse(
        await requireStatus(
          await postAssignment(app, assignment, fixture.otherCookie),
          200,
        ),
      ).data;
      return attemptDraftOkSchema.parse(
        await requireStatus(
          await call(
            `/api/student/attempts/${started.id}`,
            fixture.otherCookie,
          ),
          200,
        ),
      ).data;
    },
    note: () =>
      putNoteReceipt(app, fixture.ownerCookie, attempt.id, questionId),
    etag: (tag?: string) =>
      app.request(studentPath, {
        headers: {
          cookie: fixture.ownerCookie,
          ...(tag ? { "if-none-match": tag } : {}),
        },
      }),
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
    revisions: () => fetchSubmitRevisions(app, fixture.ownerCookie, attempt.id),
    submitRaw: (revisions: Awaited<ReturnType<typeof fetchSubmitRevisions>>) =>
      call(`${studentPath}/submit`, fixture.ownerCookie, "POST", { revisions }),
    frozenQuestion() {
      const row = db.$client
        .prepare<[string, string], { snapshot: string }>(
          "SELECT question_snapshot_json AS snapshot FROM responses WHERE attempt_id = ? AND question_id = ?",
        )
        .get(attempt.id, questionId);
      if (!row) throw new Error("缺冻结题");
      return questionSchema.parse(JSON.parse(row.snapshot));
    },
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

it("教师勘误空题原地更新权威题面和修订，拒绝旧保存并以新键正式判分", async () => {
  const env = await world("kernel");
  const teacher = await env.connect();
  const original = env.frozenQuestion();
  const before = env.authority();
  const otherBefore = await env.otherStudent();
  const cache = (await env.etag()).headers.get("etag");
  expect(cache).toEqual(expect.any(String));
  const stemMd = "教师勘误后的题面";
  const options = original.options?.map((option, index) =>
    index === 0 ? { ...option, text: "勘误后的选项" } : option,
  );
  const amended = await teacher.snapshot(
    { ...original, stemMd, options, answers: previous },
    0,
  );
  expect(amended).toMatchObject({
    isError: false,
    data: { success: true, answerRevision: 1 },
  });
  const publicBody = await requireStatus(
    await env.etag(cache ?? undefined),
    200,
  );
  assertNoLeak(publicBody, { forbid: ["acceptedChoice"] });
  const draft = attemptDraftOkSchema.parse(publicBody).data;
  const question = draft.units
    .flatMap(({ questions }) => questions)
    .find(({ id }) => id === questionId);
  expect(question).toMatchObject({
    stemMd,
    options: [
      "勘误后的选项",
      ...(options?.slice(1).map(({ text }) => text) ?? []),
    ],
  });
  expect.soft(draft.draftRevisions?.[questionId]).toBe(1);
  expect(draft.drafts[questionId]).toBeUndefined();
  expect(await env.otherStudent()).toEqual(otherBefore);
  expect(await env.teacherDetail()).toMatchObject({ changeCount: 0 });
  const after = env.authority();
  expect.soft(after).toMatchObject({
    learningTime: before.learningTime,
    activity: {
      activityId: before.activity.activityId,
      choiceSnapshotRevisions: [{ questionId, revision: 1 }],
    },
  });
  expect(await env.save(previous, 0, 409)).toMatchObject({
    error: "ANSWER_REVISION_CONFLICT",
  });
  await env.save(previous, 1);
  const result = attemptResultOkSchema.parse(
    await requireStatus(await env.submit(), 200),
  ).data;
  expect(result.attempt.scoreAuto).toBe(50);
  expect(
    result.units
      .flatMap(({ questions }) => questions)
      .find((item) => item.questionId === questionId),
  ).toMatchObject({
    answer: previous,
    autoCorrect: true,
  });
  expect(env.audits()).toMatchObject([
    { kind: "snapshot", answer_revision: 1 },
  ]);
  expect(
    await teacher.snapshot({ ...original, stemMd: "交卷后更新" }, 2),
  ).toMatchObject({
    isError: true,
    data: { error: "ATTEMPT_NOT_IN_PROGRESS" },
  });
});

it("交卷先恢复已接受的题面票据并拒绝旧修订，重交当前修订正常", async () => {
  const env = await world("kernel");
  const teacher = await env.connect();
  const earlier = await env.revisions();
  const stemMd = "交卷时恢复的题面";
  env.db.$client.exec(`
    CREATE TEMP TRIGGER interrupt_snapshot_before_submit
    BEFORE INSERT ON response_edit_audits
    BEGIN SELECT RAISE(ABORT, 'interrupted snapshot audit'); END
  `);
  try {
    expect(
      (await teacher.snapshot({ ...env.frozenQuestion(), stemMd }, 0)).isError,
    ).toBe(true);
  } finally {
    env.db.$client.exec("DROP TRIGGER interrupt_snapshot_before_submit");
  }
  expect(env.audits()).toEqual([]);
  expect(await requireStatus(await env.submitRaw(earlier), 409)).toMatchObject({
    error: "ANSWER_REVISION_CONFLICT",
    _current: { revision: 1, draft: null },
  });
  expect(env.audits()).toMatchObject([
    { kind: "snapshot", answer_revision: 1 },
  ]);
  expect(env.frozenQuestion()).toMatchObject({ stemMd });
  const revisions = earlier.map((row) =>
    row.questionId === questionId ? { ...row, expectedAnswerRevision: 1 } : row,
  );
  const result = attemptResultOkSchema.parse(
    await requireStatus(await env.submitRaw(revisions), 200),
  ).data;
  expect(result.attempt.scoreAuto).toBe(0);
});

it("教师题面勘误先校验归属与修订，再保护本题原稿和已保存答案", async () => {
  const withOriginal = await world("kernel");
  const reviewer = await withOriginal.connect();
  const foreign = await withOriginal.foreignTeacher();
  const original = withOriginal.frozenQuestion();
  const replacement = { ...original, stemMd: "不应覆盖原题面" };
  expect(await foreign.snapshot(replacement, 0)).toMatchObject({
    isError: true,
    data: { error: "ATTEMPT_NOT_FOUND" },
  });
  await withOriginal.note();
  expect(await reviewer.snapshot(replacement, 0)).toMatchObject({
    isError: true,
    data: { error: "RESPONSE_EVIDENCE_EXISTS" },
  });
  expect(withOriginal.frozenQuestion()).toEqual(original);
  expect(withOriginal.audits()).toEqual([]);

  const answered = await world("kernel");
  const teacher = await answered.connect();
  await answered.save(previous, 0);
  expect(await teacher.snapshot(replacement, 0)).toMatchObject({
    isError: true,
    data: { error: "ANSWER_REVISION_CONFLICT" },
  });
  expect(await teacher.snapshot(replacement, 1)).toMatchObject({
    isError: true,
    data: { error: "RESPONSE_EVIDENCE_EXISTS" },
  });
  expect((await answered.student()).drafts[questionId]).toEqual(previous);
  expect(answered.audits()).toEqual([]);
});

it.each([false, true])(
  "暂存教师撤权后学生可继续，内核已接受=%s",
  async (committed) => {
    const env = await world("kernel");
    const teacher = await env.connect();
    const original = env.frozenQuestion();
    const originalView = (await env.student()).units
      .flatMap(({ questions }) => questions)
      .find(({ id }) => id === questionId);
    expect(originalView).toBeDefined();
    const stemMd = "撤权中断之前暂存的新题面";
    if (committed) {
      env.db.$client.exec(`
      CREATE TEMP TRIGGER interrupt_revoked_snapshot_audit
      BEFORE INSERT ON response_edit_audits
      BEGIN SELECT RAISE(ABORT, 'interrupted snapshot audit'); END
    `);
      try {
        expect(
          (await teacher.snapshot({ ...original, stemMd }, 0)).isError,
        ).toBe(true);
      } finally {
        env.db.$client.exec("DROP TRIGGER interrupt_revoked_snapshot_audit");
      }
    } else {
      const kernel = new Database(join(env.dataDir, "learning-kernel.sqlite"));
      try {
        kernel.exec(`
        CREATE TRIGGER interrupt_revoked_snapshot_write
        BEFORE INSERT ON choice_snapshot_revisions
        BEGIN SELECT RAISE(ABORT, 'interrupted snapshot write'); END
      `);
        expect(
          (await teacher.snapshot({ ...original, stemMd }, 0)).isError,
        ).toBe(true);
        kernel.exec("DROP TRIGGER interrupt_revoked_snapshot_write");
      } finally {
        kernel.close();
      }
    }
    const pending = () =>
      env.db.$client
        .prepare<[string], { operation_id: string }>(
          "SELECT operation_id FROM kernel_choice_amendments WHERE attempt_id = ?",
        )
        .get(env.id);
    const ticket = pending();
    expect(ticket).toEqual({ operation_id: expect.any(String) });
    expect(env.audits()).toEqual([]);
    expect(env.frozenQuestion()).toEqual(original);
    if (!env.teacherId) throw new Error("缺教师身份");
    env.db
      .update(teachers)
      .set({ disabledAt: new Date().toISOString() })
      .where(eq(teachers.id, env.teacherId))
      .run();

    const recovered = await env.student();
    expect(recovered.draftRevisions?.[questionId]).toBe(committed ? 1 : 0);
    expect(
      recovered.units
        .flatMap(({ questions }) => questions)
        .find(({ id }) => id === questionId)?.stemMd,
    ).toBe(committed ? stemMd : originalView?.stemMd);
    expect(pending()).toBeUndefined();
    expect(env.audits()).toMatchObject(
      committed
        ? [{ id: ticket?.operation_id, kind: "snapshot", answer_revision: 1 }]
        : [],
    );
    const authority = env.authority().activity;
    expect(
      "choiceSnapshotRevisions" in authority
        ? (authority.choiceSnapshotRevisions?.length ?? 0)
        : 0,
    ).toBe(committed ? 1 : 0);
    await env.save(corrected, committed ? 1 : 0);
    expect((await env.student()).drafts[questionId]).toEqual(corrected);
  },
);

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
