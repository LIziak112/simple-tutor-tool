import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATTEMPT_SNAPSHOT_PROOF_HEADER } from "@tutor/contract";
import type { Db } from "../../db/client.ts";
import type { TestApp } from "../note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../note-world.ts";

const markdown = readFileSync(
  new URL("./fixtures/P0-单选夹具.md", import.meta.url),
  "utf8",
);
const ownerName = "合成甲";

export function loginAssignmentOwner(app: TestApp) {
  return loginStudent(app, ownerName);
}

export function attemptFacts(db: Db) {
  return db.$client
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM attempts) AS attempts,
        (SELECT COUNT(*) FROM responses) AS responses,
        (SELECT COUNT(*) FROM attempts WHERE score_auto IS NOT NULL OR score_final IS NOT NULL) AS scores,
        (SELECT COUNT(*) FROM submission_evidence) AS evidence,
        (SELECT COUNT(*) FROM attempt_settlements) AS settlements`,
    )
    .get();
}

export async function setupAssignment(app: TestApp) {
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: "teacher-pass-8" }),
  });
  assert.equal(setup.status, 200);
  const teacher = `tutor_session=${extractSessionToken(setup)}`;
  const teacherHeaders = {
    cookie: teacher,
    "content-type": "application/json",
  };
  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: teacherHeaders,
    body: JSON.stringify({ markdown, filename: "M04P0.md" }),
  });
  assert.equal(imported.status, 200);
  const {
    data: { units },
  } = (await imported.json()) as {
    data: { units: { id: string }[] };
  };
  assert.equal(units.length, 1);

  const studentId = await createStudent(app, teacher, ownerName);
  const otherStudentId = await createStudent(app, teacher, "合成乙");
  const ownerCookie = await loginAssignmentOwner(app);
  const otherCookie = await loginStudent(app, "合成乙");
  const assigned = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: teacherHeaders,
    body: JSON.stringify({
      title: "M04P1 两道合成单选",
      unitIds: units.map(({ id }) => id),
      studentIds: [studentId],
      answerRelease: "on_submit",
      allowPerQuestionFeedback: false,
      allowRedo: false,
    }),
  });
  assert.equal(assigned.status, 201);
  const {
    data: { assignments },
  } = (await assigned.json()) as {
    data: { assignments: { id: string }[] };
  };
  const assignmentId = assignments[0]?.id;
  assert.equal(assignments.length, 1);
  assert.ok(assignmentId);
  return {
    assignmentId,
    ownerCookie,
    otherCookie,
    studentId,
    otherStudentId,
    teacher,
  };
}

export async function verifyInactiveOwnerCookies(
  app: TestApp,
  {
    ownerCookie,
    teacher,
    studentId,
  }: Awaited<ReturnType<typeof setupAssignment>>,
  reject: (cookie: string) => Promise<void>,
) {
  const logout = await app.request("/api/student/logout", {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  assert.equal(logout.status, 200, await logout.text());
  await reject(ownerCookie);
  const activeCookie = await loginAssignmentOwner(app);
  const archive = await app.request(`/api/teacher/students/${studentId}`, {
    method: "PATCH",
    headers: { cookie: teacher, "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archive.status, 200, await archive.text());
  await reject(activeCookie);
}

export async function removeAssignmentOwner(
  app: TestApp,
  {
    assignmentId,
    studentId,
    teacher,
  }: Awaited<ReturnType<typeof setupAssignment>>,
) {
  const response = await app.request(
    `/api/teacher/assignments/${assignmentId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacher },
      body: JSON.stringify({
        removeStudentIds: [studentId],
        confirmStarted: true,
      }),
    },
  );
  assert.equal(response.status, 200, await response.text());
}

export function postAssignment(
  app: TestApp,
  assignmentId: string,
  cookie?: string,
) {
  return app.request(`/api/student/assignments/${assignmentId}/attempt`, {
    method: "POST",
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      [ATTEMPT_SNAPSHOT_PROOF_HEADER]: "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ workflowVersion: 1, feedbackMode: "after_attempt" }),
  });
}
