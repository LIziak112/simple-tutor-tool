import type { ApiErr } from "@tutor/contract";
import {
  attemptDetailDataSchema,
  wrongPracticeOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, questions, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { assertNoStemLeak } from "../test/assert-no-stem-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * 2026-10 错题重练集成测试（POST /api/student/wrong-practice；app.request()
 * 直调路由 + 内存库）：
 * - 组卷成功：做错的题按最近一次判定作答的**快照**冻结组卷（sourceType=wrong、
 *   三归属键 null、attemptNo 从 1 递增、题目顺序 = questionIds 顺序）；
 * - 校验：不在错题本聚合内的题**静默剔除**（部分剔除照常组卷）；剔完为空 →
 *   400 WRONG_PRACTICE_EMPTY；空数组 400 VALIDATION_ERROR；未登录 401；
 * - 快照冻结口径：建卷后教师改题库（题干/答案/版本 +1），重练卷的草稿题干与
 *   交卷判分仍按**建卷时**的快照（练的就是当时做错的那道题）；
 * - 交卷链路复用：wrong 来源交卷 → graded/submitted 照常；交卷后成为错题本
 *   新一轮（rounds 新增 sourceType=wrong、来源标题「错题重练 · 第 n 次」）；
 *   无标准答案手写题重练照常进教师待批队列、批改后 graded；
 * - 我的记录：wrong 草稿与已交卷记录一直可见（永不失权——sourceType=wrong
 *   筛选可命中）；
 * - 教师端：数据页列表 sourceType=wrong 命中（来源上下文全 null + attemptNo）；
 *   CSV 导出来源类型列「错题重练」；
 * - 泄露（AGENTS 第 3 条）：新建 attempt 的响应只有摘要；未交卷详情/试卷无
 *   answers/solution 前缀键/提示内容（assertNoLeak 默认集合）；交卷后结果视图
 *   照常携带参考答案与详解（allow 放行后断言无提示内容）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-9";
const STUDENT_PASSWORD = "stu-pass-7";

/** 课程练习夹具：两道判断（含提示）+ 一道无标准答案手写题（待批） */
const COURSE_PRACTICE_MD = `---
kind: practice
unit: 重练课程练习
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
  judge1: "重练课程练习-1",
  judge2: "重练课程练习-2",
  solve: "重练课程练习-3",
} as const;

/** 多次交卷的确定性时间轴（轮次史排序断言用） */
const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-02T10:00:00.000Z";

type App = ReturnType<typeof createApp>;

interface PracticeEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  courseId: string;
  unitId: string;
  studentId: string;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 组装被测环境：教师 + 课程（练习单元可见）+ 成员学生甲 */
async function makePracticeEnv(): Promise<PracticeEnv> {
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
      filename: "重练课程练习.md",
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
      displayName: "重练甲",
      loginName: "重练甲",
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
      loginName: "重练甲",
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
    studentId,
  };
}

/** POST 课程练习入口（可重做），返回 attemptId */
async function startCourseAttempt(env: PracticeEnv): Promise<string> {
  const res = await env.app.request(
    `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitId)}/attempts`,
    { method: "POST", headers: { cookie: env.aCookie } },
  );
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** POST /api/student/wrong-practice；cookie 传 null 表示匿名请求 */
async function postWrongPractice(
  env: PracticeEnv,
  questionIds: string[],
  cookie: string | null = env.aCookie,
): Promise<Response> {
  return env.app.request("/api/student/wrong-practice", {
    method: "POST",
    headers:
      cookie === null
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", cookie },
    body: JSON.stringify({ questionIds }),
  });
}

/** PUT 草稿答案 */
async function saveAnswer(
  env: PracticeEnv,
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

/** POST 交卷并直写提交时间（轮次史排序断言用；T6R.3 自动回传版本集合） */
async function submitAt(
  env: PracticeEnv,
  attemptId: string,
  submittedAt: string,
): Promise<void> {
  const res = await submitAttemptRequest(env.app, env.aCookie, attemptId);
  expect(res.status).toBe(200);
  env.db
    .update(attempts)
    .set({ submittedAt })
    .where(eq(attempts.id, attemptId))
    .run();
}

/** GET /api/student/wrong-questions（includeResolved 全量形态） */
async function getWrongQuestions(env: PracticeEnv): Promise<{
  questions: Array<{
    questionId: string;
    rounds: Array<{
      sourceType: string;
      sourceTitle: string;
      correct: boolean;
    }>;
  }>;
}> {
  const res = await env.app.request(
    "/api/student/wrong-questions?includeResolved=true",
    { headers: { cookie: env.aCookie } },
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        questions: Array<{
          questionId: string;
          rounds: Array<{
            sourceType: string;
            sourceTitle: string;
            correct: boolean;
          }>;
        }>;
      };
    }
  ).data;
}

describe("POST /api/student/wrong-practice（2026-10 错题重练）", () => {
  it("组卷成功：快照冻结（题干公开化、无答案）+ 摘要形态 + 题序 = questionIds 顺序 + 草稿在我的记录可见；泄露断言通过", async () => {
    const env = await makePracticeEnv();
    // 第 1 次课程练习：judge1 错（正确答案「正确」）、judge2 对 → 只有 judge1 入本
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a1, T1);

    const res = await postWrongPractice(env, [Q.judge1]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as unknown;
    expect(wrongPracticeOkSchema.safeParse(body).success).toBe(true);
    const summary = (body as { data: { id: string; sourceType: string } }).data;
    expect(summary.sourceType).toBe("wrong");

    // 摘要与建卷响应无任何题目内容（泄露：assertNoLeak 默认集合）
    assertNoLeak(body);

    // 草稿视图：单组「错题重练」+ 冻结题目的公开形态（题干公开化、无答案键）
    const detail = await env.app.request(
      `/api/student/attempts/${summary.id}`,
      { headers: { cookie: env.aCookie } },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as unknown;
    // 契约 schema 校验的是响应壳内的 data 部分
    expect(
      attemptDetailDataSchema.safeParse((detailBody as { data: unknown }).data)
        .success,
    ).toBe(true);
    assertNoLeak(detailBody);
    assertNoStemLeak(detailBody);
    const draft = (
      detailBody as {
        data: {
          title: string;
          courseName: string | null;
          units: {
            title: string;
            questions: { id: string; stemMd: string }[];
          }[];
        };
      }
    ).data;
    expect(draft.title).toBe("错题重练");
    expect(draft.courseName).toBeNull();
    expect(draft.units).toHaveLength(1);
    expect(draft.units[0]?.title).toBe("错题重练");
    expect(draft.units[0]?.questions.map((question) => question.id)).toEqual([
      Q.judge1,
    ]);
    // 快照题干含 [[答案]] 标记 → 公开化后为 [[]]（绝不外露答案原文）
    expect(draft.units[0]?.questions[0]?.stemMd).toContain("[[]]");
    expect(draft.units[0]?.questions[0]?.stemMd).not.toContain("[[正确]]");

    // 通用取卷同口径（单组 + 公开形态）
    const paper = await env.app.request(
      `/api/student/attempts/${summary.id}/paper`,
      { headers: { cookie: env.aCookie } },
    );
    expect(paper.status).toBe(200);
    const paperJsonBody = await paper.json();
    assertNoLeak(paperJsonBody);
    assertNoStemLeak(paperJsonBody);
    // 我的记录：wrong 草稿一直可见（永不失权——无课程归属）
    const records = await env.app.request(
      "/api/student/records?sourceType=wrong",
      { headers: { cookie: env.aCookie } },
    );
    expect(records.status).toBe(200);
    const recordsData = (
      (await records.json()) as {
        data: { records: { attemptId: string; sourceType: string }[] };
      }
    ).data;
    expect(recordsData.records.map((row) => row.attemptId)).toContain(
      summary.id,
    );
  });

  it("题序 = questionIds 顺序（去重保序）：多题组卷按请求顺序排列", async () => {
    const env = await makePracticeEnv();
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: true });
    await submitAt(env, a1, T1);

    // 请求顺序 judge2 在前（与服务端聚合排序相反），重复 id 去重保序
    const res = await postWrongPractice(env, [Q.judge2, Q.judge1, Q.judge2]);
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    const detail = (await (
      await env.app.request(`/api/student/attempts/${id}`, {
        headers: { cookie: env.aCookie },
      })
    ).json()) as {
      data: {
        units: { questions: { id: string }[] }[];
      };
    };
    expect(detail.data.units[0]?.questions.map((q) => q.id)).toEqual([
      Q.judge2,
      Q.judge1,
    ]);
  });

  it("校验与权限：不在聚合内的题静默剔除（部分剔除照常组卷）；剔完为空 400 WRONG_PRACTICE_EMPTY；空数组 400；未登录 401", async () => {
    const env = await makePracticeEnv();
    const a1 = await startCourseAttempt(env);
    // judge1 错入本；judge2 答对不入本；solve 未作答（D1 判错？——solve 无标准
    // 答案未作答 → 待批不参与聚合，也不入本）
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a1, T1);

    // 混入不在聚合内的题（judge2 从未错过 + 不存在的 id）：静默剔除，只练 judge1
    const mixed = await postWrongPractice(env, [
      "不存在的题目",
      Q.judge2,
      Q.judge1,
    ]);
    expect(mixed.status).toBe(201);
    const mixedId = ((await mixed.json()) as { data: { id: string } }).data.id;
    const detail = (await (
      await env.app.request(`/api/student/attempts/${mixedId}`, {
        headers: { cookie: env.aCookie },
      })
    ).json()) as {
      data: { units: { questions: { id: string }[] }[] };
    };
    expect(detail.data.units[0]?.questions.map((q) => q.id)).toEqual([
      Q.judge1,
    ]);

    // 全部不在聚合内 → 400 WRONG_PRACTICE_EMPTY（附中文信息）
    const empty = await postWrongPractice(env, [Q.judge2, "不存在的题目"]);
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as ApiErr;
    expect(emptyBody.error).toBe("WRONG_PRACTICE_EMPTY");
    expect(emptyBody.message).toContain("错题本");

    // 空数组 → 400 VALIDATION_ERROR（契约 min(1)）
    const invalid = await env.app.request("/api/student/wrong-practice", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: env.aCookie },
      body: JSON.stringify({ questionIds: [] }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    // 未登录 401
    const anon = await postWrongPractice(env, [Q.judge1], null);
    expect(anon.status).toBe(401);
  });

  it("attemptNo 递增 + 多张未交卷卷并存；交卷后成为错题本新一轮（sourceType=wrong、来源标题「错题重练 · 第 n 次」）；交卷后结果视图照常携带答案（allow 放行）", async () => {
    const env = await makePracticeEnv();
    const a1 = await startCourseAttempt(env);
    // 两题都答错（judge1 正确答案 true、judge2 正确答案 false）→ 都入错题本
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: true });
    await submitAt(env, a1, T1);

    // 第一张重练卷保持草稿时即可再开第二张（每次重练都是独立新卷）
    const wp1 = (
      (await (await postWrongPractice(env, [Q.judge1, Q.judge2])).json()) as {
        data: { id: string; attemptNo: number };
      }
    ).data;
    expect(wp1.attemptNo).toBe(1);
    const wp2 = (
      (await (await postWrongPractice(env, [Q.judge1])).json()) as {
        data: { id: string; attemptNo: number };
      }
    ).data;
    expect(wp2.attemptNo).toBe(2);

    // 第一张卷答对交卷（judge1/judge2 正确答案分别是 true/false）
    await saveAnswer(env, wp1.id, Q.judge1, { kind: "judge", value: true });
    await saveAnswer(env, wp1.id, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, wp1.id, T2);

    // 结果视图：graded、来源行原料（title=错题重练、courseName null）、逐题答案照常
    const result = (await (
      await env.app.request(`/api/student/attempts/${wp1.id}`, {
        headers: { cookie: env.aCookie },
      })
    ).json()) as {
      data: {
        attempt: { status: string; scoreAuto: number | null };
        title: string;
        courseName: string | null;
        answersReleased: boolean;
        units: {
          title: string;
          questions: { questionId: string; answers: unknown }[];
        }[];
      };
    };
    expect(result.data.attempt.status).toBe("graded");
    expect(result.data.attempt.scoreAuto).toBe(100);
    expect(result.data.title).toBe("错题重练");
    expect(result.data.courseName).toBeNull();
    expect(result.data.answersReleased).toBe(true);
    expect(result.data.units[0]?.title).toBe("错题重练");
    expect(result.data.units[0]?.questions.map((q) => q.questionId)).toEqual([
      Q.judge1,
      Q.judge2,
    ]);
    // 泄露：交卷后 answers 允许出现，但提示内容绝不出现（两题各一条未解锁提示）
    assertNoLeak(result, { allow: ["answers", "answer", "solutionMd"] });
    assertNoStemLeak(result);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("大于 $0$ 的数是正数。");
    expect(serialized).not.toContain("$-1$ 小于 $0$。");

    // 错题本：judge1 rounds 新增一轮（sourceType=wrong、标题「错题重练 · 第 1 次」）
    const wrong = await getWrongQuestions(env);
    const judge1 = wrong.questions.find((card) => card.questionId === Q.judge1);
    expect(judge1?.rounds).toHaveLength(2);
    const secondRound = judge1?.rounds[1] as {
      sourceType: string;
      sourceTitle: string;
      correct: boolean;
    };
    expect(secondRound.sourceType).toBe("wrong");
    expect(secondRound.sourceTitle).toBe("错题重练 · 第 1 次");
    expect(secondRound.correct).toBe(true);
    // judge2 曾错本轮做对 → 也在聚合内（includeResolved），轮次同样 +1
    const judge2 = wrong.questions.find((card) => card.questionId === Q.judge2);
    expect(judge2?.rounds).toHaveLength(2);
  });

  it("快照冻结口径：建卷后教师改题库（题干/答案/版本），重练卷的题干与判分仍按建卷快照", async () => {
    const env = await makePracticeEnv();
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, a1, T1);

    // 建卷（快照 = 当时做错的那道 judge1：答案「正确」）
    const wp = (
      (await (await postWrongPractice(env, [Q.judge1])).json()) as {
        data: { id: string };
      }
    ).data;

    // 教师改题库：题干与标准答案全换、版本 +1
    env.db
      .update(questions)
      .set({
        stemMd: "$1$ 是负数。[[错误]]",
        answersJson: JSON.stringify({ kind: "judge", value: false }),
        version: 99,
      })
      .where(eq(questions.id, Q.judge1))
      .run();

    // 草稿视图题干仍是旧快照（公开化后含 [[]]，绝不含新题干的 [[错误]] 原文标记）
    const draft = (await (
      await env.app.request(`/api/student/attempts/${wp.id}`, {
        headers: { cookie: env.aCookie },
      })
    ).json()) as {
      data: { units: { questions: { stemMd: string }[] }[] };
    };
    const stem = draft.data.units[0]?.questions[0]?.stemMd ?? "";
    expect(stem).toContain("$1$ 是正数。");
    expect(stem).not.toContain("是负数");

    // 按旧快照答案（true=「正确」）作答 → 判对（新题库答案已改为 false）
    await saveAnswer(env, wp.id, Q.judge1, { kind: "judge", value: true });
    await submitAt(env, wp.id, T2);
    const result = (await (
      await env.app.request(`/api/student/attempts/${wp.id}`, {
        headers: { cookie: env.aCookie },
      })
    ).json()) as {
      data: {
        attempt: { status: string; scoreAuto: number | null };
        units: { questions: { autoCorrect: boolean | null }[] }[];
      };
    };
    expect(result.data.attempt.status).toBe("graded");
    expect(result.data.attempt.scoreAuto).toBe(100);
    expect(result.data.units[0]?.questions[0]?.autoCorrect).toBe(true);
  });

  it("待批链路：无标准答案手写题批错后重练 → 交卷 submitted、进教师待批队列（wrong 来源）；批改后 graded", async () => {
    const env = await makePracticeEnv();
    const a1 = await startCourseAttempt(env);
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: true });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.solve, { kind: "final", finalAnswer: "2" });
    await submitAt(env, a1, T1);
    // 教师批 solve 为错 → 入错题本
    const target = env.db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(eq(responses.attemptId, a1), eq(responses.questionId, Q.solve)),
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
        body: JSON.stringify({ mark: "wrong", comment: null }),
      },
    );
    expect(markRes.status).toBe(200);

    // 重练 solve 并作答 → 待批（无标准答案不能自动判）
    const wp = (
      (await (await postWrongPractice(env, [Q.solve])).json()) as {
        data: { id: string };
      }
    ).data;
    await saveAnswer(env, wp.id, Q.solve, { kind: "final", finalAnswer: "2" });
    await submitAt(env, wp.id, T2);
    const afterSubmit = env.db
      .select({ status: attempts.status })
      .from(attempts)
      .where(eq(attempts.id, wp.id))
      .get();
    expect(afterSubmit?.status).toBe("submitted");

    // 教师待批队列命中（wrong 来源卡片的快照题干与答案照常可批改）
    const pending = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    expect(pending.status).toBe(200);
    const pendingData = (
      (await pending.json()) as {
        data: {
          marks: {
            attemptId: string;
            sourceType: string;
            questionId: string;
          }[];
        };
      }
    ).data;
    const card = pendingData.marks.find((item) => item.attemptId === wp.id);
    expect(card?.sourceType).toBe("wrong");
    expect(card?.questionId).toBe(Q.solve);

    // 批对 → graded、scoreFinal=100
    const wrongResponse = env.db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(eq(responses.attemptId, wp.id), eq(responses.questionId, Q.solve)),
      )
      .get();
    if (!wrongResponse) throw new Error("重练卷缺少 solve 的 response 行");
    const reMark = await env.app.request(
      `/api/teacher/responses/${wrongResponse.id}/mark`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ mark: "correct", comment: "很好。" }),
      },
    );
    expect(reMark.status).toBe(200);
    const graded = env.db
      .select({ status: attempts.status, scoreFinal: attempts.scoreFinal })
      .from(attempts)
      .where(eq(attempts.id, wp.id))
      .get();
    expect(graded?.status).toBe("graded");
    expect(graded?.scoreFinal).toBe(100);
  });

  it("教师端：数据页列表 sourceType=wrong 命中（来源上下文全 null + attemptNo + 题数）；CSV 导出来源列「错题重练」", async () => {
    const env = await makePracticeEnv();
    const a1 = await startCourseAttempt(env);
    // 两题都答错（judge1 正确答案 true、judge2 正确答案 false）→ 都入错题本
    await saveAnswer(env, a1, Q.judge1, { kind: "judge", value: false });
    await saveAnswer(env, a1, Q.judge2, { kind: "judge", value: true });
    await submitAt(env, a1, T1);

    const wp = (
      (await (await postWrongPractice(env, [Q.judge1, Q.judge2])).json()) as {
        data: { id: string };
      }
    ).data;
    await saveAnswer(env, wp.id, Q.judge1, { kind: "judge", value: true });
    await saveAnswer(env, wp.id, Q.judge2, { kind: "judge", value: false });
    await submitAt(env, wp.id, T2);

    // 数据页列表：wrong 筛选命中、来源上下文与计数
    const list = await env.app.request(
      "/api/teacher/attempts?sourceType=wrong",
      { headers: { cookie: env.teacherCookie } },
    );
    expect(list.status).toBe(200);
    const listData = (
      (await list.json()) as {
        data: {
          attempts: {
            attemptId: string;
            sourceType: string;
            courseId: string | null;
            assignmentId: string | null;
            unitId: string | null;
            attemptNo: number;
            questionCount: number;
            status: string;
          }[];
          total: number;
        };
      }
    ).data;
    expect(listData.total).toBe(1);
    const card = listData.attempts[0];
    expect(card?.attemptId).toBe(wp.id);
    expect(card?.sourceType).toBe("wrong");
    expect(card?.courseId).toBeNull();
    expect(card?.assignmentId).toBeNull();
    expect(card?.unitId).toBeNull();
    expect(card?.attemptNo).toBe(1);
    expect(card?.questionCount).toBe(2);
    expect(card?.status).toBe("graded");

    // 详情：单卷逐题（快照题干原文 + 参考答案 + 单元列挂回归属单元）
    const detail = await env.app.request(`/api/teacher/attempts/${wp.id}`, {
      headers: { cookie: env.teacherCookie },
    });
    expect(detail.status).toBe(200);
    const detailData = (
      (await detail.json()) as {
        data: {
          sourceType: string;
          questions: {
            questionId: string;
            unitId: string;
            answers: unknown;
          }[];
        };
      }
    ).data;
    expect(detailData.sourceType).toBe("wrong");
    expect(detailData.questions.map((q) => q.questionId)).toEqual([
      Q.judge1,
      Q.judge2,
    ]);
    expect(detailData.questions[0]?.unitId).toBe(env.unitId);

    // CSV：来源类型列「错题重练」（筛选与全量导出各验一次）
    for (const query of ["?sourceType=wrong", ""]) {
      const csv = await env.app.request(`/api/teacher/export/csv${query}`, {
        headers: { cookie: env.teacherCookie },
      });
      expect(csv.status).toBe(200);
      const text = await csv.text();
      expect(text).toContain("错题重练");
      expect(text).toContain("重练甲");
    }
  });
});
