import { randomUUID } from "node:crypto";
import type { ApiErr } from "@tutor/contract";
import {
  aiMaterialUploadReceiptOkSchema,
  aiTaskOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import { students, teachers } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  insertAiConnectionFixture,
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { makeNotePng } from "../test/note-fixtures.ts";

/**
 * SAI-20 材料上传路由测试（B11；POST /api/student/ai/tasks/:id/materials）。
 * multipart 薄壳：manifest（JSON 元数据数组）+ page-N 文件 → 服务层
 * attachAiTaskMaterials（字节/数量/槽位/版本锚定防线全在服务层，本层只验
 * 传输形状）。覆盖：
 * ① 四态（无会话 401 / 教师 Cookie 401 / 形状错误 400 / 正常回执）；
 * ② 跨账号 404 同文案防枚举；非 created 态 409 AI_STATE_CONFLICT；
 * ③ 回执只含公开材料行（无 pngPath/内部路径），过 assertNoLeak；
 * ④ 同槽位同内容重传幂等（服务层语义经路由贯通）。
 */

const active: ReturnType<typeof createTestDb>[] = [];
function world() {
  const db = createTestDb();
  active.push(db);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  for (const id of ["s-a", "s-b"])
    db.insert(students)
      .values({
        id,
        teacherId: TEST_TEACHER_ID,
        displayName: id,
        loginName: id,
        linkToken: id,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  const attemptId = insertAttempt(db, { studentId: "s-a" });
  insertResponse(db, attemptId, "q-alpha");
  // s-a 持一条 active 连接（create 知情门只看存在性）
  insertAiConnectionFixture(db, "s-a");
  const dataDir = createTestDir();
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  return {
    app,
    db,
    dataDir,
    attemptId,
    a: `tutor_student_session=${createStudentSession(db, "s-a").token}`,
    b: `tutor_student_session=${createStudentSession(db, "s-b").token}`,
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

/** 经路由创建一个任务（inapp 通道），返回任务 id */
async function createTaskViaRoute(
  w: ReturnType<typeof world>,
): Promise<string> {
  const res = await w.app.request("/api/student/ai/tasks", {
    method: "POST",
    headers: { cookie: w.a, "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: w.attemptId,
      questionId: "q-alpha",
      question: "请看我的圈画",
      channel: "inapp",
      materials: { annotation: true, draft: false, formalInk: false },
      mutationId: randomUUID(),
    }),
  });
  expect(res.status).toBe(201);
  return aiTaskOkSchema.parse(await res.json()).data.id;
}

/** 组装 multipart：manifest + page-N 文件（缺省一页 320×200 圈画） */
function materialsForm(
  pages: {
    kind: string;
    pageIndex: number;
    width: number;
    height: number;
    png: Uint8Array;
  }[],
): FormData {
  const form = new FormData();
  form.append(
    "manifest",
    JSON.stringify(
      pages.map((page) => ({
        kind: page.kind,
        pageIndex: page.pageIndex,
        pixelWidth: page.width,
        pixelHeight: page.height,
      })),
    ),
  );
  pages.forEach((page, index) => {
    form.append(
      `page-${index}`,
      new Blob([page.png], { type: "image/png" }),
      `page-${index}.png`,
    );
  });
  return form;
}

async function upload(
  w: ReturnType<typeof world>,
  taskId: string,
  form: FormData,
  cookie = w.a,
): Promise<Response> {
  return w.app.request(`/api/student/ai/tasks/${taskId}/materials`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

/** 无会话变体（显式不带 Cookie；默认参数对显式 undefined 不生效的坑位绕开） */
async function uploadAnonymous(
  w: ReturnType<typeof world>,
  taskId: string,
  form: FormData,
): Promise<Response> {
  return w.app.request(`/api/student/ai/tasks/${taskId}/materials`, {
    method: "POST",
    body: form,
  });
}

async function expectErr(
  res: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErr;
  expect(body.error).toBe(code);
}

function onePage(): {
  kind: string;
  pageIndex: number;
  width: number;
  height: number;
  png: Uint8Array;
}[] {
  return [
    {
      kind: "annotation",
      pageIndex: 0,
      width: 320,
      height: 200,
      png: makeNotePng(320, 200),
    },
  ];
}

// ---------- ① 四态 ----------

it("无会话 / 教师 Cookie：材料路由 401（对称隔离）", async () => {
  const w = world();
  const taskId = randomUUID();
  await expectErr(
    await uploadAnonymous(w, taskId, materialsForm(onePage())),
    401,
    "UNAUTHORIZED",
  );
  await expectErr(
    await upload(w, taskId, materialsForm(onePage()), w.teacher),
    401,
    "UNAUTHORIZED",
  );
});

it("形状错误：缺 manifest / 文件数不符 / 声明尺寸与 PNG 不一致 400，不落盘", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  // 缺 manifest
  const noManifest = new FormData();
  noManifest.append("page-0", new Blob([makeNotePng()], { type: "image/png" }));
  await expectErr(await upload(w, taskId, noManifest), 400, "VALIDATION_ERROR");
  // manifest 与文件数不符
  const mismatched = new FormData();
  mismatched.append(
    "manifest",
    JSON.stringify(onePage().map(({ png: _, ...meta }) => meta)),
  );
  await expectErr(await upload(w, taskId, mismatched), 400, "VALIDATION_ERROR");
  // 声明尺寸与 PNG IHDR 不一致（服务层一致性校验经路由贯通）
  await expectErr(
    await upload(
      w,
      taskId,
      materialsForm([
        {
          kind: "annotation",
          pageIndex: 0,
          width: 999,
          height: 200,
          png: makeNotePng(320, 200),
        },
      ]),
    ),
    400,
    "VALIDATION_ERROR",
  );
});

it("正常上传：回执含公开材料行与合计字节；重复上传同内容幂等", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  const res = await upload(w, taskId, materialsForm(onePage()));
  expect(res.status).toBe(200);
  const body = aiMaterialUploadReceiptOkSchema.parse(await res.json());
  expect(body.data.materials).toHaveLength(1);
  expect(body.data.materials[0]?.kind).toBe("annotation");
  expect(body.data.totalBytes).toBe(makeNotePng(320, 200).byteLength);
  assertNoLeak(body);
  // 同内容重传：幂等（同槽位同内容跳过重写，回执仍完整）
  const retry = await upload(w, taskId, materialsForm(onePage()));
  expect(retry.status).toBe(200);
  const retryBody = aiMaterialUploadReceiptOkSchema.parse(await retry.json());
  expect(retryBody.data.materials).toHaveLength(1);
});

// ---------- ② 归属与状态门禁 ----------

it("跨账号：他人任务 404 同文案；任务不存在同文案（防枚举）", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  const asB = await upload(w, taskId, materialsForm(onePage()), w.b);
  expect(asB.status).toBe(404);
  const asBBody = (await asB.json()) as ApiErr;
  const missing = await upload(w, randomUUID(), materialsForm(onePage()));
  expect(missing.status).toBe(404);
  const missingBody = (await missing.json()) as ApiErr;
  expect(asBBody.error).toBe("NOT_FOUND");
  expect(asBBody.message).toBe(missingBody.message);
});

it("非 created 态：取消后的任务拒绝材料（409 AI_STATE_CONFLICT）", async () => {
  const w = world();
  const taskId = await createTaskViaRoute(w);
  const cancel = await w.app.request(`/api/student/ai/tasks/${taskId}/cancel`, {
    method: "POST",
    headers: { cookie: w.a },
  });
  expect(cancel.status).toBe(200);
  await expectErr(
    await upload(w, taskId, materialsForm(onePage())),
    409,
    "AI_STATE_CONFLICT",
  );
});
