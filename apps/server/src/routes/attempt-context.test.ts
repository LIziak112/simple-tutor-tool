import type { ApiErr } from "@tutor/contract";
import { attemptContextOkSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import {
  attemptContextSnapshots,
  materials,
  questionGroups,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * GET /api/student/attempts/:id/context 集成测试（tt-07a / QM-06 快照公开
 * 投影路由 + TT-05b 审查 P2-2 记账落实——路由层复用 attempt 归属校验 +
 * 泄露测试双断言）：
 * - 公开投影白名单：材料/组条目键集 = materialPublicSchema /
 *   questionGroupPublicSchema + sourceVersion（sourceMd 等教师侧字段绝不
 *   下发，三投影纪律：不从完整快照删键、服务端显式挑键）；
 * - 双断言泄露（AGENTS 第 3 条）：assertNoLeak 键名族 + 内容哨兵（题内
 *   solution/hint 文本、[[答案]] 标记、教师私注）均不出现在响应；
 * - 归属校验（P2-2 核心）：非本人（同教师另一学生 / 教师乙的学生——跨域
 *   同 ID 隔离）→ 403；未知 attempt → 404；匿名 → 401；
 * - 旧卷一致性：教师改材料 v2 / 软删材料与组后，已开卷读取仍是冻结 v1
 *   （读路径只读快照，不改用 live 资源替代）；
 * - 坏快照：snapshot_json 损坏 → 409 ATTEMPT_CONTEXT_BROKEN 显式报错。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-ctx";
const STUDENT_PASSWORD = "stu-pass-ctx";
const TEACHER_B_ID = "teacher-b-ctx";
const NOW = "2026-10-24T10:00:00.000Z";

/** 语料：材料（含 seg 锚点）+ 组（引用材料与两子题）+ 两题（含详解/提示/答案标记——泄露哨兵） */
const CONTEXT_MD = `---
kind: practice
unit: 上下文投影
---

::::material{title=共享资料}
共享资料正文第一段。

:::seg
首段锚点。
:::
::::

::::group{title=资料组 label=1～2}
::ref{material=mat-上下文投影-1}
::ref{question=上下文投影-1}
::ref{question=上下文投影-2}
::::

::::question{type=choice difficulty=2}
根据材料选择正确项。

- [ ] 甲
- [x] 乙

:::solution
详解哨兵：答案选乙。
:::

:::hint
提示哨兵：细读第一段。
:::
::::

::::question{type=judge difficulty=1}
甲是正确的。[[正确]]

:::solution
详解哨兵二：甲不对。
:::
::::
`;

const Q = {
  choice: "上下文投影-1",
  judge: "上下文投影-2",
} as const;

type App = ReturnType<typeof createApp>;

interface ContextEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  bCookie: string;
  /** 教师乙的学生会话（跨域同 ID 隔离用） */
  crossCookie: string;
  courseId: string;
  unitId: string;
  attemptId: string;
}

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

/** 登录学生并返回会话 cookie */
async function loginStudent(app: App, loginName: string): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_student_session=${extractSessionToken(res, "tutor_student_session")}`;
}

/** 组装被测环境：教师甲 + QM 语料课程 + 学生甲开卷（冻结闭包建立）+ 学生乙（同教师）+ 教师乙的学生（跨域） */
async function makeContextEnv(): Promise<ContextEnv> {
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
    body: JSON.stringify({ title: "上下文投影课程" }),
  });
  expect(created.status).toBe(201);
  const courseId = ((await created.json()) as { data: { id: string } }).data.id;

  // QM 新语法导入需发布开关（§5.8.4）；导入完成后即恢复，避免影响其余用例
  const previous = process.env.NEW_CONTENT_ENABLED;
  process.env.NEW_CONTENT_ENABLED = "true";
  let unitId: string | undefined;
  try {
    const imported = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        markdown: CONTEXT_MD,
        filename: "上下文投影.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    unitId = ((await imported.json()) as { data: { units: { id: string }[] } })
      .data.units[0]?.id;
  } finally {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
  }
  if (!unitId) throw new Error("导入未产出单元");

  const detail = await app.request(`/api/teacher/courses/${courseId}`, {
    headers: { cookie: teacherCookie },
  });
  const item = (
    (await detail.json()) as {
      data: { items: { id: string; refId: string | null }[] };
    }
  ).data.items.find((entry) => entry.refId === unitId);
  if (!item) throw new Error("课程目录中未找到单元条目");
  const patched = await app.request(`/api/teacher/course-items/${item.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ visible: true }),
  });
  expect(patched.status).toBe(200);

  // 学生甲（开卷人）与学生乙（同教师非本人）
  const studentIds: string[] = [];
  for (const name of ["投影甲", "投影乙"]) {
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
    studentIds.push(
      ((await res.json()) as { data: { student: { id: string } } }).data.student
        .id,
    );
  }
  const addMembers = await app.request(
    `/api/teacher/courses/${courseId}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ studentIds }),
    },
  );
  expect(addMembers.status).toBe(200);

  const aCookie = await loginStudent(app, "投影甲");
  const bCookie = await loginStudent(app, "投影乙");

  // 教师乙的学生（直插教师行 + 学生行 + 会话——export-csv 跨域隔离同款）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师投影",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$ctx-fixture",
      apiToken: null,
      createdAt: NOW,
    })
    .run();
  const crossStudentId = "student-ctx-cross";
  db.insert(students)
    .values({
      id: crossStudentId,
      teacherId: TEACHER_B_ID,
      displayName: "乙的学生",
      loginName: "乙的学生投影",
      passwordHash: null,
      linkToken: "link-ctx-cross",
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: NOW,
    })
    .run();
  const crossCookie = `tutor_student_session=${
    createStudentSession(db, crossStudentId).token
  }`;

  // 学生甲开卷（同事务冻结材料/组闭包）
  const started = await app.request(
    `/api/student/courses/${courseId}/units/${encodeURIComponent(unitId)}/attempts`,
    { method: "POST", headers: { cookie: aCookie } },
  );
  expect([200, 201]).toContain(started.status);
  const attemptId = ((await started.json()) as { data: { id: string } }).data
    .id;

  return {
    app,
    db,
    teacherCookie,
    aCookie,
    bCookie,
    crossCookie,
    courseId,
    unitId,
    attemptId,
  };
}

/** GET /api/student/attempts/:id/context；cookie 传 null 表示匿名 */
async function getContext(
  env: ContextEnv,
  attemptId: string = env.attemptId,
  cookie: string | null = env.aCookie,
): Promise<Response> {
  return env.app.request(`/api/student/attempts/${attemptId}/context`, {
    headers: cookie === null ? {} : { cookie },
  });
}

describe("GET /api/student/attempts/:id/context（tt-07a 冻结上下文公开投影）", () => {
  it("作答期读取：公开投影白名单键集 + 契约校验 + 双断言泄露（无 answers/solutionMd/提示/私注哨兵）", async () => {
    const env = await makeContextEnv();
    // 在 responses 行写入教师私注哨兵（响应绝不携带）
    env.db
      .update(responses)
      .set({ teacherComment: "私注哨兵：不该被学生看到" })
      .where(eq(responses.attemptId, env.attemptId))
      .run();

    const res = await getContext(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(attemptContextOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: { materials: unknown[]; groups: unknown[] } })
      .data;

    // 材料/组条目键集 = 公开投影白名单 + sourceVersion（无 sourceMd 等教师侧键）
    expect(data.materials).toHaveLength(1);
    expect(Object.keys(data.materials[0] ?? {}).sort()).toEqual([
      "anchors",
      "contentMd",
      "id",
      "mediaPaths",
      "slots",
      "sourceVersion",
      "title",
    ]);
    expect(data.groups).toHaveLength(1);
    expect(Object.keys(data.groups[0] ?? {}).sort()).toEqual([
      "id",
      "introMd",
      "label",
      "materialRefs",
      "questionIds",
      "sourceVersion",
      "title",
    ]);
    const group = data.groups[0] as { questionIds: string[] };
    expect(group.questionIds).toEqual([Q.choice, Q.judge]);

    // 泄露断言①：assertNoLeak 键名族（answers/solution*/hint*/sourceMd/私注键）
    assertNoLeak(body);
    // 泄露断言②：内容哨兵（详解/提示/答案标记/教师私注的原文）
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("详解哨兵");
    expect(serialized).not.toContain("提示哨兵");
    expect(serialized).not.toContain("[[正确]]");
    expect(serialized).not.toContain("私注哨兵");
    // 正文按公开内容下发（材料 contentMd 是学生作答所需）
    expect(serialized).toContain("共享资料正文第一段");
  });

  it("归属校验（TT-05b P2-2 记账）：非本人 403；教师乙的学生跨域同 ID 隔离 403；未知 attempt 404；匿名 401", async () => {
    const env = await makeContextEnv();

    // 同教师另一名学生 → 403（归属即权限）
    const sameTeacher = await getContext(env, env.attemptId, env.bCookie);
    expect(sameTeacher.status).toBe(403);
    expect(((await sameTeacher.json()) as ApiErr).error).toBe("FORBIDDEN");

    // 教师乙的学生 → 403（快照三函数按 attemptId 直查不过滤 teacherId 是
    // 设计内，归属防线在路由层 requireOwnAttempt——跨域同 ID 不可见）
    const cross = await getContext(env, env.attemptId, env.crossCookie);
    expect(cross.status).toBe(403);
    const crossBody = (await cross.json()) as unknown;
    expect((crossBody as ApiErr).error).toBe("FORBIDDEN");
    // 跨域响应同样不带任何快照内容
    assertNoLeak(crossBody);

    // 未知 attempt → 404
    const unknown = await getContext(env, "attempt-does-not-exist");
    expect(unknown.status).toBe(404);

    // 匿名 → 401
    const anon = await getContext(env, env.attemptId, null);
    expect(anon.status).toBe(401);
  });

  it("旧卷一致性：教师改材料 v2 + 软删材料与组后，读取仍是冻结 v1（不用 live 替代）；交卷后回看照常", async () => {
    const env = await makeContextEnv();
    const materialId = env.db
      .select({ id: materials.id })
      .from(materials)
      .limit(1)
      .all()[0]?.id;
    if (!materialId) throw new Error("夹具缺少材料行");
    const groupId = env.db
      .select({ id: questionGroups.id })
      .from(questionGroups)
      .limit(1)
      .all()[0]?.id;
    if (!groupId) throw new Error("夹具缺少题组行");

    // 教师改材料（v2）并软删材料与组（live 侧全部「变动」）
    env.db
      .update(materials)
      .set({
        contentMd: "教师改稿后的新正文（v2）",
        version: 99,
      })
      .where(eq(materials.id, materialId))
      .run();
    env.db
      .update(questionGroups)
      .set({ deletedAt: NOW })
      .where(eq(questionGroups.id, groupId))
      .run();

    const frozen = await getContext(env);
    expect(frozen.status).toBe(200);
    const data = (
      (await frozen.json()) as {
        data: {
          materials: { sourceVersion: number; contentMd: string }[];
          groups: unknown[];
        };
      }
    ).data;
    expect(data.materials[0]?.sourceVersion).toBe(1);
    expect(data.materials[0]?.contentMd).toContain("共享资料正文第一段");
    expect(data.materials[0]?.contentMd).not.toContain("v2");
    expect(data.groups).toHaveLength(1); // 软删不影响已开卷

    // 交卷后结果回看照常读取（submitted 卷不做课程校验，D7）
    const answerRes = await env.app.request(
      `/api/student/attempts/${env.attemptId}/answers/${encodeURIComponent(Q.judge)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({ answer: { kind: "judge", value: true } }),
      },
    );
    expect(answerRes.status).toBe(200);
    const submitted = await submitAttemptRequest(
      env.app,
      env.aCookie,
      env.attemptId,
    );
    expect(submitted.status).toBe(200);
    const afterSubmit = await getContext(env);
    expect(afterSubmit.status).toBe(200);
  });

  it("坏快照：snapshot_json 损坏 → 409 ATTEMPT_CONTEXT_BROKEN 显式报错（不静默、不用 live 替代）", async () => {
    const env = await makeContextEnv();
    env.db
      .update(attemptContextSnapshots)
      .set({ snapshotJson: "{bad json" })
      .where(eq(attemptContextSnapshots.attemptId, env.attemptId))
      .run();

    const res = await getContext(env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("ATTEMPT_CONTEXT_BROKEN");
    expect(body.message).toContain("快照");
    // 错误响应不带任何题目/材料内容
    assertNoLeak(body);
  });
});
