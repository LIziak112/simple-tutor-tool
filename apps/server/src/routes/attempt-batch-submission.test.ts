import { randomUUID } from "node:crypto";
import type {
  AttemptBatchSubmissionBatch,
  StudentAnswer,
} from "@tutor/contract";
import {
  ATTEMPT_SUBMIT_MAX_QUESTIONS,
  attemptBatchSubmissionSessionSchema,
  attemptDraftOkSchema,
  attemptResultOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  assignmentStudents,
  assignments,
  attemptBatchSubmissions,
  attemptSubmissionBatches,
  attempts,
  submissionEvidence,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { putNoteReceipt } from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";

async function makeWorld(
  answerRelease: "on_submit" | "after_due" = "on_submit",
) {
  const db = createTestDb();
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost:8787",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: "teacher-pass-8" }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  const password = "student-pass-8";
  const studentId = await createStudent(
    app,
    teacherCookie,
    "存量卷学生",
    password,
  );
  const cookie = await loginStudent(app, "存量卷学生", password);
  await createStudent(app, teacherCookie, "其他学生", password);
  const otherCookie = await loginStudent(app, "其他学生", password);
  const questions = Array.from(
    { length: ATTEMPT_SUBMIT_MAX_QUESTIONS + 1 },
    (_, index) => {
      const questionId = `历史题-${index}`;
      return {
        questionId,
        snapshotJson: snapshotJsonOf({
          id: questionId,
          type: "judge",
          answers: { kind: "judge", value: true },
          solutionMd: "只在公布后显示的解析",
        }),
      };
    },
  );
  const { attemptId } = frozenDraftAttempt(db, studentId, questions);
  const assignmentId = randomUUID();
  db.insert(assignments)
    .values({
      id: assignmentId,
      title: "存量超限作业",
      createdAt: "2026-10-01T00:00:00.000Z",
      answerRelease,
      dueAt: answerRelease === "after_due" ? "2099-01-01T01:00:00+01:00" : null,
    })
    .run();
  db.insert(assignmentStudents)
    .values({ assignmentId, studentId, addedAt: "2026-10-01T00:00:00.000Z" })
    .run();
  db.update(attempts)
    .set({ assignmentId })
    .where(eq(attempts.id, attemptId))
    .run();
  const base = `/api/student/attempts/${attemptId}`;
  const request = (
    method: string,
    path: string,
    body?: unknown,
    auth = cookie,
  ) =>
    app.request(`${base}${path}`, {
      method,
      headers: { cookie: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const detail = attemptDraftOkSchema.parse(
    await (await request("GET", "")).json(),
  ).data;
  const revisions = detail.units.flatMap((unit) =>
    unit.questions.map((question) => ({
      questionId: question.id,
      questionRevisionId: question.questionRevisionId,
      expectedAnswerRevision: detail.draftRevisions?.[question.id] ?? 0,
    })),
  );
  const batches: AttemptBatchSubmissionBatch[] = [0, 1].map((batchIndex) => {
    const start = batchIndex * ATTEMPT_SUBMIT_MAX_QUESTIONS;
    const items = revisions.slice(start, start + ATTEMPT_SUBMIT_MAX_QUESTIONS);
    return {
      batchIndex,
      revisions: items,
      evidence: items.map(({ questionId }) => ({ questionId, state: "none" })),
    };
  });
  async function start(): Promise<string> {
    const response = await request("POST", "/submit-batches", {
      batchCount: 2,
    });
    expect(response.status).toBe(201);
    const data = ((await response.json()) as { data: unknown }).data;
    assertNoLeak(data);
    return attemptBatchSubmissionSessionSchema.parse(data).submissionId;
  }
  function put(id: string, batch: AttemptBatchSubmissionBatch) {
    return request("PUT", `/submit-batches/${id}`, batch);
  }
  function finish(id: string) {
    return request("POST", `/submit-batches/${id}/finish`, {});
  }
  function save(questionId: string, answer: StudentAnswer) {
    return request("PUT", `/answers/${questionId}`, { answer });
  }
  return {
    db,
    attemptId,
    request,
    otherCookie,
    batches,
    start,
    put,
    finish,
    save,
    putNote: (questionId: string, baseRevision = 0) =>
      putNoteReceipt(app, cookie, attemptId, questionId, baseRevision + 1, {
        baseRevision,
      }),
  };
}

describe("存量超限卷分批提交", () => {
  it("暂存到期后拒绝迟到请求，学生可以保留草稿并重新确认", async () => {
    const world = await makeWorld();
    const [first] = world.batches;
    const questionId = first?.revisions[0]?.questionId;
    if (!first || !questionId) throw new Error("缺少交卷批次");
    const answer = { kind: "judge", value: true } as const;
    expect((await world.save(questionId, answer)).status).toBe(200);
    const old = await world.start();
    expect((await world.put(old, first)).status).toBe(200);
    world.db
      .update(attemptBatchSubmissions)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(attemptBatchSubmissions.id, old))
      .run();
    const expired = await world.finish(old);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({
      error: "SUBMIT_BATCH_EXPIRED",
    });
    expect(await world.start()).not.toBe(old);
    expect(world.db.select().from(attemptSubmissionBatches).all()).toHaveLength(
      0,
    );
    const current = attemptDraftOkSchema.parse(
      await (await world.request("GET", "")).json(),
    ).data;
    expect(current.drafts[questionId]).toEqual(answer);
    expect(world.db.select().from(submissionEvidence).all()).toHaveLength(0);
  });

  it("501 题分两批，幂等上传，齐全后只交卷一次", async () => {
    const world = await makeWorld("after_due");
    const [first, second] = world.batches;
    if (!first || !second) throw new Error("缺少两批声明");
    const id = await world.start();
    const staged = await world.put(id, first);
    expect(staged.status).toBe(200);
    assertNoLeak(await staged.json());
    expect((await world.put(id, first)).status).toBe(200);
    expect((await world.put(id, { ...first, evidence: [] })).status).toBe(409);
    expect((await world.finish(id)).status).toBe(409);
    expect(world.db.select().from(submissionEvidence).all()).toHaveLength(0);
    expect((await world.put(id, second)).status).toBe(200);
    const submitted = await world.finish(id);
    expect(submitted.status).toBe(200);
    const body = await submitted.json();
    assertNoLeak(body, { allow: ["answer", "answers", "solutionMd"] });
    expect(JSON.stringify(body)).not.toContain("只在公布后显示的解析");
    const result = attemptResultOkSchema.parse(body).data;
    expect(result.dueAt).toBe("2099-01-01T00:00:00.000Z");
    expect(result.answersReleased).toBe(false);
    expect(result.attempt.scoreAuto).toBeNull();
    expect(result.summary).toMatchObject({
      correct: 0,
      wrong: 0,
      scoreFinal: null,
    });
    const questions = result.units.flatMap((unit) => unit.questions);
    expect(questions).toHaveLength(ATTEMPT_SUBMIT_MAX_QUESTIONS + 1);
    for (const question of questions) {
      expect(question).toMatchObject({
        autoCorrect: null,
        finalCorrect: null,
        answers: null,
        solutionMd: null,
      });
    }
    expect(result.summary.total).toBe(ATTEMPT_SUBMIT_MAX_QUESTIONS + 1);
    expect(world.db.select().from(submissionEvidence).all()).toHaveLength(
      ATTEMPT_SUBMIT_MAX_QUESTIONS + 1,
    );
    const repeated = await world.finish(id);
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({ error: "ALREADY_SUBMITTED" });
  });

  it("批次之间的新版答案拒绝最终交卷，取消仍保留本人草稿", async () => {
    const world = await makeWorld();
    const [first, second] = world.batches;
    const questionId = first?.revisions[0]?.questionId;
    if (!first || !second || !questionId) throw new Error("缺少两批声明");
    const id = await world.start();
    const foreign = await world.request(
      "PUT",
      `/submit-batches/${id}`,
      first,
      world.otherCookie,
    );
    expect(foreign.status).toBe(403);
    assertNoLeak(await foreign.json());
    expect((await world.put(id, first)).status).toBe(200);
    const answer = { kind: "judge", value: true } as const;
    expect((await world.save(questionId, answer)).status).toBe(200);
    expect((await world.put(id, second)).status).toBe(200);
    const conflict = await world.finish(id);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "ANSWER_REVISION_CONFLICT",
    });
    expect(world.db.select().from(submissionEvidence).all()).toHaveLength(0);
    expect(
      (await world.request("DELETE", `/submit-batches/${id}`)).status,
    ).toBe(200);
    expect((await world.put(id, first)).status).toBe(409);
    const current = attemptDraftOkSchema.parse(
      await (await world.request("GET", "")).json(),
    ).data;
    expect(current.drafts[questionId]).toEqual(answer);
  });

  it("草稿头在分批期间变化，最终核对拒绝且没有任何证据行", async () => {
    const world = await makeWorld();
    const [first, second] = world.batches;
    const questionId = first?.revisions[0]?.questionId;
    if (!first || !second || !questionId) throw new Error("缺少交卷批次");
    const note = await world.putNote(questionId);
    const id = await world.start();
    const evidence = first.evidence.map((entry) =>
      entry.questionId === questionId
        ? {
            questionId,
            state: "frozen" as const,
            revision: note.revision,
            versionId: note.versionId,
          }
        : entry,
    );
    expect((await world.put(id, { ...first, evidence })).status).toBe(200);
    expect((await world.put(id, second)).status).toBe(200);
    await world.putNote(questionId, note.revision);
    const failed = await world.finish(id);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({
      error: "NOTE_EVIDENCE_MISMATCH",
    });
    expect(world.db.select().from(submissionEvidence).all()).toHaveLength(0);
    expect(
      world.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, world.attemptId))
        .get()?.status,
    ).toBe("draft");
  });
});
