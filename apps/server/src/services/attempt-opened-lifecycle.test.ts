import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  attemptContextSnapshots,
  attempts,
  courseItems,
  courseStudents,
  courses,
  materials,
  questions,
  responses,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  expectHttpError,
  insertAiConnectionFixture,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  gzipJson,
  makeNotePng,
  makeStudent,
  noteDoc,
} from "../test/note-fixtures.ts";
import { createAiBatchReviewTasks } from "./ai-companion/student-ai-batch.ts";
import { createAiTask } from "./ai-companion/student-ai-queue.ts";
import {
  assembleAnnotationBase,
  putAnnotationDoc,
  registerBaseImage,
} from "./annotation-service.ts";
import {
  createAssignment,
  getAssignmentDetail,
  updateAssignment,
} from "./assignment-service.ts";
import { activateAttempt, getOpenedAttempt } from "./attempt-activation.ts";
import { saveDraftAnswer, setStudentFlag } from "./attempt-answer.ts";
import { purgeOpenedAttempts } from "./attempt-opened-purge.ts";
import { refreshOpenedAttempt } from "./attempt-opened-refresh.ts";
import { startAttempt, startCourseAttempt } from "./attempt-start.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";
import { commitImport } from "./content-service.ts";
import { openHint } from "./hint-service.ts";
import { saveInk } from "./ink-service.ts";
import { contextFromMemoAnchor } from "./memo-context.ts";
import { createTextMemo } from "./memo-service.ts";
import { saveNoteVersion } from "./note-service.ts";
import { getStudentUnitLanding } from "./student-course-service.ts";
import { listStudentRecords } from "./student-records.ts";
import { listTeacherAttempts } from "./teacher-attempt-service.ts";

const opened: Db[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) db.$client.close();
});
const now = "2026-11-14T10:00:00.000Z";
const markdown = `---
kind: practice
unit: 激活练习
---
::::material{id="activation-material"}
材料原文
::::
::::question{id="activation-q" type=judge difficulty=1}
::ref{material=activation-material}
判断题。[[正确]]
:::hint
激活提示秘密
:::
:::solution
激活解析秘密
:::
::::
`;
function fixture() {
  const db = createTestDb();
  opened.push(db);
  const studentId = makeStudent(db),
    courseId = randomUUID();
  const imported = commitImport(
    db,
    TEST_TEACHER_ID,
    { markdown, filename: "activation.md" },
    undefined,
    undefined,
    true,
  );
  const unitId = imported.units[0]?.id;
  if (!unitId) throw new Error("测试单元未生成");
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "激活课程",
      order: 0,
      createdAt: now,
    })
    .run();
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: now })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId,
      kind: "unit",
      refId: unitId,
      order: 0,
      visible: true,
      createdAt: now,
    })
    .run();
  const start = (timeLimitMinutes?: number) =>
    startCourseAttempt(
      db,
      studentId,
      courseId,
      unitId,
      timeLimitMinutes === undefined ? {} : { timeLimitMinutes },
    );
  const row = (id: string) =>
    db.select().from(attempts).where(eq(attempts.id, id)).get();
  const refs = (id: string) =>
    db.select().from(responses).where(eq(responses.attemptId, id)).all();
  const query = { sourceType: "course" as const, courseId, unitId };
  return { db, studentId, courseId, unitId, start, row, refs, query };
}

it.each(["answer", "ink", "note", "annotation", "hint", "flag"] as const)(
  "ACT01 %s 重冻后无论是否已激活都要求本稿版本凭据",
  (kind) => {
    for (const active of [false, true]) {
      const env = fixture(),
        dataDir = createTestDir(),
        first = env.start();
      env.db
        .update(questions)
        .set({ version: 2, stemMd: "新版题" })
        .where(eq(questions.id, "activation-q"))
        .run();
      const current = env.start();
      if (kind === "annotation") {
        const base = assembleAnnotationBase(
          env.db,
          env.studentId,
          first.id,
          "activation-q",
          "scratch",
        );
        const row = env.refs(first.id)[0];
        if (!row) throw new Error("测试题缺失");
        registerBaseImage(
          env.db,
          dataDir,
          env.studentId,
          first.id,
          "activation-q",
          makeNotePng(1440, 900),
          {
            questionRevisionId: row.id,
            baseRenderVersion: base.baseRenderVersion,
            phase: "scratch",
          },
        );
      }
      if (active)
        activateAttempt(env.db, env.studentId, first.id, {
          expectedFrozenAt: current.frozenAt ?? null,
        });
      const before = env.row(first.id)?.activatedAt;
      const write = (proof?: string | null) => {
        const meta = {
          baseRevision: 0,
          mutationId: randomUUID(),
          ...(proof === undefined ? {} : { expectedFrozenAt: proof }),
        };
        if (kind === "hint")
          return openHint(
            env.db,
            env.studentId,
            first.id,
            "activation-q",
            0,
            meta,
          );
        if (kind === "flag")
          return setStudentFlag(
            env.db,
            env.studentId,
            first.id,
            "activation-q",
            "unsure",
            meta,
          );
        if (kind === "answer")
          return saveDraftAnswer(
            env.db,
            env.studentId,
            first.id,
            "activation-q",
            { kind: "judge", value: true },
            meta,
          );
        if (kind === "ink")
          return saveInk(
            env.db,
            dataDir,
            env.studentId,
            first.id,
            "activation-q",
            gzipJson({
              engine: "atrament",
              version: 1,
              data: noteDoc().ink,
              updatedAt: 1,
            }),
            makeNotePng(),
            meta,
          );
        if (kind === "note")
          return saveNoteVersion(
            env.db,
            dataDir,
            env.studentId,
            first.id,
            "activation-q",
            gzipJson(noteDoc()),
            meta,
          );
        return putAnnotationDoc(
          env.db,
          dataDir,
          env.studentId,
          first.id,
          "activation-q",
          gzipJson({
            version: 1,
            baseWidth: 1440,
            baseHeight: 900,
            strokes: noteDoc().ink.strokes,
          }),
          meta,
        );
      };
      expectHttpError(() => write(), 409, "ATTEMPT_SNAPSHOT_CHANGED");
      expectHttpError(
        () => write(first.frozenAt ?? null),
        409,
        "ATTEMPT_SNAPSHOT_CHANGED",
      );
      expect(env.row(first.id)?.activatedAt).toBe(before);
      expect(() => write(current.frozenAt ?? null)).not.toThrow();
      expect(env.row(first.id)?.activatedAt).toBeTruthy();
    }
  },
);

it.each(["ink", "note", "annotation"] as const)(
  "ACT01 %s 真实multipart传递并校验本稿expectedFrozenAt",
  async (kind) => {
    const env = fixture(),
      dataDir = createTestDir(),
      first = env.start();
    env.db
      .update(questions)
      .set({ version: 2 })
      .where(eq(questions.id, "activation-q"))
      .run();
    const current = env.start();
    if (kind === "annotation") {
      const base = assembleAnnotationBase(
        env.db,
        env.studentId,
        first.id,
        "activation-q",
        "scratch",
      );
      const row = env.refs(first.id)[0];
      if (!row) throw new Error("题缺失");
      registerBaseImage(
        env.db,
        dataDir,
        env.studentId,
        first.id,
        "activation-q",
        makeNotePng(1440, 900),
        {
          questionRevisionId: row.id,
          baseRenderVersion: base.baseRenderVersion,
          phase: "scratch",
        },
      );
    }
    const app = createApp({
      db: env.db,
      dataDir,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
      isProduction: false,
    });
    const cookie = `tutor_student_session=${createStudentSession(env.db, env.studentId).token}`;
    const send = (token?: string) => {
      const body = new FormData(),
        meta = {
          baseRevision: 0,
          mutationId: randomUUID(),
          ...(token === undefined ? {} : { expectedFrozenAt: token }),
        };
      if (kind === "ink") {
        body.set(
          "strokes",
          new File(
            [
              new Uint8Array(
                gzipJson({
                  engine: "atrament",
                  version: 1,
                  data: noteDoc().ink,
                  updatedAt: 1,
                }),
              ),
            ],
            "strokes.gz",
          ),
        );
        body.set(
          "snapshot",
          new File([new Uint8Array(makeNotePng())], "snapshot.png"),
        );
        body.set("meta", JSON.stringify(meta));
      } else {
        const doc =
          kind === "note"
            ? noteDoc()
            : {
                version: 1,
                baseWidth: 1440,
                baseHeight: 900,
                strokes: noteDoc().ink.strokes,
              };
        body.set("body", new File([new Uint8Array(gzipJson(doc))], "body.gz"));
        body.set("baseRevision", "0");
        body.set("mutationId", meta.mutationId);
        if (token !== undefined) body.set("expectedFrozenAt", token);
      }
      const path =
        kind === "annotation"
          ? `questions/activation-q/annotation`
          : `${kind === "ink" ? "ink" : "notes"}/activation-q`;
      return app.request(`/api/student/attempts/${first.id}/${path}`, {
        method: "PUT",
        headers: { cookie },
        body,
      });
    };
    expect((await send()).status).toBe(409);
    expect((await send(first.frozenAt ?? "null")).status).toBe(409);
    expect((await send("malformed")).status).toBe(400);
    expect((await send(current.frozenAt ?? "null")).status).toBe(200);
  },
);

it("ACT03 清除后的旧对象恢复返回404，不再重建孤儿快照", () => {
  const env = fixture(),
    first = env.start(),
    stale = env.row(first.id);
  if (!stale) throw new Error("测试卷缺失");
  expect(
    purgeOpenedAttempts(env.db, {
      enabled: true,
      days: 1,
      now: new Date(Date.now() + 2 * 86400_000),
    }),
  ).toBe(1);
  expectHttpError(
    () => refreshOpenedAttempt(env.db, stale),
    404,
    "ATTEMPT_NOT_FOUND",
  );
  expect(env.db.select().from(attempts).all()).toEqual([]);
});

it("ACT04 仅opened作业未开始但物理内容锁仍投影为true", () => {
  const env = fixture();
  const assigned = createAssignment(env.db, TEST_TEACHER_ID, {
    unitIds: [env.unitId],
    studentIds: [env.studentId],
  }).assignments[0];
  if (!assigned) throw new Error("作业未生成");
  expect(
    getAssignmentDetail(env.db, TEST_TEACHER_ID, assigned.id),
  ).toMatchObject({ locked: false, startedCount: 0 });
  startAttempt(env.db, env.studentId, assigned.id);
  expect(
    getAssignmentDetail(env.db, TEST_TEACHER_ID, assigned.id),
  ).toMatchObject({ locked: true, startedCount: 0 });
  expectHttpError(
    () =>
      updateAssignment(env.db, TEST_TEACHER_ID, assigned.id, {
        unitIds: [env.unitId],
      }),
    409,
    "ASSIGNMENT_CONTENT_LOCKED",
  );
});

it("未激活卷从学生/教师记录、单元历次汇总隐藏，预检只读且无答案泄露", async () => {
  const env = fixture();
  expect(getOpenedAttempt(env.db, env.studentId, env.query)).toEqual({
    attempt: null,
  });
  expect(env.db.select().from(attempts).all()).toHaveLength(0);
  const attempt = env.start();
  expect(attempt).toMatchObject({ phase: "opened", activatedAt: null });
  expect(
    listStudentRecords(env.db, env.studentId, {
      limit: 20,
      offset: 0,
      sort: "activity_desc",
    }).total,
  ).toBe(0);
  expect(
    listTeacherAttempts(env.db, TEST_TEACHER_ID, { limit: 20, offset: 0 })
      .total,
  ).toBe(0);
  const landing = getStudentUnitLanding(
    env.db,
    env.studentId,
    env.courseId,
    env.unitId,
  );
  expect(landing.attempts).toHaveLength(0);
  const app = createApp({
    db: env.db,
    dataDir: createTestDir(),
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
    isProduction: false,
  });
  const cookie = `tutor_student_session=${createStudentSession(env.db, env.studentId).token}`;
  const preflight = await app.request(
    `/api/student/attempts/opened?${new URLSearchParams(env.query)}`,
    { headers: { cookie } },
  );
  expect(preflight.status).toBe(200);
  const body = await preflight.json();
  assertNoLeak(body);
  expect(JSON.stringify(body)).not.toContain("激活解析秘密");
  expect(JSON.stringify(body)).not.toContain("激活提示秘密");
  expect(body).toMatchObject({
    data: { attempt: { id: attempt.id, frozenAt: attempt.frozenAt } },
  });
  const activated = await app.request(
    `/api/student/attempts/${attempt.id}/activate`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedFrozenAt: attempt.frozenAt }),
    },
  );
  expect(activated.status).toBe(200);
  const result = await activated.json();
  assertNoLeak(result);
  expect(Object.keys((result as { data: object }).data).sort()).toEqual([
    "activatedAt",
    "attemptId",
    "frozenAt",
    "phase",
  ]);
  expect(activated.headers.get("cache-control")).toBe("private, no-store");
  expect(
    listStudentRecords(env.db, env.studentId, {
      limit: 20,
      offset: 0,
      sort: "activity_desc",
    }).total,
  ).toBe(1);
  expect(
    listTeacherAttempts(env.db, TEST_TEACHER_ID, { limit: 20, offset: 0 })
      .total,
  ).toBe(1);
  expect(
    (
      await app.request(`/api/student/attempts/${attempt.id}/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
});

it("同版本复用卷与冻结行；改题/材料同事务重冻，同毫秒token也前进", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const env = fixture(),
    first = env.start(),
    before = env.refs(first.id);
  expect(env.start()).toEqual(first);
  expect(env.refs(first.id).map((row) => row.id)).toEqual(
    before.map((row) => row.id),
  );
  env.db
    .update(questions)
    .set({ version: 2, stemMd: "新版题干" })
    .where(
      and(
        eq(questions.teacherId, TEST_TEACHER_ID),
        eq(questions.id, "activation-q"),
      ),
    )
    .run();
  env.db
    .update(materials)
    .set({ version: 2, contentMd: "新版材料" })
    .where(eq(materials.id, "activation-material"))
    .run();
  const second = env.start();
  expect(second.id).toBe(first.id);
  expect(second.frozenAt).not.toBe(first.frozenAt);
  expect(env.refs(first.id)[0]).toMatchObject({ questionVersion: 2 });
  expect(env.refs(first.id)[0]?.id).not.toBe(before[0]?.id);
  expect(
    env.db
      .select()
      .from(attemptContextSnapshots)
      .where(eq(attemptContextSnapshots.attemptId, first.id))
      .get()?.sourceVersion,
  ).toBe(2);
  expect(() =>
    activateAttempt(env.db, env.studentId, first.id, {
      expectedFrozenAt: first.frozenAt ?? null,
    }),
  ).toThrow("版本");
  expect(() =>
    saveDraftAnswer(
      env.db,
      env.studentId,
      first.id,
      "activation-q",
      { kind: "judge", value: true },
      { questionRevisionId: before[0]?.id },
    ),
  ).toThrow("版本");
  expect(env.row(first.id)?.activatedAt).toBeNull();
});

it("预检后先激活可保护旧本机材料稿；活跃卷任何内容更新都不重冻", () => {
  const env = fixture(),
    first = env.start(),
    refs = env.refs(first.id);
  env.db
    .update(questions)
    .set({ version: 2, stemMd: "新版" })
    .where(eq(questions.id, "activation-q"))
    .run();
  const preflight = getOpenedAttempt(env.db, env.studentId, env.query).attempt;
  expect(preflight?.frozenAt).toBe(first.frozenAt);
  activateAttempt(env.db, env.studentId, first.id, {
    expectedFrozenAt: preflight?.frozenAt ?? null,
  });
  expect(env.start()).toMatchObject({
    id: first.id,
    phase: "active",
    frozenAt: first.frozenAt,
  });
  expect(env.refs(first.id)).toEqual(refs);
  expect(() =>
    env.db.$client
      .prepare("UPDATE attempts SET activated_at=NULL WHERE id=?")
      .run(first.id),
  ).toThrow("immutable");
  expect(() =>
    env.db.$client
      .prepare("DELETE FROM attempt_context_freezes WHERE attempt_id=?")
      .run(first.id),
  ).toThrow("immutable");
});

it("重冻中途失败恢复原卷快照，限时卷建即激活", () => {
  const env = fixture(),
    first = env.start(),
    refs = env.refs(first.id);
  env.db
    .update(questions)
    .set({ version: 2 })
    .where(eq(questions.id, "activation-q"))
    .run();
  env.db.$client.exec(
    "CREATE TRIGGER fail_refreeze BEFORE INSERT ON responses WHEN NEW.question_version=2 BEGIN SELECT RAISE(ABORT,'freeze failed'); END",
  );
  expect(env.start).toThrow("freeze failed");
  expect(env.refs(first.id)).toEqual(refs);
  expect(env.row(first.id)?.frozenAt).toBe(first.frozenAt);
  const timed = fixture().start(10);
  expect(timed).toMatchObject({
    phase: "active",
    activatedAt: timed.startedAt,
  });
});

it("首次提示与合法带题随笔激活；无锚随笔和越权裸锚不激活", () => {
  const hint = fixture(),
    h = hint.start();
  openHint(hint.db, hint.studentId, h.id, "activation-q", 0);
  expect(hint.row(h.id)?.activatedAt).toBeTruthy();
  const first = hint.row(h.id)?.lastActivityAt;
  openHint(hint.db, hint.studentId, h.id, "activation-q", 0);
  expect(hint.row(h.id)?.lastActivityAt).toBe(first);
  const memo = fixture(),
    m = memo.start();
  createTextMemo(memo.db, {
    studentId: memo.studentId,
    clientId: randomUUID(),
    text: "无锚随笔",
  });
  expect(memo.row(m.id)?.activatedAt).toBeNull();
  const other = makeStudent(memo.db);
  createTextMemo(memo.db, {
    studentId: other,
    clientId: randomUUID(),
    text: "越权锚不激活",
    anchor: {
      kind: "question",
      attemptId: m.id,
      questionId: "activation-q",
      label: "题",
    },
  });
  expect(memo.row(m.id)?.activatedAt).toBeNull();
  createTextMemo(memo.db, {
    studentId: memo.studentId,
    clientId: randomUUID(),
    text: "我的题卡随笔",
    anchor: {
      kind: "question",
      attemptId: m.id,
      questionId: "activation-q",
      label: "题",
    },
  });
  expect(memo.row(m.id)?.activatedAt).toBeTruthy();
});

it.each(["hint", "flag"] as const)(
  "ACT01 %s JSON真实请求原子校验，失败不激活",
  async (kind) => {
    const env = fixture(),
      first = env.start();
    env.db
      .update(questions)
      .set({ version: 2 })
      .where(eq(questions.id, "activation-q"))
      .run();
    const current = env.start();
    const app = createApp({
      db: env.db,
      dataDir: createTestDir(),
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
      isProduction: false,
    });
    const cookie = `tutor_student_session=${createStudentSession(env.db, env.studentId).token}`;
    const send = (proof?: string | null, invalid = false) =>
      app.request(
        `/api/student/attempts/${first.id}/${kind === "hint" ? "hints" : "flags/activation-q"}`,
        {
          method: kind === "hint" ? "POST" : "PUT",
          headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(kind === "hint"
              ? { questionId: "activation-q", index: invalid ? 100 : 0 }
              : { flag: invalid ? "invalid" : "unsure" }),
            ...(proof === undefined ? {} : { expectedFrozenAt: proof }),
          }),
        },
      );
    expect((await send()).status).toBe(409);
    expect((await send(first.frozenAt)).status).toBe(409);
    expect((await send(current.frozenAt, true)).status).toBe(400);
    expect(env.row(first.id)?.activatedAt).toBeNull();
    env.db.$client.exec(
      "CREATE TEMP TRIGGER reject_response_write BEFORE UPDATE ON responses BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
    );
    expect((await send(current.frozenAt)).status).toBe(500);
    expect(env.row(first.id)?.activatedAt).toBeNull();
    env.db.$client.exec("DROP TRIGGER reject_response_write");
    expect((await send(current.frozenAt)).status).toBe(200);
    expect(env.row(first.id)?.activatedAt).toBeTruthy();
  },
);

it.each(["ai", "memo"] as const)(
  "ACT01 %s 只信客户端原题revision，失败不激活",
  (kind) => {
    const env = fixture(),
      first = env.start(),
      oldRevision = env.refs(first.id)[0]?.id;
    const anchor = {
      kind: "question" as const,
      attemptId: first.id,
      questionId: "activation-q",
      label: "原稿",
    };
    const oldContext = contextFromMemoAnchor(env.db, env.studentId, anchor);
    env.db
      .update(questions)
      .set({ version: 2 })
      .where(eq(questions.id, "activation-q"))
      .run();
    env.start();
    const freshContext = contextFromMemoAnchor(env.db, env.studentId, anchor);
    if (!freshContext || !oldContext || !oldRevision)
      throw new Error("缺测试上下文");
    const write = (proof: "none" | "old" | "current") => {
      if (kind === "ai")
        return createAiTask(
          env.db,
          {
            studentId: env.studentId,
            attemptId: first.id,
            questionId: "activation-q",
            question: "解释思路",
            channel: "mcp",
            mutationId: randomUUID(),
            ...(proof === "none"
              ? {}
              : {
                  questionRevisionId:
                    proof === "old"
                      ? oldRevision
                      : freshContext.session?.questionRevisionId,
                }),
          },
          { hmacSecret: "proof-test-secret" },
        );
      return createTextMemo(env.db, {
        studentId: env.studentId,
        clientId: randomUUID(),
        text: "本题思考",
        anchor,
        tags: [],
        device: "desktop",
        ...(proof === "none"
          ? {}
          : { context: proof === "old" ? oldContext : freshContext }),
      });
    };
    expectHttpError(() => write("none"), 409, "ATTEMPT_SNAPSHOT_CHANGED");
    expect(() => write("old")).toThrow();
    expect(env.row(first.id)?.activatedAt).toBeNull();
    env.db.$client.exec(
      `CREATE TEMP TRIGGER reject_action_write BEFORE INSERT ON ${kind === "ai" ? "ai_tasks" : "memos"} BEGIN SELECT RAISE(ABORT, 'write rejected'); END`,
    );
    expect(() => write("current")).toThrow();
    expect(env.row(first.id)?.activatedAt).toBeNull();
    env.db.$client.exec("DROP TRIGGER reject_action_write");
    expect(() => write("current")).not.toThrow();
    expect(env.row(first.id)?.activatedAt).toBeTruthy();
  },
);

it.each(["ai", "memo", "batch"] as const)(
  "ACT01 已完成不可变来源 %s 兼容旧参数，显式错误凭据仍拒绝",
  (kind) => {
    const env = fixture(),
      first = env.start();
    const anchor = {
      kind: "question" as const,
      attemptId: first.id,
      questionId: "activation-q",
      label: "复盘",
    };
    const oldContext = contextFromMemoAnchor(env.db, env.studentId, anchor);
    env.db
      .update(questions)
      .set({ version: 2 })
      .where(eq(questions.id, "activation-q"))
      .run();
    const current = env.start();
    saveDraftAnswer(
      env.db,
      env.studentId,
      first.id,
      "activation-q",
      { kind: "judge", value: false },
      { expectedFrozenAt: current.frozenAt },
    );
    submitAttempt(env.db, env.studentId, first.id);
    const before = env.row(first.id);
    if (kind === "batch") {
      const result = createAiBatchReviewTasks(
        env.db,
        {
          studentId: env.studentId,
          items: [{ attemptId: first.id, questionId: "activation-q" }],
          mutationId: randomUUID(),
          question: "解释思路",
          channel: "mcp",
        },
        { hmacSecret: "proof-test-secret" },
      );
      expect(result.items[0]?.status).toBe("created");
    } else if (kind === "ai") {
      const input = {
        studentId: env.studentId,
        attemptId: first.id,
        questionId: "activation-q",
        question: "解释思路",
        channel: "mcp" as const,
        mutationId: randomUUID(),
      };
      expect(() =>
        createAiTask(env.db, input, { hmacSecret: "proof-test-secret" }),
      ).not.toThrow();
      expectHttpError(
        () =>
          createAiTask(
            env.db,
            {
              ...input,
              mutationId: randomUUID(),
              questionRevisionId: "stale-rendered-revision",
            },
            { hmacSecret: "proof-test-secret" },
          ),
        409,
        "QUESTION_REVISION_STALE",
      );
    } else {
      expect(() =>
        createTextMemo(env.db, {
          studentId: env.studentId,
          clientId: randomUUID(),
          text: "复盘思考",
          anchor,
        }),
      ).not.toThrow();
      if (!oldContext) throw new Error("缺旧上下文");
      expect(() =>
        createTextMemo(env.db, {
          studentId: env.studentId,
          clientId: randomUUID(),
          text: "复盘思考",
          anchor,
          context: oldContext,
        }),
      ).toThrow();
    }
    expect(env.row(first.id)).toEqual(before);
  },
);

it("ACT01 AI真实JSON绑定原渲染revision，陈旧/缺失拒绝且合法请求激活", async () => {
  const env = fixture(),
    first = env.start(),
    oldRevision = env.refs(first.id)[0]?.id;
  env.db
    .update(questions)
    .set({ version: 2 })
    .where(eq(questions.id, "activation-q"))
    .run();
  env.start();
  insertAiConnectionFixture(env.db, env.studentId);
  const app = createApp({
    db: env.db,
    dataDir: createTestDir(),
    logger: pino({ enabled: false }),
    publicUrl: "http://localhost:8787",
    isProduction: false,
  });
  const cookie = `tutor_student_session=${createStudentSession(env.db, env.studentId).token}`;
  const send = (revision?: string) =>
    app.request("/api/student/ai/tasks", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: first.id,
        questionId: "activation-q",
        question: "解释思路",
        channel: "mcp",
        mutationId: randomUUID(),
        materials: { annotation: true, draft: false, formalInk: false },
        ...(revision === undefined ? {} : { questionRevisionId: revision }),
      }),
    });
  expect((await send()).status).toBe(409);
  expect((await send(oldRevision)).status).toBe(409);
  expect(env.row(first.id)?.activatedAt).toBeNull();
  const response = await send(env.refs(first.id)[0]?.id);
  expect(response.status).toBe(201);
  assertNoLeak(await response.json());
  expect(env.row(first.id)?.activatedAt).toBeTruthy();
});
