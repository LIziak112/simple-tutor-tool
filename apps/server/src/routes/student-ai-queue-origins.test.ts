import { randomUUID } from "node:crypto";
import {
  type AiAttemptReviewCreateData,
  type AiAttemptReviewPreviewData,
  aiAttemptReviewListOkSchema,
  aiBatchCreateOkSchema,
  aiTaskListOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  aiAttemptReviewTasks,
  aiTasks,
  assignments,
  attempts,
  courses,
  responses,
  teachers,
  units,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { attemptOriginSummariesOf } from "../services/ai-companion/student-ai-origin-summary.ts";
import { insertAiConnectionFixture } from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeStudent } from "../test/note-fixtures.ts";

/**
 * 「求助记录」来源呈现的路由测试：
 * - 逐题任务列表的 origins 带批次来源——同一次批量复盘的任务共用批次标识与
 *   任务数，单题求助显式为 null；批次幂等键原文不出服务端；
 * - 整卷任务的账号范围列表带作答级来源摘要与 archived 过滤；
 * - 两类任务互不混装：整卷复盘只建 1 条整卷任务、0 条逐题任务；批量复盘
 *   只建逐题任务、0 条整卷任务；
 * - 两条列表响应过 assertNoLeak 与哨兵内容级双断言（AGENTS.md 硬规则 3）。
 */

const SENTINEL_STEM = "SENTINEL_ORIGINS_STEM";
const SENTINEL_SOLUTION = "SENTINEL_ORIGINS_SOLUTION";
const BATCH_MUTATION_ID = "origins-batch-mutation-key-0001";
const ASSIGNMENT_TITLE = "来源摘要作业";

const active: ReturnType<typeof createTestDb>[] = [];

function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = makeStudent(db);
  insertAiConnectionFixture(db, studentId);
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
  return { app, db, cookie, studentId };
}

afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

/** 已交卷、答案已公布的作业卷（attemptNo 可指定，用于轮次断言） */
function submittedAttempt(db: Db, studentId: string, attemptNo = 1): string {
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      teacherId: TEST_TEACHER_ID,
      title: ASSIGNMENT_TITLE,
      dueAt: null,
      answerRelease: "on_submit",
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const attemptId = randomUUID();
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId,
      sourceType: "assignment",
      assignmentId,
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptNo,
      status: "submitted",
      startedAt: "2026-06-01T00:00:00.000Z",
      submittedAt: "2026-06-01T01:00:00.000Z",
      frozenAt: "2026-06-01T00:00:00.000Z",
      legacyUnverified: false,
      abandonedAt: null,
    })
    .run();
  return attemptId;
}

function addWrongQuestion(db: Db, attemptId: string, questionId: string) {
  db.insert(responses)
    .values({
      id: randomUUID(),
      attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: JSON.stringify({
        type: "choice",
        difficulty: 3,
        knowledge: ["考点A"],
        stemMd: SENTINEL_STEM,
        options: [{ text: "甲" }, { text: "乙" }],
        answers: { kind: "choice", index: 1 },
        hints: [],
        solutionMd: SENTINEL_SOLUTION,
        sourceMd: "::::question{type=choice}\n题干\n:::",
        id: questionId,
      }),
      answerJson: JSON.stringify({ kind: "choice", index: 0 }),
      submittedAt: "2026-06-01T01:00:00.000Z",
      autoCorrect: false,
      finalCorrect: false,
      teacherComment: null,
    })
    .run();
}

type App = ReturnType<typeof createApp>;

function postJson(app: App, cookie: string, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createBatch(
  app: App,
  cookie: string,
  attemptId: string,
  questionIds: string[],
  mutationId = BATCH_MUTATION_ID,
) {
  const res = await postJson(app, cookie, "/api/student/ai/batch-review", {
    items: questionIds.map((questionId) => ({ attemptId, questionId })),
    channel: "mcp",
    question: "请帮我复盘这些错题",
    mutationId,
  });
  expect(res.status).toBe(200);
  return aiBatchCreateOkSchema.parse(await res.json()).data;
}

async function createSingle(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
) {
  const res = await postJson(app, cookie, "/api/student/ai/tasks", {
    attemptId,
    questionId,
    question: "这一步为什么这样做？",
    channel: "mcp",
    materials: { annotation: false, draft: false, formalInk: false },
    mutationId: randomUUID(),
  });
  expect(res.status).toBe(201);
}

async function createWholeReview(app: App, cookie: string, attemptId: string) {
  const previewRes = await app.request(
    `/api/student/ai/attempt-reviews/preview?attemptId=${attemptId}`,
    { headers: { cookie } },
  );
  expect(previewRes.status).toBe(200);
  const preview = (
    (await previewRes.json()) as {
      data: AiAttemptReviewPreviewData;
    }
  ).data;
  const res = await postJson(app, cookie, "/api/student/ai/attempt-reviews", {
    attemptId,
    mutationId: randomUUID(),
    expectedPreviewVersion: preview.opaquePreviewVersion,
    purpose: "复盘",
    channel: "mcp",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: AiAttemptReviewCreateData }).data.task;
}

async function listTasks(app: App, cookie: string, query = "archived=exclude") {
  const res = await app.request(`/api/student/ai/tasks?${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const body = aiTaskListOkSchema.parse(JSON.parse(raw));
  return { raw, body, data: body.data };
}

async function listReviews(app: App, cookie: string, query: string) {
  const res = await app.request(`/api/student/ai/attempt-reviews?${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const body = aiAttemptReviewListOkSchema.parse(JSON.parse(raw));
  return { raw, body, data: body.data };
}

describe("逐题任务列表：批次来源", () => {
  it("同一次批量复盘的任务共用批次标识与任务数；单题求助 batch 为 null", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId, 2);
    const batchQuestions = ["q-1", "q-8", "q-11"];
    for (const id of [...batchQuestions, "q-single"])
      addWrongQuestion(db, attemptId, id);

    const batch = await createBatch(app, cookie, attemptId, batchQuestions);
    expect(batch.summary.created).toBe(3);
    await createSingle(app, cookie, attemptId, "q-single");

    const { raw, body, data } = await listTasks(app, cookie);
    const origins = data.origins ?? {};
    const batchIds = new Set<string>();
    for (const task of data.tasks) {
      const origin = origins[task.id];
      expect(origin).toBeDefined();
      if (origin === undefined) continue;
      expect(origin.attemptNo).toBe(2);
      expect(origin.title).toBe(ASSIGNMENT_TITLE);
      if (task.questionId === "q-single") {
        expect(origin.batch).toBeNull();
        continue;
      }
      expect(origin.batch?.taskCount).toBe(3);
      if (origin.batch !== null) batchIds.add(origin.batch.id);
    }
    expect(data.tasks).toHaveLength(4);
    expect(batchIds.size).toBe(1);
    // 批次发起时刻 = 批内最早任务的创建时刻
    const createdAts = db
      .select({ createdAt: aiTasks.createdAt, questionId: aiTasks.questionId })
      .from(aiTasks)
      .all()
      .filter((row) => batchQuestions.includes(row.questionId))
      .map((row) => row.createdAt)
      .sort();
    const firstBatchTask = data.tasks.find((task) => task.questionId === "q-1");
    expect(origins[firstBatchTask?.id ?? ""]?.batch?.createdAt).toBe(
      createdAts[0],
    );

    // 防泄露双断言：字段名 + 内容哨兵；批次幂等键原文不出服务端
    assertNoLeak(body);
    expect(raw).not.toContain(SENTINEL_STEM);
    expect(raw).not.toContain(SENTINEL_SOLUTION);
    expect(raw).not.toContain(BATCH_MUTATION_ID);
    expect(raw).not.toContain("mutationId");
  });

  it("两次批量复盘是两个批次；批内任务归档后任务数仍按批次创建数计", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    for (const id of ["q-1", "q-2", "q-3"]) addWrongQuestion(db, attemptId, id);
    await createBatch(app, cookie, attemptId, ["q-1", "q-2"], "batch-key-a");
    await createBatch(app, cookie, attemptId, ["q-3"], "batch-key-b");

    const first = await listTasks(app, cookie);
    const batchOf = (questionId: string) => {
      const task = first.data.tasks.find(
        (row) => row.questionId === questionId,
      );
      return first.data.origins?.[task?.id ?? ""]?.batch ?? null;
    };
    expect(batchOf("q-1")?.id).toBe(batchOf("q-2")?.id);
    expect(batchOf("q-3")?.id).not.toBe(batchOf("q-1")?.id);
    expect(batchOf("q-1")?.taskCount).toBe(2);
    expect(batchOf("q-3")?.taskCount).toBe(1);

    // 归档一条（直接置归档时间：归档动作的状态门不是本用例关注点）
    db.update(aiTasks)
      .set({ archivedAt: "2026-06-02T00:00:00.000Z" })
      .where(eq(aiTasks.questionId, "q-2"))
      .run();
    const after = await listTasks(app, cookie);
    expect(after.data.tasks.map((task) => task.questionId).sort()).toEqual([
      "q-1",
      "q-3",
    ]);
    const remaining = after.data.tasks.find((row) => row.questionId === "q-1");
    expect(after.data.origins?.[remaining?.id ?? ""]?.batch?.taskCount).toBe(2);
  });

  it("批量复盘只创建逐题任务：整卷任务表 0 行", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    for (const id of ["q-1", "q-2"]) addWrongQuestion(db, attemptId, id);
    await createBatch(app, cookie, attemptId, ["q-1", "q-2"]);
    expect(db.select().from(aiTasks).all()).toHaveLength(2);
    expect(db.select().from(aiAttemptReviewTasks).all()).toHaveLength(0);
  });
});

describe("整卷任务列表：账号范围、来源摘要与归档过滤", () => {
  it("整卷复盘确认后只创建 1 条整卷任务、0 条逐题任务", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    for (const id of ["q-1", "q-2", "q-3"]) addWrongQuestion(db, attemptId, id);
    const task = await createWholeReview(app, cookie, attemptId);
    expect(task.questionCount).toBe(3);
    expect(db.select().from(aiAttemptReviewTasks).all()).toHaveLength(1);
    expect(db.select().from(aiTasks).all()).toHaveLength(0);
  });

  it("账号范围列表附作答级来源摘要；按作答过滤时省略；响应不含题面与解析", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId, 3);
    addWrongQuestion(db, attemptId, "q-1");
    const task = await createWholeReview(app, cookie, attemptId);

    const global = await listReviews(app, cookie, "archived=exclude");
    expect(global.data.tasks.map((row) => row.id)).toEqual([task.id]);
    expect(global.data.origins?.[task.id]).toEqual({
      sourceType: "assignment",
      attemptNo: 3,
      title: ASSIGNMENT_TITLE,
      unitTitle: null,
      assignmentId: expect.any(String),
      courseId: null,
      unitId: null,
      lectureId: null,
      attemptStatus: "submitted",
    });
    assertNoLeak(global.body);
    expect(global.raw).not.toContain(SENTINEL_STEM);
    expect(global.raw).not.toContain(SENTINEL_SOLUTION);
    expect(global.raw).not.toContain("mutationId");

    const scoped = await listReviews(app, cookie, `attemptId=${attemptId}`);
    expect(scoped.data.tasks).toHaveLength(1);
    expect(scoped.data.origins).toBeUndefined();
  });

  it("archived=exclude / only 互补；缺省返回全部；非法取值 400", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptA = submittedAttempt(db, studentId);
    const attemptB = submittedAttempt(db, studentId);
    addWrongQuestion(db, attemptA, "q-a");
    addWrongQuestion(db, attemptB, "q-b");
    const kept = await createWholeReview(app, cookie, attemptA);
    const archived = await createWholeReview(app, cookie, attemptB);
    db.update(aiAttemptReviewTasks)
      .set({ status: "cancelled", archivedAt: "2026-06-02T00:00:00.000Z" })
      .where(eq(aiAttemptReviewTasks.id, archived.id))
      .run();

    const open = await listReviews(app, cookie, "archived=exclude");
    expect(open.data.tasks.map((row) => row.id)).toEqual([kept.id]);
    const only = await listReviews(app, cookie, "archived=only");
    expect(only.data.tasks.map((row) => row.id)).toEqual([archived.id]);
    expect(Object.keys(only.data.origins ?? {})).toEqual([archived.id]);
    const all = await listReviews(app, cookie, "limit=50");
    expect(all.data.tasks).toHaveLength(2);

    const bad = await app.request(
      "/api/student/ai/attempt-reviews?archived=all",
      { headers: { cookie } },
    );
    expect(bad.status).toBe(400);
  });

  it("他人的整卷任务不进本人列表", async () => {
    const { app, db, cookie, studentId } = world();
    const attemptId = submittedAttempt(db, studentId);
    addWrongQuestion(db, attemptId, "q-1");
    await createWholeReview(app, cookie, attemptId);

    const otherId = makeStudent(db);
    insertAiConnectionFixture(db, otherId);
    const otherCookie = `tutor_student_session=${createStudentSession(db, otherId).token}`;
    const other = await listReviews(app, otherCookie, "archived=exclude");
    expect(other.data.tasks).toHaveLength(0);
  });
});

describe("作答级来源摘要：课程练习的单元标题", () => {
  it("课程练习带单元当前标题（本教师域内读取）；作业来源为 null；他人同名单元不串", () => {
    const { db, studentId } = world();
    const courseId = randomUUID();
    db.insert(courses)
      .values({
        id: courseId,
        teacherId: TEST_TEACHER_ID,
        title: "初二数学",
        order: 1,
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      .run();
    const otherTeacherId = randomUUID();
    db.insert(teachers)
      .values({
        ...(db
          .select()
          .from(teachers)
          .where(eq(teachers.id, TEST_TEACHER_ID))
          .get() as typeof teachers.$inferSelect),
        id: otherTeacherId,
        loginName: "origins-other-teacher",
      })
      .run();
    for (const [teacherId, title] of [
      [otherTeacherId, "别的老师的同名单元"],
      [TEST_TEACHER_ID, "有理数小练"],
    ] as const)
      db.insert(units)
        .values({
          id: "unit-origins",
          teacherId,
          courseId: null,
          folderId: null,
          lectureId: null,
          title,
          order: 0,
          updatedAt: "2026-06-01T00:00:00.000Z",
        })
        .run();
    const courseAttemptId = randomUUID();
    db.insert(attempts)
      .values({
        id: courseAttemptId,
        studentId,
        sourceType: "course",
        assignmentId: null,
        courseId,
        unitId: "unit-origins",
        lectureId: null,
        attemptNo: 3,
        status: "submitted",
        startedAt: "2026-06-01T00:00:00.000Z",
        submittedAt: "2026-06-01T01:00:00.000Z",
        frozenAt: "2026-06-01T00:00:00.000Z",
        legacyUnverified: false,
        abandonedAt: null,
      })
      .run();
    const assignmentAttemptId = submittedAttempt(db, studentId);

    const origins = attemptOriginSummariesOf(db, [
      courseAttemptId,
      assignmentAttemptId,
    ]);
    expect(origins.get(courseAttemptId)).toMatchObject({
      sourceType: "course",
      attemptNo: 3,
      title: "初二数学",
      unitTitle: "有理数小练",
    });
    expect(origins.get(assignmentAttemptId)).toMatchObject({
      sourceType: "assignment",
      title: ASSIGNMENT_TITLE,
      unitTitle: null,
    });
  });
});
