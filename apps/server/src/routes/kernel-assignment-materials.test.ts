import { randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttemptContextData,
  adminTeacherCreateOkSchema,
  attemptContextOkSchema,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  studentAssignmentListOkSchema,
  studentPaperOkSchema,
} from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import pino from "pino";
import { expect, it, vi } from "vitest";
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
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions.ts";

const privateSolution = "仅教师解析占位";
function expectPublicPayload(payload: unknown) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain(privateSolution);
  expect(json).not.toMatch(
    /sourceMd|acceptedChoice|acceptedResponse|acceptedByQuestion|scoringKey|\[\[正确\]\]|\[x\]/,
  );
}

const markdown = (version: number, mixed: boolean) =>
  [
    "---",
    "kind: practice",
    "unit: 两份材料",
    "---",
    "",
    "::::material{id=ctx-one}",
    "合成阅读甲 V1",
    "::::",
    "",
    "::::material{id=ctx-two}",
    `合成阅读乙 V${version}`,
    "::::",
    "",
    "::::group{id=ctx-group}",
    "::ref{material=ctx-one}",
    "::ref{material=ctx-two}",
    "::ref{question=mt-q1}",
    "::ref{question=mt-q2}",
    "::::",
    "",
    "::::question{id=mt-q1 type=choice}",
    "第一道普通单选。",
    "",
    "- [ ] 甲",
    "- [x] 乙",
    "",
    ":::solution",
    privateSolution,
    ":::",
    "::::",
    "",
    ...(mixed
      ? [
          "::::question{id=mt-q2 type=judge}",
          "第二道普通判断。[[正确]]",
          "::::",
        ]
      : [
          "::::question{id=mt-q2 type=choice}",
          "第二道普通单选。",
          "",
          "- [x] 甲",
          "- [ ] 乙",
          "::::",
        ]),
  ].join("\n");

it.each([
  { name: "普通单选", mixed: false },
  { name: "单选与判断混合整卷", mixed: true },
])("两份材料按开卷版本冻结，$name 经正式入口恢复", async ({ mixed }) => {
  vi.stubEnv("NEW_CONTENT_ENABLED", "true");
  using data = mkdtempDisposableSync(join(tmpdir(), "ownclass-k15-material-"));
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
    const foreignTeacherName = "合成异域教师";
    const newTeacher = await call(
      "/api/admin/teachers",
      world.teacher,
      "POST",
      { loginName: foreignTeacherName },
    );
    expect(newTeacher.status, await newTeacher.clone().text()).toBe(201);
    const { initialPassword } = adminTeacherCreateOkSchema.parse(
      await newTeacher.json(),
    ).data;
    const login = await call("/api/public/teacher/login", "", "POST", {
      loginName: foreignTeacherName,
      password: initialPassword,
    });
    expect(login.status).toBe(200);
    const foreignTeacher = `tutor_session=${extractSessionToken(login)}`;
    const foreignName = "合成异域学生";
    await createStudent(app, foreignTeacher, foreignName);
    const foreignStudent = await loginStudent(app, foreignName);
    const importUnit = async (version: number) => {
      const imported = await call(
        "/api/teacher/import/commit",
        world.teacher,
        "POST",
        {
          markdown: markdown(version, mixed),
          filename: "两份材料.md",
        },
      );
      expect(imported.status, await imported.clone().text()).toBe(200);
      const shape = z.object({
        data: z.object({ units: z.tuple([z.object({ id: z.string() })]) }),
      });
      return shape.parse(await imported.json()).data.units[0].id;
    };
    const unitId = await importUnit(1);

    const resultPolicy = {
      dueAt: "2099-01-01T00:00:00.000Z",
      answerRelease: "after_due",
    } as const;
    const assignment = await assignKernelFixture(
      app,
      { ...world, unitId },
      resultPolicy,
    );
    const toRefreeze = await assignKernelFixture(app, { ...world, unitId });
    const owner = world.ownerCookie;
    const other = world.otherCookie;
    const open = async (id: string, cookie: string) => {
      const response = await postAssignment(app, id, cookie);
      expect(response.status, await response.clone().text()).toBe(200);
      return attemptStartOkSchema.parse(await response.json()).data;
    };
    const root = (id: string) => `/api/student/attempts/${id}`;
    const context = async (id: string, cookie: string) => {
      const response = await call(`${root(id)}/context`, cookie);
      expect(response.status, await response.clone().text()).toBe(200);
      const raw = await response.json();
      expectPublicPayload(raw);
      return attemptContextOkSchema.parse(raw).data;
    };
    const versions = (data: AttemptContextData) =>
      data.materials.map(({ id, sourceVersion, contentMd }) => [
        id,
        sourceVersion,
        contentMd.trim(),
      ]);
    const expectedMaterials = (version: number) => [
      ["ctx-one", 1, "合成阅读甲 V1"],
      ["ctx-two", version, `合成阅读乙 V${version}`],
    ];
    const listing = await call("/api/student/assignments", owner);
    expect(listing.status, await listing.clone().text()).toBe(200);
    expect(
      studentAssignmentListOkSchema.parse(await listing.json()).data
        .assignments,
    ).toContainEqual(expect.objectContaining({ id: assignment }));
    const original = await open(assignment, owner);
    expect(
      (await call(`${root(original.id)}/context`, foreignStudent)).status,
    ).toBe(403);
    const paper = await call(`${root(original.id)}/paper`, owner);
    expect(paper.status, await paper.clone().text()).toBe(200);
    const paperRaw = await paper.json();
    expectPublicPayload(paperRaw);
    expect(
      studentPaperOkSchema
        .parse(paperRaw)
        .data.units.flatMap(({ questions }) => questions)
        .map(({ id, type }) => [id, type]),
    ).toEqual([
      ["mt-q1", "choice"],
      ["mt-q2", mixed ? "judge" : "choice"],
    ]);
    const prepared = await open(toRefreeze, owner);
    const toOpen = await assignKernelFixture(app, { ...world, unitId });
    handle.db.$client.exec(
      "CREATE TRIGGER interrupt_material_opening BEFORE INSERT ON attempts " +
        "BEGIN SELECT RAISE(ABORT, '切断宿主开卷投影'); END",
    );
    expect((await postAssignment(app, toOpen, owner)).status).toBe(500);
    expect(
      handle.db.$client
        .prepare(
          "SELECT practice_version AS version FROM kernel_assignment_openings WHERE assignment_id=? AND student_id=?",
        )
        .get(toOpen, world.studentId),
    ).toEqual({ version: 1 });
    expect(
      handle.db.$client
        .prepare("SELECT id FROM attempts WHERE assignment_id=?")
        .get(toOpen),
    ).toBeUndefined();
    handle.db.$client.exec("DROP TRIGGER interrupt_material_opening");
    const oldContext = await context(original.id, owner);
    expect(versions(oldContext)).toEqual(expectedMaterials(1));
    expect(oldContext.groups).toEqual([
      expect.objectContaining({
        id: "ctx-group",
        sourceVersion: 1,
        materialRefs: [{ material: "ctx-one" }, { material: "ctx-two" }],
        questionIds: ["mt-q1", "mt-q2"],
      }),
    ]);
    const revisions = await fetchSubmitRevisions(app, owner, original.id);
    expect(revisions.map(({ questionId }) => questionId)).toEqual([
      "mt-q1",
      "mt-q2",
    ]);
    const savedAnswers = [
      { kind: "choice", index: 1 },
      mixed ? { kind: "judge", value: true } : { kind: "choice", index: 0 },
    ];
    for (const [index, item] of revisions.entries()) {
      const save = await call(
        `${root(original.id)}/answers/${item.questionId}`,
        owner,
        "PUT",
        {
          answer: savedAnswers[index],
          baseRevision: 0,
          mutationId: randomUUID(),
          expectedFrozenAt: original.frozenAt,
          questionRevisionId: item.questionRevisionId,
        },
      );
      expect(save.status, await save.clone().text()).toBe(200);
    }
    expect(await importUnit(2)).toBe(unitId);
    const reopened = await open(assignment, owner);
    expect({ id: reopened.id, frozenAt: reopened.frozenAt }).toEqual({
      id: original.id,
      frozenAt: original.frozenAt,
    });
    expect(await context(reopened.id, owner)).toEqual(oldContext);
    const draft = await call(root(reopened.id), owner);
    expect(draft.status, await draft.clone().text()).toBe(200);
    const draftRaw = await draft.json();
    expectPublicPayload(draftRaw);
    expect(attemptDraftOkSchema.parse(draftRaw).data).toMatchObject({
      drafts: { "mt-q1": savedAnswers[0], "mt-q2": savedAnswers[1] },
    });
    const opened = await open(toOpen, owner);
    expect(versions(await context(opened.id, owner))).toEqual(
      expectedMaterials(1),
    );
    const replay = openLearningRuntime({
      databasePath: join(data.path, "learning-kernel.sqlite"),
    });
    try {
      const receipt = replay.prepare(
        { role: "student", id: world.studentId },
        {
          protocolVersion: 1,
          operationId: `open:${toOpen}`,
          practiceId: toOpen,
          practiceVersion: 1,
        },
      );
      expect(receipt).toMatchObject({
        activityId: opened.id,
        startedAt: opened.startedAt,
      });
    } finally {
      replay.close();
    }
    expect(await context(original.id, owner)).toEqual(oldContext);
    const fresh = await open(assignment, other);
    expect(versions(await context(fresh.id, other))).toEqual(
      expectedMaterials(2),
    );
    const boundActivities = () =>
      openLearningRuntime({
        databasePath: join(data.path, "learning-kernel.sqlite"),
        authorizeConfirmationRecovery: (scope) =>
          scope.studentId === world.studentId &&
          scope.activityId === original.id,
      });
    const kernelRead = (id: string, studentId: string) => {
      const runtime = boundActivities();
      try {
        return runtime.read({ role: "student", id: studentId }, id);
      } finally {
        runtime.close();
      }
    };
    const materialsIn = (activity: ReturnType<typeof kernelRead>) => {
      expectPublicPayload(activity);
      if (!("inputs" in activity)) throw new Error("找不到冻结材料位置");
      return Object.entries(activity.inputs)
        .flatMap(([inputName, input]) => {
          if (input.from !== "material" || !input.material) return [];
          expect(inputName).toBe(input.positionId);
          return [{ ...input.material, positionId: input.positionId }];
        })
        .sort((a, b) => a.source.localeCompare(b.source));
    };
    const previousPositions = materialsIn(
      kernelRead(original.id, world.studentId),
    );
    const nextPositions = materialsIn(
      kernelRead(fresh.id, world.otherStudentId),
    );
    expect(
      previousPositions.map(({ source, version }) => [source, version]),
    ).toEqual([
      ["ctx-one", 1],
      ["ctx-two", 1],
    ]);
    expect(
      new Set(previousPositions.map(({ positionId }) => positionId)).size,
    ).toBe(2);
    expect(nextPositions).toEqual([
      previousPositions[0],
      {
        ...previousPositions[1],
        version: 2,
        paragraphs: [{ id: "content", text: "合成阅读乙 V2" }],
      },
    ]);

    handle.db.$client.exec(
      "CREATE TRIGGER interrupt_material_refreeze BEFORE UPDATE OF frozen_at ON attempts " +
        "BEGIN SELECT RAISE(ABORT, '切断宿主材料投影'); END",
    );
    const interrupted = await postAssignment(app, toRefreeze, owner);
    expect(interrupted.status).toBe(500);
    const binding = handle.db.$client.prepare(
      "SELECT practice_version AS version FROM kernel_attempt_bindings WHERE attempt_id=?",
    );
    expect(binding.get(prepared.id)).toEqual({ version: 1 });
    expect(kernelRead(prepared.id, world.studentId)).toMatchObject({
      practiceVersion: 2,
    });
    expect(materialsIn(kernelRead(prepared.id, world.studentId))).toEqual(
      nextPositions,
    );
    handle.db.$client.exec("DROP TRIGGER interrupt_material_refreeze");
    expect(await importUnit(3)).toBe(unitId);
    const adminId = z
      .uuid()
      .parse(
        handle.db.$client
          .prepare("SELECT id FROM teachers WHERE is_admin=1")
          .pluck()
          .get(),
      );
    handle.close();
    handle = reopen();
    app = create(adminId);
    const forbidden = await call(`${root(prepared.id)}/context`, other);
    expect(forbidden.status).toBe(403);
    expect(
      (await call(`${root(prepared.id)}/context`, foreignStudent)).status,
    ).toBe(403);
    const currentBinding = () =>
      handle.db.$client
        .prepare(
          "SELECT practice_version AS version FROM kernel_attempt_bindings WHERE attempt_id=?",
        )
        .get(prepared.id);
    expect(currentBinding()).toEqual({ version: 1 });
    expect(versions(await context(prepared.id, owner))).toEqual(
      expectedMaterials(2),
    );
    expect(currentBinding()).toEqual({ version: 2 });
    expect(await context(original.id, owner)).toEqual(oldContext);
    expect(versions(await context(fresh.id, other))).toEqual(
      expectedMaterials(2),
    );

    const submission = {
      revisions: await fetchSubmitRevisions(app, owner, original.id),
    };
    const submitted = await call(
      `${root(original.id)}/submit`,
      owner,
      "POST",
      submission,
    );
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const hiddenRaw = await submitted.json();
    expectPublicPayload(hiddenRaw);
    const hidden = attemptResultOkSchema.parse(hiddenRaw).data;
    expect(hidden.answersReleased).toBe(false);
    expect(hidden.attempt.scoreAuto).toBeNull();
    expect(
      hidden.units
        .flatMap(({ questions }) => questions)
        .map(({ answers, autoCorrect, solutionMd }) => [
          answers,
          autoCorrect,
          solutionMd,
        ]),
    ).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
    expect(await context(original.id, owner)).toEqual(oldContext);
    const publish = await call(
      `/api/teacher/assignments/${assignment}`,
      world.teacher,
      "PATCH",
      { answerRelease: "on_submit" },
    );
    expect(publish.status).toBe(200);
    const published = async () => {
      const response = await call(root(original.id), owner);
      expect(response.status).toBe(200);
      return attemptResultOkSchema.parse(await response.json()).data;
    };
    const result = await published();
    expect(result.attempt.scoreAuto).toBe(100);
    expect(result.units[0]?.questions[0]?.solutionMd).toBe(privateSolution);
    expect(
      result.units
        .flatMap(({ questions }) => questions)
        .map(({ autoCorrect }) => autoCorrect),
    ).toEqual([true, true]);
    const bindingSchema = z.object({
      operationId: z.string(),
      stepAttemptId: z.uuid(),
    });
    const readReceipt = () => {
      const confirmationTable = mixed
        ? "kernel_question_deliveries"
        : "kernel_attempt_confirmations";
      const [ticket] = z
        .tuple([bindingSchema])
        .parse(
          handle.db.$client
            .prepare(
              `SELECT operation_id AS operationId, step_attempt_id AS stepAttemptId FROM ${confirmationTable} WHERE attempt_id=?`,
            )
            .all(original.id),
        );
      const runtime = boundActivities();
      try {
        const actor = { role: "student", id: world.studentId } as const;
        const key = { protocolVersion: 1, ...ticket } as const;
        return mixed
          ? runtime.recoverQuestionDelivery(actor, original.id, key).receipt
          : runtime.recoverChoiceConfirmation(actor, original.id, key).receipt;
      } finally {
        runtime.close();
      }
    };
    const receipt = readReceipt();
    expect(receipt).toMatchObject({
      id: expect.any(String),
      confirmedAt: result.attempt.submittedAt,
    });
    const repeated = await call(
      `${root(original.id)}/submit`,
      owner,
      "POST",
      submission,
    );
    expect(repeated.status).toBe(409);
    expect(
      z.object({ error: z.string() }).parse(await repeated.json()).error,
    ).toBe("ALREADY_SUBMITTED");

    expect(readReceipt()).toEqual(receipt);
    if (mixed) {
      expect(
        handle.db.$client
          .prepare(
            "SELECT id FROM attempt_settlements WHERE attempt_id=? AND kind='final'",
          )
          .all(original.id),
      ).toHaveLength(1);
    }

    const backupRoute = "/api/teacher/backup";
    const download = await call(`${backupRoute}/download`, world.teacher);
    expect(download.status, await download.clone().text()).toBe(200);
    const zip = new File(
      [new Uint8Array(await download.arrayBuffer())],
      "materials.zip",
      { type: "application/zip" },
    );
    handle.db.$client
      .prepare(
        "UPDATE attempt_context_snapshots SET snapshot_json=json_set(snapshot_json,'$.contentMd','受控错配') " +
          "WHERE attempt_id=? AND kind='material' AND source_id='ctx-two'",
      )
      .run(fresh.id);
    expect((await call(`${root(fresh.id)}/context`, other)).status).toBe(503);
    expect((await call(`${backupRoute}/download`, world.teacher)).status).toBe(
      500,
    );
    const form = new FormData();
    form.set("zip", zip);
    form.set("password", "teacher-pass-8");
    const restored = await app.request(`${backupRoute}/restore`, {
      method: "POST",
      headers: { cookie: world.teacher },
      body: form,
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await published()).toEqual(result);
    expect(readReceipt()).toEqual(receipt);
    expect(await context(original.id, owner)).toEqual(oldContext);
    expect(versions(await context(fresh.id, other))).toEqual(
      expectedMaterials(2),
    );
    expect(versions(await context(prepared.id, owner))).toEqual(
      expectedMaterials(2),
    );
  } finally {
    handle.close();
    vi.unstubAllEnvs();
  }
});
