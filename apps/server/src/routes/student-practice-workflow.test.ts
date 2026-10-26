import type { ApiErr } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  assignments,
  attempts,
  responses,
  students,
  teachers,
  units,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { teacherPolicyOfStudent } from "../services/practice-workflow-wiring.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions.ts";

/**
 * M1b 普通练习工作流接线集成测试（2026-10-22 计划 §10.1）：
 * - 建卷：显式 workflowVersion=1 才写新协议（服务端按教师规则/作业授权裁决，
 *   不信任学生参数越权）；省略维持旧协议；create-or-return 已有 draft 不升级
 *   不覆盖；wrong 同口径；
 * - 草稿读取：新协议卷携带 practiceWorkflow + questionProgress 白名单
 *   （无答案秘密，assertNoLeak），历史卷缺失两字段（缺失 = 旧协议）；
 * - PATCH /attempts/:id/workflow：首次提交前可改、真实事务 CAS（陈旧 409）、
 *   不允许模式 400、legacy/lesson/已交/首题已交/跨学生拒绝、no-store。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 单题判断题练习文档（错题重练与课程练习共用最小夹具） */
const PRACTICE_MD = `---
kind: practice
unit: 工作流练习
topic: 测试
---

::::question{type=judge difficulty=1}
$1+1=2$。[[正确]]
::::
`;

type App = ReturnType<typeof createApp>;

interface Env {
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  bCookie: string;
  unitId: string;
}

/** 基础环境：教师 + 导入单题单元 + 张三/李四 */
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
  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习.md" }),
  });
  expect(imported.status).toBe(200);
  const unitId = (
    (await imported.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("导入未产出单元");
  const aCookie = await createStudentAndLogin(app, teacherCookie, "张三");
  const bCookie = await createStudentAndLogin(app, teacherCookie, "李四");
  return { app, db, teacherCookie, aCookie, bCookie, unitId };
}

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

async function createStudentAndLogin(
  app: App,
  teacherCookie: string,
  name: string,
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: name,
      loginName: name,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(res.status).toBe(201);
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  return `tutor_student_session=${extractSessionToken(login, "tutor_student_session")}`;
}

/** 布置作业（缺省单位一份 merged），返回作业 id */
async function createAssignment(
  app: App,
  teacherCookie: string,
  unitId: string,
  studentLoginName: string | string[],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const names = Array.isArray(studentLoginName)
    ? studentLoginName
    : [studentLoginName];
  const studentIds: string[] = [];
  for (const name of names) {
    studentIds.push(await studentIdOfLogin(app, teacherCookie, name));
  }
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      unitIds: [unitId],
      studentIds: studentIds,
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { data: { assignments: { id: string }[] } })
    .data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少 id");
  return id;
}

async function studentIdOfLogin(
  app: App,
  teacherCookie: string,
  loginName: string,
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    headers: { cookie: teacherCookie },
  });
  const list = (
    (await res.json()) as {
      data: { students: { id: string; loginName: string | null }[] };
    }
  ).data.students;
  const found = list.find((entry) => entry.loginName === loginName);
  if (!found) throw new Error(`未找到学生 ${loginName}`);
  return found.id;
}

/** POST /assignments/:id/attempt（可带可选工作流选项 body） */
async function postAssignmentAttempt(
  app: App,
  cookie: string,
  assignmentId: string,
  options: Record<string, unknown> = {},
): Promise<Response> {
  return app.request(`/api/student/assignments/${assignmentId}/attempt`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(options),
  });
}

/** GET /attempts/:id 草稿视图 */
async function getAttempt(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  return app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie },
  });
}

/** attempt 行的工作流三列 */
function workflowColumns(db: Db, attemptId: string) {
  return db
    .select({
      version: attempts.practiceWorkflowVersion,
      mode: attempts.feedbackMode,
      revision: attempts.workflowRevision,
    })
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
}

describe("M1b 建卷：新协议显式写入，旧请求维持旧协议", () => {
  it("作业建卷：省略选项 → 旧协议（version NULL）；显式 v1 → 新协议默认 per_question", async () => {
    const env = await makeEnv();
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      ["张三", "李四"],
      { allowPerQuestionFeedback: true },
    );
    const legacy = await postAssignmentAttempt(env.app, env.aCookie, asgId);
    expect(legacy.status).toBe(200);
    const legacyId = ((await legacy.json()) as { data: { id: string } }).data
      .id;
    expect(workflowColumns(env.db, legacyId)).toEqual({
      version: null,
      mode: null,
      revision: 0,
    });

    // 第二个学生显式新协议
    const fresh = await postAssignmentAttempt(env.app, env.bCookie, asgId, {
      workflowVersion: 1,
    });
    expect(fresh.status).toBe(200);
    const freshId = ((await fresh.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, freshId)).toEqual({
      version: 1,
      mode: "per_question",
      revision: 0,
    });
  });

  it("作业未授权逐题（allow=false）：新协议卷恒 after_attempt + teacher_after_attempt，学生显式 per_question 不能越权", async () => {
    const env = await makeEnv();
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
    );
    const res = await postAssignmentAttempt(env.app, env.aCookie, asgId, {
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(res.status).toBe(200);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, attemptId)).toEqual({
      version: 1,
      mode: "after_attempt",
      revision: 0,
    });
    const detail = await getAttempt(env.app, env.aCookie, attemptId);
    const workflow = (
      (await detail.json()) as {
        data: { practiceWorkflow?: { restrictionReason: string | null } };
      }
    ).data.practiceWorkflow;
    expect(workflow?.restrictionReason).toBe("teacher_after_attempt");
  });

  it("create-or-return：已有 draft 卷原样返回（旧协议不升级；新协议不覆盖模式）", async () => {
    const env = await makeEnv();
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
      { allowPerQuestionFeedback: true },
    );
    const first = await postAssignmentAttempt(env.app, env.aCookie, asgId);
    const firstId = ((await first.json()) as { data: { id: string } }).data.id;
    // 旧协议卷 + 新协议请求 → 返回原卷且不升级
    const second = await postAssignmentAttempt(env.app, env.aCookie, asgId, {
      workflowVersion: 1,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { id: string } }).data.id).toBe(
      firstId,
    );
    expect(workflowColumns(env.db, firstId)?.version).toBeNull();
  });

  it("错题重练建卷：教师策略 after_attempt → 新卷 after_attempt；未配置默认 per_question", async () => {
    const env = await makeEnv();
    // 张三先做一份作业并交卷判错，制造错题
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
    );
    const attempt = await postAssignmentAttempt(env.app, env.aCookie, asgId);
    const attemptId = ((await attempt.json()) as { data: { id: string } }).data
      .id;
    await submitAllWrong(env.app, env.aCookie, attemptId);
    // 未配置 → 默认 per_question
    const first = await env.app.request("/api/student/wrong-practice", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: env.aCookie },
      body: JSON.stringify({
        questionIds: ["工作流练习-1"],
        workflowVersion: 1,
      }),
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, firstId)?.mode).toBe("per_question");

    // 教师收紧 → 新卷 after_attempt
    env.db
      .update(teachers)
      .set({ practiceFeedbackPolicy: "after_attempt" })
      .where(eq(teachers.loginName, "teacher"))
      .run();
    const second = await env.app.request("/api/student/wrong-practice", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: env.aCookie },
      body: JSON.stringify({
        questionIds: ["工作流练习-1"],
        workflowVersion: 1,
      }),
    });
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { data: { id: string } }).data
      .id;
    expect(workflowColumns(env.db, secondId)).toEqual({
      version: 1,
      mode: "after_attempt",
      revision: 0,
    });
  });
});

/** 全部题答错并交卷（judge 题答 false）——制造错题的捷径 */
async function submitAllWrong(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<void> {
  // #6980-3：未做判错不再入错题本——制造错题改为「答了判错」：
  // 单道 judge 题标准答案是「正确」，答 false 判错
  const saved = await app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent("工作流练习-1")}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ answer: { kind: "judge", value: false } }),
    },
  );
  expect(saved.status).toBe(200);
  const submit = await submitAttemptRequest(app, cookie, attemptId);
  expect([200, 201]).toContain(submit.status);
}

describe("M1b 草稿读取：工作流投影与题级进度白名单", () => {
  it("新协议卷携带 practiceWorkflow/questionProgress（白名单）；历史卷缺失两字段；两卷都过 assertNoLeak", async () => {
    const env = await makeEnv();
    const legacyAsg = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
    );
    const freshAsg = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
      { allowPerQuestionFeedback: true, title: "新协议作业" },
    );
    const legacyRes = await postAssignmentAttempt(
      env.app,
      env.aCookie,
      legacyAsg,
    );
    const legacyId = ((await legacyRes.json()) as { data: { id: string } }).data
      .id;
    const freshRes = await postAssignmentAttempt(
      env.app,
      env.aCookie,
      freshAsg,
      {
        workflowVersion: 1,
      },
    );
    expect(freshRes.status).toBe(200);
    const freshId = ((await freshRes.json()) as { data: { id: string } }).data
      .id;

    const legacyDetail = await getAttempt(env.app, env.aCookie, legacyId);
    expect(legacyDetail.status).toBe(200);
    const legacyBody = (await legacyDetail.json()) as {
      data: Record<string, unknown>;
    };
    expect(legacyBody.data.practiceWorkflow).toBeUndefined();
    expect(legacyBody.data.questionProgress).toBeUndefined();
    assertNoLeak(legacyBody);

    const freshDetail = await getAttempt(env.app, env.aCookie, freshId);
    expect(freshDetail.status).toBe(200);
    const freshBody = (await freshDetail.json()) as {
      data: {
        practiceWorkflow?: {
          version: number;
          feedbackMode: string;
          revision: number;
          canChangeFeedback: boolean;
          canSubmitQuestion: boolean;
          restrictionReason: string | null;
        };
        questionProgress?: {
          questionId: string;
          submittedAt: string | null;
          feedbackReadable: boolean;
        }[];
      };
    };
    const workflow = freshBody.data.practiceWorkflow;
    expect(workflow).toMatchObject({
      version: 1,
      feedbackMode: "per_question",
      revision: 0,
      canChangeFeedback: true,
      canSubmitQuestion: true,
      restrictionReason: null,
    });
    expect(freshBody.data.questionProgress).toEqual([
      {
        questionId: "工作流练习-1",
        submittedAt: null,
        feedbackReadable: false,
      },
    ]);
    assertNoLeak(freshBody);
  });

  it("教师收紧后草稿重算：canSubmitQuestion=false、allowed 收窄，已选 feedbackMode 不改写", async () => {
    const env = await makeEnv();
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
      { allowPerQuestionFeedback: true },
    );
    const res = await postAssignmentAttempt(env.app, env.aCookie, asgId, {
      workflowVersion: 1,
    });
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    // 教师撤授权（保留 on_submit）
    env.db
      .update(assignments)
      .set({ allowPerQuestionFeedback: false })
      .where(eq(assignments.id, asgId))
      .run();
    const detail = await getAttempt(env.app, env.aCookie, attemptId);
    const body = (await detail.json()) as {
      data: {
        practiceWorkflow?: {
          feedbackMode: string;
          allowedFeedbackModes: string[];
          canSubmitQuestion: boolean;
          restrictionReason: string | null;
        };
      };
    };
    expect(body.data.practiceWorkflow).toMatchObject({
      feedbackMode: "per_question",
      allowedFeedbackModes: ["after_attempt"],
      canSubmitQuestion: false,
      restrictionReason: "teacher_after_attempt",
    });
  });
});

describe("M1b PATCH /attempts/:id/workflow", () => {
  it("未登录 401；跨学生 404；legacy 卷 409 WORKFLOW_LEGACY", async () => {
    const env = await makeEnv();
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
    );
    const res = await postAssignmentAttempt(env.app, env.aCookie, asgId);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;

    const unauth = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(unauth.status).toBe(401);

    const foreign = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.bCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(foreign.status).toBe(404);

    const legacy = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(legacy.status).toBe(409);
    expect(((await legacy.json()) as ApiErr).error).toBe("WORKFLOW_LEGACY");
  });
});

describe("M1b PATCH /attempts/:id/workflow：成功与 CAS", () => {
  /** 建一个已授权新协议 draft 卷（张三），返回 attempt 与作业 id */
  async function makeFreshAttempt(
    env: Env,
  ): Promise<{ attemptId: string; asgId: string }> {
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
      { allowPerQuestionFeedback: true },
    );
    const res = await postAssignmentAttempt(env.app, env.aCookie, asgId, {
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(res.status).toBe(200);
    return {
      attemptId: ((await res.json()) as { data: { id: string } }).data.id,
      asgId,
    };
  }

  it("成功改节奏：revision 0→1、no-store 响应携带新投影；陈旧 revision 409 WORKFLOW_REVISION_STALE", async () => {
    const env = await makeEnv();
    const { attemptId } = await makeFreshAttempt(env);
    const first = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const firstBody = (await first.json()) as {
      data: {
        practiceWorkflow: { feedbackMode: string; revision: number };
        questionProgress: unknown[];
      };
    };
    expect(firstBody.data.practiceWorkflow).toMatchObject({
      feedbackMode: "after_attempt",
      revision: 1,
    });
    assertNoLeak(firstBody);
    expect(workflowColumns(env.db, attemptId)).toEqual({
      version: 1,
      mode: "after_attempt",
      revision: 1,
    });

    // 陈旧 revision（重放第一次请求）→ 409
    const stale = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ApiErr).error).toBe(
      "WORKFLOW_REVISION_STALE",
    );
  });

  it("教师不允许的模式 → 400 WORKFLOW_MODE_NOT_ALLOWED；已交卷 → 409 ALREADY_SUBMITTED", async () => {
    const env = await makeEnv();
    const { attemptId, asgId } = await makeFreshAttempt(env);
    env.db
      .update(assignments)
      .set({ allowPerQuestionFeedback: false })
      .where(eq(assignments.id, asgId))
      .run();
    // 收紧后（教师 after_attempt）请求 per_question
    const restricted = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "per_question",
          workflowRevision: 0,
        }),
      },
    );
    expect(restricted.status).toBe(400);

    // 已整卷提交 → 409
    await submitAllWrong(env.app, env.aCookie, attemptId);
    const submitted = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(submitted.status).toBe(409);
    expect(((await submitted.json()) as ApiErr).error).toBe(
      "ALREADY_SUBMITTED",
    );
  });

  it("陈旧 revision 且模式也不被允许 → 409 WORKFLOW_REVISION_STALE 优先（客户端凭 409 刷新，避免 CAS 重试死循环）", async () => {
    const env = await makeEnv();
    const { attemptId, asgId } = await makeFreshAttempt(env);
    // 先合法切换一次（revision 0→1）
    await env.app.request(`/api/student/attempts/${attemptId}/workflow`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: env.aCookie },
      body: JSON.stringify({
        feedbackMode: "after_attempt",
        workflowRevision: 0,
      }),
    });
    // 教师收紧 + revision 陈旧：应报 409 而非 400
    env.db
      .update(assignments)
      .set({ allowPerQuestionFeedback: false })
      .where(eq(assignments.id, asgId))
      .run();
    const res = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "per_question",
          workflowRevision: 0,
        }),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe(
      "WORKFLOW_REVISION_STALE",
    );
  });

  it("任一题已提交（模拟 M2 题级提交事实）→ 409 QUESTION_ALREADY_SUBMITTED", async () => {
    const env = await makeEnv();
    const { attemptId } = await makeFreshAttempt(env);
    env.db
      .update(responses)
      .set({ submittedAt: "2026-10-22T00:00:00.000Z" })
      .where(eq(responses.attemptId, attemptId))
      .run();
    const res = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe(
      "QUESTION_ALREADY_SUBMITTED",
    );
  });
});

describe("teacherPolicyOfStudent：异常数据 fail closed", () => {
  it("教师行缺失（teacherId 悬挂）→ after_attempt，不得按未配置缺省放行 student_choice；正常未配置 → null", async () => {
    const env = await makeEnv();
    const teacherRow = env.db.select().from(teachers).get();
    if (!teacherRow) throw new Error("夹具缺教师行");
    const [normalId] = env.db
      .select({ id: students.id })
      .from(students)
      .limit(1)
      .all()
      .map((row) => row.id);
    if (!normalId) throw new Error("夹具缺学生行");
    // 正常教师行存在且未配置 → null（resolver 缺省 student_choice）
    expect(teacherPolicyOfStudent(env.db, normalId)).toBeNull();

    // 悬挂 teacherId（教师行不存在）：不得把 join 未命中的 null 误判为「未配置」
    const ghostId = crypto.randomUUID();
    env.db
      .insert(students)
      .values({
        id: ghostId,
        teacherId: "missing-teacher-id",
        displayName: "孤儿",
        loginName: `ghost-${ghostId}`,
        linkToken: `ghost-${ghostId}`,
        linkEnabled: false,
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(teacherPolicyOfStudent(env.db, ghostId)).toBe("after_attempt");
    // 学生不存在 → after_attempt
    expect(teacherPolicyOfStudent(env.db, "no-such-student")).toBe(
      "after_attempt",
    );
  });
});

describe("v2 合并验收补充：异常数据降级与课程失权（2026-10-22）", () => {
  it("课程失权后 PATCH workflow 403 COURSE_ACCESS_DENIED（requireVisibleCourseUnit 分态校验）", async () => {
    const env = await makeEnv();
    const course = await env.app.request("/api/teacher/courses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ title: "工作流课程" }),
    });
    expect(course.status).toBe(201);
    const courseId = ((await course.json()) as { data: { id: string } }).data
      .id;
    const imported = await env.app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        markdown: PRACTICE_MD,
        filename: "课程练习.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    const courseUnitId = (
      (await imported.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!courseUnitId) throw new Error("课程导入未产出单元");
    const detail = await env.app.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: env.teacherCookie },
    });
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === courseUnitId);
    if (!item) throw new Error("课程目录缺单元条目");
    const visible = await env.app.request(
      `/api/teacher/course-items/${item.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ visible: true }),
      },
    );
    expect(visible.status).toBe(200);
    const zhangId = await studentIdOfLogin(env.app, env.teacherCookie, "张三");
    const added = await env.app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [zhangId] }),
      },
    );
    expect(added.status).toBe(200);
    const start = await env.app.request(
      `/api/student/courses/${courseId}/units/${courseUnitId}/attempts`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          workflowVersion: 1,
          feedbackMode: "per_question",
        }),
      },
    );
    expect(start.status).toBe(201);
    const attemptId = ((await start.json()) as { data: { id: string } }).data
      .id;

    // 移出成员 → PATCH 与取卷同口径 403，不得仍可改节奏
    await env.app.request(`/api/teacher/courses/${courseId}/members`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ studentIds: [zhangId] }),
    });
    const patch = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "after_attempt",
          workflowRevision: 0,
        }),
      },
    );
    expect(patch.status).toBe(403);
    expect(((await patch.json()) as ApiErr).error).toBe("COURSE_ACCESS_DENIED");
  });
});

describe("M5-D2 建卷：文档推荐进入裁决链（studentChoice > unitRecommendation > per_question）", () => {
  /** 课程练习环境：教师 + 导入单题单元入课程 + 张三成员，返回课程/单元 id */
  async function makeCourseEnv(): Promise<
    Env & { courseId: string; courseUnitId: string }
  > {
    const env = await makeEnv();
    const course = await env.app.request("/api/teacher/courses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ title: "推荐课程" }),
    });
    expect(course.status).toBe(201);
    const courseId = ((await course.json()) as { data: { id: string } }).data
      .id;
    const imported = await env.app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        markdown: PRACTICE_MD,
        filename: "推荐练习.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    const courseUnitId = (
      (await imported.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!courseUnitId) throw new Error("课程导入未产出单元");
    const detail = await env.app.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: env.teacherCookie },
    });
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === courseUnitId);
    if (!item) throw new Error("课程目录缺单元条目");
    const visible = await env.app.request(
      `/api/teacher/course-items/${item.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ visible: true }),
      },
    );
    expect(visible.status).toBe(200);
    const zhangId = await studentIdOfLogin(env.app, env.teacherCookie, "张三");
    const added = await env.app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [zhangId] }),
      },
    );
    expect(added.status).toBe(200);
    return { ...env, courseId, courseUnitId };
  }

  /** 直写单元推荐列（模拟 frontmatter practice 导入产物） */
  function setUnitRecommendation(
    env: Env,
    unitId: string,
    recommendation: Record<string, unknown> | string | null,
  ): void {
    env.db
      .update(units)
      .set({
        practiceDefaultsJson:
          recommendation === null || typeof recommendation === "string"
            ? recommendation
            : JSON.stringify(recommendation),
      })
      .where(eq(units.id, unitId))
      .run();
  }

  async function startCourseAttempt(
    env: Env & { courseId: string; courseUnitId: string },
    options: Record<string, unknown> = {},
  ): Promise<Response> {
    return env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.courseUnitId}/attempts`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify(options),
      },
    );
  }

  it("不传 feedbackMode 且单元推荐 after_attempt → 建卷列 after_attempt（推荐生效面=从未保存偏好的学生）", async () => {
    const env = await makeCourseEnv();
    setUnitRecommendation(env, env.courseUnitId, {
      feedback: "after_attempt",
    });
    const res = await startCourseAttempt(env, { workflowVersion: 1 });
    expect(res.status).toBe(201);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, attemptId)).toEqual({
      version: 1,
      mode: "after_attempt",
      revision: 0,
    });
  });

  it("学生显式选择胜出：推荐 after_attempt 但 feedbackMode=per_question → per_question", async () => {
    const env = await makeCourseEnv();
    setUnitRecommendation(env, env.courseUnitId, {
      feedback: "after_attempt",
    });
    const res = await startCourseAttempt(env, {
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(res.status).toBe(201);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, attemptId)?.mode).toBe("per_question");
  });

  it("教师限制收敛推荐：教师策略 after_attempt + 推荐 per_question → after_attempt", async () => {
    const env = await makeCourseEnv();
    setUnitRecommendation(env, env.courseUnitId, {
      feedback: "per_question",
    });
    const put = await env.app.request(
      "/api/teacher/settings/practice-feedback",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ practiceFeedbackPolicy: "after_attempt" }),
      },
    );
    expect(put.status).toBe(200);
    const res = await startCourseAttempt(env, { workflowVersion: 1 });
    expect(res.status).toBe(201);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, attemptId)?.mode).toBe("after_attempt");
  });

  it("单元无推荐 + 不传 feedbackMode → 缺省 per_question（无推荐老文档行为不变）", async () => {
    const env = await makeCourseEnv();
    const res = await startCourseAttempt(env, { workflowVersion: 1 });
    expect(res.status).toBe(201);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    expect(workflowColumns(env.db, attemptId)?.mode).toBe("per_question");
  });
});
