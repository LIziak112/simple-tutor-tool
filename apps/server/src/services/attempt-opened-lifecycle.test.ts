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
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { activateAttempt, getOpenedAttempt } from "./attempt-activation.ts";
import { saveDraftAnswer } from "./attempt-answer.ts";
import { startCourseAttempt } from "./attempt-start.ts";
import { commitImport } from "./content-service.ts";
import { openHint } from "./hint-service.ts";
import { createTextMemo } from "./memo-service.ts";
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
