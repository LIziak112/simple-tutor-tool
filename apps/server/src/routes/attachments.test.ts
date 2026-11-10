import type { ApiErr } from "@tutor/contract";
import {
  attachmentListOkSchema,
  attachmentOkSchema,
  studentAttachmentListOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { courses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils";
import { MINI_DOCX, MINI_PDF } from "../services/attachment-format.test.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { attachmentFileResponse } from "./teacher-attachments.ts";

/**
 * 资料附件（模块 6 第一步）接口集成测试：教师上传 / 列表 / 改可见性 / 软删 /
 * 下载；学生列表与下载的访问矩阵（成员 + 可见 → 200；teacher_only、非成员、
 * 软删、课程归档 → 404 / 403）；格式与上限拒绝；学生响应不泄露教师侧字段。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

interface Env {
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
  memberCookie: string;
  outsiderCookie: string;
  courseId: string;
}

async function createStudentAndLogin(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  displayName: string,
): Promise<{ studentId: string; cookie: string }> {
  const create = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName,
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as {
    data: { student: { id: string } };
  };
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(login.status).toBe(200);
  return {
    studentId: created.data.student.id,
    cookie: `tutor_student_session=${extractSessionToken(login, "tutor_student_session")}`,
  };
}

async function makeEnv(): Promise<Env> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  const created = await app.request("/api/teacher/courses", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ title: "行测冲刺", description: "公考行测" }),
  });
  expect(created.status).toBe(201);
  const courseId = ((await created.json()) as { data: { id: string } }).data.id;
  const member = await createStudentAndLogin(app, teacherCookie, "成员张三");
  const outsider = await createStudentAndLogin(
    app,
    teacherCookie,
    "非成员李四",
  );
  const added = await app.request(`/api/teacher/courses/${courseId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ studentIds: [member.studentId] }),
  });
  expect(added.status).toBe(200);
  return {
    app,
    db,
    teacherCookie,
    memberCookie: member.cookie,
    outsiderCookie: outsider.cookie,
    courseId,
  };
}

/** 教师上传（multipart：file + 可选文本字段） */
async function upload(
  env: Env,
  bytes: Uint8Array,
  fileName: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return env.app.request("/api/teacher/attachments", {
    method: "POST",
    headers: { cookie: env.teacherCookie },
    body: form,
  });
}

async function uploadOk(
  env: Env,
  bytes: Uint8Array,
  fileName: string,
  fields: Record<string, string> = {},
) {
  const res = await upload(env, bytes, fileName, fields);
  expect(res.status).toBe(201);
  return attachmentOkSchema.parse(await res.json()).data;
}

describe("资料附件 · 教师侧", () => {
  it("上传 PDF：识别格式、页数、文件名清洗、挂课程；列表按课程过滤；下载直出", async () => {
    const env = await makeEnv();
    const pdf = await uploadOk(env, MINI_PDF, "2024 国考\\行测真题.pdf", {
      courseId: env.courseId,
    });
    expect(pdf).toMatchObject({
      courseId: env.courseId,
      courseTitle: "行测冲刺",
      fileName: "行测真题.pdf",
      format: "pdf",
      bytes: MINI_PDF.byteLength,
      pageCount: 3,
      visibility: "students",
    });
    const docx = await uploadOk(env, MINI_DOCX, "申论 材料.docx", {
      visibility: "teacher_only",
    });
    expect(docx).toMatchObject({
      courseId: null,
      courseTitle: null,
      format: "docx",
      pageCount: null,
      visibility: "teacher_only",
    });

    const all = await env.app.request("/api/teacher/attachments", {
      headers: { cookie: env.teacherCookie },
    });
    expect(all.status).toBe(200);
    const allData = attachmentListOkSchema.parse(await all.json()).data;
    expect(allData.attachments.map((a) => a.id)).toEqual([docx.id, pdf.id]);
    const byCourse = await env.app.request(
      `/api/teacher/attachments?courseId=${env.courseId}`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(
      attachmentListOkSchema
        .parse(await byCourse.json())
        .data.attachments.map((a) => a.id),
    ).toEqual([pdf.id]);

    const file = await env.app.request(
      `/api/teacher/attachments/${pdf.id}/file`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("行测真题.pdf")}`,
    );
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await file.arrayBuffer()).equals(MINI_PDF)).toBe(true);
  });

  it("拒绝：非 PDF / docx 415；超 20 MB 413（content-length 粗防线）；他人课程 404；缺 file 400", async () => {
    const env = await makeEnv();
    const png = await upload(
      env,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      "图.pdf",
    );
    expect(png.status).toBe(415);
    expect(((await png.json()) as ApiErr).error).toBe(
      "ATTACHMENT_UNSUPPORTED_TYPE",
    );

    const big = await env.app.request("/api/teacher/attachments", {
      method: "POST",
      headers: {
        cookie: env.teacherCookie,
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(22 * 1024 * 1024),
      },
      body: "",
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as ApiErr).error).toBe("ATTACHMENT_TOO_LARGE");

    const otherCourse = await upload(env, MINI_PDF, "a.pdf", {
      courseId: "99999999-9999-4999-8999-999999999999",
    });
    expect(otherCourse.status).toBe(404);
    expect(((await otherCourse.json()) as ApiErr).error).toBe(
      "COURSE_NOT_FOUND",
    );

    const form = new FormData();
    form.append("file", "not-a-file");
    const noFile = await env.app.request("/api/teacher/attachments", {
      method: "POST",
      headers: { cookie: env.teacherCookie },
      body: form,
    });
    expect(noFile.status).toBe(400);
  });

  it("直出响应：文件名含孤立代理项（历史脏数据）也能生成下载头，不抛 URIError（#103-03 最后防线）", () => {
    // 说明：better-sqlite3 写入时已把孤立代理项转成 U+FFFD，库里出现它的概率极低；
    // 这里直接喂给响应函数，锁定「任何来源的脏名字都不让下载 500」
    const res = attachmentFileResponse({
      bytes: new Uint8Array(MINI_PDF).buffer as ArrayBuffer,
      contentType: "application/pdf",
      fileName: `${"甲".repeat(195)}\ud83d.pdf`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent(`${"甲".repeat(195)}\ufffd.pdf`)}`,
    );
  });

  it("改可见性 / 改名；软删后列表不见、下载 404；再删 404", async () => {
    const env = await makeEnv();
    const pdf = await uploadOk(env, MINI_PDF, "真题.pdf", {
      courseId: env.courseId,
    });
    const patched = await env.app.request(
      `/api/teacher/attachments/${pdf.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({
          visibility: "teacher_only",
          fileName: " 真题（教师版）.pdf ",
        }),
      },
    );
    expect(patched.status).toBe(200);
    expect(attachmentOkSchema.parse(await patched.json()).data).toMatchObject({
      visibility: "teacher_only",
      fileName: "真题（教师版）.pdf",
    });
    const empty = await env.app.request(`/api/teacher/attachments/${pdf.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const del = await env.app.request(`/api/teacher/attachments/${pdf.id}`, {
      method: "DELETE",
      headers: { cookie: env.teacherCookie },
    });
    expect(del.status).toBe(200);
    const list = await env.app.request("/api/teacher/attachments", {
      headers: { cookie: env.teacherCookie },
    });
    expect(
      attachmentListOkSchema.parse(await list.json()).data.attachments,
    ).toEqual([]);
    const file = await env.app.request(
      `/api/teacher/attachments/${pdf.id}/file`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(file.status).toBe(404);
    const again = await env.app.request(`/api/teacher/attachments/${pdf.id}`, {
      method: "DELETE",
      headers: { cookie: env.teacherCookie },
    });
    expect(again.status).toBe(404);
  });
});

describe("资料附件 · 学生侧", () => {
  it("成员看到 students 可见的；teacher_only / 未挂课程的不出现；响应不泄露教师侧字段", async () => {
    const env = await makeEnv();
    const visible = await uploadOk(env, MINI_PDF, "真题.pdf", {
      courseId: env.courseId,
    });
    await uploadOk(env, MINI_DOCX, "答案.docx", {
      courseId: env.courseId,
      visibility: "teacher_only",
    });
    await uploadOk(env, MINI_DOCX, "空间里的.docx");

    const res = await env.app.request(
      `/api/student/courses/${env.courseId}/attachments`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    assertNoLeak(body, {
      forbid: ["visibility", "teacherId", "sha256", "courseTitle"],
    });
    const data = studentAttachmentListOkSchema.parse(body).data;
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0]).toMatchObject({
      id: visible.id,
      fileName: "真题.pdf",
      format: "pdf",
      pageCount: 3,
    });

    const file = await env.app.request(
      `/api/student/attachments/${visible.id}/file`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer()).equals(MINI_PDF)).toBe(true);
  });

  it("越权矩阵：非成员列表 403 / 下载 404；teacher_only 下载 404；软删 404；课程归档后 403 / 404", async () => {
    const env = await makeEnv();
    const visible = await uploadOk(env, MINI_PDF, "真题.pdf", {
      courseId: env.courseId,
    });
    const hidden = await uploadOk(env, MINI_DOCX, "答案.docx", {
      courseId: env.courseId,
      visibility: "teacher_only",
    });

    const outsiderList = await env.app.request(
      `/api/student/courses/${env.courseId}/attachments`,
      { headers: { cookie: env.outsiderCookie } },
    );
    expect(outsiderList.status).toBe(403);
    expect(((await outsiderList.json()) as ApiErr).error).toBe(
      "COURSE_ACCESS_DENIED",
    );
    const outsiderFile = await env.app.request(
      `/api/student/attachments/${visible.id}/file`,
      { headers: { cookie: env.outsiderCookie } },
    );
    expect(outsiderFile.status).toBe(404);

    const hiddenFile = await env.app.request(
      `/api/student/attachments/${hidden.id}/file`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(hiddenFile.status).toBe(404);
    expect(((await hiddenFile.json()) as ApiErr).error).toBe(
      "ATTACHMENT_NOT_FOUND",
    );

    // 教师软删后成员也 404
    await env.app.request(`/api/teacher/attachments/${visible.id}`, {
      method: "DELETE",
      headers: { cookie: env.teacherCookie },
    });
    const deletedFile = await env.app.request(
      `/api/student/attachments/${visible.id}/file`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(deletedFile.status).toBe(404);

    // 再传一份可见的，然后归档课程：列表 403、下载 404
    const again = await uploadOk(env, MINI_PDF, "真题2.pdf", {
      courseId: env.courseId,
    });
    env.db
      .update(courses)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(courses.id, env.courseId))
      .run();
    const archivedList = await env.app.request(
      `/api/student/courses/${env.courseId}/attachments`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(archivedList.status).toBe(403);
    const archivedFile = await env.app.request(
      `/api/student/attachments/${again.id}/file`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(archivedFile.status).toBe(404);

    // 未登录
    const anon = await env.app.request(
      `/api/student/attachments/${again.id}/file`,
    );
    expect(anon.status).toBe(401);
  });
});
