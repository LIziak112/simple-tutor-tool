import { randomUUID } from "node:crypto";
import type { NoteSubmissionEvidenceState } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { submissionEvidence as submissionEvidenceTable } from "../db/schema.ts";
import type { TestApp } from "./note-fixtures.ts";

/**
 * 笔记路由测试的共享世界件（T6R.5 复审⑧：student-note-read / teacher-notes
 * 两文件的世界 helper 合一，提 src/test/ 防两份漂移）：
 * - 会话三件套：extractSessionToken / createStudent / loginStudent；
 * - insertEvidence：直插提交证据行（带 state 版——交卷事务写入口在 T6R.10，
 *   读侧测试按行存在性投影）。
 */

export function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c: string) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
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
