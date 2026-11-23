import { rmSync } from "node:fs";
import {
  apiErrSchema,
  studentMeOkSchema,
  teacherInfoOkSchema,
} from "@tutor/contract";
import pino from "pino";
import { expect, it, onTestFinished } from "vitest";
import { createApp } from "../app.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { createIdentitySessionFixture } from "./identity-session.fixture.ts";

const sessionCookieNames = {
  teacher: "tutor_session",
  student: "tutor_student_session",
};

async function readSubject(
  app: ReturnType<typeof createApp>,
  role: keyof typeof sessionCookieNames,
  cookie: string,
) {
  const response = await app.request(`/api/${role}/me`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const schema = role === "teacher" ? teacherInfoOkSchema : studentMeOkSchema;
  return schema.parse(await response.json()).data.id;
}

it.each([
  ["student", "teacher"],
  ["teacher", "student"],
] as const)(
  "双会话中 %s 注销后保留 %s，另一名学生保持独立",
  async (role, remaining) => {
    const db = createTestDb();
    onTestFinished(() => {
      db.$client.close();
    });
    const dataDir = createTestDir();
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));

    const app = createApp({
      isProduction: false,
      logger: pino({ enabled: false }),
      db,
      dataDir,
      publicUrl: "http://localhost:8787",
    });
    const credentials = { loginName: "teacher", password: "teacher-pass-8" };
    const setup = await app.request("/api/public/teacher/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    expect(setup.status).toBe(200);

    const session = await createIdentitySessionFixture(app, credentials);
    expect(session.teacher.id).toBe(TEST_TEACHER_ID);
    expect(session.student.id).not.toBe(session.otherStudent.id);
    expect(await readSubject(app, "teacher", session.browserCookie)).toBe(
      session.teacher.id,
    );
    expect(await readSubject(app, "student", session.browserCookie)).toBe(
      session.student.id,
    );
    expect(await readSubject(app, "student", session.otherStudent.cookie)).toBe(
      session.otherStudent.id,
    );

    const logout = await app.request(`/api/${role}/logout`, {
      method: "POST",
      headers: { cookie: session.browserCookie },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true, data: null });

    const setCookies = logout.headers.getSetCookie();
    expect(setCookies.map((cookie) => cookie.split("=")[0])).not.toContain(
      sessionCookieNames[remaining],
    );
    expect(setCookies.at(-1)).toMatch(
      new RegExp(`^${sessionCookieNames[role]}=;.*Max-Age=0\\b`, "i"),
    );

    const revoked = await app.request(`/api/${role}/me`, {
      headers: { cookie: session.browserCookie },
    });
    expect(revoked.status).toBe(401);
    expect(apiErrSchema.parse(await revoked.json()).error).toBe("UNAUTHORIZED");
    expect(await readSubject(app, remaining, session[remaining].cookie)).toBe(
      session[remaining].id,
    );
    expect(await readSubject(app, "student", session.otherStudent.cookie)).toBe(
      session.otherStudent.id,
    );
  },
);
