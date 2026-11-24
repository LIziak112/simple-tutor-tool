import assert from "node:assert/strict";
import {
  apiOkSchema,
  attemptStartOkSchema,
  studentListDataSchema,
  studentMeDataSchema,
  studentResetLinkDataSchema,
  studentResetPasswordDataSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { students } from "../db/schema.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { createChoiceOpenReadFixture } from "../test/m04-p1/open-read-fixture.ts";
import {
  attemptFacts,
  postAssignment,
  setupAssignment,
} from "../test/m04-p1/product-fixture.ts";
import { nodePeerBindings } from "../test/node-peer.ts";
import { extractSessionToken } from "../test/note-world.ts";

let trial: ReturnType<typeof createChoiceOpenReadFixture>;
let fixture: Awaited<ReturnType<typeof setupAssignment>>;

beforeAll(async () => {
  trial = createChoiceOpenReadFixture();
  fixture = await setupAssignment(trial.app);
});

afterAll(() => trial?.close());

async function okData(response: Response) {
  expect(response.status).toBe(200);
  return apiOkSchema.parse(await response.json()).data;
}

async function expectDenied(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  const payload: unknown = await response.json();
  expect(payload).toMatchObject({ ok: false, error });
  expect(payload).not.toHaveProperty("data");
  assertNoLeak(payload, { forbid: ["password"] });
}

it("改链接和口令后仅新凭据能登录，原会话和新会话都仍能读取同一内核作业卷", async () => {
  const { app, db, runtime } = trial;
  const { assignmentId, studentId, ownerCookie, otherCookie, teacher } =
    fixture;
  const opened = await postAssignment(app, assignmentId, ownerCookie);
  expect(opened.status).toBe(200);
  const { id } = attemptStartOkSchema.parse(await opened.json()).data;
  const pathname = `/api/student/attempts/${id}`;
  const original = runtime.read({ role: "student", id: studentId }, id);
  expect(original).toMatchObject({
    inputs: {
      questions: { questions: [expect.any(Object), expect.any(Object)] },
    },
  });

  const roster = await app.request("/api/teacher/students", {
    headers: { cookie: teacher },
  });
  const target = studentListDataSchema
    .parse(await okData(roster))
    .students.find((student) => student.id === studentId);
  assert.ok(target);

  const linkLogin = (linkToken: string) =>
    app.request(`/api/public/s/${linkToken}`);
  const passwordLogin = (password: string) =>
    app.request("/api/public/student/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: target.loginName, password }),
    });
  const reset = (kind: "link" | "password", cookie: string) =>
    app.request(`/api/teacher/students/${studentId}/reset-${kind}`, {
      method: "POST",
      headers: { cookie },
    });

  const loginCookie = async (response: Response) => {
    const data = await okData(response);
    expect(studentMeDataSchema.strict().parse(data).id).toBe(studentId);
    return `tutor_student_session=${extractSessionToken(response, "tutor_student_session")}`;
  };
  const expectOwnerRead = async (cookie: string) => {
    const me = await app.request("/api/student/me", { headers: { cookie } });
    expect(studentMeDataSchema.strict().parse(await okData(me)).id).toBe(
      studentId,
    );
    const read = await app.request(pathname, { headers: { cookie } });
    const data = await okData(read);
    expect(data).toEqual(original);
    assertNoLeak(data, {
      allow: ["answers"],
      forbid: ["password", "scoringKey", "acceptedChoices"],
    });
  };

  const originalLinkCookie = await loginCookie(
    await linkLogin(target.linkToken),
  );
  await expectOwnerRead(ownerCookie);
  await expectOwnerRead(originalLinkCookie);

  const registered = await app.request(
    "/api/public/teacher/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        loginName: "合成他师",
        password: "other-teacher-8",
      }),
    },
    nodePeerBindings("10.0.0.2"),
  );
  expect(registered.status).toBe(200);
  expect(teacherInfoOkSchema.parse(await registered.json()).data.isAdmin).toBe(
    false,
  );
  const foreignTeacher = `tutor_session=${extractSessionToken(registered)}`;

  const getStudentRow = () =>
    db.select().from(students).where(eq(students.id, studentId)).get();
  const originalRow = getStudentRow();
  expect(originalRow).toBeDefined();
  await expectDenied(
    await reset("link", foreignTeacher),
    404,
    "STUDENT_NOT_FOUND",
  );
  await expectDenied(
    await reset("password", foreignTeacher),
    404,
    "STUDENT_NOT_FOUND",
  );
  expect(getStudentRow()).toEqual(originalRow);

  const { linkToken } = studentResetLinkDataSchema.parse(
    await okData(await reset("link", teacher)),
  );
  expect(linkToken === target.linkToken).toBe(false);
  await expectDenied(await linkLogin(target.linkToken), 401, "LINK_INVALID");
  const newLinkCookie = await loginCookie(await linkLogin(linkToken));
  for (const cookie of [ownerCookie, originalLinkCookie, newLinkCookie]) {
    await expectOwnerRead(cookie);
  }

  const { password } = studentResetPasswordDataSchema.parse(
    await okData(await reset("password", teacher)),
  );
  await expectDenied(
    await passwordLogin("stu-pass-6"),
    401,
    "INVALID_CREDENTIALS",
  );
  const newPasswordCookie = await loginCookie(await passwordLogin(password));
  for (const cookie of [
    ownerCookie,
    originalLinkCookie,
    newLinkCookie,
    newPasswordCookie,
  ]) {
    await expectOwnerRead(cookie);
  }
  await expectDenied(
    await app.request(pathname, { headers: { cookie: otherCookie } }),
    403,
    "FORBIDDEN",
  );
  expect(attemptFacts(db)).toMatchObject({ attempts: 0, responses: 0 });
});
