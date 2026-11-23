import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { attemptStartOkSchema, studentRecordsOkSchema } from "@tutor/contract";
import { openLearningRuntime } from "learning-kernel";
import { createDb } from "../../db/client.ts";
import { assertNoLeak } from "../assert-no-leak.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import {
  assignKernelFixture,
  postAssignment,
  setupAssignment,
} from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;

function readProduct(read) {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return read(db.$client);
  } finally {
    db.$client.close();
  }
}

async function interrupt(trigger, run) {
  readProduct((db) =>
    db.exec(`
    CREATE TRIGGER fail_record_projection ${trigger}
    BEGIN SELECT RAISE(ABORT, 'interrupted record projection'); END
  `),
  );
  try {
    const result = await run();
    assert.equal(result.status, 500, await result.clone().text());
  } finally {
    readProduct((db) => db.exec("DROP TRIGGER fail_record_projection"));
  }
}

async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  return response;
}

try {
  const before = await boot(true);
  const world = await setupAssignment(app);
  const { ownerCookie, otherCookie, teacher } = world;
  const finalAssignment = await assignKernelFixture(app, world, {
    dueAt: "2099-01-01T00:00:00.000Z",
    answerRelease: "after_due",
  });
  const activeAssignment = await assignKernelFixture(app, world);
  const openedAssignment = await assignKernelFixture(app, world);
  await assignKernelFixture(app, world);
  const call = (path, cookie = ownerCookie, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async (query = "", cookie = ownerCookie) => {
    const response = await status(
      await call(`/api/student/records?${query}`, cookie),
      200,
    );
    const body = await response.json();
    assertNoLeak(body);
    return studentRecordsOkSchema.parse(body).data;
  };
  const open = async (assignment, cookie = ownerCookie) => {
    const response = await status(
      await postAssignment(app, assignment, cookie),
      200,
    );
    return attemptStartOkSchema.parse(await response.json()).data.id;
  };
  const save = (id, index, cookie = ownerCookie) =>
    call(`/api/student/attempts/${id}/answers/m04-p0-q1`, cookie, "PUT", {
      answer: { kind: "choice", index },
    });

  const legacy = await open(world.assignmentId);
  await status(await save(legacy, 1), 200);
  await status(await submitAttemptRequest(app, ownerCookie, legacy), 200);
  const confirmed = await open(finalAssignment);
  await status(await save(confirmed, 1), 200);
  const active = await open(activeAssignment);
  const opened = await open(openedAssignment);
  const other = await open(activeAssignment, otherCookie);
  await status(await save(other, 0, otherCookie), 200);
  await interrupt(
    "BEFORE UPDATE OF activated_at, last_activity_at ON attempts",
    () => save(active, 0),
  );
  await sleep(10);
  await interrupt(
    "BEFORE UPDATE OF activated_at, last_activity_at ON attempts",
    () => save(active, 1),
  );
  const runtime = openLearningRuntime({
    databasePath: join(dataDir, "learning-kernel.sqlite"),
  });
  let kernelDraftTimes;
  try {
    kernelDraftTimes = runtime.readChoiceDraftActivity(
      { role: "student", id: world.studentId },
      active,
    );
    assert.ok(kernelDraftTimes.firstChangedAt < kernelDraftTimes.lastChangedAt);
  } finally {
    runtime.close();
  }
  await interrupt(
    "BEFORE UPDATE OF status ON attempts WHEN NEW.status = 'graded'",
    () => submitAttemptRequest(app, ownerCookie, confirmed),
  );
  const host = (id) =>
    readProduct((db) =>
      db
        .prepare(
          "SELECT status, activated_at, last_activity_at, submitted_at, score_auto, score_final FROM attempts WHERE id = ?",
        )
        .get(id),
    );
  assert.equal(host(active).activated_at, null);
  assert.equal(host(confirmed).status, "draft");
  assert.equal(host(opened).activated_at, null);

  const endpoint = (id) => `/api/teacher/assignments/${id}`;
  await status(
    await call(endpoint(finalAssignment), teacher, "PATCH", {
      removeStudentIds: [world.studentId],
      confirmStarted: true,
    }),
    200,
  );

  await stop();
  const after = await boot(false);
  assert.notEqual(before, after);

  const first = await list("status=graded&sort=started_desc&limit=1");
  const afterOffset = await list("limit=1&offset=1");
  const mixed = await list("sourceType=assignment");
  const activeOnly = await list(
    new URLSearchParams({
      assignmentId: activeAssignment,
      status: "draft",
      from: kernelDraftTimes.lastChangedAt,
      to: kernelDraftTimes.lastChangedAt,
    }),
  );
  const foreign = await list(`assignmentId=${activeAssignment}`, otherCookie);
  const cutoff = await status(
    await call(
      `/api/teacher/assignments/${finalAssignment}`,
      teacher,
      "PATCH",
      {
        dueAt: "2000-01-01T00:00:00.000Z",
      },
    ),
    200,
  );
  assert.ok(cutoff.ok);
  const released = await list(`assignmentId=${finalAssignment}`);
  console.log(
    JSON.stringify({
      before,
      after,
      kernelDraftTimes,
      activeOnly,
      first,
      mixed,
      afterOffset,
      released,
      legacy,
      confirmed,
      active,
      opened,
      foreign,
    }),
  );

  const {
    records: [masked],
  } = first;
  assert.equal(first.total, 2);
  assert.equal(masked.attemptId, confirmed);
  assert.equal(masked.status, "graded");
  assert.equal(masked.answersReleased, false);
  for (const key of [
    "score",
    "resultCounts",
    "pendingCount",
    "pendingSelfReviewCount",
  ])
    assert.equal(masked[key], null);

  assert.equal(mixed.total, 3);
  assert.deepEqual(
    mixed.records.map(({ attemptId }) => attemptId),
    [confirmed, active, legacy],
  );
  assert.deepEqual(
    afterOffset.records.map(({ attemptId }) => attemptId),
    [active],
  );
  assert.equal(afterOffset.total, 3);
  assert.equal(activeOnly.total, 1);
  assert.equal(activeOnly.records[0].attemptId, active);
  assert.equal(
    activeOnly.records[0].lastActivityAt,
    kernelDraftTimes.lastChangedAt,
  );
  assert.deepEqual(activeOnly.records[0].answerProgress, {
    answeredCount: 1,
    totalCount: 2,
  });
  assert.equal(host(active).activated_at, kernelDraftTimes.firstChangedAt);
  assert.equal(host(active).last_activity_at, kernelDraftTimes.lastChangedAt);
  assert.equal(foreign.total, 1);
  assert.equal(foreign.records[0].attemptId, other);

  const {
    records: [result],
  } = released;
  assert.equal(released.total, 1);
  assert.equal(result.score, 50);
  assert.equal(result.answersReleased, true);
  assert.equal(result.pendingCount, 0);
  assert.equal(result.pendingSelfReviewCount, 0);
  assert.deepEqual(result.resultCounts, {
    correctCount: 1,
    totalCount: 2,
    pendingCount: 0,
    pendingSelfReviewCount: 0,
  });
  assert.equal(host(opened).activated_at, null);
  assert.deepEqual(
    ["status", "score_auto", "score_final"].map((key) => host(confirmed)[key]),
    ["graded", null, null],
  );

  assert.deepEqual(
    readProduct((db) =>
      db
        .prepare(`
    SELECT COUNT(*) AS n FROM responses
    WHERE attempt_id IN (?, ?) AND
      (answer_json IS NOT NULL OR answer_revision <> 0 OR auto_correct IS NOT NULL OR final_correct IS NOT NULL)
  `)
        .get(active, confirmed),
    ),
    { n: 0 },
  );
  assert.equal(masked.practiceSubmittedCount, 2);
  assert.equal(masked.settlementCount, 1);
  assert.equal(result.settlementCount, 1);
  await status(
    await call(endpoint(activeAssignment), teacher, "PATCH", {
      removeStudentIds: [world.studentId],
      confirmStarted: true,
    }),
    200,
  );
  assert.equal((await list(`assignmentId=${activeAssignment}`)).total, 0);
  assert.equal(
    (await list(`assignmentId=${finalAssignment}`)).records[0].score,
    50,
  );

  const kernelPath = join(dataDir, "learning-kernel.sqlite");
  const offlinePath = join(dataDir, "learning-kernel-offline.sqlite");
  renameSync(kernelPath, offlinePath);
  try {
    // 旧卷仍可用，且另一名学生不会因相同作业有他人确认而读取内核。
    const legacyOnly = await list(
      `assignmentId=${world.assignmentId}&status=graded`,
    );
    assert.equal(legacyOnly.total, 1);
    assert.equal(legacyOnly.records[0].score, 50);
    assert.equal(
      (await list(`assignmentId=${finalAssignment}`, otherCookie)).total,
      0,
    );
    assert.equal((await list(`assignmentId=${activeAssignment}`)).total, 0);
    const changed = await status(
      await call(`/api/student/records?assignmentId=${finalAssignment}`),
      503,
    );
    const denied = await changed.json();
    assert.equal(denied.error, "KERNEL_ATTEMPT_UNAVAILABLE");
    assert.ok(!Object.hasOwn(denied, "data"));
  } finally {
    renameSync(offlinePath, kernelPath);
  }

  await status(await call("/api/student/logout", ownerCookie, "POST"), 200);
  await status(await call("/api/student/records"), 401);
  console.log("记录恢复、名单可见性、内核离线范围及注销断言均通过");
} finally {
  await service.close();
}
