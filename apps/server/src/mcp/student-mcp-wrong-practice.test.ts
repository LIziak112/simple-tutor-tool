import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { connectMcpClientViaApp } from "../test/mcp-test-utils.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * 学生 MCP 错题组卷工具测试（2026-10 错题本迭代：list_my_wrong_questions +
 * create_wrong_practice，真实 SDK Streamable HTTP 客户端全链路）：
 * - list_my_wrong_questions：只读，只给组卷决策所需的元数据 + 脱敏题干摘录
 *   （studentStemMd 投影后的 stemMd 截断），**不下发答案/详解/本人答案**
 *   （assertNoLeak 默认集合 + 摘录无 [[答案]] 内容）；筛选（knowledge/courseId/
 *   sinceDays/includeConquered/limit）与本人域隔离；
 * - create_wrong_practice：走 startWrongPractice 服务层（与页面接口同一校验：
 *   ∉ 错题本聚合的题静默剔除、剔完为空 400 WRONG_PRACTICE_EMPTY）；每次调用
 *   新建一份独立练习卷（**非幂等**）；建卷范围 kind=ai 随卷快照落库；建出的卷
 *   学生页面 API 可读（同一规则另一接口闭环）；
 * - 他学生的错题 id 不在本人聚合 → 静默剔除（跨生数据不可组卷）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-w";
const STUDENT_PASSWORD = "stu-pass-w";

/** 三道判断题（两个考点）+ 一道含详解的解答题（不入本，防侧漏对照） */
const COURSE_PRACTICE_MD = `---
kind: practice
unit: MCP组卷课程练习
topic: 正数与负数
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]

:::hint
大于 $0$ 的数是正数。
:::
::::

::::question{type=judge difficulty=2 knowledge="有理数加法"}
$-1+1$ 是负数。[[错误]]

:::solution
$-1+1=0$，$0$ 既不是正数也不是负数。
:::
::::

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是正数。[[错误]]
::::
`;

/** 题目 id（单元 slug 缺省编号） */
const Q = {
  concept1: "MCP组卷课程练习-1",
  addition: "MCP组卷课程练习-2",
  concept2: "MCP组卷课程练习-3",
} as const;

/** 判断题正确答案（[[正确]] → true；[[错误]] → false） */
const CORRECT: Record<string, { kind: "judge"; value: boolean }> = {
  [Q.concept1]: { kind: "judge", value: true },
  [Q.addition]: { kind: "judge", value: false },
  [Q.concept2]: { kind: "judge", value: false },
};

/** 多轮时间轴（sinceDays 与攻克场景用；近期时间相对真实时钟动态生成） */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}
const OLD_DAY = "2026-01-01T00:00:00.000Z";
const RECENT_DAY = daysAgoIso(2);
const RECENT_DAY_2 = daysAgoIso(1);

type App = ReturnType<typeof createApp>;

interface McpWrongEnv {
  app: App;
  db: Db;
  aCookie: string;
  bCookie: string;
  courseId: string;
  unitId: string;
  token: string;
  client: Client;
}

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

/** 建教师 + 课程 + 三道判断题 + 学生甲（MCP 连接）与学生乙 */
async function makeMcpWrongEnv(): Promise<McpWrongEnv> {
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
    body: JSON.stringify({ title: "初一上" }),
  });
  expect(created.status).toBe(201);
  const courseId = ((await created.json()) as { data: { id: string } }).data.id;

  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      markdown: COURSE_PRACTICE_MD,
      filename: "MCP组卷课程练习.md",
      courseId,
    }),
  });
  const importBody = (await imported.json()) as {
    data?: { units: { id: string }[] };
  } & Record<string, unknown>;
  expect(
    imported.status,
    `IMPORTBODY=${JSON.stringify(importBody).slice(0, 500)}`,
  ).toBe(200);
  const unitId = importBody.data?.units[0]?.id ?? "";
  if (unitId === "") throw new Error("导入未产出单元");

  const detail = await app.request(`/api/teacher/courses/${courseId}`, {
    headers: { cookie: teacherCookie },
  });
  const detailBody = (await detail.json()) as {
    data?: { items: { id: string; refId: string | null }[] };
  } & Record<string, unknown>;
  expect(
    detail.status,
    `DETAILBODY=${JSON.stringify(detailBody).slice(0, 400)}`,
  ).toBe(200);
  const item = detailBody.data?.items.find(
    (entry) => entry.refId === unitId,
  );
  if (!item) throw new Error("课程目录中未找到单元条目");
  const patched = await app.request(`/api/teacher/course-items/${item.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ visible: true }),
  });
  expect(patched.status).toBe(200);

  const mkStudent = async (name: string): Promise<string> => {
    const res = await app.request("/api/teacher/students", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        displayName: name,
        loginName: name,
        password: STUDENT_PASSWORD,
      }),
    });
    const body = (await res.json()) as {
      data?: { student?: { id: string } };
    } & Record<string, unknown>;
    expect(
      res.status,
      `STUBODY=${JSON.stringify(body).slice(0, 400)}`,
    ).toBe(201);
    const studentId = body.data?.student?.id;
    if (studentId === undefined) throw new Error("学生创建失败");
    const add = await app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ studentIds: [studentId] }),
      },
    );
    expect(add.status).toBe(200);
    const login = await app.request("/api/public/student/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
    });
    expect(login.status).toBe(200);
    return studentId;
  };
  await mkStudent("组卷甲");
  const bId = await mkStudent("组卷乙");

  // 学生甲建 MCP 连接（真实 token）
  const aLoginRes = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "组卷甲", password: STUDENT_PASSWORD }),
  });
  const aLoginBody = (await aLoginRes.json()) as Record<string, unknown>;
  expect(
    aLoginRes.status,
    `ALOGIN=${JSON.stringify(aLoginBody).slice(0, 300)}`,
  ).toBe(200);
  const aCookie = `tutor_student_session=${extractSessionToken(aLoginRes, "tutor_student_session")}`;
  const bLogin = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "组卷乙", password: STUDENT_PASSWORD }),
  });
  expect(bLogin.status, "学生乙登录失败").toBe(200);
  const bCookie = `tutor_student_session=${extractSessionToken(bLogin, "tutor_student_session")}`;
  void bId;

  const conn = await app.request("/api/student/ai/connections", {
    method: "POST",
    headers: { cookie: aCookie, "content-type": "application/json" },
    body: JSON.stringify({ channel: "mcp" }),
  });
  const connBody = (await conn.json()) as {
    data?: { credential?: { token: string } | null };
  } & Record<string, unknown>;
  expect(
    conn.status,
    `CONN=${JSON.stringify(connBody).slice(0, 300)}`,
  ).toBe(201);
  const token = connBody.data?.credential?.token;
  if (token === undefined || token === null) throw new Error("mcp token 创建失败");

  const client = await connectMcpClientViaApp(
    app,
    "/mcp/student",
    token,
    "mcp-wrong-practice-test",
  );
  return { app, db, aCookie, bCookie, courseId, unitId, token, client };
}

/** POST 课程练习入口，返回 attemptId */
async function startCourseAttempt(
  env: McpWrongEnv,
  cookie = env.aCookie,
): Promise<string> {
  const res = await env.app.request(
    `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitId)}/attempts`,
    { method: "POST", headers: { cookie } },
  );
  expect([200, 201]).toContain(res.status);
  return (((await res.json()) as { data: { id: string } }).data.id);
}

/** PUT 答案 */
async function saveAnswer(
  env: McpWrongEnv,
  attemptId: string,
  questionId: string,
  answer: unknown,
  cookie = env.aCookie,
): Promise<void> {
  const res = await env.app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ answer }),
    },
  );
  expect(res.status, `保存 ${questionId} 失败`).toBe(200);
}

/** 交卷并把该卷全部作答行时间写为指定时刻（确定性时间轴） */
async function submitAt(
  env: McpWrongEnv,
  attemptId: string,
  submittedAt: string,
  cookie = env.aCookie,
): Promise<void> {
  const res = await submitAttemptRequest(env.app, cookie, attemptId);
  expect(res.status).toBe(200);
  env.db
    .update(attempts)
    .set({ submittedAt })
    .where(eq(attempts.id, attemptId))
    .run();
  env.db
    .update(responses)
    .set({ submittedAt })
    .where(eq(responses.attemptId, attemptId))
    .run();
}

/** callTool + 解析首段 text 为 JSON */
async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const block = (result.content as TextContent[]).find(
    (c) => c.type === "text",
  );
  if (block === undefined) throw new Error(`${name} 结果没有 text content`);
  return {
    data: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

/** 学生甲做一轮课程练习：三题全错入本 */
async function answerAllWrong(env: McpWrongEnv, at: string): Promise<void> {
  const attemptId = await startCourseAttempt(env);
  for (const questionId of [Q.concept1, Q.addition, Q.concept2]) {
    const correct = CORRECT[questionId];
    await saveAnswer(env, attemptId, questionId, {
      kind: "judge",
      value: !correct.value,
    });
  }
  await submitAt(env, attemptId, at);
}

describe("list_my_wrong_questions（只读错题列表）", () => {
  it("列出本人错题：元数据 + 脱敏摘录，无答案/详解/本人答案（assertNoLeak）", async () => {
    const env = await makeMcpWrongEnv();
    try {
      await answerAllWrong(env, RECENT_DAY);
      const result = await callJson(env.client, "list_my_wrong_questions", {});
      expect(result.isError).toBe(false);
      const body = result.data as {
        total: number;
        questions: Array<Record<string, unknown>>;
      };
      expect(body.total).toBe(3);
      expect(body.questions).toHaveLength(3);
      const q = body.questions.find(
        (item) => item.questionId === Q.addition,
      );
      expect(q).toBeDefined();
      // 元数据齐备（组卷决策所需）
      expect(q?.type).toBe("judge");
      expect(q?.difficulty).toBe(2);
      expect(q?.knowledge).toEqual(["有理数加法"]);
      expect(q?.wrongCount).toBe(1);
      expect(q?.originUnitTitle).toBe("MCP组卷课程练习");
      expect(Array.isArray(q?.courseNames)).toBe(true);
      // 摘录：脱敏后题干（答案标记只剩空框 [[]]，绝无非空 [[答案]] 内容）
      const excerpt = (q?.stemExcerpt as string) ?? "";
      expect(excerpt.length).toBeGreaterThan(0);
      expect(excerpt).not.toMatch(/\[\[[^\]]+\]\]/);
      // 键名泄露矩阵：answers/solution*/hint 等教师侧键绝不出现在任何层级
      assertNoLeak(result.data);
      // 本人答案序列化文本（answerText 语义）也不得出现
      expect(JSON.stringify(result.data)).not.toContain("answerText");
    } finally {
      await env.client.close();
      env.db.$client.close();
    }
  });

  it("筛选：knowledge / courseId / sinceDays / includeConquered / limit", async () => {
    const env = await makeMcpWrongEnv();
    try {
      await answerAllWrong(env, RECENT_DAY);
      // concept1 再做一轮做对 → 服务端宽松口径 resolved=true，默认被过滤
      const attemptId = await startCourseAttempt(env);
      await saveAnswer(env, attemptId, Q.concept1, CORRECT[Q.concept1]);
      await saveAnswer(env, attemptId, Q.addition, {
        kind: "judge",
        value: true,
      });
      await saveAnswer(env, attemptId, Q.concept2, { kind: "judge", value: true });
      await submitAt(env, attemptId, RECENT_DAY_2);

      const base = await callJson(env.client, "list_my_wrong_questions", {});
      const ids = (
        (base.data as { questions: { questionId: string }[] }).questions
      ).map((item) => item.questionId);
      expect(ids).toEqual([Q.addition, Q.concept2]); // concept1 已攻克剔除

      const byKnowledge = await callJson(env.client, "list_my_wrong_questions", {
        knowledge: "有理数的概念",
      });
      expect(
        (
          byKnowledge.data as { questions: { questionId: string }[] }
        ).questions.map((item) => item.questionId),
      ).toEqual([Q.concept2]);

      const byCourse = await callJson(env.client, "list_my_wrong_questions", {
        courseId: env.courseId,
      });
      expect(
        (byCourse.data as { total: number }).total,
      ).toBe(2);
      const byUnknownCourse = await callJson(
        env.client,
        "list_my_wrong_questions",
        { courseId: "77777777-7777-4777-8777-777777777777" },
      );
      expect((byUnknownCourse.data as { total: number }).total).toBe(0);

      const conquered = await callJson(env.client, "list_my_wrong_questions", {
        includeConquered: true,
      });
      expect((conquered.data as { total: number }).total).toBe(3);

      const limited = await callJson(env.client, "list_my_wrong_questions", {
        limit: 1,
      });
      expect((limited.data as { total: number }).total).toBe(2);
      expect(
        (limited.data as { questions: unknown[] }).questions,
      ).toHaveLength(1);

      // sinceDays：全部错题把最近判定写为 2026-10-21（now=真实时钟跑测会晚于
      // 该时刻），用大窗口 3650 天必然命中、极小窗口配合改库到远古验证排除
      const wide = await callJson(env.client, "list_my_wrong_questions", {
        sinceDays: 3650,
        includeConquered: true,
      });
      expect((wide.data as { total: number }).total).toBe(3);
      env.db
        .update(responses)
        .set({ submittedAt: OLD_DAY })
        .where(eq(responses.questionId, Q.concept2))
        .run();
      const narrow = await callJson(env.client, "list_my_wrong_questions", {
        sinceDays: 30,
      });
      expect((narrow.data as { total: number }).total).toBeLessThan(2);
    } finally {
      await env.client.close();
      env.db.$client.close();
    }
  });

  it("域隔离：只列本人错题，学生乙的错题绝不出现", async () => {
    const env = await makeMcpWrongEnv();
    try {
      await answerAllWrong(env, RECENT_DAY);
      // 学生乙做错 concept1（乙的错题本）
      const bAttempt = await startCourseAttempt(env, env.bCookie);
      await saveAnswer(
        env,
        bAttempt,
        Q.concept1,
        { kind: "judge", value: !CORRECT[Q.concept1].value },
        env.bCookie,
      );
      await saveAnswer(
        env,
        bAttempt,
        Q.addition,
        { kind: "judge", value: !CORRECT[Q.addition].value },
        env.bCookie,
      );
      await saveAnswer(
        env,
        bAttempt,
        Q.concept2,
        { kind: "judge", value: !CORRECT[Q.concept2].value },
        env.bCookie,
      );
      await submitAt(env, bAttempt, RECENT_DAY, env.bCookie);

      const result = await callJson(env.client, "list_my_wrong_questions", {});
      const listed = (
        result.data as {
          questions: {
            questionId: string;
            wrongCount: number;
            roundCount: number;
          }[];
        }
      ).questions;
      // 三题甲乙都错过（同题）：列出的是甲自己的轮次（1 轮），不是乙的数据
      expect(
        listed.every((item) => item.roundCount === 1 && item.wrongCount === 1),
      ).toBe(true);
    } finally {
      await env.client.close();
      env.db.$client.close();
    }
  });
});

describe("create_wrong_practice（AI 组卷）", () => {
  it("组卷成功：走服务层校验与快照冻结，范围 kind=ai 落库，学生 API 可读；无效 id 剔除计数", async () => {
    const env = await makeMcpWrongEnv();
    try {
      await answerAllWrong(env, RECENT_DAY);
      const result = await callJson(env.client, "create_wrong_practice", {
        questionIds: [Q.concept1, "不存在的题"],
        label: "最近一周 · 高频错题",
      });
      expect(result.isError).toBe(false);
      const body = result.data as {
        created: boolean;
        attemptId: string;
        attemptUrl: string;
        attemptNo: number;
        includedCount: number;
        excludedCount: number;
      };
      expect(body.created).toBe(true);
      expect(body.attemptNo).toBe(1);
      expect(body.includedCount).toBe(1);
      expect(body.excludedCount).toBe(1);
      expect(body.attemptUrl).toBe(`/s/attempts/${body.attemptId}`);
      // 建卷范围快照：kind=ai + label 原样落库
      const row = env.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, body.attemptId))
        .get();
      expect(row?.sourceType).toBe("wrong");
      const scope = JSON.parse(row?.practiceScopeJson ?? "null") as {
        kind: string;
        label: string;
      } | null;
      expect(scope?.kind).toBe("ai");
      expect(scope?.label).toBe("最近一周 · 高频错题");
      // 学生页面 API 可读（同一规则另一接口闭环）
      const detail = await env.app.request(
        `/api/student/attempts/${body.attemptId}`,
        { headers: { cookie: env.aCookie } },
      );
      expect(detail.status).toBe(200);
      // 建出的卷无答案泄露（assertNoLeak 默认集合）
      assertNoLeak(await detail.json());
    } finally {
      await env.client.close();
      env.db.$client.close();
    }
  });

  it("label 缺省为「AI 组卷」；非幂等：两次调用建两份独立卷（attemptNo 递增）", async () => {
    const env = await makeMcpWrongEnv();
    try {
      await answerAllWrong(env, RECENT_DAY);
      const first = await callJson(env.client, "create_wrong_practice", {
        questionIds: [Q.concept1],
      });
      const second = await callJson(env.client, "create_wrong_practice", {
        questionIds: [Q.concept1],
      });
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      const a = first.data as { attemptId: string; attemptNo: number; label: string };
      const b = second.data as { attemptId: string; attemptNo: number };
      expect(a.attemptId).not.toBe(b.attemptId);
      expect(b.attemptNo).toBe(a.attemptNo + 1);
      expect(a.label).toBe("AI 组卷");
    } finally {
      await env.client.close();
      env.db.$client.close();
    }
  });

  it("边界：全无效 → WRONG_PRACTICE_EMPTY；他学生的错题 id 不在本人聚合被剔除；超上限入参拒绝", async () => {
    const env = await makeMcpWrongEnv();
    try {
      // 甲只做错 concept1（addition/concept2 未作答 → 不入甲的错题本聚合）；
      // 乙做错 addition（只在乙的聚合内）
      const aAttempt = await startCourseAttempt(env);
      await saveAnswer(env, aAttempt, Q.concept1, {
        kind: "judge",
        value: !CORRECT[Q.concept1].value,
      });
      await submitAt(env, aAttempt, RECENT_DAY);
      const bAttempt = await startCourseAttempt(env, env.bCookie);
      await saveAnswer(
        env,
        bAttempt,
        Q.addition,
        { kind: "judge", value: !CORRECT[Q.addition].value },
        env.bCookie,
      );
      await submitAt(env, bAttempt, RECENT_DAY, env.bCookie);

      // 甲聚合只有 concept1：传入乙错过的 addition → 全部无效 → 400
      const empty = await callJson(env.client, "create_wrong_practice", {
        questionIds: [Q.addition],
      });
      expect(empty.isError).toBe(true);
      expect(empty.data.error).toBe("WRONG_PRACTICE_EMPTY");

      // 混合：concept1 命中 + addition（乙的错题）剔除 → included=1/excluded=1
      const result = await callJson(env.client, "create_wrong_practice", {
        questionIds: [Q.concept1, Q.addition],
        label: "混合卷",
      });
      expect(result.isError).toBe(false);
      expect((result.data as { includedCount: number }).includedCount).toBe(1);
      expect((result.data as { excludedCount: number }).excludedCount).toBe(1);

      // 超上限（>200）入参拒绝（SDK 层 Zod 形状校验，错误文本非 JSON 载荷）
      const over = await env.client.callTool({
        name: "create_wrong_practice",
        arguments: {
          questionIds: Array.from({ length: 201 }, (_, i) => `q-${i}`),
        },
      });
      expect(over.isError).toBe(true);
    } finally {
      await env.client.close();
      env.db.$client.close();
    }
  });
});
