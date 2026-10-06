import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { NoteDoc, NoteVersionReceipt } from "@tutor/contract";
import { noteVersionReceiptSchema } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { students as studentsTable } from "../db/schema.ts";
import { TEST_TEACHER_ID } from "../db/test-utils.ts";

/**
 * 题目草稿（T6R.4/T6R.5）测试共享夹具（复审⑫收敛；⑧补路由层请求组装）：
 * - noteDoc：最小合法 NoteDoc（n 笔，y 可区分不同稿）；
 * - gzipJson：gzip 打包任意 JSON（NoteDocInput 直传通道）；
 * - makeNotePng：最小合法 PNG（魔数 + IHDR，padding 撑大小）；
 * - makeStudent：直插学生行（归属测试教师；服务层测试用）；
 * - putNoteForm / putNoteVersion / noteImageForm：路由层 multipart 组装
 *   （五处手写 FormData 归一，字段集漂移即测试漂移）。
 * 服务层测试（note-service.test）与路由测试（student-notes/student-note-read/
 * teacher-notes.test）共用，避免多份漂移。
 */

/** 最小合法 NoteDoc（strokes 笔，每笔 2 点，y 可区分不同稿） */
export function noteDoc(strokes = 1, y = 20): NoteDoc {
  return {
    version: 1,
    ink: {
      width: 1000,
      strokes: Array.from({ length: strokes }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y, p: 0.5, t: 0 },
          { x: 30 + i, y: y + 5, p: 0.8, t: 25 },
        ],
      })),
    },
    paperHeightLogical: 800,
    background: "grid",
  };
}

/** gzip 打包任意 JSON 值（正文直传通道；level 可注入用于幂等/压缩无关测试） */
export function gzipJson(value: unknown, level?: number): Uint8Array {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  return new Uint8Array(
    level === undefined ? gzipSync(raw) : gzipSync(raw, { level }),
  );
}

/**
 * 最小合法 PNG（魔数 + IHDR 声明宽高 + 尾部 IEND 块；不解码像素数据）。
 * padding 撑大文件测字节限额；总长恒 ≥76（24 头 + 12 IEND + 40 余量），
 * IEND 写在缓冲末 12 字节——padding 之后仍是完整文件。
 */
export function makeNotePng(
  width = 320,
  height = 200,
  padding = 0,
): Uint8Array {
  const buf = Buffer.alloc(Math.max(76, 64 + padding));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // 尾部 IEND 块（长度 0 + 标签 + CRC 置零——服务端只验哨兵不验 CRC）
  buf.writeUInt32BE(0, buf.length - 12);
  buf.write("IEND", buf.length - 8, "latin1");
  return new Uint8Array(buf);
}

let studentSeq = 0;

/** 直插学生行（归属测试教师；requireUsableAttempt 只需 studentId 匹配） */
export function makeStudent(db: Db): string {
  const id = randomUUID();
  studentSeq += 1;
  db.insert(studentsTable)
    .values({
      id,
      teacherId: TEST_TEACHER_ID,
      displayName: `学生${studentSeq}`,
      loginName: `stu-${id.slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${id}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  return id;
}

// ---------- 路由层请求组装（T6R.5 复审⑧：五处手写 FormData 归一） ----------

/** app.request 的最小形态（createApp 返回值满足；测试注入用） */
export type TestApp = {
  request: (path: string, init?: RequestInit) => Promise<Response> | Response;
};

export interface PutNoteOptions {
  baseRevision?: number;
  mutationId?: string;
}

/** PUT 草稿正文的 multipart FormData（body 字节原样上传——自定义字节用例用） */
export function putNoteBodyForm(
  body: Uint8Array,
  options: PutNoteOptions = {},
): FormData {
  const form = new FormData();
  form.append(
    "body",
    new Blob([body], { type: "application/gzip" }),
    "note.json.gz",
  );
  form.append("baseRevision", String(options.baseRevision ?? 0));
  form.append("mutationId", options.mutationId ?? randomUUID());
  return form;
}

/** PUT 草稿正文的 multipart FormData（noteDoc(strokes) gzip 打包；常用路径） */
export function putNoteForm(
  strokes = 1,
  options: PutNoteOptions = {},
): FormData {
  return putNoteBodyForm(gzipJson(noteDoc(strokes)), options);
}

/**
 * PUT 一版草稿正文并取回 versionId（路由层测试高频路径）。
 * 非 200 时不抛（调用方按需断言状态码），versionId 为 undefined。
 */
export async function putNoteVersion(
  app: TestApp,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  strokes = 1,
  options: PutNoteOptions = {},
): Promise<{ status: number; versionId?: string }> {
  const res = await app.request(
    `/api/student/attempts/${attemptId}/notes/${questionId}`,
    {
      method: "PUT",
      headers: cookie === undefined ? {} : { cookie },
      body: putNoteForm(strokes, options),
    },
  );
  if (res.status !== 200) return { status: res.status };
  const data = (await res.json()) as { data: { versionId: string } };
  return { status: res.status, versionId: data.data.versionId };
}

/**
 * PUT 一版草稿正文并返回**完整回执**（T6R.10 证据测试用——frozen 声明需要
 * versionId+revision；非 200 即测试前置失败，明确抛错）。
 */
export async function putNoteReceipt(
  app: TestApp,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  strokes = 1,
  options: PutNoteOptions = {},
): Promise<NoteVersionReceipt> {
  const res = await app.request(
    `/api/student/attempts/${attemptId}/notes/${questionId}`,
    {
      method: "PUT",
      headers: cookie === undefined ? {} : { cookie },
      body: putNoteForm(strokes, options),
    },
  );
  if (res.status !== 200) {
    throw new Error(`putNoteReceipt：HTTP ${res.status}（测试前置失败）`);
  }
  return noteVersionReceiptSchema.parse(
    ((await res.json()) as { data: unknown }).data,
  );
}

/**
 * PUT 一版草稿正文，断言 200 并返回回执里的 versionId（两路由测试文件的
 * 高频断言路径归一——复审轮⑭）。
 */
export async function putNoteOk(
  app: TestApp,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  strokes = 1,
  options: PutNoteOptions = {},
): Promise<string> {
  const { status, versionId } = await putNoteVersion(
    app,
    cookie,
    attemptId,
    questionId,
    strokes,
    options,
  );
  if (status !== 200) throw new Error(`PUT 草稿失败：${status}`);
  if (versionId === undefined) throw new Error("上传成功但缺少 versionId");
  return versionId;
}

/**
 * POST 补图（学生 ⑤ / 教师 ⑧ 同形态；prefix 决定路由前缀——三胞胎归一，
 * 复审轮⑭）。multipart 组装在 noteImageForm。
 */
export function postNoteImage(
  app: TestApp,
  prefix: "student" | "teacher",
  versionId: string,
  png: Uint8Array,
  cookie: string,
  options: NoteImageFormOptions = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/${prefix}/note-versions/${versionId}/images`, {
      method: "POST",
      headers: { cookie },
      body: noteImageForm(png, options),
    }),
  );
}

export interface NoteImageFormOptions {
  spec?: string;
  pageIndex?: number | string;
  cropX?: number | string;
  cropY?: number | string;
  cropW?: number | string;
  cropH?: number | string;
  pixelWidth?: number | string;
  pixelHeight?: number | string;
}

/**
 * POST 补图的 multipart FormData（image 文件 + 八个元信息字段；字段值可传
 * 字符串以构造非法形态用例，如 pageIndex: "1e0"）。
 */
export function noteImageForm(
  png: Uint8Array,
  options: NoteImageFormOptions = {},
): FormData {
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), "note.png");
  form.append("spec", options.spec ?? "analysis");
  form.append("pageIndex", String(options.pageIndex ?? 0));
  form.append("cropX", String(options.cropX ?? 0));
  form.append("cropY", String(options.cropY ?? 0));
  form.append("cropW", String(options.cropW ?? 1000));
  form.append("cropH", String(options.cropH ?? 800));
  form.append("pixelWidth", String(options.pixelWidth ?? 320));
  form.append("pixelHeight", String(options.pixelHeight ?? 200));
  return form;
}
