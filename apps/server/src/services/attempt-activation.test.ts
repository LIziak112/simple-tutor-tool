import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { attempts } from "../db/schema.ts";
import { createTestDir } from "../db/test-utils.ts";
import { gzipJson, makeNotePng, noteDoc } from "../test/note-fixtures.ts";
import {
  at,
  closeTimingFixtures,
  timingFixture,
} from "../test/submission-time-fixture.ts";
import { createAiTask } from "./ai-companion/student-ai-queue.ts";
import {
  assembleAnnotationBase,
  putAnnotationDoc,
  registerBaseImage,
} from "./annotation-service.ts";
import { activateAttempt } from "./attempt-activation.ts";
import { touchAttemptActivity } from "./attempt-activity.ts";
import { saveDraftAnswer, setStudentFlag } from "./attempt-answer.ts";
import { getAttemptDetail } from "./attempt-detail.ts";
import { submitAttempt } from "./attempt-whole-submit.ts";
import { saveInk } from "./ink-service.ts";
import { saveNoteVersion } from "./note-service.ts";
import { getStudentMcpPractice } from "./student-mcp-practice-read.ts";

afterEach(closeTimingFixtures);
const current = (env: ReturnType<typeof timingFixture>) =>
  env.db.select().from(attempts).where(eq(attempts.id, env.attemptId)).get();

it("ACT08 无固定墙钟的首次交卷回执与详情同一激活事实，前置动作首次时刻不被收尾覆盖", () => {
  for (const withDraft of [false, true]) {
    const env = timingFixture();
    env.db.transaction(() => {
      if (withDraft)
        saveDraftAnswer(env.db, env.studentId, env.attemptId, "q1", {
          kind: "judge",
          value: true,
        });
      const first = current(env)?.activatedAt;
      const later = new Date(Date.now() + 1234).toISOString();
      const receipt = submitAttempt(
        env.db,
        env.studentId,
        env.attemptId,
        later,
      );
      expect(receipt.attempt.activatedAt).toBe(first ?? later);
      expect(receipt.attempt).toEqual(
        getAttemptDetail(env.db, env.studentId, env.attemptId).attempt,
      );
    });
  }
});

it.each(["ink", "note", "annotation"] as const)(
  "%s 首次空白正文同步不属于实质动作",
  (kind) => {
    const env = timingFixture(),
      dataDir = createTestDir();
    const meta = { baseRevision: 0, mutationId: randomUUID() };
    if (kind === "ink")
      saveInk(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        gzipJson({
          engine: "atrament",
          version: 1,
          data: noteDoc(0).ink,
          updatedAt: 1,
        }),
        makeNotePng(),
        meta,
      );
    if (kind === "note")
      saveNoteVersion(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        gzipJson(noteDoc(0)),
        meta,
      );
    if (kind === "annotation") {
      const base = assembleAnnotationBase(
        env.db,
        env.studentId,
        env.attemptId,
        "q1",
        "scratch",
      );
      registerBaseImage(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        makeNotePng(1440, 900),
        {
          questionRevisionId: env.row("q1").id,
          baseRenderVersion: base.baseRenderVersion,
          phase: "scratch",
        },
      );
      putAnnotationDoc(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        gzipJson({ version: 1, baseWidth: 1440, baseHeight: 900, strokes: [] }),
        meta,
      );
    }
    expect(current(env)?.activatedAt).toBeNull();
  },
);

it("打开和浏览事件不激活；首个答案在同事务激活且重放不改首次时刻", () => {
  const env = timingFixture();
  expect(current(env)?.activatedAt).toBeNull();
  env.event("question_view", 1, "q1");
  expect(current(env)?.activatedAt).toBeNull();
  saveDraftAnswer(env.db, env.studentId, env.attemptId, "q1", {
    kind: "judge",
    value: true,
  });
  const first = current(env)?.activatedAt;
  expect(first).toBeTruthy();
  env.db.transaction((tx) => touchAttemptActivity(tx, env.attemptId, at(100)));
  expect(current(env)?.activatedAt).toBe(first);
});

it("显式激活校验精确冻结版本、归属，幂等且不改最近活动", () => {
  const env = timingFixture();
  expect(() =>
    activateAttempt(env.db, "other", env.attemptId, {
      expectedFrozenAt: at(0),
    }),
  ).toThrow("自己的");
  expect(() =>
    activateAttempt(env.db, env.studentId, env.attemptId, {
      expectedFrozenAt: null,
    }),
  ).toThrow("版本");
  expect(current(env)?.activatedAt).toBeNull();
  const first = activateAttempt(
    env.db,
    env.studentId,
    env.attemptId,
    { expectedFrozenAt: at(0) },
    at(10),
  );
  expect(first).toEqual({
    attemptId: env.attemptId,
    activatedAt: at(10),
    phase: "active",
    frozenAt: at(0),
  });
  expect(
    activateAttempt(
      env.db,
      env.studentId,
      env.attemptId,
      { expectedFrozenAt: at(0) },
      at(20),
    ),
  ).toEqual(first);
  expect(current(env)?.lastActivityAt).toBe(at(10));
});

it("标不会激活，清除空标记不激活；事务回滚连同激活回滚", () => {
  const env = timingFixture();
  setStudentFlag(env.db, env.studentId, env.attemptId, "q1", null);
  expect(current(env)?.activatedAt).toBeNull();
  expect(() =>
    env.db.transaction(() => {
      setStudentFlag(env.db, env.studentId, env.attemptId, "q1", "unsure");
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(current(env)?.activatedAt).toBeNull();
  setStudentFlag(env.db, env.studentId, env.attemptId, "q1", "unsure");
  expect(current(env)?.activatedAt).toBeTruthy();
});

it.each(["ink", "note", "annotation", "ai", "question", "whole"] as const)(
  "%s 首个有效写入激活，读取不激活",
  (kind) => {
    const env = timingFixture();
    const dataDir = createTestDir();
    const before = getStudentMcpPractice(env.db, env.studentId, {
      practiceId: env.attemptId,
    });
    expect(before.phase).toBe("opened");
    expect(current(env)?.activatedAt).toBeNull();
    const meta = { baseRevision: 0, mutationId: randomUUID() };
    if (kind === "ink")
      saveInk(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
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
      saveNoteVersion(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        gzipJson(noteDoc()),
        meta,
      );
    if (kind === "annotation") {
      const base = assembleAnnotationBase(
        env.db,
        env.studentId,
        env.attemptId,
        "q1",
        "scratch",
      );
      registerBaseImage(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        makeNotePng(1440, 900),
        {
          questionRevisionId: env.row("q1").id,
          baseRenderVersion: base.baseRenderVersion,
          phase: "scratch",
        },
      );
      expect(current(env)?.activatedAt).toBeNull();
      putAnnotationDoc(
        env.db,
        dataDir,
        env.studentId,
        env.attemptId,
        "q1",
        gzipJson({
          version: 1,
          baseWidth: 1440,
          baseHeight: 900,
          strokes: noteDoc().ink.strokes,
        }),
        meta,
      );
    }
    if (kind === "ai")
      createAiTask(
        env.db,
        {
          studentId: env.studentId,
          attemptId: env.attemptId,
          questionId: "q1",
          question: "解释思路",
          channel: "mcp",
          mutationId: meta.mutationId,
        },
        { hmacSecret: "activation-test-secret", now: at(10) },
      );
    if (kind === "question") env.submit("q1", 10);
    if (kind === "whole")
      submitAttempt(env.db, env.studentId, env.attemptId, at(10));
    expect(current(env)?.activatedAt).toBeTruthy();
  },
);
