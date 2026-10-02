import type { ApiErr } from "@tutor/contract";
import {
  type WrongQuestionsData,
  wrongQuestionsOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, questions, responses, students } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * T3.5 错题本集成测试（D11；2026-10 轮次史 + 归属单元扩展；app.request() 直调
 * 路由 + 内存库）：
 * - 入本条件：任一次已判定作答判错（曾错入本）；默认只显示「最近一次判定仍为
 *   错」，includeResolved=true 额外列出「曾错、最近一次已做对」（resolved）；
 * - 待批作答不参与（无标准答案手写题未批绝不出现在本子里）；教师批改后的
 *   finalCorrect 参与聚合（批错入本）；
 * - 首次是否做对标注（firstCorrect）；跨来源取最近（课程练习先错、作业后对 →
 *   最近来源=作业）；排序 lastAt 倒序；
 * - 轮次史（rounds）：该题全部已判定作答按时间升序，每轮带来源标题/课程名；
 *   wrongCount/correctCount 计数；攻克判定在端上从 rounds 计算（服务端不下发
 *   判定规则，resolved 保留服务端口径）；
 * - 归属单元（originUnitId/originUnitTitle）：questions.unitId join units，
 *   assignment 来源条目也按题挂回单元（与「最近来源上下文」unitId 区分）；
 *   软删题目行仍在、值照常返回；
 * - 考点筛选（与条目展示同源的精确匹配）；
 * - 公布 gate：after_due 未公布作业的作答整体不参与聚合——该题完全消失
 *   （出现即泄露对错）；
 * - 参数与权限：includeResolved 非法 400、knowledge 空串 400、未登录 401；
 * - 泄露：条目只含已交卷题目内容（assertNoLeak 放行 answers/solutionMd 后
 *   断言无提示内容——未解锁提示文本绝不出现；rounds 等新字段无敏感键）。
 * 夹具：两道判断（含提示，可自动判分）+ 一道无标准答案手写题（待批）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 课程练习夹具：两道判断（含提示）+ 一道无标准答案手写题（待批） */
const COURSE_PRACTICE_MD = `---
kind: practice
unit: 有理数课程练习
topic: 正数与负数
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]

:::hint
大于 $0$ 的数是正数。
:::
::::

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是正数。[[错误]]

:::hint
$-1$ 小于 $0$。
:::
::::

::::question{type=solve difficulty=3 knowledge="计算"}
写一写：$1+1$ 是多少？

:::solution
$1+1=2$。
:::
::::
`;

/** 题目 id（单元 slug 缺省编号） */
const Q = {
  judge1: "有理数课程练习-1",
  judge2: "有理数课程练习-2",
  solve: "有理数课程练习-3",
} as const;

/** after_due 远期截止（真实时钟下恒未到） */
const FAR_DUE = "2099-01-01T00:00:00.000Z";

/** 多次交卷的确定性时间轴（first/last/轮次史与排序断言用） */
const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";
const T3 = "2026-09-03T10:00:00.000Z";

type App = ReturnType<typeof createApp>;

interface WrongEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  courseId: string;
  unitId: string;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 组装被测环境：教师 + 课程（练习单元可见）+ 成员学生甲 */
async function makeWrongEnv(): Promise<WrongEnv> {
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
      filename: "有理数课程练习.md",
      courseId,
    }),
  });
  expect(imported.status).toBe(200);
  const unitId = (
    (await imported.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
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

  const studentRes = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: "错题甲",
      loginName: "错题甲",
      password: STUDENT_PASSWORD,
    }),
  });
  expect(studentRes.status).toBe(201);
  const studentId = (
    (await studentRes.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  const addMembers = await app.request(
    `/api/teacher/courses/${courseId}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ studentIds: [studentId] }),
    },
  );
  expect(addMembers.status).toBe(200);
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      loginName: "错题甲",
      password: STUDENT_PASSWORD,
    }),
  });
  expect(login.status).toBe(200);

  return {
    app,
    db,
    teacherCookie,
    aCookie: `tutor_session=${extractSessionToken(login)}`,
    courseId,
    unitId,
  };
}

/** POST 课程练习入口（可重做），返回 attemptId */
async function startCourseAttempt(env: WrongEnv): Promise<string> {
  const res = await env.app.request(
    `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitId)}/attempts`,
    { method: "POST", headers: { cookie: env.aCookie } },
  );
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** POST 开卷（作业来源），返回 attemptId */
async function startAssignmentAttempt(
  env: WrongEnv,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await env.app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: env.teacherCookie },
    body: JSON.stringify({
      unitIds: [env.unitId],
      studentIds: [studentIdOf(env)],
      ...extra,
    }),
  });
  expect(created.status).toBe(201);
  const assignmentId = (
    (await created.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }
  const res = await env.app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: env.aCookie } },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** 甲的学生 id（布置作业名单用；一次查库） */
function studentIdOf(env: WrongEnv): string {
  const row = env.db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.loginName, "错题甲"))
    .get();
  if (row === undefined) throw new Error("夹具缺少学生行");
  return row.id;
}

/** PUT 草稿答案 */
async function saveAnswer(
  env: WrongEnv,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<void> {
  const res = await env.app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: env.aCookie },
      body: JSON.stringify({ answer }),
    },
  );
  expect(res.status, `保存 ${questionId} 失败`).toBe(200);
}

/** POST 交卷并直写提交时间（first/last 确定性断言用） */
async function submitAt(
  env: WrongEnv,
  attemptId: string,
  submittedAt: string,
): Promise<void> {
  const res = await env.app.request(
    `/api/student/attempts/${attemptId}/submit`,
    {
      method: "POST",
      headers: { cookie: env.aCookie },
    },
  );
  expect(res.status).toBe(200);
  env.db
    .update(attempts)
    .set({ submittedAt })
    .where(eq(attempts.id, attemptId))
    .run();
}

/** GET /api/student/wrong-questions（返回 status、解包 data 与原始 Body；
 * cookie 传 null 表示匿名请求——显式 undefined 会命中默认参） */
async function getWrongQuestions(
  env: WrongEnv,
  query = "",
  cookie: string | null = env.aCookie,
): Promise<{
  status: number;
  body: unknown;
  data: WrongQuestionsData | undefined;
}> {
  const res = await env.app.request(`/api/student/wrong-questions${query}`, {
    headers: cookie === null ? {} : { cookie },
  });
  const json = (await res.json()) as unknown;
  return {
    status: res.status,
    body: json,
    data:
      res.status === 200
        ? (json as { data: WrongQuestionsData }).data
        : undefined,
  };
}

describe("GET /api/student/wrong-questions（T3.5 D11 错题本）", () => {
  it("曾错入本；默认只显示最近仍错、includeResolved 列出已攻克；首次做对标注；待批作答不参与；lastAt 倒序；assertNoLeak 通过", async () => {
    const env = await makeWrongEnv();
    // 第 1 次：judge1 错 / judge2 对 / solve 未答（待批）
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a1, T1);
    // 第 2 次：judge1 对 / judge2 错 / solve 已答（无标准答案仍待批）
    const a2 = await startCourseAttempt(env);
    await saveAnswer(env, a2, Q.judge1, { kind: "judge", value: true });
    await saveAnswer(env, a2, Q.judge2, { kind: "judge", value: true });
    await saveAnswer(env, a2, Q.solve, { kind: "final", finalAnswer: "2" });
    await submitAt(env, a2, T2);

    // 默认：只显示最近仍错的 judge2（judge1 曾错已攻克；solve 待批不参与）
    const { status, body, data } = await getWrongQuestions(env);
    expect(status).toBe(200);
    expect(wrongQuestionsOkSchema.safeParse(body).success).toBe(true);
    expect(data?.questions.map((card) => card.questionId)).toEqual([Q.judge2]);
    const judge2 = data?.questions[0];
    expect(judge2?.firstCorrect).toBe(true); // 首次做对标注（第 1 次答对）
    expect(judge2?.resolved).toBe(false);
    expect(judge2?.firstAt).toBe(T1);
    expect(judge2?.lastAt).toBe(T2);
    expect(judge2?.answerText).toBe("正确"); // 最近答案（第 2 次 value=true）
    expect(judge2?.sourceType).toBe("course");
    expect(judge2?.courseName).toBe("初一上");
    expect(judge2?.unitTitle).toBe("有理数课程练习");
    expect(judge2?.attemptNo).toBe(2); // 最近一次来源 = 第 2 次课程练习
    expect(judge2?.type).toBe("judge");
    expect(judge2?.knowledge).toEqual(["有理数的概念"]);
    expect(judge2?.answers).toEqual({ kind: "judge", value: false }); // 快照参考答案
    expect(judge2?.stemMd).toContain("[[错误]]"); // 快照原文（已交卷允许）

    // includeResolved=true：judge1（曾错、最近做对）额外列出；lastAt 倒序
    // （两者 lastAt 同为 T2 → questionId 升序兜底稳定）
    const resolved = await getWrongQuestions(env, "?includeResolved=true");
    expect(resolved.data?.questions.map((card) => card.questionId)).toEqual([
      Q.judge1,
      Q.judge2,
    ]);
    const judge1 = resolved.data?.questions[0];
    expect(judge1?.firstCorrect).toBe(false);
    expect(judge1?.resolved).toBe(true);
    expect(judge1?.answerText).toBe("正确");

    // 泄露：条目只含已交卷题目内容——放行参考答案/详解键后无禁用键；
    // 未解锁提示内容绝不出现（两道判断题各有一条提示）
    assertNoLeak(body, { allow: ["answers", "solutionMd"] });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("大于 $0$ 的数是正数。");
    expect(serialized).not.toContain("$-1$ 小于 $0$。");
  });

  it("轮次史：同题三次作答 错-对-错 → rounds=3、wrongCount=2、correctCount=1、lastAt=第三次、resolved=false；归属单元下发（软删题目行仍在）；assertNoLeak 通过", async () => {
    const env = await makeWrongEnv();
    // 第 1 次：judge1 错 / judge2 对
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a1, T1);
    // 第 2 次：judge1 对 / judge2 对（judge2 全对永不入本）
    const a2 = await startCourseAttempt(env);
    await saveAnswer(env, a2, Q.judge1, { kind: "judge", value: true });
    await saveAnswer(env, a2, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a2, T2);
    // 第 3 次：judge1 再错 / judge2 对
    const a3 = await startCourseAttempt(env);
    await saveAnswer(env, a3, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a3, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a3, T3);

    const { status, body, data } = await getWrongQuestions(env);
    expect(status).toBe(200);
    expect(wrongQuestionsOkSchema.safeParse(body).success).toBe(true);
    expect(data?.questions.map((card) => card.questionId)).toEqual([Q.judge1]);
    const card = data?.questions[0];
    // 轮次史：三轮按时间升序，每轮带判定/时间/来源标题
    expect(card?.rounds).toHaveLength(3);
    expect(card?.rounds.map((round) => round.correct)).toEqual([
      false,
      true,
      false,
    ]);
    expect(card?.rounds.map((round) => round.submittedAt)).toEqual([
      T1,
      T2,
      T3,
    ]);
    expect(card?.rounds.map((round) => round.sourceType)).toEqual([
      "course",
      "course",
      "course",
    ]);
    expect(card?.rounds.map((round) => round.sourceTitle)).toEqual([
      "有理数课程练习 · 第 1 次",
      "有理数课程练习 · 第 2 次",
      "有理数课程练习 · 第 3 次",
    ]);
    expect(card?.rounds[0]?.attemptId).toBe(a1);
    expect(card?.rounds[0]?.courseName).toBe("初一上");
    // 计数与端上攻克判定的原料（严格标准下 错-对-错 仍待复习）
    expect(card?.wrongCount).toBe(2);
    expect(card?.correctCount).toBe(1);
    expect(card?.lastAt).toBe(T3);
    expect(card?.resolved).toBe(false);
    // 归属单元（questions.unitId join units；按练习分组的依据）
    expect(card?.originUnitId).toBe(env.unitId);
    expect(card?.originUnitTitle).toBe("有理数课程练习");

    // 泄露：新字段（rounds/wrongCount/correctCount/originUnit*）无敏感键——
    // 放行参考答案/详解键后无禁用键；未解锁提示内容绝不出现
    assertNoLeak(body, { allow: ["answers", "solutionMd"] });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("大于 $0$ 的数是正数。");
    expect(serialized).not.toContain("$-1$ 小于 $0$。");

    // 软删题目行（题目只软删，db-change 红线）：行仍在 → 归属单元照常返回
    // （单教师测试环境，按 id 定位即可命中唯一行）
    env.db
      .update(questions)
      .set({ deletedAt: T3 })
      .where(eq(questions.id, Q.judge1))
      .run();
    const afterDelete = await getWrongQuestions(env);
    expect(afterDelete.data?.questions[0]?.originUnitId).toBe(env.unitId);
    expect(afterDelete.data?.questions[0]?.originUnitTitle).toBe(
      "有理数课程练习",
    );
  });

  it("教师批改后的判定参与聚合：批错的手写题入本（默认列表），批对则只在 includeResolved 中出现", async () => {
    const env = await makeWrongEnv();
    const attemptId = await startCourseAttempt(env);
    // 两道判断都答对（judge2 正确答案为「错误」→ value:false），只有 solve 待批
    await saveAnswer(env, attemptId, Q.judge1, { kind: "judge", value: true });
    await saveAnswer(env, attemptId, Q.judge2, { kind: "judge", value: false });
    await saveAnswer(env, attemptId, Q.solve, {
      kind: "final",
      finalAnswer: "2",
    });
    await submitAt(env, attemptId, T1);
    // 批改前：solve 待批不参与
    expect((await getWrongQuestions(env)).data?.questions).toEqual([]);

    // 教师批 solve 为错 → finalCorrect=false → 入本（唯一一次判定即首次与最近）
    const target = env.db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.solve),
        ),
      )
      .get();
    if (!target) throw new Error("夹具缺少 solve 的 response 行");
    const markRes = await env.app.request(
      `/api/teacher/responses/${target.id}/mark`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ mark: "wrong", comment: "重算一遍。" }),
      },
    );
    expect(markRes.status).toBe(200);

    const marked = await getWrongQuestions(env);
    expect(marked.data?.questions.map((card) => card.questionId)).toEqual([
      Q.solve,
    ]);
    const solve = marked.data?.questions[0];
    expect(solve?.firstCorrect).toBe(false);
    expect(solve?.resolved).toBe(false);
    expect(solve?.answerText).toBe("2");
    expect(solve?.knowledge).toEqual(["计算"]);
    expect(solve?.solutionMd).toContain("$1+1=2$");
  });

  it("跨来源取最近：课程练习先错、作业后对 → 默认不含；includeResolved 列出且最近来源=作业", async () => {
    const env = await makeWrongEnv();
    const courseAttemptId = await startCourseAttempt(env);
    await saveAnswer(env, courseAttemptId, Q.judge1, {
      kind: "judge",
      value: false,
    });
    // judge2 答对（避免 D1 未答判错混入断言）
    await saveAnswer(env, courseAttemptId, Q.judge2, {
      kind: "judge",
      value: false,
    });
    await submitAt(env, courseAttemptId, T1);

    const assignmentAttemptId = await startAssignmentAttempt(env, {
      courseId: env.courseId,
    });
    await saveAnswer(env, assignmentAttemptId, Q.judge1, {
      kind: "judge",
      value: true,
    });
    await saveAnswer(env, assignmentAttemptId, Q.judge2, {
      kind: "judge",
      value: false,
    });
    await submitAt(env, assignmentAttemptId, T2);

    expect((await getWrongQuestions(env)).data?.questions).toEqual([]);
    const resolved = await getWrongQuestions(env, "?includeResolved=true");
    expect(resolved.data?.questions.map((card) => card.questionId)).toEqual([
      Q.judge1,
    ]);
    const judge1 = resolved.data?.questions[0];
    expect(judge1?.resolved).toBe(true);
    expect(judge1?.firstCorrect).toBe(false);
    expect(judge1?.firstAt).toBe(T1);
    expect(judge1?.lastAt).toBe(T2);
    // 最近一次来源 = 作业（assignmentTitle，attemptNo=1，courseName 取作业所属课程）
    expect(judge1?.sourceType).toBe("assignment");
    expect(judge1?.assignmentId).not.toBeNull();
    expect(judge1?.assignmentTitle).toBeTruthy();
    expect(judge1?.attemptNo).toBe(1);
    expect(judge1?.courseName).toBe("初一上");
    // 轮次史跨来源：课程练习（错）→ 作业（对），来源标题各按各的口径
    expect(judge1?.rounds).toHaveLength(2);
    expect(judge1?.rounds.map((round) => round.sourceType)).toEqual([
      "course",
      "assignment",
    ]);
    expect(judge1?.rounds[0]?.sourceTitle).toBe("有理数课程练习 · 第 1 次");
    // 作业轮标题 = 作业标题（本例未显式传 title → 缺省为首单元标题，快照语义）
    expect(judge1?.rounds[1]?.sourceTitle).toBe("有理数课程练习");
    expect(judge1?.rounds.map((round) => round.correct)).toEqual([false, true]);
    expect(judge1?.wrongCount).toBe(1);
    expect(judge1?.correctCount).toBe(1);
    // 归属单元 vs 最近来源上下文：assignment 来源 unitId 为 null（来源口径），
    // 但错题按题挂回 home unit（合并作业里的错题也归回各自单元，分组依据）
    expect(judge1?.unitId).toBeNull();
    expect(judge1?.originUnitId).toBe(env.unitId);
    expect(judge1?.originUnitTitle).toBe("有理数课程练习");
  });

  it("公布 gate：after_due 未公布作业的作答整体不参与聚合——该题完全消失（含 includeResolved）", async () => {
    const env = await makeWrongEnv();
    const attemptId = await startAssignmentAttempt(env, {
      dueAt: FAR_DUE,
      answerRelease: "after_due",
    });
    await saveAnswer(env, attemptId, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, attemptId, Q.judge2, { kind: "judge", value: true });
    await submitAt(env, attemptId, T1);

    // 库内已判定为错（防测试空转），但未公布 → 错题本完全不出现
    const judged = env.db
      .select({ finalCorrect: responses.finalCorrect })
      .from(responses)
      .where(eq(responses.questionId, Q.judge1))
      .all();
    expect(judged.some((row) => row.finalCorrect === false)).toBe(true);

    const { status, body, data } = await getWrongQuestions(env);
    expect(status).toBe(200);
    expect(data?.questions).toEqual([]);
    const resolved = await getWrongQuestions(env, "?includeResolved=true");
    expect(resolved.data?.questions).toEqual([]);
    // 出现即泄露对错：序列化文本不含题干（题目完全消失）
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(Q.judge1);
    expect(serialized).not.toContain(Q.judge2);
  });

  it("考点筛选：与条目展示同源精确匹配（同卷题目 lastAt 同刻 → 题目 id 升序稳定）", async () => {
    const env = await makeWrongEnv();
    // 第 1 次：两道判断都错（T1）；第 2 次：judge2 仍错（T2）。
    // D1 口径下 attempt2 未答的 judge1 也判错 → 两题最近判定都在 T2（同刻）
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: true });
    await submitAt(env, a1, T1);
    const a2 = await startCourseAttempt(env);
    await saveAnswer(env, a2, Q.judge2, { kind: "judge", value: true });
    await submitAt(env, a2, T2);

    const all = await getWrongQuestions(env);
    expect(all.data?.questions.map((card) => card.questionId)).toEqual([
      Q.judge1, // lastAt 同为 T2 → questionId 升序兜底稳定
      Q.judge2,
    ]);
    // judge2 最近一次在第 2 次（attemptNo=2）；judge1 最近一次也在第 2 次（未答判错）
    const byId = new Map(
      all.data?.questions.map((card) => [card.questionId, card]),
    );
    expect(byId.get(Q.judge2)?.lastAt).toBe(T2);
    expect(byId.get(Q.judge2)?.attemptNo).toBe(2);
    expect(byId.get(Q.judge1)?.firstAt).toBe(T1);
    expect(byId.get(Q.judge1)?.lastAt).toBe(T2);
    const byKnowledge = await getWrongQuestions(
      env,
      `?knowledge=${encodeURIComponent("有理数的概念")}`,
    );
    expect(byKnowledge.data?.questions.map((card) => card.questionId)).toEqual([
      Q.judge1,
      Q.judge2,
    ]);
    const none = await getWrongQuestions(
      env,
      `?knowledge=${encodeURIComponent("不存在的考点")}`,
    );
    expect(none.data?.questions).toEqual([]);
  });

  it("参数与权限：includeResolved 非法值 400、knowledge 空串 400、未登录 401", async () => {
    const env = await makeWrongEnv();
    for (const query of ["?includeResolved=maybe", "?knowledge="]) {
      const { status, body } = await getWrongQuestions(env, query);
      expect(status, query).toBe(400);
      expect((body as ApiErr).error).toBe("VALIDATION_ERROR");
    }
    const anon = await getWrongQuestions(env, "", null);
    expect(anon.status).toBe(401);
  });
});
