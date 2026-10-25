import type { ApiErr } from "@tutor/contract";
import {
  DEFAULT_QUICK_BUTTONS,
  type StudentQuickButton,
  type StudentQuickButtonsData,
  studentQuickButtonsOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import {
  aiConnections,
  aiQuickButtons,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * SAI-08 学生快捷按钮路由测试（B03 批次「先测」6 条逐条 + AGENTS.md 泄露规则）：
 * - A 学生无法读取/更新 B 学生预设（会话即归属，B 视角恒为自己的配置）；
 *   学生请求携带 teacherId / effectiveMode 等教师域字段 → 400 strict 整体拒绝，
 *   学生 Cookie 打教师 PUT /ai/settings → 401（不越权改教师模板）；
 * - 新账号默认值一致；删除全部后重取仍空，不偷偷回填；
 * - 添加、改名、改提示词、改附件、禁用、重排均保存并恢复；
 * - 空白/超长/重复 ID → 400 AI_BUTTONS_INVALID；过期 baseUpdatedAt → 409
 *   AI_SETTINGS_STALE；两者都不部分写入（已存列表原样）；
 * - 恢复默认 = 整组显式提交契约常量：四项与顺序正确，其他连接偏好
 *   （ai_connections 行）不被重置；
 * - 全部学生可读响应过 assertNoLeak（学生端接口防泄露硬规则）。
 */

const BUTTONS_PATH = "/api/student/ai/quick-buttons";

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
        createdAt: new Date().toISOString(),
      })
      .run();
  const app = createApp({
    db,
    dataDir: createTestDir(),
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const cookie = (id: string) =>
    `tutor_student_session=${createStudentSession(db, id).token}`;
  return {
    app,
    db,
    a: cookie("s-a"),
    b: cookie("s-b"),
    teacher: `tutor_session=${createTeacherSession(db, TEST_TEACHER_ID).token}`,
  };
}
afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
});

/** 统一 JSON 请求块 */
async function jsonReq(
  app: ReturnType<typeof createApp>,
  method: "GET" | "PUT",
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** GET + 契约解析 + 泄露断言（每个学生可读响应都过，硬规则 3） */
async function getButtons(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<StudentQuickButtonsData> {
  const res = await jsonReq(app, "GET", BUTTONS_PATH, cookie);
  expect(res.status).toBe(200);
  const body = studentQuickButtonsOkSchema.parse(await res.json());
  assertNoLeak(body);
  return body.data;
}

/** PUT + 契约解析 + 泄露断言 */
async function putButtons(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: unknown,
): Promise<{ res: Response; data: StudentQuickButtonsData | null }> {
  const res = await jsonReq(app, "PUT", BUTTONS_PATH, cookie, body);
  if (res.status !== 200) return { res, data: null };
  const parsed = studentQuickButtonsOkSchema.parse(await res.json());
  assertNoLeak(parsed);
  return { res, data: parsed.data };
}

/** 单按钮速构 */
function button(
  id: string,
  orderIndex: number,
  overrides: Partial<StudentQuickButton> = {},
): StudentQuickButton {
  return {
    id,
    name: `按钮-${id}`,
    prompt: `提示词-${id}`,
    orderIndex,
    enabled: true,
    attachmentPref: { annotation: false, draft: false, formalInk: false },
    ...overrides,
  };
}

it("未登录拒绝；新账号默认四项一致且泄露断言通过", async () => {
  const { app, a } = world();
  const anon = await jsonReq(app, "GET", BUTTONS_PATH, undefined);
  expect(anon.status).toBe(401);
  expect(((await anon.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  const anonPut = await jsonReq(app, "PUT", BUTTONS_PATH, undefined, {
    buttons: [],
  });
  expect(anonPut.status).toBe(401);

  const data = await getButtons(app, a);
  expect(data.buttons).toEqual(DEFAULT_QUICK_BUTTONS);
  expect(data.buttons.map((b) => b.orderIndex)).toEqual([0, 1, 2, 3]);
  expect(data.updatedAt).toBe("1970-01-01T00:00:00.000Z");
});

it("A 学生无法读写 B 学生预设：会话即归属，双方互不可见", async () => {
  const { app, a, b } = world();
  const saved = await putButtons(app, a, {
    buttons: [button("a-only", 0, { name: "A 的按钮" })],
  });
  expect(saved.data?.buttons.map((x) => x.id)).toEqual(["a-only"]);
  // B 读到的仍是自己的默认（不是 A 的配置，也不是空）
  const bView = await getButtons(app, b);
  expect(bView.buttons).toEqual(DEFAULT_QUICK_BUTTONS);
  // B 写只影响 B
  await putButtons(app, b, { buttons: [button("b-only", 0)] });
  expect((await getButtons(app, a)).buttons.map((x) => x.id)).toEqual([
    "a-only",
  ]);
});

it("学生请求携带 teacherId / effectiveMode → 400 strict 整体拒绝且不落库", async () => {
  const { app, a, db } = world();
  const withTeacherId = await putButtons(app, a, {
    buttons: [button("x", 0)],
    teacherId: TEST_TEACHER_ID,
  });
  expect(withTeacherId.res.status).toBe(400);
  expect(((await withTeacherId.res.json()) as ApiErr).error).toBe(
    "VALIDATION_ERROR",
  );
  const withMode = await putButtons(app, a, {
    buttons: [],
    effectiveMode: "open_study",
  });
  expect(withMode.res.status).toBe(400);
  expect(
    db
      .select()
      .from(aiQuickButtons)
      .where(eq(aiQuickButtons.studentId, "s-a"))
      .all(),
  ).toHaveLength(0);
});

it("学生 Cookie 不能改教师模板：PUT /api/teacher/ai/settings → 401", async () => {
  const { app, a } = world();
  const res = await jsonReq(app, "PUT", "/api/teacher/ai/settings", a, {
    defaultMode: "post_submit_only",
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
});

it("添加、改名、改提示词、改附件、禁用、重排均保存并恢复", async () => {
  const { app, a } = world();
  const initial = await getButtons(app, a);
  const edited: StudentQuickButton[] = [
    {
      id: "hint-next",
      name: "再启发一点",
      prompt: "再给我一点提示。",
      orderIndex: 1,
      enabled: false,
      attachmentPref: { annotation: true, draft: false, formalInk: true },
    },
    {
      id: "mine",
      name: "我的按钮",
      prompt: "帮我检查计算。",
      orderIndex: 0,
      enabled: true,
      attachmentPref: { annotation: false, draft: true, formalInk: false },
    },
  ];
  const saved = await putButtons(app, a, {
    buttons: edited,
    baseUpdatedAt: initial.updatedAt,
  });
  // 响应为整组规范形态：按 orderIndex 升序（与 GET 读回同一口径）
  const expectedSaved = [...edited].sort((x, y) => x.orderIndex - y.orderIndex);
  expect(saved.data?.buttons).toEqual(expectedSaved);
  // 重取仍按保存恢复（跨设备语义）
  expect(await getButtons(app, a)).toEqual(saved.data);
});

it("空白名称/超长提示词/重复 ID → 400 AI_BUTTONS_INVALID，已存列表不变", async () => {
  const { app, a } = world();
  const saved = await putButtons(app, a, { buttons: [button("keep", 0)] });
  expect(saved.res.status).toBe(200);

  const blank = await putButtons(app, a, {
    buttons: [button("bad", 0, { name: "  " })],
  });
  expect(blank.res.status).toBe(400);
  expect(((await blank.res.json()) as ApiErr).error).toBe("AI_BUTTONS_INVALID");

  const tooLong = await putButtons(app, a, {
    buttons: [button("bad", 0, { prompt: "长".repeat(501) })],
  });
  expect(tooLong.res.status).toBe(400);
  expect(((await tooLong.res.json()) as ApiErr).error).toBe(
    "AI_BUTTONS_INVALID",
  );

  const dup = await putButtons(app, a, {
    buttons: [button("dup", 0), button("dup", 1)],
  });
  expect(dup.res.status).toBe(400);
  expect(((await dup.res.json()) as ApiErr).error).toBe("AI_BUTTONS_INVALID");

  const after = await getButtons(app, a);
  expect(after.buttons.map((x) => x.id)).toEqual(["keep"]);
  expect(after.updatedAt).toBe(saved.data?.updatedAt);
});

it("过期 baseUpdatedAt → 409 AI_SETTINGS_STALE，列表原样；删光后重取仍空", async () => {
  const { app, a } = world();
  const saved = await putButtons(app, a, { buttons: [button("keep", 0)] });
  const stale = await putButtons(app, a, {
    buttons: [button("new", 0)],
    baseUpdatedAt: "2000-01-01T00:00:00.000Z",
  });
  expect(stale.res.status).toBe(409);
  expect(((await stale.res.json()) as ApiErr).error).toBe("AI_SETTINGS_STALE");
  expect((await getButtons(app, a)).buttons.map((x) => x.id)).toEqual(["keep"]);

  // 删光：合法空组；重取仍空，不偷偷回填默认
  const emptied = await putButtons(app, a, {
    buttons: [],
    baseUpdatedAt: saved.data?.updatedAt,
  });
  expect(emptied.data?.buttons).toEqual([]);
  expect((await getButtons(app, a)).buttons).toEqual([]);
});

it("恢复默认整组提交：四项与顺序正确，其他连接偏好不被重置", async () => {
  const { app, a, db } = world();
  // 直插一条连接偏好行（SAI-18 前无服务写入，直插验证不被快捷按钮 PUT 触碰）
  db.insert(aiConnections)
    .values({
      id: "conn-1",
      studentId: "s-a",
      channel: "inapp",
      isDefault: true,
      configJson: "{}",
      verifyStatus: "unverified",
      verifiedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    })
    .run();
  const customized = await putButtons(app, a, {
    buttons: [button("mine", 0, { name: "我的按钮" })],
  });
  const restored = await putButtons(app, a, {
    buttons: DEFAULT_QUICK_BUTTONS.map((b) => ({ ...b })),
    baseUpdatedAt: customized.data?.updatedAt,
  });
  expect(restored.data?.buttons).toEqual(DEFAULT_QUICK_BUTTONS);
  expect(restored.data?.buttons.map((b) => b.orderIndex)).toEqual([0, 1, 2, 3]);
  expect(db.select({ id: aiConnections.id }).from(aiConnections).all()).toEqual(
    [{ id: "conn-1" }],
  );
});

// ---------- AI 提示词设置（hall-9533）：GET/PUT /api/student/ai/prompts ----------

const STUDENT_PROMPTS_PATH = "/api/student/ai/prompts";

it("学生 AI 提示词：默认全默认 → 覆盖生效 → 空白 400 → 过期锚点 409 → null 恢复默认；教师 Cookie 不可读写", async () => {
  const env = world();
  const first = await jsonReq(env.app, "GET", STUDENT_PROMPTS_PATH, env.a);
  expect(first.status).toBe(200);
  const firstData = (await first.json()) as {
    data: {
      slots: Array<{
        key: string;
        body: string;
        defaultBody: string;
        isCustom: boolean;
      }>;
      updatedAt: string;
    };
  };
  expect(firstData.data.updatedAt).toBe("1970-01-01T00:00:00.000Z");
  expect(firstData.data.slots.map((slot) => slot.key)).toEqual([
    "review-pack-student",
  ]);
  expect(
    firstData.data.slots.every(
      (slot) => !slot.isCustom && slot.body === slot.defaultBody,
    ),
  ).toBe(true);

  const put = await jsonReq(env.app, "PUT", STUDENT_PROMPTS_PATH, env.a, {
    baseUpdatedAt: firstData.data.updatedAt,
    updates: [{ key: "review-pack-student", body: "我的复习指令" }],
  });
  expect(put.status).toBe(200);
  const putData = (await put.json()) as typeof firstData;
  expect(putData.data.slots[0]?.isCustom).toBe(true);
  expect(putData.data.slots[0]?.body).toBe("我的复习指令");

  // 学生槽位互不串号：B 学生读不到 A 的覆盖
  const other = await jsonReq(env.app, "GET", STUDENT_PROMPTS_PATH, env.b);
  const otherData = (await other.json()) as typeof firstData;
  expect(otherData.data.slots[0]?.isCustom).toBe(false);

  const putBlank = await jsonReq(env.app, "PUT", STUDENT_PROMPTS_PATH, env.a, {
    updates: [{ key: "review-pack-student", body: "   " }],
  });
  expect(putBlank.status).toBe(400);
  expect(((await putBlank.json()) as ApiErr).error).toBe("AI_PROMPT_INVALID");

  const putStale = await jsonReq(env.app, "PUT", STUDENT_PROMPTS_PATH, env.a, {
    baseUpdatedAt: firstData.data.updatedAt,
    updates: [{ key: "review-pack-student", body: "过期写" }],
  });
  expect(putStale.status).toBe(409);
  expect(((await putStale.json()) as ApiErr).error).toBe("AI_SETTINGS_STALE");

  const putReset = await jsonReq(env.app, "PUT", STUDENT_PROMPTS_PATH, env.a, {
    baseUpdatedAt: putData.data.updatedAt,
    updates: [{ key: "review-pack-student", body: null }],
  });
  expect(putReset.status).toBe(200);
  const resetData = (await putReset.json()) as typeof firstData;
  expect(resetData.data.slots[0]?.isCustom).toBe(false);

  // 教师 Cookie 打学生端点：会话类型不匹配 → 401
  const teacherGet = await jsonReq(
    env.app,
    "GET",
    STUDENT_PROMPTS_PATH,
    env.teacher,
  );
  expect(teacherGet.status).toBe(401);
});
