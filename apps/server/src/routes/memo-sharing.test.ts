import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { expect, it } from "vitest";
import { createApp } from "../app";
import { createStudentSession, createTeacherSession } from "../auth/session";
import { teachers } from "../db/schema";
import { createTestDb, createTestDir, TEST_TEACHER_ID } from "../db/test-utils";
import { MEMO_TEST_PNG } from "../services/memo-format.test";
import { createMediaMemo, createTextMemo } from "../services/memo-service";
import { assertNoLeak } from "../test/assert-no-leak";
import { makeStudent } from "../test/note-fixtures";

it("真实路由逐条分享/撤回与媒体GET HEAD Range实时鉴权，普通学生出口防泄露", async () => {
  const db = createTestDb();
  db.update(teachers)
    .set({ passwordHash: "test-session-enabled" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const other = makeStudent(db);
  const app = createApp({
    db,
    dataDir,
    isProduction: false,
    publicUrl: "http://localhost",
    logger: pino({ enabled: false }),
  });
  const own = `tutor_student_session=${createStudentSession(db, studentId).token}`;
  const foreign = `tutor_student_session=${createStudentSession(db, other).token}`;
  const teacher = `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`;
  const media = createMediaMemo(db, dataDir, {
    studentId,
    clientId: randomUUID(),
    kind: "image",
    bytes: MEMO_TEST_PNG,
    text: "已分享",
  }).memo;
  createTextMemo(db, { studentId, clientId: randomUUID(), text: "私密哨兵" });
  const base = `/api/teacher/students/${studentId}/memos`;
  const list = () => app.request(base, { headers: { cookie: teacher } });
  expect(await (await list()).json()).toMatchObject({ data: { memos: [] } });
  const share = `/api/student/memos/${media.id}/share`;
  expect(
    (
      await app.request(share, {
        method: "PUT",
        headers: { cookie: foreign, "content-type": "application/json" },
        body: JSON.stringify({ teacherId: TEST_TEACHER_ID }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(share, {
        method: "PUT",
        headers: { cookie: own, "content-type": "application/json" },
        body: JSON.stringify({ teacherId: TEST_TEACHER_ID }),
      })
    ).status,
  ).toBe(200);
  const body: unknown = await (await list()).json();
  assertNoLeak(body);
  expect(JSON.stringify(body)).not.toContain("私密哨兵");
  for (const method of ["GET", "HEAD"]) {
    const result = await app.request(`${base}/${media.id}/media`, {
      method,
      headers: { cookie: teacher, Range: "bytes=0-4" },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(
    (await app.request(share, { method: "DELETE", headers: { cookie: own } }))
      .status,
  ).toBe(200);
  for (const method of ["GET", "HEAD"])
    expect(
      (
        await app.request(`${base}/${media.id}/media`, {
          method,
          headers: { cookie: teacher },
        })
      ).status,
    ).toBe(404);
});
