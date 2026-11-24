import { randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  pendingMarkListDataSchema,
  studentRecordsOkSchema,
  teacherAttemptDetailOkSchema,
} from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { runBackfills } from "../db/backfill.ts";
import { createDbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions.ts";

const pendingSchema = z.object({ data: pendingMarkListDataSchema });

const markdown = [
  "---",
  "kind: practice",
  "unit: K14 合成判断",
  "---",
  "",
  ...["正确", "错误", "正确", "错误", "正确"].flatMap((key, index) => [
    `::::question{id=k14-judge-${index + 1} type=judge}`,
    `合成判断题 ${index + 1}。[[${key}]]`,
    "::::",
    "",
  ]),
].join("\n");

it("经正常教师入口创建只有带布尔参考键的内核判断作业", async () => {
  using data = mkdtempDisposableSync(join(tmpdir(), "ownclass-k14-judge-"));
  const reopen = () =>
    createDbHandle(join(data.path, "tutor.db"), (db) => {
      runMigrations(db);
      runBackfills(db);
    });
  let handle = reopen();
  const create = (backupOperatorId?: string) =>
    createApp({
      db: handle.db,
      dbHandle: handle,
      dataDir: data.path,
      backupOperatorId,
      kernelAssignmentCreationEnabled: true,
      isProduction: false,
      logger: pino({ enabled: false }),
      publicUrl: "http://localhost:8787",
    });
  let app = create();
  const call = (path: string, cookie: string, method = "GET", body?: object) =>
    app.request(path, {
      method,
      headers: { cookie, ...(body && { "content-type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
    });
  try {
    const world = await setupAssignment(app);
    const imported = await call(
      "/api/teacher/import/commit",
      world.teacher,
      "POST",
      {
        markdown,
        filename: "K14 合成判断.md",
      },
    );
    expect(imported.status, await imported.clone().text()).toBe(200);
    const { data: unitData } = z
      .object({
        data: z.object({
          units: z.array(z.object({ id: z.string() })).nonempty(),
        }),
      })
      .parse(await imported.json());
    const unit = unitData.units[0];
    if (!unit) throw new Error("没有导入判断单元");
    const assignment = await assignKernelFixture(
      app,
      {
        ...world,
        unitId: unit.id,
      },
      { dueAt: "2099-01-01T00:00:00.000Z", answerRelease: "after_due" },
    );
    const opened = await postAssignment(app, assignment, world.ownerCookie);
    expect(opened.status).toBe(200);
    const { data: attempt } = attemptStartOkSchema.parse(await opened.json());
    const root = `/api/student/attempts/${attempt.id}`;
    const revisions = await fetchSubmitRevisions(
      app,
      world.ownerCookie,
      attempt.id,
    );
    const values = [true, false, " √ ", "  待人工辨认　"] as const;
    expect(revisions).toHaveLength(5);
    const claimed = revisions.slice(0, values.length);
    for (const [index, item] of claimed.entries()) {
      const response = await call(
        `${root}/answers/${item.questionId}`,
        world.ownerCookie,
        "PUT",
        {
          answer: { kind: "judge", value: values[index] },
          expectedFrozenAt: attempt.frozenAt,
          questionRevisionId: item.questionRevisionId,
          baseRevision: 0,
          mutationId: randomUUID(),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const bad = await call(
      `${root}/answers/${revisions[4]?.questionId}`,
      world.ownerCookie,
      "PUT",
      {
        answer: { kind: "judge", value: 1 },
        baseRevision: 0,
        mutationId: randomUUID(),
      },
    );
    expect(bad.status).toBe(400);
    const draft = attemptDraftOkSchema.parse(
      await (await call(root, world.ownerCookie)).json(),
    ).data;
    for (const [index, item] of claimed.entries()) {
      expect(draft.drafts[item.questionId]).toEqual({
        kind: "judge",
        value: values[index],
      });
      expect(draft.draftRevisions?.[item.questionId]).toBe(1);
    }
    expect(draft.drafts[revisions[4]?.questionId ?? ""]).toBeUndefined();
    const oneRecord = async (cookie = world.ownerCookie) => {
      const result = await call("/api/student/records", cookie);
      expect(result.status).toBe(200);
      return studentRecordsOkSchema
        .parse(await result.json())
        .data.records.find((row) => row.attemptId === attempt.id);
    };
    expect(await oneRecord()).toMatchObject({
      status: "draft",
      answerProgress: { answeredCount: 4, totalCount: 5 },
    });
    expect(await oneRecord(world.otherCookie)).toBeUndefined();
    const request = {
      revisions: await fetchSubmitRevisions(app, world.ownerCookie, attempt.id),
    };
    const other = await call(
      `${root}/submit`,
      world.otherCookie,
      "POST",
      request,
    );
    expect(other.status).toBe(403);
    handle.db.$client.exec(`
      CREATE TRIGGER judge_interrupt_projection BEFORE UPDATE OF status ON attempts
      WHEN OLD.status='draft' AND NEW.status='submitted'
      BEGIN SELECT RAISE(ABORT, '切断宿主正式投影'); END;`);
    const interrupted = await call(
      `${root}/submit`,
      world.ownerCookie,
      "POST",
      request,
    );
    expect(interrupted.status).toBe(500);
    expect(
      handle.db.$client
        .prepare("SELECT status FROM attempts WHERE id=?")
        .pluck()
        .get(attempt.id),
    ).toBe("draft");
    const runtime = openLearningRuntime({
      databasePath: join(data.path, "learning-kernel.sqlite"),
    });
    try {
      expect(
        runtime.read({ role: "student", id: world.studentId }, attempt.id)
          .status,
      ).toBe("completed");
    } finally {
      runtime.close();
    }
    handle.db.$client.exec("DROP TRIGGER judge_interrupt_projection");
    handle.close();
    handle = reopen();
    const teacherId = z
      .string()
      .parse(
        handle.db.$client
          .prepare("SELECT id FROM teachers WHERE is_admin=1")
          .pluck()
          .get(),
      );
    app = create(teacherId);
    const pendingPath = `/api/teacher/pending-marks?assignmentId=${assignment}`;
    const pendingResponse = await call(pendingPath, world.teacher);
    expect(pendingResponse.status, await pendingResponse.clone().text()).toBe(
      200,
    );
    const pending = pendingSchema.parse(await pendingResponse.json()).data
      .marks;
    expect(
      pending.map(({ questionId, answerText }) => [questionId, answerText]),
    ).toEqual([[revisions[3]?.questionId, values[3]]]);
    const hidden = attemptResultOkSchema.parse(
      await (await call(root, world.ownerCookie)).json(),
    ).data;
    expect(hidden.answersReleased).toBe(false);
    expect(hidden.attempt.scoreAuto).toBeNull();
    expect(hidden.summary.pendingCount).toBeNull();
    expect(await oneRecord()).toMatchObject({
      answersReleased: false,
      score: null,
      pendingCount: null,
      resultCounts: null,
    });
    const hiddenRows = hidden.units.flatMap(({ questions }) => questions);
    expect(hiddenRows[3]?.answer).toEqual({ kind: "judge", value: values[3] });
    expect(
      hiddenRows.every(
        (row) => row.autoCorrect === null && row.answers === null,
      ),
    ).toBe(true);
    const teacherDetail = teacherAttemptDetailOkSchema.parse(
      await (
        await call(`/api/teacher/attempts/${attempt.id}`, world.teacher)
      ).json(),
    ).data;
    expect(teacherDetail).toMatchObject({
      status: "submitted",
      scoreAuto: 75,
      scoreFinal: null,
      pendingCount: 1,
    });
    expect(
      teacherDetail.questions.map((row) => [
        row.answered,
        row.autoCorrect,
        row.finalCorrect,
      ]),
    ).toEqual([
      [true, true, true],
      [true, true, true],
      [true, true, true],
      [true, null, null],
      [false, false, false],
    ]);
    const judgeResponseId = teacherDetail.questions[0]?.responseId;
    expect(judgeResponseId).toBeDefined();
    const mark = await call(
      `/api/teacher/responses/${judgeResponseId}/mark`,
      world.teacher,
      "POST",
      { mark: "wrong", comment: null },
    );
    expect(mark.status).toBe(503);
    expect(await mark.json()).toMatchObject({
      error: "KERNEL_ATTEMPT_WRITE_UNAVAILABLE",
    });

    const released = await call(
      `/api/teacher/assignments/${assignment}`,
      world.teacher,
      "PATCH",
      { answerRelease: "on_submit" },
    );
    expect(released.status).toBe(200);
    const published = attemptResultOkSchema.parse(
      await (await call(root, world.ownerCookie)).json(),
    ).data;
    expect(published).toMatchObject({
      answersReleased: true,
      attempt: { scoreAuto: 75 },
      summary: { pendingCount: 1, scoreFinal: null },
    });
    expect(await oneRecord()).toMatchObject({
      answersReleased: true,
      score: 75,
      pendingCount: 1,
      resultCounts: { pendingCount: 1 },
    });
    const patchAssignment = (answerRelease: string) =>
      call(`/api/teacher/assignments/${assignment}`, world.teacher, "PATCH", {
        answerRelease,
      });
    expect((await patchAssignment("after_due")).status).toBe(200);
    expect(await oneRecord()).toMatchObject({
      answersReleased: false,
      pendingCount: null,
      resultCounts: null,
    });
    expect((await patchAssignment("on_submit")).status).toBe(200);
    const repeated = await call(
      `${root}/submit`,
      world.ownerCookie,
      "POST",
      request,
    );
    expect(repeated.status).toBe(409);
    expect(
      z.object({ error: z.string() }).parse(await repeated.json()).error,
    ).toBe("ALREADY_SUBMITTED");
    const downloaded = await call(
      "/api/teacher/backup/download",
      world.teacher,
    );
    expect(downloaded.status, await downloaded.clone().text()).toBe(200);
    const zip = new File(
      [new Uint8Array(await downloaded.arrayBuffer())],
      "judge.zip",
      {
        type: "application/zip",
      },
    );
    const form = new FormData();
    form.set("zip", zip);
    form.set("password", "teacher-pass-8");
    const restored = await app.request("/api/teacher/backup/restore", {
      method: "POST",
      headers: { cookie: world.teacher },
      body: form,
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(
      pendingSchema.parse(await (await call(pendingPath, world.teacher)).json())
        .data.marks,
    ).toEqual(pending);
    expect(
      attemptResultOkSchema.parse(
        await (await call(root, world.ownerCookie)).json(),
      ).data,
    ).toEqual(published);
    expect(
      handle.db.$client
        .prepare("SELECT score_auto, score_final FROM attempts WHERE id=?")
        .get(attempt.id),
    ).toEqual({ score_auto: null, score_final: null });
  } finally {
    handle.close();
  }
});
