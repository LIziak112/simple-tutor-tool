import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../app";
import { createStudentSession } from "../auth/session";
import { courseItems, courseStudents, students, units } from "../db/schema";
import { createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { createTextMemo } from "../services/memo-service";
import { assertNoLeak } from "../test/assert-no-leak";
import { memoSourceFixture } from "../test/memo-source-fixtures";

function fixture() {
  const f = memoSourceFixture();
  const app = createApp({
    db: f.db,
    dataDir: createTestDir(),
    isProduction: false,
    publicUrl: "http://localhost",
    logger: pino({ enabled: false }),
  });
  const own = `tutor_student_session=${createStudentSession(f.db, f.studentId).token}`;
  const other = `tutor_student_session=${createStudentSession(f.db, f.otherId).token}`;
  f.db
    .update(students)
    .set({ note: "PRIVATE_TEACHER_NOTE" })
    .where(eq(students.id, f.studentId))
    .run();
  return { ...f, app, own, other };
}
async function safeJson(response: Response, status = 200) {
  expect(response.status).toBe(status);
  const body: unknown = await response.json();
  assertNoLeak(body, {
    forbid: [
      "stemMd",
      "questions",
      "responses",
      "context",
      "deviceId",
      "parentMemoSeq",
      "agentRequestDigest",
      "note",
      "seq",
    ],
  });
  const raw = JSON.stringify(body);
  for (const secret of [
    "SECRET_ANSWER_SENTINEL",
    "SECRET_SOLUTION_SENTINEL",
    "SECRET_SOURCE_SENTINEL",
    "PRIVATE_TEACHER_NOTE",
    "OTHER_PRIVATE_TAG",
  ])
    expect(raw).not.toContain(secret);
  return body;
}
it("新增学生出口tags/source-target/share GET PUT DELETE逐一验证完整HTTP响应防泄露", async () => {
  const f = fixture();
  createTextMemo(f.db, {
    studentId: f.studentId,
    clientId: randomUUID(),
    text: "本人",
    tags: ["公开标签"],
  });
  createTextMemo(f.db, {
    studentId: f.otherId,
    clientId: randomUUID(),
    text: "他人",
    tags: ["OTHER_PRIVATE_TAG"],
  });
  const get = (path: string, cookie = f.own) =>
    f.app.request(path, { headers: { cookie } });
  expect(await safeJson(await get("/api/student/memos/tags"))).toMatchObject({
    data: { tags: ["公开标签"] },
  });
  const path = `/api/student/memos/${f.memo.id}`;
  expect(await safeJson(await get(`${path}/source-target`))).toMatchObject({
    data: { kind: "unit" },
  });
  expect(await safeJson(await get(`${path}/share`))).toMatchObject({
    data: { teacherId: null, availableTeacherId: TEST_TEACHER_ID },
  });
  const put = (cookie: string) =>
    f.app.request(`${path}/share`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ teacherId: TEST_TEACHER_ID }),
    });
  expect(await safeJson(await put(f.own))).toMatchObject({
    data: { teacherId: TEST_TEACHER_ID },
  });
  await safeJson(await get(`${path}/share`));
  await safeJson(
    await f.app.request(`${path}/share`, {
      method: "DELETE",
      headers: { cookie: f.own },
    }),
  );
  expect(await safeJson(await get(`${path}/share`))).toMatchObject({
    data: { teacherId: null },
  });
  await safeJson(await get(`${path}/source-target`, f.other), 404);
  await safeJson(await get(`${path}/share`, f.other), 404);
  await safeJson(await put(f.other), 404);
  await safeJson(
    await f.app.request(`${path}/share`, {
      method: "DELETE",
      headers: { cookie: f.other },
    }),
    404,
  );
});
it.each(["隐藏", "删除", "移课", "撤权"] as const)(
  "来源%s不投影未公布答案或私注，保留安全降级",
  async (mode) => {
    const f = fixture();
    // 即使已有同题有效作业，当前单元或课程撤权后也不向它导航。
    f.makeAttempt();
    if (mode === "隐藏")
      f.db
        .update(courseItems)
        .set({ visible: false })
        .where(eq(courseItems.id, f.itemId))
        .run();
    if (mode === "删除")
      f.db
        .update(units)
        .set({ deletedAt: new Date().toISOString() })
        .where(
          and(eq(units.id, f.unitId), eq(units.teacherId, TEST_TEACHER_ID)),
        )
        .run();
    if (mode === "移课")
      f.db
        .update(courseItems)
        .set({ courseId: f.otherCourseId })
        .where(eq(courseItems.id, f.itemId))
        .run();
    if (mode === "撤权")
      f.db
        .delete(courseStudents)
        .where(
          and(
            eq(courseStudents.courseId, f.courseId),
            eq(courseStudents.studentId, f.studentId),
          ),
        )
        .run();
    const response = await f.app.request(
      `/api/student/memos/${f.memo.id}/source-target`,
      { headers: { cookie: f.own } },
    );
    expect(await safeJson(response)).toMatchObject({
      data: { kind: mode === "撤权" ? "unavailable" : "course" },
    });
  },
);
