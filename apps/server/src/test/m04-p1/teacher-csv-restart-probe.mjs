import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  assignmentCreateOkSchema,
  attemptStartOkSchema,
} from "@tutor/contract";
import { createDb } from "../../db/client.ts";
import { extractSessionToken } from "../note-world.ts";
import { submitAttemptRequest } from "../submit-revisions.ts";
import { postAssignment, setupAssignment } from "./product-fixture.ts";
import { createRealServiceFixture } from "./real-service-fixture.mjs";

const service = await createRealServiceFixture();
const { app, dataDir, boot, stop } = service;
const far = "2099-01-01T00:00:00.000Z";
const past = "2000-01-01T00:00:00.000Z";
async function status(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  return response;
}
function dbRead(f) {
  const db = createDb(join(dataDir, "tutor.db"));
  try {
    return f(db.$client);
  } finally {
    db.$client.close();
  }
}

try {
  const firstPid = await boot(true);
  const world = await setupAssignment(app);
  const { teacher, ownerCookie, otherCookie } = world;
  const call = (path, cookie = teacher, method = "GET", body) =>
    app.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const makeCourse = async (title) => {
    const created = await status(
      await call("/api/teacher/courses", teacher, "POST", { title }),
      201,
    );
    const { id } = (await created.json()).data;
    await status(
      await call(`/api/teacher/courses/${id}/members`, teacher, "POST", {
        studentIds: [world.studentId, world.otherStudentId],
      }),
      200,
    );
    return id;
  };
  const legacyCourse = await makeCourse("CSV旧课");
  const kernelCourse = await makeCourse("CSV内核课");
  const assign = async (courseId, useKernel) => {
    const created = await status(
      await call("/api/teacher/assignments", teacher, "POST", {
        title: useKernel ? "CSV内核卷" : "CSV旧卷",
        courseId,
        unitIds: [world.unitId],
        studentIds: [world.studentId, world.otherStudentId],
        dueAt: far,
        answerRelease: "after_due",
        allowRedo: false,
        ...(useKernel ? { executionBackend: "kernel" } : {}),
      }),
      201,
    );
    return assignmentCreateOkSchema.parse(await created.json()).data
      .assignments[0].id;
  };
  const oldAssignment = await assign(legacyCourse, false);
  const kernelAssignment = await assign(kernelCourse, true);
  const open = async (id, cookie = ownerCookie) => {
    const opened = await status(await postAssignment(app, id, cookie), 200);
    return attemptStartOkSchema.parse(await opened.json()).data;
  };
  async function fill(id) {
    for (const [question, index] of [
      ["m04-p0-q1", 1],
      ["m04-p0-q2", 0],
    ]) {
      await status(
        await call(
          `/api/student/attempts/${id}/answers/${question}`,
          ownerCookie,
          "PUT",
          {
            answer: { kind: "choice", index },
          },
        ),
        200,
      );
    }
  }

  const legacy = await open(oldAssignment);
  await fill(legacy.id);
  await status(await submitAttemptRequest(app, ownerCookie, legacy.id), 200);
  const current = await open(kernelAssignment);
  await fill(current.id);
  await open(kernelAssignment, otherCookie);
  const from = new Date().toISOString();
  assert.ok(from > current.startedAt);
  dbRead((db) =>
    db.exec(`
    CREATE TRIGGER interrupt_csv_projection BEFORE UPDATE OF status ON attempts
    WHEN NEW.status = 'graded'
    BEGIN SELECT RAISE(ABORT, 'interrupted csv projection'); END
  `),
  );
  try {
    await status(await submitAttemptRequest(app, ownerCookie, current.id), 500);
  } finally {
    dbRead((db) => db.exec("DROP TRIGGER interrupt_csv_projection"));
  }
  const host = () =>
    dbRead((db) =>
      db
        .prepare(
          "SELECT status, submitted_at, score_auto, score_final FROM attempts WHERE id = ?",
        )
        .get(current.id),
    );
  assert.equal(host().status, "draft");

  const otherTeacherResponse = await status(
    await call("/api/public/teacher/register", "", "POST", {
      loginName: "CSV他教师",
      password: "other-teacher-8",
    }),
    200,
  );
  const otherTeacher = `tutor_session=${extractSessionToken(otherTeacherResponse)}`;
  await stop();
  const secondPid = await boot(false);
  assert.notEqual(firstPid, secondPid);

  const pathOf = (params = {}) =>
    `/api/teacher/export/csv?${new URLSearchParams(params)}`;
  async function download(params, cookie = teacher) {
    const response = await status(await call(pathOf(params), cookie), 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/csv; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      response.headers.get("content-disposition"),
      /^attachment; filename="tutor-export-\d{8}-\d{6}\.csv"$/,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
    const text = bytes.subarray(3).toString("utf8");
    assert.ok(!text.replaceAll("\r\n", "").includes("\n"));
    const [header, ...lines] = text.split("\r\n");
    const rows = lines.map((line) => line.split(","));
    assert.equal(header.split(",").length, 24);
    assert.ok(rows.every((row) => row.length === 24));
    return { header, rows, text };
  }
  const summary = ({ rows }) =>
    rows.map((row) => [row[6], ...row.slice(10, 14), row[16]]);
  const old = await download({
    courseId: legacyCourse,
    studentId: world.studentId,
  });
  const filters = {
    assignmentId: kernelAssignment,
    courseId: kernelCourse,
    studentId: world.studentId,
    sourceType: "assignment",
  };
  const recovered = await download({ ...filters, from });
  const expected = [
    ["1", "B", "答对", "答对", "自动", "1"],
    ["2", "A", "答错", "答错", "自动", "1"],
  ];
  console.log(
    JSON.stringify({
      firstPid,
      secondPid,
      old: summary(old),
      candidate: summary(recovered),
      header: recovered.header,
      host: host(),
    }),
  );
  assert.deepEqual(summary(old), expected);
  assert.deepEqual(summary(recovered), expected);
  assert.equal(recovered.header, old.header);
  assert.ok(
    recovered.rows.every(
      (row) => row[2] === "CSV内核课" && row[3] === "CSV内核卷",
    ),
  );
  const submittedAt = host().submitted_at;
  assert.ok(submittedAt >= from);
  assert.deepEqual(
    (await download({ ...filters, from: submittedAt, to: submittedAt })).rows,
    recovered.rows,
  );
  assert.equal(
    (await download({ ...filters, studentId: world.otherStudentId })).rows
      .length,
    0,
  );
  assert.equal(
    (await download({ ...filters, sourceType: "course" })).rows.length,
    0,
  );
  assert.equal((await download(filters, otherTeacher)).rows.length, 0);
  await status(await call(pathOf(filters), ownerCookie), 401);

  for (const dueAt of [past, far]) {
    await status(
      await call(
        `/api/teacher/assignments/${kernelAssignment}`,
        teacher,
        "PATCH",
        { dueAt },
      ),
      200,
    );
    assert.deepEqual(await download(filters), recovered);
  }

  const path = join(dataDir, "learning-kernel.sqlite");
  const offlinePath = join(dataDir, "learning-kernel-offline.sqlite");
  renameSync(path, offlinePath);
  try {
    const unavailable = await status(await call(pathOf(filters)), 503);
    const error = await unavailable.json();
    assert.equal(error.error, "KERNEL_ATTEMPT_UNAVAILABLE");
    assert.ok(!Object.hasOwn(error, "data"));
    assert.deepEqual(await download({ courseId: legacyCourse }), old);
    assert.equal((await download({ ...filters, to: past })).rows.length, 0);
    assert.equal((await download({ ...filters, from: far })).rows.length, 0);
    assert.equal((await download(filters, otherTeacher)).rows.length, 0);
  } finally {
    renameSync(offlinePath, path);
  }
  assert.deepEqual(host(), {
    status: "graded",
    submitted_at: submittedAt,
    score_auto: null,
    score_final: null,
  });
  assert.deepEqual(
    dbRead((db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM responses WHERE attempt_id=? AND (answer_json IS NOT NULL OR auto_correct IS NOT NULL OR final_correct IS NOT NULL OR change_count <> 0)",
        )
        .get(current.id),
    ),
    { n: 0 },
  );
  await status(await call("/api/teacher/logout", teacher, "POST"), 200);
  await status(await call(pathOf(filters)), 401);
  console.log(
    "教师 CSV 的 24 列、提交时间边界、公布控制、权限和内核离线范围均通过",
  );
} finally {
  await service.close();
}
