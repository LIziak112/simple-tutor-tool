import type {
  AiPolicyOverrideData,
  AiTeacherSettingsData,
  ApiErr,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession, createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { assignments, students, teachers } from "../db/schema";
import { createTestDb, createTestDir } from "../db/test-utils";

/**
 * SAI-06 教学配置后端路由测试（B02 批次「先写的接口用例」6 条逐条）：
 * - 未登录 / 学生 Cookie：不允许读写教师策略（教师域以 tutor_session 会话为准）；
 * - 另一教师的学生 / 作业：沿用防探测 404 口径（STUDENT_NOT_FOUND /
 *   ASSIGNMENT_NOT_FOUND），不读出配置（响应不含 mode / resolution）；
 * - 明确模式改继承：写入值 + 保存后即刻有效裁决（resolveAiPolicy 单源，
 *   含教师默认 post 时作业显式开放的 truth-table 行）；
 * - 非法 / 空模板：400 AI_PROMPT_INVALID（超长同口径），已生效配置不被更新；
 * - 编辑版本过期：409 AI_SETTINGS_STALE，服务器保留最后成功值；
 * - 恢复默认单模板：只改指定范围，其他模板、学生覆盖、其他教师配置保持原值。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-sai06";
const TEACHER_B_ID = "teacher-b-sai06";

const SETTINGS_PATH = "/api/teacher/ai/settings";

/** 统一 JSON 请求块（GET 无 body） */
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
    // exactOptionalPropertyTypes：不传 undefined 进 RequestInit.body
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface AiRouteEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  /** 教师甲（真实 setup 登录流）*/
  cookieA: string;
  /** 教师乙（直插教师行 + 伪造会话，域隔离测试既有惯例）*/
  cookieB: string;
  /** 甲的学生 / 乙的学生 */
  studentAId: string;
  studentBId: string;
  /** 甲的作业 / 乙的作业 */
  assignmentAId: string;
  assignmentBId: string;
  /** 甲学生的学生会话（学生 Cookie 拒改用例）*/
  studentCookieA: string;
}

/** 建环境：双教师 + 双学生 + 双作业 + 甲学生的学生会话 */
async function makeEnv(): Promise<AiRouteEnv> {
  const db: Db = createTestDb();
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
  const setupCookie = setup.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (setupCookie === undefined) throw new Error("setup 未写入 tutor_session");
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "teacher-b",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$sai06-fixture",
      apiToken: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
  const teacherA = db
    .select()
    .from(teachers)
    .where(eq(teachers.loginName, "teacher"))
    .get();
  if (teacherA === undefined) throw new Error("setup 后未找到教师甲行");
  const studentAId = "student-a-sai06";
  const studentBId = "student-b-sai06";
  const assignmentAId = "assignment-a-sai06";
  const assignmentBId = "assignment-b-sai06";
  const studentRow = (id: string, teacherId: string, login: string) => ({
    id,
    teacherId,
    displayName: `学生-${id}`,
    loginName: login,
    passwordHash: null,
    linkToken: `link-${id}`,
    createdAt: "2026-01-03T00:00:00.000Z",
  });
  db.insert(students)
    .values([
      studentRow(studentAId, teacherA.id, "student-a-login"),
      studentRow(studentBId, TEACHER_B_ID, "student-b-login"),
    ])
    .run();
  db.insert(assignments)
    .values([
      {
        id: assignmentAId,
        teacherId: teacherA.id,
        title: "甲的作业",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: assignmentBId,
        teacherId: TEACHER_B_ID,
        title: "乙的作业",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ])
    .run();
  return {
    app,
    db,
    cookieA: `tutor_session=${setupCookie.slice("tutor_session=".length).split(";")[0] ?? ""}`,
    cookieB: `tutor_session=${createTeacherSession(db, TEACHER_B_ID).token}`,
    studentAId,
    studentBId,
    assignmentAId,
    assignmentBId,
    studentCookieA: `tutor_student_session=${createStudentSession(db, studentAId).token}`,
  };
}

/** 读教师设置（收敛请求块 + data 断言前置读取） */
async function getSettings(
  env: AiRouteEnv,
  cookie: string,
): Promise<{ res: Response; data: AiTeacherSettingsData | null }> {
  const res = await jsonReq(env.app, "GET", SETTINGS_PATH, cookie);
  const data =
    res.status === 200
      ? ((await res.json()) as { data: AiTeacherSettingsData }).data
      : null;
  return { res, data };
}

describe("GET/PUT /api/teacher/ai/settings（SAI-06 教师全局设置）", () => {
  it("未登录 → 401（读与写）；学生 Cookie 不构成教师会话 → 401 且不落任何配置行", async () => {
    const env = await makeEnv();
    const getAnon = await jsonReq(env.app, "GET", SETTINGS_PATH, undefined);
    expect(getAnon.status).toBe(401);
    expect(((await getAnon.json()) as ApiErr).error).toBe("UNAUTHORIZED");
    const putAnon = await jsonReq(env.app, "PUT", SETTINGS_PATH, undefined, {
      defaultMode: "guided_only",
    });
    expect(putAnon.status).toBe(401);

    const putStudentCookie = await jsonReq(
      env.app,
      "PUT",
      SETTINGS_PATH,
      env.studentCookieA,
      { defaultMode: "post_submit_only" },
    );
    expect(putStudentCookie.status).toBe(401);
    expect(((await putStudentCookie.json()) as ApiErr).error).toBe(
      "UNAUTHORIZED",
    );
    // 学生 Cookie 既不能改教师全局配置，也不能改本人策略覆盖
    const putOverride = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.studentCookieA,
      { mode: "post_submit_only" },
    );
    expect(putOverride.status).toBe(401);
    const after = await getSettings(env, env.cookieA);
    expect(after.data?.defaultMode).toBe("open_study");
    const studentPolicy = await jsonReq(
      env.app,
      "GET",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
    );
    expect(
      ((await studentPolicy.json()) as { data: AiPolicyOverrideData }).data
        .mode,
    ).toBe("inherit");
  });

  it("GET 未设置 → 默认值（open_study + 三模板 null）；PUT 保存后读回", async () => {
    const env = await makeEnv();
    const initial = await getSettings(env, env.cookieA);
    expect(initial.res.status).toBe(200);
    expect(initial.data?.defaultMode).toBe("open_study");
    expect(initial.data?.promptsOpen).toBeNull();
    expect(initial.data?.promptsGuided).toBeNull();
    expect(initial.data?.promptsReview).toBeNull();
    expect(typeof initial.data?.updatedAt).toBe("string");

    const saved = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "guided_only",
      promptsOpen: "开放模板正文",
    });
    expect(saved.status).toBe(200);
    expect(
      ((await saved.json()) as { data: AiTeacherSettingsData }).data,
    ).toMatchObject({
      defaultMode: "guided_only",
      promptsOpen: "开放模板正文",
      promptsGuided: null,
    });
    const after = await getSettings(env, env.cookieA);
    expect(after.data?.defaultMode).toBe("guided_only");
    expect(after.data?.promptsOpen).toBe("开放模板正文");
  });

  it("保存非法 / 空模板 → 400 AI_PROMPT_INVALID，已生效配置不被更新", async () => {
    const env = await makeEnv();
    const saved = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "guided_only",
      promptsOpen: "既有的开放模板",
    });
    expect(saved.status).toBe(200);

    const empty = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      promptsGuided: "   ",
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as ApiErr).error).toBe("AI_PROMPT_INVALID");

    const tooLong = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      promptsReview: "长".repeat(8001),
    });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as ApiErr).error).toBe("AI_PROMPT_INVALID");

    const badMode = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "always_on",
    });
    expect(badMode.status).toBe(400);
    expect(((await badMode.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    // 三次失败都不落地：已保存值原样保留
    const after = await getSettings(env, env.cookieA);
    expect(after.data?.defaultMode).toBe("guided_only");
    expect(after.data?.promptsOpen).toBe("既有的开放模板");
    expect(after.data?.promptsGuided).toBeNull();
    expect(after.data?.promptsReview).toBeNull();
  });

  it("编辑版本过期 → 409 AI_SETTINGS_STALE，保留旧服务器值", async () => {
    const env = await makeEnv();
    const base0 = (await getSettings(env, env.cookieA)).data?.updatedAt;
    expect(typeof base0).toBe("string");
    const first = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "guided_only",
      baseUpdatedAt: base0,
    });
    expect(first.status).toBe(200);
    const stamp1 = ((await first.json()) as { data: AiTeacherSettingsData })
      .data.updatedAt;

    const second = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "post_submit_only",
      baseUpdatedAt: stamp1,
    });
    expect(second.status).toBe(200);

    // 持 stamp1 的旧编辑在 second 之后提交 → 冲突，不静默覆盖
    const stale = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "open_study",
      promptsOpen: "迟到编辑的模板",
      baseUpdatedAt: stamp1,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ApiErr).error).toBe("AI_SETTINGS_STALE");

    const after = await getSettings(env, env.cookieA);
    expect(after.data?.defaultMode).toBe("post_submit_only");
    expect(after.data?.promptsOpen).toBeNull();
  });

  it("恢复默认某模板 → 其他模板与学生覆盖、其他教师配置均保持原值", async () => {
    const env = await makeEnv();
    const saved = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      promptsOpen: "模板甲",
      promptsGuided: "模板乙",
      promptsReview: "模板丙",
    });
    expect(saved.status).toBe(200);
    const putStudent = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
      { mode: "guided_only" },
    );
    expect(putStudent.status).toBe(200);

    const restore = await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      promptsGuided: null,
    });
    expect(restore.status).toBe(200);
    const data = ((await restore.json()) as { data: AiTeacherSettingsData })
      .data;
    expect(data.promptsGuided).toBeNull();
    expect(data.promptsOpen).toBe("模板甲");
    expect(data.promptsReview).toBe("模板丙");

    // 学生覆盖不受教师模板恢复影响
    const policy = await jsonReq(
      env.app,
      "GET",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
    );
    expect(
      ((await policy.json()) as { data: AiPolicyOverrideData }).data.mode,
    ).toBe("guided_only");
    // 其他教师的全局配置不受影响（乙仍为默认开放）
    const teacherB = await getSettings(env, env.cookieB);
    expect(teacherB.data?.defaultMode).toBe("open_study");
    expect(teacherB.data?.promptsOpen).toBeNull();
  });

  it("教师甲保存配置不影响教师乙；乙自行保存后互不串读", async () => {
    const env = await makeEnv();
    await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "post_submit_only",
    });
    const b1 = await getSettings(env, env.cookieB);
    expect(b1.data?.defaultMode).toBe("open_study");
    await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieB, {
      defaultMode: "guided_only",
    });
    const a2 = await getSettings(env, env.cookieA);
    const b2 = await getSettings(env, env.cookieB);
    expect(a2.data?.defaultMode).toBe("post_submit_only");
    expect(b2.data?.defaultMode).toBe("guided_only");
  });
});

describe("GET/PUT /api/teacher/{students,assignments}/:id/ai-policy（SAI-06 覆盖）", () => {
  it("另一教师的学生 / 作业 → 404 防探测口径，不读出配置", async () => {
    const env = await makeEnv();
    // 乙先在自己的学生 / 作业上落显式覆盖
    await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/students/${env.studentBId}/ai-policy`,
      env.cookieB,
      { mode: "post_submit_only" },
    );
    await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/assignments/${env.assignmentBId}/ai-policy`,
      env.cookieB,
      { mode: "guided_only" },
    );

    const paths = [
      `/api/teacher/students/${env.studentBId}/ai-policy`,
      `/api/teacher/assignments/${env.assignmentBId}/ai-policy`,
    ] as const;
    for (const path of paths) {
      const getRes = await jsonReq(env.app, "GET", path, env.cookieA);
      expect(getRes.status).toBe(404);
      const getBody = (await getRes.json()) as ApiErr;
      expect(
        getBody.error === "STUDENT_NOT_FOUND" ||
          getBody.error === "ASSIGNMENT_NOT_FOUND",
      ).toBe(true);
      // 防探测：错误响应不携带 mode / resolution / 有效裁决任何字段
      expect(getBody).not.toHaveProperty("mode");
      expect(getBody).not.toHaveProperty("resolution");
      expect(JSON.stringify(getBody)).not.toContain("post_submit_only");
      expect(JSON.stringify(getBody)).not.toContain("guided_only");

      const putRes = await jsonReq(env.app, "PUT", path, env.cookieA, {
        mode: "open_study",
      });
      expect(putRes.status).toBe(404);
    }
    // 甲自己的学生仍可正常读写（inherit）
    const own = await jsonReq(
      env.app,
      "GET",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
    );
    expect(own.status).toBe(200);
    expect(
      ((await own.json()) as { data: AiPolicyOverrideData }).data.mode,
    ).toBe("inherit");
  });

  it("明确模式改继承：写入值 + 返回实际有效来源（含教师默认关闭时作业显式开放）", async () => {
    const env = await makeEnv();
    // 教师默认 guided → 学生继承时预览应回落教师默认（有效来源）
    await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "guided_only",
    });

    const guided = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
      { mode: "guided_only" },
    );
    expect(guided.status).toBe(200);
    expect(
      ((await guided.json()) as { data: AiPolicyOverrideData }).data,
    ).toEqual({
      mode: "guided_only",
      resolution: {
        usable: true,
        mode: "guided_only",
        reason: "student_override",
      },
    });

    const inherit = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
      { mode: "inherit" },
    );
    expect(inherit.status).toBe(200);
    expect(
      ((await inherit.json()) as { data: AiPolicyOverrideData }).data,
    ).toEqual({
      mode: "inherit",
      resolution: {
        usable: true,
        mode: "guided_only",
        reason: "teacher_default",
      },
    });

    // 作业显式关闭：预览 usable=false（另一层按继承口径）
    const closed = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/assignments/${env.assignmentAId}/ai-policy`,
      env.cookieA,
      { mode: "post_submit_only" },
    );
    expect(closed.status).toBe(200);
    expect(
      ((await closed.json()) as { data: AiPolicyOverrideData }).data,
    ).toEqual({
      mode: "post_submit_only",
      resolution: { usable: false, reason: "assignment_closed" },
    });

    // 教师默认改为关闭后，作业显式开放可覆盖继承的默认（truth-table 行 7 同构）
    await jsonReq(env.app, "PUT", SETTINGS_PATH, env.cookieA, {
      defaultMode: "post_submit_only",
    });
    const reopen = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/assignments/${env.assignmentAId}/ai-policy`,
      env.cookieA,
      { mode: "open_study" },
    );
    expect(reopen.status).toBe(200);
    expect(
      ((await reopen.json()) as { data: AiPolicyOverrideData }).data,
    ).toEqual({
      mode: "open_study",
      resolution: {
        usable: true,
        mode: "open_study",
        reason: "assignment_override",
      },
    });

    // GET 读回存储值 + 预览（作业 open_study、教师默认 post）
    const readBack = await jsonReq(
      env.app,
      "GET",
      `/api/teacher/assignments/${env.assignmentAId}/ai-policy`,
      env.cookieA,
    );
    expect(
      ((await readBack.json()) as { data: AiPolicyOverrideData }).data.mode,
    ).toBe("open_study");

    // 恢复继承（删行语义）：作业层回到教师默认关闭
    const backToInherit = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/assignments/${env.assignmentAId}/ai-policy`,
      env.cookieA,
      { mode: "inherit" },
    );
    expect(
      ((await backToInherit.json()) as { data: AiPolicyOverrideData }).data,
    ).toEqual({
      mode: "inherit",
      resolution: { usable: false, reason: "teacher_default_closed" },
    });
  });

  it("mode 非法 → 400 AI_POLICY_INVALID；不存在的学生 / 作业 → 404", async () => {
    const env = await makeEnv();
    const bad = await jsonReq(
      env.app,
      "PUT",
      `/api/teacher/students/${env.studentAId}/ai-policy`,
      env.cookieA,
      { mode: "always_open" },
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiErr).error).toBe("AI_POLICY_INVALID");

    const missingStudent = await jsonReq(
      env.app,
      "GET",
      "/api/teacher/students/no-such-student/ai-policy",
      env.cookieA,
    );
    expect(missingStudent.status).toBe(404);
    expect(((await missingStudent.json()) as ApiErr).error).toBe(
      "STUDENT_NOT_FOUND",
    );
    const missingAssignment = await jsonReq(
      env.app,
      "PUT",
      "/api/teacher/assignments/no-such-assignment/ai-policy",
      env.cookieA,
      { mode: "inherit" },
    );
    expect(missingAssignment.status).toBe(404);
    expect(((await missingAssignment.json()) as ApiErr).error).toBe(
      "ASSIGNMENT_NOT_FOUND",
    );
  });
});
