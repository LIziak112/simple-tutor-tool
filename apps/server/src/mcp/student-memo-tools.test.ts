import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { memoListDataSchema, memoSchema } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  courseItems,
  courseStudents,
  courses,
  lectures,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { MEMO_TEST_PNG, MEMO_TEST_WEBM } from "../services/memo-format.test.ts";
import { createMediaMemo } from "../services/memo-service.ts";
import { insertAttempt } from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  callToolJson,
  connectMcpClientViaApp,
} from "../test/mcp-test-utils.ts";
import { makeStudent } from "../test/note-fixtures.ts";

/**
 * 随笔三工具（模块 5 第一步）MCP 测试（真实 SDK Streamable HTTP 客户端）：
 * add_memo 转记（source=agent、锚核对：本人作答 / 他人作答 404、可见讲义 label
 * 缺省取标题、同教师但隐藏的讲义 404——#104-04）→ list_my_memos 读到 → 页面接口
 * 同样读到（同一服务层）；get_memo_media 语音以 audio、图片以 image 内联；别的
 * 学生的 id 404。
 */

const silentLogger: Logger = pino({ enabled: false });

interface Env {
  app: ReturnType<typeof createApp>;
  db: Db;
  dataDir: string;
  studentId: string;
  studentCookie: string;
  client: Client;
}

async function makeEnv(): Promise<Env> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost:8787",
    isProduction: false,
    logger: silentLogger,
  });
  const studentCookie = `tutor_student_session=${
    createStudentSession(db, studentId).token
  }`;
  const created = await app.request("/api/student/ai/connections", {
    method: "POST",
    headers: { cookie: studentCookie, "content-type": "application/json" },
    body: JSON.stringify({ channel: "mcp" }),
  });
  const body = (await created.json()) as {
    data: { credential: { token: string } | null };
  };
  if (body.data.credential === null) throw new Error("mcp token 创建失败");
  const client = await connectMcpClientViaApp(
    app,
    "/mcp/student",
    body.data.credential.token,
    "memo-tools-test",
  );
  return { app, db, dataDir, studentId, studentCookie, client };
}

/** 讲义只经课程对学生可见（D5）：建讲义 + 一门该生为成员的课 + 目录条目（可指定隐藏） */
function insertLecture(
  db: Db,
  teacherId: string,
  title: string,
  studentId: string,
  visible = true,
): string {
  const id = randomUUID();
  db.insert(lectures)
    .values({
      id,
      teacherId,
      courseId: null,
      folderId: null,
      title,
      markdown: `# ${title}\n\n正文`,
      kind: "lecture",
      order: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      teachingPackJson: null,
    })
    .run();
  const courseId = randomUUID();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId,
      title: `课程 ${title}`,
      order: 0,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  db.insert(courseStudents)
    .values({ courseId, studentId, joinedAt: "2026-01-01T00:00:00.000Z" })
    .run();
  db.insert(courseItems)
    .values({
      id: randomUUID(),
      courseId,
      kind: "lecture",
      refId: id,
      title: null,
      order: 0,
      visible,
      publishAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  return id;
}

describe("随笔 MCP 工具", () => {
  it("tools/list 含三件随笔工具", async () => {
    const env = await makeEnv();
    const names = (await env.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_my_memos", "add_memo", "get_memo_media"]),
    );
  });

  it("add_memo 转记：source=agent；本人作答锚通过、他人作答 404；讲义 label 缺省取标题；页面接口同样读到", async () => {
    const env = await makeEnv();
    const attemptId = insertAttempt(env.db, { studentId: env.studentId });
    const otherAttemptId = insertAttempt(env.db, {
      studentId: makeStudent(env.db),
    });
    const lectureId = insertLecture(
      env.db,
      TEST_TEACHER_ID,
      "第二讲 比例",
      env.studentId,
    );
    const hiddenLectureId = insertLecture(
      env.db,
      TEST_TEACHER_ID,
      "隐藏的第三讲",
      env.studentId,
      false,
    );

    const plain = await callToolJson(env.client, "add_memo", {
      text: "语音转写：这题先算总量再算比例",
      tags: ["转写"],
    });
    expect(plain.isError).toBe(false);
    assertNoLeak(plain.data);
    const plainMemo = memoSchema.parse(plain.data);
    expect(plainMemo.source).toBe("agent");
    expect(plainMemo.device).toBe("agent");
    expect(plainMemo.anchor).toEqual({ kind: "none" });

    const anchored = await callToolJson(env.client, "add_memo", {
      text: "锚到我的作答",
      anchor: { kind: "question", attemptId, questionId: "q-1" },
      recordedAt: "2026-03-01T08:00:00+08:00",
    });
    expect(anchored.isError).toBe(false);
    const anchoredMemo = memoSchema.parse(anchored.data);
    expect(anchoredMemo.anchor).toEqual({
      kind: "question",
      attemptId,
      questionId: "q-1",
      label: "作答",
    });
    expect(anchoredMemo.recordedAt).toBe("2026-03-01T00:00:00.000Z");

    const foreign = await callToolJson(env.client, "add_memo", {
      text: "锚到别人的作答",
      anchor: { kind: "question", attemptId: otherAttemptId, questionId: "q" },
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.data.error).toBe("MEMO_ANCHOR_NOT_FOUND");

    const lecture = await callToolJson(env.client, "add_memo", {
      text: "讲义要点",
      anchor: { kind: "lecture", lectureId },
    });
    expect(lecture.isError).toBe(false);
    expect(memoSchema.parse(lecture.data).anchor).toEqual({
      kind: "lecture",
      lectureId,
      sectionId: null,
      label: "第二讲 比例",
    });
    const unknownLecture = await callToolJson(env.client, "add_memo", {
      text: "不存在的讲义",
      anchor: { kind: "lecture", lectureId: randomUUID() },
    });
    expect(unknownLecture.isError).toBe(true);
    expect(unknownLecture.data.error).toBe("MEMO_ANCHOR_NOT_FOUND");
    // 同教师但目录里隐藏的讲义：与不存在同口径，标题不经转记泄露（#104-04）
    const hiddenLecture = await callToolJson(env.client, "add_memo", {
      text: "隐藏讲义",
      anchor: { kind: "lecture", lectureId: hiddenLectureId },
    });
    expect(hiddenLecture.isError).toBe(true);
    expect(hiddenLecture.data.error).toBe("MEMO_ANCHOR_NOT_FOUND");
    expect(JSON.stringify(hiddenLecture.data)).not.toContain("隐藏的第三讲");

    const listed = await callToolJson(env.client, "list_my_memos", {
      tag: "转写",
    });
    expect(listed.isError).toBe(false);
    assertNoLeak(listed.data);
    const list = memoListDataSchema.parse(listed.data);
    expect(list.memos.map((m) => m.id)).toEqual([plainMemo.id]);

    const byAttempt = memoListDataSchema.parse(
      (await callToolJson(env.client, "list_my_memos", { attemptId })).data,
    );
    expect(byAttempt.memos.map((m) => m.id)).toEqual([anchoredMemo.id]);

    const page = await env.app.request("/api/student/memos", {
      headers: { cookie: env.studentCookie },
    });
    expect(page.status).toBe(200);
    const pageData = memoListDataSchema.parse(
      ((await page.json()) as { data: unknown }).data,
    );
    expect(pageData.memos).toHaveLength(3);
  });

  it("get_memo_media：语音 audio / 图片 image 内联；文字随笔与他人随笔 404", async () => {
    const env = await makeEnv();
    const voice = createMediaMemo(env.db, env.dataDir, {
      studentId: env.studentId,
      clientId: randomUUID(),
      kind: "voice",
      bytes: MEMO_TEST_WEBM,
      durationSec: 3,
    }).memo;
    const image = createMediaMemo(env.db, env.dataDir, {
      studentId: env.studentId,
      clientId: randomUUID(),
      kind: "ink",
      bytes: MEMO_TEST_PNG,
    }).memo;
    const foreign = createMediaMemo(env.db, env.dataDir, {
      studentId: makeStudent(env.db),
      clientId: randomUUID(),
      kind: "image",
      bytes: MEMO_TEST_PNG,
    }).memo;

    const audio = await env.client.callTool({
      name: "get_memo_media",
      arguments: { memoId: voice.id },
    });
    expect(audio.isError).not.toBe(true);
    const audioContent = audio.content as {
      type: string;
      data?: string;
      mimeType?: string;
    }[];
    expect(audioContent.map((c) => c.type)).toEqual(["text", "audio"]);
    expect(audioContent[1]?.mimeType).toBe("audio/webm");
    expect(
      new Uint8Array(Buffer.from(audioContent[1]?.data ?? "", "base64")),
    ).toEqual(MEMO_TEST_WEBM);

    const picture = await env.client.callTool({
      name: "get_memo_media",
      arguments: { memoId: image.id },
    });
    const pictureContent = picture.content as {
      type: string;
      mimeType?: string;
    }[];
    expect(pictureContent.map((c) => c.type)).toEqual(["text", "image"]);
    expect(pictureContent[1]?.mimeType).toBe("image/png");

    const text = await callToolJson(env.client, "add_memo", { text: "文字" });
    const textMedia = await callToolJson(env.client, "get_memo_media", {
      memoId: memoSchema.parse(text.data).id,
    });
    expect(textMedia.isError).toBe(true);
    expect(textMedia.data.error).toBe("MEMO_NOT_FOUND");

    const foreignMedia = await callToolJson(env.client, "get_memo_media", {
      memoId: foreign.id,
    });
    expect(foreignMedia.isError).toBe(true);
    expect(foreignMedia.data.error).toBe("MEMO_NOT_FOUND");
  });
});
