import { randomUUID } from "node:crypto";
import type { NoteSubmissionEvidenceState } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  notes as notesTable,
  submissionEvidence as submissionEvidenceTable,
} from "../db/schema.ts";
import type { TestApp } from "./note-fixtures.ts";

/**
 * 笔记路由测试的共享世界件（T6R.5 复审⑧收敛；复审轮⑭再收 fresh/noteRowOf）：
 * - 会话三件套：extractSessionToken / createStudent / loginStudent；
 * - insertEvidence：直插提交证据行（带 state 版——交卷事务写入口在 T6R.10，
 *   读侧测试按行存在性投影）；
 * - freshNoteAttempt：布置作业 + 开卷（三份 freshAttempt 手写归一）；
 * - noteRowOf：该 attempt 该题的 scratch 笔记行（两路由测试文件共用）。
 */

export function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c: string) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/**
 * 布置作业（指定教师域内单元给学生）并开卷，返回新 attemptId（每测试取新卷，
 * 笔记数据按 attempt 天然隔离）。
 */
export async function freshNoteAttempt(
  app: TestApp,
  teacherCookie: string,
  unitId: string,
  studentIds: string[],
  studentCookie: string,
): Promise<string> {
  const createRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds }),
  });
  if (createRes.status !== 201) {
    throw new Error(`布置作业失败：${createRes.status}`);
  }
  const assignmentId = (
    (await createRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置作业响应缺少作业 id");
  const attemptRes = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: studentCookie } },
  );
  if (attemptRes.status !== 200) {
    throw new Error(`开卷失败：${attemptRes.status}`);
  }
  return ((await attemptRes.json()) as { data: { id: string } }).data.id;
}

/** 该 attempt 该题的 scratch 笔记行 */
export function noteRowOf(db: Db, attemptId: string, questionId: string) {
  return db
    .select()
    .from(notesTable)
    .where(
      and(
        eq(notesTable.attemptId, attemptId),
        eq(notesTable.questionId, questionId),
        eq(notesTable.phase, "scratch"),
      ),
    )
    .get();
}

/** 建学生（指定教师域；返回 id） */
export async function createStudent(
  app: TestApp,
  teacherCookie: string,
  name: string,
  password = "stu-pass-6",
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: name,
      loginName: name,
      password,
    }),
  });
  if (res.status !== 201) throw new Error(`建学生失败：${res.status}`);
  return ((await res.json()) as { data: { student: { id: string } } }).data
    .student.id;
}

/** 学生登录（返回 Cookie 串） */
export async function loginStudent(
  app: TestApp,
  name: string,
  password = "stu-pass-6",
): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password }),
  });
  if (res.status !== 200) throw new Error(`学生登录失败：${res.status}`);
  return `tutor_session=${extractSessionToken(res)}`;
}

/** 直插提交证据行（state 全值域版；frozen 须带 versionId，其余 null） */
export function insertEvidence(
  db: Db,
  attemptId: string,
  questionId: string,
  state: NoteSubmissionEvidenceState,
  versionId: string | null,
): void {
  db.insert(submissionEvidenceTable)
    .values({
      id: randomUUID(),
      attemptId,
      questionId,
      state,
      versionId,
      recordedAt: new Date().toISOString(),
    })
    .run();
}
