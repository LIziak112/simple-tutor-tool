import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pino from "pino";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import {
  attempts,
  courseItems,
  courseStudents,
  courses,
  lectures,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  seedLessonWithEmbeddedUnit,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { insertAttempt, insertResponse } from "./ai-companion-fixtures.ts";
import { connectMcpClientViaApp } from "./mcp-test-utils.ts";
import { makeStudent } from "./note-fixtures.ts";

/** 真实HTTP鉴权/SDK协议，测试内存库，不监听端口或复用教学数据。 */
export async function studentPracticeReadEnv(kind: "class" | "personal") {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  if (kind === "personal") {
    db.update(teachers)
      .set({ accountKind: "personal", personalStudentId: studentId })
      .where(eq(teachers.id, TEST_TEACHER_ID))
      .run();
    db.update(students)
      .set({ linkEnabled: false, passwordEnabled: false })
      .where(eq(students.id, studentId))
      .run();
  }
  const practiceId = insertAttempt(db, { studentId });
  db.update(attempts)
    .set({
      sourceType: "wrong",
      assignmentId: null,
      practiceWorkflowVersion: 1,
      feedbackMode: "per_question",
    })
    .where(eq(attempts.id, practiceId))
    .run();
  const revisions = [
    insertResponse(db, practiceId, "q-1"),
    insertResponse(db, practiceId, "q-2"),
  ];
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = `tutor_student_session=${createStudentSession(db, studentId).token}`;
  const response = await app.request("/api/student/ai/connections", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ channel: "mcp" }),
  });
  const created = (await response.json()) as {
    data?: { connection: { id: string }; credential: { token: string } | null };
  };
  if (!response.ok || !created.data?.credential)
    throw new Error(`测试MCP连接创建失败 HTTP ${response.status}`);
  const path = kind === "personal" ? "/mcp/personal" : "/mcp/student";
  const token = created.data.credential.token;
  const client = await connectMcpClientViaApp(
    app,
    path,
    token,
    "practice-read-test",
  );
  return {
    db,
    dataDir,
    studentId,
    practiceId,
    revisions,
    app,
    cookie,
    path,
    token,
    client,
    connectionId: created.data.connection.id,
  };
}

/** 合法内容寻址图片，尾部标识使公开/私有图片字节可区分。 */
export function practiceImage(dataDir: string, character: string, size = 76) {
  const src = `blobs/media/${character.repeat(64)}.png`;
  mkdirSync(join(dataDir, "blobs", "media"), { recursive: true });
  const bytes = Buffer.alloc(size, character.charCodeAt(0));
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  writeFileSync(join(dataDir, src), bytes);
  return src;
}

export function patchPracticeQuestion(
  env: Awaited<ReturnType<typeof studentPracticeReadEnv>>,
  index: number,
  patch: Record<string, unknown>,
) {
  const id = env.revisions[index];
  const row = env.db
    .select()
    .from(responses)
    .where(eq(responses.id, id ?? ""))
    .get();
  if (!row?.questionSnapshotJson) throw new Error("缺少冻结题快照");
  const snapshot: unknown = JSON.parse(row.questionSnapshotJson);
  if (typeof snapshot !== "object" || snapshot === null)
    throw new Error("冻结夹具不合法");
  env.db
    .update(responses)
    .set({ questionSnapshotJson: JSON.stringify({ ...snapshot, ...patch }) })
    .where(eq(responses.id, row.id))
    .run();
}

export function practiceLesson(
  env: Awaited<ReturnType<typeof studentPracticeReadEnv>>,
) {
  const { lectureId, unitId } = seedLessonWithEmbeddedUnit(env.db);
  env.db
    .update(lectures)
    .set({
      markdown:
        '# 讲练\n\n::::question{id="q-2" type="choice"}\n正文先第二题\n::::',
    })
    .where(eq(lectures.id, lectureId))
    .run();
  const attach = (title: string) => {
    const id = randomUUID();
    const itemId = randomUUID();
    const now = new Date().toISOString();
    env.db
      .insert(courses)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        title,
        order: 0,
        createdAt: now,
      })
      .run();
    env.db
      .insert(courseStudents)
      .values({ courseId: id, studentId: env.studentId, joinedAt: now })
      .run();
    env.db
      .insert(courseItems)
      .values({
        id: itemId,
        courseId: id,
        kind: "lecture",
        refId: lectureId,
        title: null,
        order: 0,
        visible: true,
        createdAt: now,
      })
      .run();
    return { id, itemId };
  };
  const a = attach("A可见课程");
  const b = attach("B真实来源课程");
  env.db
    .update(attempts)
    .set({ sourceType: "lesson", lectureId, unitId, courseId: b.id })
    .where(eq(attempts.id, env.practiceId))
    .run();
  env.db
    .update(responses)
    .set({ unitId })
    .where(eq(responses.attemptId, env.practiceId))
    .run();
  return { a, b, lectureId, unitId };
}
