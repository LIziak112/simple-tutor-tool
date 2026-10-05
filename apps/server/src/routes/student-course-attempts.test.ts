import { gzipSync } from "node:zlib";
import type { ApiErr, InkDoc } from "@tutor/contract";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  studentPaperDataSchema,
  studentUnitLandingOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { assertNoStemLeak } from "../test/assert-no-stem-leak.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions";

/**
 * T2A.6 课程练习作答集成测试（app.request() 直调路由 + 内存库）：
 * - 可重做（D10）：再做一次 attemptNo=2 且答案为空；同时两次开始只得一份草稿；
 * - 历次记录完整且每次结果使用各自快照（两次之间改题 → 各次结果视图按各自快照）；
 * - 移出成员（D7）：paper/保存/交卷 403 COURSE_ACCESS_DENIED，已交卷 GET
 *   /attempts/:id 仍 200（只读记录）；
 * - activeSec（事件计算）、hintsUsed、笔迹在课程作答中正常（与作业作答同一套接口）；
 * - 越权矩阵（D22）：非成员 403、隐藏/未到发布 404（落地页与开始练习同口径）；
 * - 泄露：课程作答全部学生端接口 assertNoLeak（未交卷时）；
 * - 通用取卷 GET /attempts/:id/paper 两种来源；作业作答迁移形态
 *   （sourceType=assignment、attemptNo=1）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 课程练习夹具：两道判断（可自动判分，答对/答错可控）+ 一道无标准答案手写题（待批） */
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

/** 全对的判断题答案 + 手写题最终答案（无标准答案 → 待批） */
const ANSWERS_ALL: Record<string, unknown> = {
  [Q.judge1]: { kind: "judge", value: true },
  [Q.judge2]: { kind: "judge", value: false },
  [Q.solve]: { kind: "final", finalAnswer: "2" },
};

/** 判断题全错（第二次练习用，制造 first=100 / latest=0 的分差） */
const ANSWERS_WRONG: Record<string, unknown> = {
  [Q.judge1]: { kind: "judge", value: false },
  [Q.judge2]: { kind: "judge", value: true },
};

type App = ReturnType<typeof createApp>;

interface TestEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  memberCookie: string;
  memberStudentId: string;
  outsiderCookie: string;
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

async function createStudentAndLogin(
  app: App,
  teacherCookie: string,
  displayName: string,
): Promise<{ studentId: string; cookie: string }> {
  const create = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName,
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as {
    data: { student: { id: string } };
  };
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(login.status).toBe(200);
  return {
    studentId: created.data.student.id,
    cookie: `tutor_session=${extractSessionToken(login)}`,
  };
}

/**
 * 组装被测环境：课程 + 练习单元（courseId 兼容导入路径，默认隐藏 → 放开可见）
 * + 成员/非成员两名学生。
 */
async function makeEnv(): Promise<TestEnv> {
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

  // 导入兼容路径默认单元隐藏 → 放开可见（D23-3 口径）
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

  const member = await createStudentAndLogin(app, teacherCookie, "成员张三");
  const outsider = await createStudentAndLogin(
    app,
    teacherCookie,
    "非成员李四",
  );
  const added = await app.request(`/api/teacher/courses/${courseId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ studentIds: [member.studentId] }),
  });
  expect(added.status).toBe(200);

  return {
    app,
    db,
    teacherCookie,
    memberCookie: member.cookie,
    memberStudentId: member.studentId,
    outsiderCookie: outsider.cookie,
    courseId,
    unitId,
  };
}

/** POST 课程练习入口（开始/继续/再做一次） */
async function startAttempt(
  env: TestEnv,
  cookie: string = env.memberCookie,
): Promise<Response> {
  return env.app.request(
    `/api/student/courses/${env.courseId}/units/${env.unitId}/attempts`,
    { method: "POST", headers: { cookie } },
  );
}

/** 保存一道草稿答案 */
async function saveAnswer(
  env: TestEnv,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return env.app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ answer }),
    },
  );
}

/** 交卷（T6R.3：自动回传题目版本集合，与前端同流程） */
async function submit(
  env: TestEnv,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  return (async () => {
    const revisions = await fetchSubmitRevisions(env.app, cookie, attemptId);
    return env.app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ revisions }),
    });
  })();
}

/** 上报学习痕迹事件（focus/blur 区间 → activeSec 计算数据源） */
async function postEvents(
  env: TestEnv,
  cookie: string,
  attemptId: string,
  events: unknown[],
): Promise<Response> {
  return env.app.request(`/api/student/attempts/${attemptId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ events }),
  });
}

describe("T2A.6 课程练习：开始 / 继续作答 / 再做一次（D10）", () => {
  it("落地页：题数、题型分布、汇总为 null（从未做）；assertNoLeak", async () => {
    const env = await makeEnv();
    const res = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Record<string, unknown>;
    };
    expect(
      studentUnitLandingOkSchema.safeParse({ ok: true, data: body.data })
        .success,
    ).toBe(true);
    expect(body.data).toMatchObject({
      courseName: "初一上",
      title: "有理数课程练习",
      questionCount: 3,
      typeDistribution: { judge: 2, solve: 1 },
      attempts: [],
      summary: null,
    });
    assertNoLeak(body, { forbid: ["stemMd", "questions"] });
  });

  it("开始练习 → attemptNo=1、sourceType=course；同时两次开始只得一份草稿", async () => {
    const env = await makeEnv();
    const first = await startAttempt(env);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: Record<string, unknown>;
    };
    expect(
      attemptStartOkSchema.safeParse({ ok: true, data: firstBody.data })
        .success,
    ).toBe(true);
    expect(firstBody.data).toMatchObject({
      sourceType: "course",
      assignmentId: null,
      courseId: env.courseId,
      unitId: env.unitId,
      attemptNo: 1,
      status: "draft",
    });
    assertNoLeak(firstBody);
    assertNoStemLeak(firstBody);
    // 同时两次开始（幂等取回同一份 draft；服务层事务先查后插保证唯一）
    const second = await startAttempt(env);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { data: { id: string } }).data.id).toBe(
      firstBody.data.id,
    );
  });

  it("交卷后再做一次 → attemptNo=2 且新一次答案为空（不预填上次答案）", async () => {
    const env = await makeEnv();
    const started = (await (await startAttempt(env)).json()) as {
      data: { id: string };
    };
    for (const [questionId, answer] of Object.entries(ANSWERS_ALL)) {
      const res = await saveAnswer(
        env,
        env.memberCookie,
        started.data.id,
        questionId,
        answer,
      );
      expect(res.status).toBe(200);
    }
    const submitted = await submit(env, env.memberCookie, started.data.id);
    expect(submitted.status).toBe(200);

    // 再做一次：新 attempt，attemptNo=2，从空白开始
    const again = await startAttempt(env);
    expect(again.status).toBe(201);
    const againBody = (await again.json()) as {
      data: { id: string; attemptNo: number };
    };
    expect(againBody.data.attemptNo).toBe(2);
    expect(againBody.data.id).not.toBe(started.data.id);

    // 新一次草稿视图：drafts 为空、responses 无行（不预填上次答案与笔迹）
    const detail = await env.app.request(
      `/api/student/attempts/${againBody.data.id}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: {
        drafts: Record<string, unknown>;
        attempt: Record<string, unknown>;
      };
    };
    expect(
      attemptDraftOkSchema.safeParse({ ok: true, data: detailBody.data })
        .success,
    ).toBe(true);
    expect(detailBody.data.drafts).toEqual({});
    expect(detailBody.data.attempt).toMatchObject({
      attemptNo: 2,
      sourceType: "course",
    });
    assertNoLeak(detailBody, { allow: ["drafts"] });
    assertNoStemLeak(detailBody);
  });

  it("历次记录完整：首次/最近/最高分、待批数；每次结果使用各自快照", async () => {
    const env = await makeEnv();

    // 第一次：全对（判断题 2/2 → scoreAuto=100；手写题已答但无标准答案 → 待批 1）
    const first = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    // 事件区间（activeSec 数据源）：judge1 聚焦 8 秒
    await postEvents(env, env.memberCookie, first.id, [
      { type: "attempt_start", clientTs: 1000 },
      {
        type: "question_focus",
        clientTs: 2000,
        questionId: Q.judge1,
      },
      {
        type: "question_blur",
        clientTs: 10000,
        questionId: Q.judge1,
      },
      { type: "submit", clientTs: 11000 },
    ]);
    // 解锁一道提示（hintsUsed 语义在课程作答中同样生效）
    const hint = await env.app.request(
      `/api/student/attempts/${first.id}/hints`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({ questionId: Q.judge1, index: 0 }),
      },
    );
    expect(hint.status).toBe(200);
    for (const [questionId, answer] of Object.entries(ANSWERS_ALL)) {
      await saveAnswer(env, env.memberCookie, first.id, questionId, answer);
    }
    const firstResult = (await (
      await submit(env, env.memberCookie, first.id)
    ).json()) as {
      data: { attempt: { scoreAuto: number }; questions: unknown[] };
    };
    expect(firstResult.data.attempt.scoreAuto).toBe(100);

    // 教师改题（version+1，题干变更）——第二次作答使用新版本，第一次仍用旧快照
    const questionDetail = await env.app.request(
      `/api/teacher/questions/${encodeURIComponent(Q.judge1)}`,
      { headers: { cookie: env.teacherCookie } },
    );
    const sourceMd = (
      (await questionDetail.json()) as { data: { sourceMd: string } }
    ).data.sourceMd;
    const edited = await env.app.request(
      `/api/teacher/questions/${encodeURIComponent(Q.judge1)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({
          sourceMd: sourceMd.replace("$1$ 是正数", "$2$ 是正数"),
        }),
      },
    );
    expect(edited.status).toBe(200);

    // 第二次：判断题全错（scoreAuto=0）
    const second = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    for (const [questionId, answer] of Object.entries(ANSWERS_WRONG)) {
      await saveAnswer(env, env.memberCookie, second.id, questionId, answer);
    }
    const secondResult = (await (
      await submit(env, env.memberCookie, second.id)
    ).json()) as {
      data: {
        attempt: { scoreAuto: number };
        units: { questions: { snapshot: { stemMd: string } }[] }[];
      };
    };
    expect(secondResult.data.attempt.scoreAuto).toBe(0);
    expect(
      secondResult.data.units
        .flatMap((unit) => unit.questions)
        .some((question) => question.snapshot.stemMd.includes("$2$ 是正数")),
    ).toBe(true);

    // 第一次结果视图仍是旧快照（题干 $1$，历次各自独立）
    const firstView = (await (
      await env.app.request(`/api/student/attempts/${first.id}`, {
        headers: { cookie: env.memberCookie },
      })
    ).json()) as {
      data: { units: { questions: { snapshot: { stemMd: string } }[] }[] };
    };
    expect(
      firstView.data.units
        .flatMap((unit) => unit.questions)
        .some((question) => question.snapshot.stemMd.includes("$1$ 是正数")),
    ).toBe(true);

    // 落地页历次记录与汇总：attemptNo 降序；first=100、latest=0、best=100、待批 1
    const landing = (await (
      await env.app.request(
        `/api/student/courses/${env.courseId}/units/${env.unitId}`,
        { headers: { cookie: env.memberCookie } },
      )
    ).json()) as {
      data: {
        attempts: { attemptNo: number; score: number | null }[];
        summary: {
          count: number;
          submittedCount: number;
          firstScore: number | null;
          latestScore: number | null;
          bestScore: number | null;
          pendingCount: number;
        };
      };
    };
    expect(landing.data.attempts.map((attempt) => attempt.attemptNo)).toEqual([
      2, 1,
    ]);
    expect(landing.data.attempts[0]?.score).toBe(0);
    expect(landing.data.attempts[1]?.score).toBe(100);
    expect(landing.data.summary).toEqual({
      count: 2,
      submittedCount: 2,
      hasDraft: false,
      firstScore: 100,
      latestScore: 0,
      bestScore: 100,
      // D4 共享谓词（T3.2a）：finalCorrect IS NULL 且不再要求 answerJson 非空——
      // 第一次 solve 已答无标准答案 + 第二次 solve 未作答（answerJson null）
      // 都进待批，各计 1
      pendingCount: 2,
    });

    // activeSec：事件区间计算回写（judge1 聚焦 8 秒）
    const activeRow = env.db.$client
      .prepare(
        "SELECT active_sec FROM responses WHERE attempt_id = ? AND question_id = ?",
      )
      .get(first.id, Q.judge1) as { active_sec: number | null };
    expect(activeRow.active_sec).toBe(8);
  });

  it("存在未交卷作答时落地页 hasDraft=true，入口返回同一份", async () => {
    const env = await makeEnv();
    const started = (await (await startAttempt(env)).json()) as {
      data: { id: string };
    };
    await saveAnswer(env, env.memberCookie, started.data.id, Q.judge1, {
      kind: "judge",
      value: true,
    });
    const landing = (await (
      await env.app.request(
        `/api/student/courses/${env.courseId}/units/${env.unitId}`,
        { headers: { cookie: env.memberCookie } },
      )
    ).json()) as { data: { summary: { hasDraft: boolean } | null } };
    expect(landing.data.summary?.hasDraft).toBe(true);
    const again = (await (await startAttempt(env)).json()) as {
      data: { id: string };
    };
    expect(again.data.id).toBe(started.data.id);
  });
});

describe("T2A.6 课程练习：越权矩阵（D22）与移出成员（D7）", () => {
  it("非成员：落地页与开始练习均 403 COURSE_ACCESS_DENIED", async () => {
    const env = await makeEnv();
    const landing = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}`,
      { headers: { cookie: env.outsiderCookie } },
    );
    expect(landing.status).toBe(403);
    expect(((await landing.json()) as ApiErr).error).toBe(
      "COURSE_ACCESS_DENIED",
    );
    const start = await startAttempt(env, env.outsiderCookie);
    expect(start.status).toBe(403);
    expect(((await start.json()) as ApiErr).error).toBe("COURSE_ACCESS_DENIED");
  });

  it("隐藏条目与未到发布时间：404 NOT_FOUND（不暴露存在性）", async () => {
    const env = await makeEnv();
    const detail = await env.app.request(
      `/api/teacher/courses/${env.courseId}`,
      {
        headers: { cookie: env.teacherCookie },
      },
    );
    const items = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items;
    const unitItem = items.find((entry) => entry.refId === env.unitId);

    // 隐藏
    await env.app.request(`/api/teacher/course-items/${unitItem?.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ visible: false }),
    });
    const hiddenLanding = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(hiddenLanding.status).toBe(404);
    expect(((await hiddenLanding.json()) as ApiErr).error).toBe("NOT_FOUND");
    expect((await startAttempt(env)).status).toBe(404);

    // 未到发布时间（publishAt = 远未来）
    await env.app.request(`/api/teacher/course-items/${unitItem?.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        visible: true,
        publishAt: "2999-01-01T00:00:00.000Z",
      }),
    });
    const futureLanding = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(futureLanding.status).toBe(404);
    expect((await startAttempt(env)).status).toBe(404);
  });

  it("移出成员后：paper/保存/交卷 403；已交卷记录 GET /attempts/:id 仍 200", async () => {
    const env = await makeEnv();
    // 已交一份 + 一份未交草稿
    const first = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    for (const [questionId, answer] of Object.entries(ANSWERS_ALL)) {
      await saveAnswer(env, env.memberCookie, first.id, questionId, answer);
    }
    expect((await submit(env, env.memberCookie, first.id)).status).toBe(200);
    const second = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;

    // 移出成员（D7）
    const removed = await env.app.request(
      `/api/teacher/courses/${env.courseId}/members`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [env.memberStudentId] }),
      },
    );
    expect(removed.status).toBe(200);

    // 未交草稿：取卷/保存/交卷/事件全部 403 COURSE_ACCESS_DENIED
    const paper = await env.app.request(
      `/api/student/attempts/${second.id}/paper`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(paper.status).toBe(403);
    expect(((await paper.json()) as ApiErr).error).toBe("COURSE_ACCESS_DENIED");
    const save = await saveAnswer(env, env.memberCookie, second.id, Q.judge1, {
      kind: "judge",
      value: true,
    });
    expect(save.status).toBe(403);
    expect(((await save.json()) as ApiErr).error).toBe("COURSE_ACCESS_DENIED");
    expect((await submit(env, env.memberCookie, second.id)).status).toBe(403);
    expect(
      (
        await postEvents(env, env.memberCookie, second.id, [
          { type: "attempt_start", clientTs: Date.now() },
        ])
      ).status,
    ).toBe(403);

    // 已交卷记录：GET /attempts/:id 仍 200（只读回看；快照/答案/详解完整）
    const view = await env.app.request(`/api/student/attempts/${first.id}`, {
      headers: { cookie: env.memberCookie },
    });
    expect(view.status).toBe(200);
    const viewBody = (await view.json()) as {
      data: { attempt: { id: string }; summary: { total: number } };
    };
    expect(viewBody.data.attempt.id).toBe(first.id);
    expect(viewBody.data.summary.total).toBe(3);
  });
});

describe("T2A.6 通用取卷与作业作答迁移形态", () => {
  it("GET /attempts/:id/paper：课程来源（QuestionPublic 形态 + assertNoLeak）", async () => {
    const env = await makeEnv();
    const started = (await (await startAttempt(env)).json()) as {
      data: { id: string };
    };
    const paper = await env.app.request(
      `/api/student/attempts/${started.data.id}/paper`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(paper.status).toBe(200);
    const body = (await paper.json()) as {
      data: { units: { questions: unknown[] }[] };
    };
    expect(studentPaperDataSchema.safeParse(body.data).success).toBe(true);
    // T2A.7：course 来源单单元分组（1 组 3 题）
    expect(body.data.units).toHaveLength(1);
    expect(body.data.units[0]?.questions).toHaveLength(3);
    assertNoLeak(body);
    assertNoStemLeak(body);
  });

  it("GET /attempts/:id/paper：作业来源照常（未被指派的他人 attempt 403）", async () => {
    const env = await makeEnv();
    // 布置一份作业给成员学生（单单元现状）
    const assignment = await env.app.request("/api/teacher/assignments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        unitIds: [env.unitId],
        studentIds: [env.memberStudentId],
      }),
    });
    expect(assignment.status).toBe(201);
    const assignmentId = (
      (await assignment.json()) as {
        data: { assignments: { id: string }[] };
      }
    ).data.assignments[0]?.id;
    if (assignmentId === undefined) {
      throw new Error("布置作业响应缺少作业 id");
    }
    const started = await env.app.request(
      `/api/student/assignments/${assignmentId}/attempt`,
      { method: "POST", headers: { cookie: env.memberCookie } },
    );
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as {
      data: Record<string, unknown>;
    };
    // 迁移形态：作业作答 sourceType=assignment、attemptNo=1（D23-6 同口径）
    expect(startBody.data).toMatchObject({
      sourceType: "assignment",
      attemptNo: 1,
      assignmentId,
      courseId: null,
    });

    const paper = await env.app.request(
      `/api/student/attempts/${startBody.data.id}/paper`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(paper.status).toBe(200);
    const body = (await paper.json()) as { data: unknown };
    expect(studentPaperDataSchema.safeParse(body.data).success).toBe(true);
    assertNoLeak(body);
    assertNoStemLeak(body);
    // 作业与课程练习互不计次：作业作答后课程单元落地页仍无记录
    const landing = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}`,
      { headers: { cookie: env.memberCookie } },
    );
    const landingBody = (await landing.json()) as {
      data: { attempts: unknown[] };
    };
    expect(landingBody.data.attempts).toEqual([]);

    // 非本人 attempt 取卷 403
    const outsiderPaper = await env.app.request(
      `/api/student/attempts/${startBody.data.id}/paper`,
      { headers: { cookie: env.outsiderCookie } },
    );
    expect(outsiderPaper.status).toBe(403);
    expect(((await outsiderPaper.json()) as ApiErr).error).toBe("FORBIDDEN");
  });
});

describe("T2A.6 教师进度矩阵（GET /api/teacher/courses/:id/progress）", () => {
  it("成员 × 可见单元矩阵：次数、首次/最近/最高分、待批数、历次列表", async () => {
    const env = await makeEnv();
    // 成员做两次（全对 → 全错）
    const first = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    for (const [questionId, answer] of Object.entries(ANSWERS_ALL)) {
      await saveAnswer(env, env.memberCookie, first.id, questionId, answer);
    }
    await submit(env, env.memberCookie, first.id);
    const second = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    for (const [questionId, answer] of Object.entries(ANSWERS_WRONG)) {
      await saveAnswer(env, env.memberCookie, second.id, questionId, answer);
    }
    await submit(env, env.memberCookie, second.id);

    const res = await env.app.request(
      `/api/teacher/courses/${env.courseId}/progress`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        members: { studentId: string; displayName: string }[];
        units: { unitId: string; title: string }[];
        cells: {
          studentId: string;
          unitId: string;
          count: number;
          submittedCount: number;
          firstScore: number | null;
          latestScore: number | null;
          bestScore: number | null;
          pendingCount: number;
          latestSubmittedAt: string | null;
          history: {
            attemptNo: number;
            status: string;
            score: number | null;
          }[];
        }[];
      };
    };
    expect(body.data.members.map((m) => m.displayName)).toEqual(["成员张三"]);
    expect(body.data.units).toHaveLength(1);
    expect(body.data.units[0]?.unitId).toBe(env.unitId);
    expect(body.data.cells).toHaveLength(1);
    const cell = body.data.cells[0];
    if (cell === undefined) throw new Error("矩阵缺少成员 × 单元格");
    expect(cell).toMatchObject({
      studentId: env.memberStudentId,
      unitId: env.unitId,
      count: 2,
      submittedCount: 2,
      firstScore: 100,
      latestScore: 0,
      bestScore: 100,
      // D4 共享谓词：两次的 solve（第一次已答无标准答案、第二次未作答）都计待批
      pendingCount: 2,
      latestSubmittedAt: expect.any(String),
    });
    expect(cell.history.map((h) => h.attemptNo)).toEqual([2, 1]);
    expect(cell.history[0]?.score).toBe(0);

    // 隐藏单元后不出现在矩阵列（可见单元口径）
    const detail = await env.app.request(
      `/api/teacher/courses/${env.courseId}`,
      {
        headers: { cookie: env.teacherCookie },
      },
    );
    const unitItem = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === env.unitId);
    await env.app.request(`/api/teacher/course-items/${unitItem?.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ visible: false }),
    });
    const res2 = await env.app.request(
      `/api/teacher/courses/${env.courseId}/progress`,
      { headers: { cookie: env.teacherCookie } },
    );
    const body2 = (await res2.json()) as {
      data: { units: unknown[]; cells: unknown[] };
    };
    expect(body2.data.units).toEqual([]);
    expect(body2.data.cells).toEqual([]);
  });

  it("D4 共享谓词（T3.2a）：只写笔迹未填最终答案的手写题 → 进待批且 attempt 保持 submitted", async () => {
    const env = await makeEnv();
    const started = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    // 判断答对 + solve 只上传笔迹、不保存最终答案（answerJson 保持 null）
    await saveAnswer(env, env.memberCookie, started.id, Q.judge1, {
      kind: "judge",
      value: true,
    });
    const form = new FormData();
    form.append(
      "strokes",
      new Blob(
        [
          new Uint8Array(
            gzipSync(Buffer.from(JSON.stringify(atramentDoc(2)), "utf8")),
          ),
        ],
        { type: "application/gzip" },
      ),
      "strokes.json.gz",
    );
    form.append(
      "snapshot",
      new Blob([makePng()], { type: "image/png" }),
      "snapshot.png",
    );
    const ink = await env.app.request(
      `/api/student/attempts/${started.id}/ink/${encodeURIComponent(Q.solve)}`,
      { method: "PUT", headers: { cookie: env.memberCookie }, body: form },
    );
    expect(ink.status).toBe(200);
    expect((await submit(env, env.memberCookie, started.id)).status).toBe(200);

    // 前置：solve 行 answerJson 为 null 且 finalCorrect 为 null（正是旧
    // 「answerJson 非空」条件会漏掉、最需要批改的形态）
    const solveRow = env.db
      .select()
      .from(responses)
      .all()
      .find(
        (row) => row.attemptId === started.id && row.questionId === Q.solve,
      );
    expect(solveRow?.answerJson).toBeNull();
    expect(solveRow?.finalCorrect).toBeNull();

    // 学生落地页与教师进度矩阵：待批 1（旧口径此处为 0——漏报即本用例要防的回归）
    const landing = (await (
      await env.app.request(
        `/api/student/courses/${env.courseId}/units/${env.unitId}`,
        { headers: { cookie: env.memberCookie } },
      )
    ).json()) as { data: { summary: { pendingCount: number } | null } };
    expect(landing.data.summary?.pendingCount).toBe(1);
    const progress = (await (
      await env.app.request(`/api/teacher/courses/${env.courseId}/progress`, {
        headers: { cookie: env.teacherCookie },
      })
    ).json()) as { data: { cells: { pendingCount: number }[] } };
    expect(progress.data.cells[0]?.pendingCount).toBe(1);

    // 存在待批 → attempt 保持 submitted（D2：待批数 0 ⇔ graded）
    const attemptRow = env.db
      .select()
      .from(attempts)
      .all()
      .find((row) => row.id === started.id);
    expect(attemptRow?.status).toBe("submitted");
  });

  it("课程不存在 404；未登录 401", async () => {
    const env = await makeEnv();
    const missing = await env.app.request(
      `/api/teacher/courses/${crypto.randomUUID()}/progress`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(missing.status).toBe(404);
    const unauth = await env.app.request(
      `/api/teacher/courses/${env.courseId}/progress`,
    );
    expect(unauth.status).toBe(401);
  });
});

describe("T2A.6 课程目录单元状态与首页进度", () => {
  it("目录单元项携带作答摘要；未做单元为 null；完成后课程卡片进度联动", async () => {
    const env = await makeEnv();
    const before = (await (
      await env.app.request(`/api/student/courses/${env.courseId}`, {
        headers: { cookie: env.memberCookie },
      })
    ).json()) as {
      data: {
        items: { kind: string; refId: string | null; attempt: unknown }[];
      };
    };
    const unitEntry = before.data.items.find((item) => item.kind === "unit");
    expect(unitEntry?.attempt).toBeNull();

    const coursesBefore = (await (
      await env.app.request("/api/student/courses", {
        headers: { cookie: env.memberCookie },
      })
    ).json()) as {
      data: {
        courses: { visibleUnitCount: number; completedUnitCount: number }[];
      };
    };
    expect(coursesBefore.data.courses[0]).toMatchObject({
      visibleUnitCount: 1,
      completedUnitCount: 0,
    });

    // 交卷一次 → 目录摘要与首页进度联动
    const first = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    for (const [questionId, answer] of Object.entries(ANSWERS_ALL)) {
      await saveAnswer(env, env.memberCookie, first.id, questionId, answer);
    }
    await submit(env, env.memberCookie, first.id);

    const after = (await (
      await env.app.request(`/api/student/courses/${env.courseId}`, {
        headers: { cookie: env.memberCookie },
      })
    ).json()) as {
      data: {
        items: {
          kind: string;
          refId: string | null;
          attempt: { count: number; hasDraft: boolean } | null;
        }[];
      };
    };
    const unitAfter = after.data.items.find((item) => item.kind === "unit");
    expect(unitAfter?.attempt).toMatchObject({ count: 1, hasDraft: false });

    const coursesAfter = (await (
      await env.app.request("/api/student/courses", {
        headers: { cookie: env.memberCookie },
      })
    ).json()) as {
      data: {
        courses: { completedUnitCount: number }[];
      };
    };
    expect(coursesAfter.data.courses[0]?.completedUnitCount).toBe(1);
  });
});

/** 最小合法 PNG（魔数 + IHDR；服务端只校验魔数/IHDR/尺寸） */
function makePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 构造 atrament InkDoc（n 笔） */
function atramentDoc(strokes = 2): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokes }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y: 20, p: 0.5, t: 0 },
          { x: 30 + i, y: 240, p: 0.8, t: 25 },
        ],
      })),
    },
    updatedAt: 1727392800000,
  };
}

describe("T2A.6 课程作答的笔迹（与作业作答同一套 ink 接口）", () => {
  it("上传/取回/PNG 正常；两次作答笔迹按 attemptId 隔离；移出成员后未交卷笔迹 403", async () => {
    const env = await makeEnv();
    const first = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    const doc = atramentDoc(2);
    const form = new FormData();
    form.append(
      "strokes",
      new Blob(
        [new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")))],
        { type: "application/gzip" },
      ),
      "strokes.json.gz",
    );
    form.append(
      "snapshot",
      new Blob([makePng()], { type: "image/png" }),
      "snapshot.png",
    );
    const put = await env.app.request(
      `/api/student/attempts/${first.id}/ink/${encodeURIComponent(Q.solve)}`,
      { method: "PUT", headers: { cookie: env.memberCookie }, body: form },
    );
    expect(put.status).toBe(200);

    // 取回矢量文档与 PNG 直出（本人）
    const docGet = await env.app.request(
      `/api/student/attempts/${first.id}/ink/${encodeURIComponent(Q.solve)}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(docGet.status).toBe(200);
    const pngGet = await env.app.request(
      `/api/student/attempts/${first.id}/ink/${encodeURIComponent(Q.solve)}.png`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(pngGet.status).toBe(200);

    // 交卷 → 再做一次：新 attempt 取回 404 INK_NOT_FOUND（笔迹按 attemptId 隔离，
    // 不串到下一次）
    for (const [questionId, answer] of Object.entries(ANSWERS_ALL)) {
      await saveAnswer(env, env.memberCookie, first.id, questionId, answer);
    }
    await submit(env, env.memberCookie, first.id);
    const second = (
      (await (await startAttempt(env)).json()) as { data: { id: string } }
    ).data;
    const secondInk = await env.app.request(
      `/api/student/attempts/${second.id}/ink/${encodeURIComponent(Q.solve)}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(secondInk.status).toBe(404);
    expect(((await secondInk.json()) as ApiErr).error).toBe("INK_NOT_FOUND");
    // 第一次（已交卷）的笔迹仍可回看
    const firstInk = await env.app.request(
      `/api/student/attempts/${first.id}/ink/${encodeURIComponent(Q.solve)}`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(firstInk.status).toBe(200);

    // 移出成员：未交卷的第二次作答上传笔迹 403（D7），已交卷的取回不受影响
    await env.app.request(`/api/teacher/courses/${env.courseId}/members`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ studentIds: [env.memberStudentId] }),
    });
    const form2 = new FormData();
    form2.append(
      "strokes",
      new Blob(
        [new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")))],
        { type: "application/gzip" },
      ),
      "strokes.json.gz",
    );
    form2.append(
      "snapshot",
      new Blob([makePng()], { type: "image/png" }),
      "snapshot.png",
    );
    const deniedPut = await env.app.request(
      `/api/student/attempts/${second.id}/ink/${encodeURIComponent(Q.solve)}`,
      { method: "PUT", headers: { cookie: env.memberCookie }, body: form2 },
    );
    expect(deniedPut.status).toBe(403);
    expect(((await deniedPut.json()) as ApiErr).error).toBe(
      "COURSE_ACCESS_DENIED",
    );
  });
});
