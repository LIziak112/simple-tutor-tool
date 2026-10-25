import {
  attemptFlagDataSchema,
  type WrongQuestionsData,
  wrongQuestionsOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * #6980-4 标注「不会」端点（PUT /api/student/attempts/:id/flags/:questionId）：
 * - draft 可标/可取消；交卷后 409 ALREADY_SUBMITTED（做题时的事实不再追加）；
 * - 题不在本卷 404 QUESTION_NOT_FOUND；未登录 401；
 * - 请求/回执只有标志位（无任何作答内容——assertNoLeak 断言）；
 * - 标记随草稿视图 studentFlags 下发、随结果视图单题保留；
 * - 仅标不会（答对了也行）的题进错题本，轮次带 studentFlag、不计错次。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = `---
kind: practice
unit: 标注练习
topic: 测试
---

::::question{type=judge difficulty=1}
$1$ 是正数。[[正确]]

:::hint
大于 $0$ 的数是正数。
:::
::::

::::question{type=judge difficulty=1}
$-1$ 是正数。[[错误]]
::::
`;

const Q = {
  judge1: "标注练习-1",
  judge2: "标注练习-2",
} as const;

interface FlagEnv {
  app: ReturnType<typeof createApp>;
  aCookie: string;
  courseId: string;
  unitId: string;
}

async function makeFlagEnv(): Promise<FlagEnv> {
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
  const teacherCookie = `tutor_session=${extractSessionToken(setup, "tutor_session")}`;
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
      markdown: PRACTICE_MD,
      filename: "标注练习.md",
      courseId,
    }),
  });
  expect(imported.status).toBe(200);
  const unitId = (
    (await imported.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("导入未产出单元");
  const studentRes = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: "标注甲",
      loginName: "标注甲",
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
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "标注甲", password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  return {
    app,
    aCookie: `tutor_student_session=${extractSessionToken(login, "tutor_student_session")}`,
    courseId,
    unitId,
  };
}

function extractSessionToken(res: Response, cookie: string): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

/** POST 课程练习入口（可重做），返回 attemptId */
async function startAttempt(env: FlagEnv): Promise<string> {
  const res = await env.app.request(
    `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitId)}/attempts`,
    { method: "POST", headers: { cookie: env.aCookie } },
  );
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** PUT 标注「不会」（flag=null 取消） */
function setFlag(
  env: FlagEnv,
  attemptId: string,
  questionId: string,
  flag: "unsure" | null,
  cookie: string | null = env.aCookie,
) {
  return env.app.request(
    `/api/student/attempts/${attemptId}/flags/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(cookie === null ? {} : { cookie }),
      },
      body: JSON.stringify({ flag }),
    },
  );
}

/** GET 草稿视图（data 无类型化解包） */
async function getDraft(
  env: FlagEnv,
  attemptId: string,
): Promise<{
  status: number;
  body: unknown;
  data: {
    studentFlags?: Record<string, "unsure">;
    units: { questions: { questionId: string; studentFlag?: unknown }[] }[];
  };
}> {
  const res = await env.app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie: env.aCookie },
  });
  const json = (await res.json()) as {
    data: {
      studentFlags?: Record<string, "unsure">;
      units: { questions: { questionId: string; studentFlag?: unknown }[] }[];
    };
  };
  return { status: res.status, body: json, data: json.data };
}

async function getWrongQuestions(
  env: FlagEnv,
  query = "",
): Promise<{
  status: number;
  body: unknown;
  data: WrongQuestionsData | undefined;
}> {
  const res = await env.app.request(`/api/student/wrong-questions${query}`, {
    headers: { cookie: env.aCookie },
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

describe("PUT /api/student/attempts/:id/flags/:questionId（#6980-4 标注不会）", () => {
  it("draft 标记/取消随草稿视图下发；回执只含标志位（泄露断言）；未登录 401；题不在本卷 404", async () => {
    const env = await makeFlagEnv();
    const attemptId = await startAttempt(env);

    const marked = await setFlag(env, attemptId, Q.judge1, "unsure");
    expect(marked.status).toBe(200);
    const markedBody = (await marked.json()) as { data: unknown };
    expect(attemptFlagDataSchema.parse(markedBody.data)).toEqual({
      questionId: Q.judge1,
      studentFlag: "unsure",
    });
    assertNoLeak(markedBody);

    const draft = await getDraft(env, attemptId);
    expect(draft.status).toBe(200);
    expect(draft.data.studentFlags).toEqual({ [Q.judge1]: "unsure" });

    const cleared = await setFlag(env, attemptId, Q.judge1, null);
    expect(cleared.status).toBe(200);
    const draftAfterClear = await getDraft(env, attemptId);
    expect(draftAfterClear.data.studentFlags).toEqual({});

    // 重新标记（后续用例事实）+ 未登录 401 + 题不在本卷 404
    expect((await setFlag(env, attemptId, Q.judge1, "unsure")).status).toBe(
      200,
    );
    const anonymous = await setFlag(env, attemptId, Q.judge1, "unsure", null);
    expect(anonymous.status).toBe(401);
    const unknown = await setFlag(env, attemptId, "标注练习-999", "unsure");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { ok: false; error: string }).error).toBe(
      "QUESTION_NOT_FOUND",
    );
  });

  it("交卷后 409；结果视图保留标志；仅标不会（判对）也入错题本，轮次带标志不计错次", async () => {
    const env = await makeFlagEnv();
    const attemptId = await startAttempt(env);
    // judge1 标不会且答对（参考答案「正确」）——标过不会的题仍进错题本
    await setFlag(env, attemptId, Q.judge1, "unsure");
    const saved = await env.app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(Q.judge1)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({ answer: { kind: "judge", value: true } }),
      },
    );
    expect(saved.status).toBe(200);
    const submitted = await submitAttemptRequest(
      env.app,
      env.aCookie,
      attemptId,
    );
    expect(submitted.status).toBe(200);

    // 交卷后不可再改标记
    const after = await setFlag(env, attemptId, Q.judge2, "unsure");
    expect(after.status).toBe(409);
    expect(((await after.json()) as { ok: false; error: string }).error).toBe(
      "ALREADY_SUBMITTED",
    );

    // 结果视图单题保留标志
    const result = await getDraft(env, attemptId);
    expect(result.status).toBe(200);
    const resultJudge1 = result.data.units
      .flatMap((unit) => unit.questions)
      .find((question) => question.questionId === Q.judge1);
    expect(resultJudge1?.studentFlag).toBe("unsure");

    // 错题本：judge1 以「标过不会」入本（判对、wrongCount=0），轮次带标志
    // judge1 最近一次判对 → 属「已攻克」，includeResolved 才列出
    const wrong = await getWrongQuestions(env, "?includeResolved=true");
    expect(wrong.status).toBe(200);
    expect(wrongQuestionsOkSchema.safeParse(wrong.body).success).toBe(true);
    const judge1 = wrong.data?.questions.find(
      (card) => card.questionId === Q.judge1,
    );
    expect(judge1).toBeDefined();
    expect(judge1?.rounds).toHaveLength(1);
    expect(judge1?.rounds[0]?.studentFlag).toBe("unsure");
    expect(judge1?.rounds[0]?.correct).toBe(true);
    expect(judge1?.rounds[0]?.answered).toBe(true);
    expect(judge1?.wrongCount).toBe(0);
    expect(judge1?.correctCount).toBe(1);
    // judge2 既未答也未标 → 不入本（#6980-3 口径不变）
    expect(
      wrong.data?.questions.some((card) => card.questionId === Q.judge2),
    ).toBe(false);
    assertNoLeak(wrong.body, { allow: ["answers", "solutionMd"] });
  });
});
