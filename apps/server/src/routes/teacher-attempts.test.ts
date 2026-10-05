import { gzipSync } from "node:zlib";
import type { ApiErr } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { attempts, teachers } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { fetchSubmitRevisions } from "../test/submit-revisions";

/**
 * T3.1 教师端作答数据接口测试（GET /api/teacher/attempts 与 /:id）：
 * - 列表与筛选组合（studentId / courseId / assignmentId / unitId / sourceType /
 *   status / from / to）与最近活动时间倒序；
 * - D5：draft attempt 出现在列表（status=draft）；draft 详情含草稿答案与笔迹，
 *   判定字段全 null、不下发参考答案/详解、题干公开化（与学生草稿视图同源）；
 * - D7 已交卷详情：快照题干（含 [[答案]] 标记）、参考答案、详解、判定字段、
 *   手写信息按 ink 表关联（只写笔迹未填最终答案 → hasStrokes true）、
 *   多单元作业全卷连续题号（单元顺序 × 题序）；
 * - 域隔离（T2B 红线）：教师乙列表查不到甲数据；按 id 详情 → 404；
 * - 分页边界：limit 默认 50 / 最大 200 / 非法 400；offset 越界空数组 + total 正确；
 * - D16：含软删单元的作业 attempt 照常可查（单元 deletedAt 不影响列表与详情）。
 *
 * 夹具：甲 = setup 教师；乙 = 直插教师行 + createTeacherSession（teacher-domain-
 * isolation 同款）；学生经真实学生端接口作答（开卷 / 存答 / 传笔迹 / 交卷），
 * attempt 时间戳直写库以获得确定的排序与时间筛选断言。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
const TEACHER_B_ID = "teacher-b-t31-0001";

/** 作业单元：判断（可自动判分）+ 手写 solve（无标准答案 → 待批；带详解） */
const ASSIGN_UNIT = "有理数作业练习";
const ASSIGN_UNIT_MD = `---
kind: practice
unit: ${ASSIGN_UNIT}
topic: 有理数
---

# ${ASSIGN_UNIT}

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=solve difficulty=3 knowledge="计算"}
写一写：$1+1$ 是多少？

:::solution
$1+1=2$。
:::
::::
`;

/** 课程练习单元：同构两题（判断 + 手写 solve） */
const COURSE_UNIT = "有理数课程练习";
const COURSE_UNIT_MD = `---
kind: practice
unit: ${COURSE_UNIT}
topic: 有理数
---

# ${COURSE_UNIT}

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$2$ 是正数。[[正确]]
::::

::::question{type=solve difficulty=3 knowledge="计算"}
写一写：$2+2$ 是多少？

:::solution
$2+2=4$。
:::
::::
`;

/** 题目 id（单元 slug 缺省编号：按文档内题目顺序 1 起） */
const Q = {
  assignJudge: `${ASSIGN_UNIT}-1`,
  assignSolve: `${ASSIGN_UNIT}-2`,
  courseJudge: `${COURSE_UNIT}-1`,
  courseSolve: `${COURSE_UNIT}-2`,
} as const;

/** 夹具时间戳（控制最近活动时间排序与 from/to 筛选断言；UTC ISO） */
const T = {
  courseSubmittedStart: "2026-09-20T10:00:00.000Z",
  courseSubmittedEnd: "2026-09-20T10:20:00.000Z",
  assignmentStart: "2026-09-25T09:00:00.000Z",
  assignmentEnd: "2026-09-25T09:30:00.000Z",
  courseDraftStart: "2026-09-28T08:00:00.000Z",
} as const;

type App = ReturnType<typeof createApp>;

interface TestEnv {
  app: App;
  db: Db;
  cookieA: string;
  cookieB: string;
  studentId: string;
  courseId: string;
  assignmentId: string;
  /** 课程练习第 1 次（已交卷；solve 只写笔迹未填最终答案） */
  courseSubmittedId: string;
  /** 课程练习第 2 次（进行中草稿；含草稿答案与笔迹） */
  courseDraftId: string;
  /** 作业作答（已交卷；双单元 4 题） */
  assignmentSubmittedId: string;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 发 JSON 请求（POST/PATCH/PUT/DELETE；可带 Cookie） */
async function request(
  app: App,
  path: string,
  body: unknown,
  cookie?: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method, headers, body: JSON.stringify(body) });
}

/** 存草稿答案（PUT /answers/:questionId） */
async function saveAnswer(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<void> {
  const res = await request(
    app,
    `/api/student/attempts/${attemptId}/answers/${questionId}`,
    { answer },
    cookie,
    "PUT",
  );
  expect(res.status).toBe(200);
}

/** 最小合法 PNG（服务端只校验魔数/IHDR；与既有测试同构造） */
function fakePng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 构造 atrament InkDoc 并 gzip（与既有测试同口径） */
function inkDoc(strokeCount: number): Uint8Array {
  const doc = {
    engine: "atrament" as const,
    version: 1 as const,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokeCount }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y: 20, p: 0.5, t: 0 },
          { x: 30 + i, y: 40, p: 0.8, t: 25 },
        ],
      })),
    },
    updatedAt: 1727392800000,
  };
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")));
}

/** PUT 笔迹（multipart：strokes.gz + snapshot.png） */
async function putInk(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
): Promise<void> {
  const form = new FormData();
  form.append(
    "strokes",
    new Blob([inkDoc(3)], { type: "application/gzip" }),
    "strokes.json.gz",
  );
  form.append(
    "snapshot",
    new Blob([fakePng()], { type: "image/png" }),
    "snapshot.png",
  );
  const res = await app.request(
    `/api/student/attempts/${attemptId}/ink/${questionId}`,
    { method: "PUT", headers: { cookie }, body: form },
  );
  expect(res.status).toBe(200);
}

/** 教师端作答列表（GET，可带任意 query 串；返回解包后的 data） */
async function teacherList(
  app: App,
  cookie: string,
  query = "",
): Promise<{
  status: number;
  body: { attempts: Record<string, unknown>[]; total: number };
}> {
  const res = await app.request(`/api/teacher/attempts${query}`, {
    headers: { cookie },
  });
  const json = (await res.json()) as {
    data: { attempts: Record<string, unknown>[]; total: number };
  };
  return { status: res.status, body: json.data };
}

/** 教师端作答详情（GET /:id；返回解包后的 data） */
async function teacherDetail(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`/api/teacher/attempts/${attemptId}`, {
    headers: { cookie },
  });
  const json = (await res.json()) as { data: Record<string, unknown> };
  return { status: res.status, body: json.data };
}

/** 直写 attempt 时间戳（排序与时间筛选的确定性断言用） */
function setAttemptTimes(
  db: Db,
  attemptId: string,
  times: { startedAt: string; submittedAt: string | null },
): void {
  db.update(attempts)
    .set({ startedAt: times.startedAt, submittedAt: times.submittedAt })
    .where(eq(attempts.id, attemptId))
    .run();
}

/**
 * 组装被测环境：甲导入两单元 → 建学生/课程（成员+目录条目）/作业（双单元挂课程）；
 * 学生真实作答三条 attempt（课程已交 / 作业已交 / 课程草稿）；乙直插教师 + 会话。
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
  const setup = await request(app, "/api/public/teacher/setup", {
    loginName: "teacher",
    password: TEACHER_PASSWORD,
  });
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;

  for (const [markdown, filename] of [
    [ASSIGN_UNIT_MD, "作业练习.md"],
    [COURSE_UNIT_MD, "课程练习.md"],
  ] as const) {
    const res = await request(
      app,
      "/api/teacher/import/commit",
      { markdown, filename },
      cookieA,
    );
    expect(res.status).toBe(200);
  }

  // 学生 + 登录
  const studentRes = await request(
    app,
    "/api/teacher/students",
    {
      displayName: "小明",
      loginName: "小明",
      password: STUDENT_PASSWORD,
    },
    cookieA,
  );
  expect(studentRes.status).toBe(201);
  const studentId = (
    (await studentRes.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  const loginRes = await request(app, "/api/public/student/login", {
    loginName: "小明",
    password: STUDENT_PASSWORD,
  });
  expect(loginRes.status).toBe(200);
  const studentCookie = `tutor_session=${extractSessionToken(loginRes)}`;

  // 课程 + 成员 + 目录条目（课程练习入口）
  const courseRes = await request(
    app,
    "/api/teacher/courses",
    {
      title: "初一上",
    },
    cookieA,
  );
  expect(courseRes.status).toBe(201);
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  expect(
    (
      await request(
        app,
        `/api/teacher/courses/${courseId}/members`,
        { studentIds: [studentId] },
        cookieA,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        app,
        `/api/teacher/courses/${courseId}/items`,
        { items: [{ kind: "unit", refId: COURSE_UNIT }] },
        cookieA,
      )
    ).status,
  ).toBe(201);

  // 作业：双单元（布置顺序 = 作业单元 → 课程单元），挂课程
  const assignmentRes = await request(
    app,
    "/api/teacher/assignments",
    {
      title: "第一周作业",
      courseId,
      unitIds: [ASSIGN_UNIT, COURSE_UNIT],
      studentIds: [studentId],
    },
    cookieA,
  );
  expect(assignmentRes.status).toBe(201);
  const assignmentId = (
    (await assignmentRes.json()) as {
      data: { assignments: { id: string }[] };
    }
  ).data.assignments[0]?.id;
  if (assignmentId === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }

  // 课程练习第 1 次：判断答对；solve 只写笔迹不填最终答案 → 交卷（待批 1）
  const c1Res = await request(
    app,
    `/api/student/courses/${courseId}/units/${COURSE_UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(c1Res.status).toBe(201);
  const courseSubmittedId = ((await c1Res.json()) as { data: { id: string } })
    .data.id;
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.courseJudge, {
    kind: "judge",
    value: true,
  });
  await putInk(app, studentCookie, courseSubmittedId, Q.courseSolve);
  expect(
    (
      await request(
        app,
        `/api/student/attempts/${courseSubmittedId}/submit`,
        {
          revisions: await fetchSubmitRevisions(
            app,
            studentCookie,
            courseSubmittedId,
          ),
        },
        studentCookie,
      )
    ).status,
  ).toBe(200);
  setAttemptTimes(db, courseSubmittedId, {
    startedAt: T.courseSubmittedStart,
    submittedAt: T.courseSubmittedEnd,
  });

  // 课程练习第 2 次：进行中草稿（判断已答 + solve 笔迹），不交卷（D5）
  const c2Res = await request(
    app,
    `/api/student/courses/${courseId}/units/${COURSE_UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(c2Res.status).toBe(201);
  const courseDraftId = (
    (await c2Res.json()) as { data: { id: string; attemptNo: number } }
  ).data.id;
  await saveAnswer(app, studentCookie, courseDraftId, Q.courseJudge, {
    kind: "judge",
    value: false,
  });
  await putInk(app, studentCookie, courseDraftId, Q.courseSolve);
  setAttemptTimes(db, courseDraftId, {
    startedAt: T.courseDraftStart,
    submittedAt: null,
  });

  // 作业作答：两道判断都答对；两道 solve 未作答 → 交卷（对 2 / 待批 2）
  const a1Res = await request(
    app,
    `/api/student/assignments/${assignmentId}/attempt`,
    {},
    studentCookie,
  );
  expect(a1Res.status).toBe(200);
  const assignmentSubmittedId = (
    (await a1Res.json()) as { data: { id: string } }
  ).data.id;
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.assignJudge, {
    kind: "judge",
    value: true,
  });
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.courseJudge, {
    kind: "judge",
    value: true,
  });
  expect(
    (
      await request(
        app,
        `/api/student/attempts/${assignmentSubmittedId}/submit`,
        {
          revisions: await fetchSubmitRevisions(
            app,
            studentCookie,
            assignmentSubmittedId,
          ),
        },
        studentCookie,
      )
    ).status,
  ).toBe(200);
  setAttemptTimes(db, assignmentSubmittedId, {
    startedAt: T.assignmentStart,
    submittedAt: T.assignmentEnd,
  });

  // 乙：直插教师行 + 会话（多教师库形态，teacher-domain-isolation 同款）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t31-fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const cookieB = `tutor_session=${createTeacherSession(db, TEACHER_B_ID).token}`;

  return {
    app,
    db,
    cookieA,
    cookieB,
    studentId,
    courseId,
    assignmentId,
    courseSubmittedId,
    courseDraftId,
    assignmentSubmittedId,
  };
}

describe("T3.1 列表：默认排序与卡片字段", () => {
  it("按最近活动时间倒序；三种来源卡片字段齐全（D6）", async () => {
    const env = await makeEnv();
    const { status, body } = await teacherList(env.app, env.cookieA);
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.attempts.map((a) => a.attemptId)).toEqual([
      env.courseDraftId,
      env.assignmentSubmittedId,
      env.courseSubmittedId,
    ]);

    // 草稿卡片（D5：列表可见进行中作答）
    const draft = body.attempts[0];
    expect(draft).toMatchObject({
      studentId: env.studentId,
      studentName: "小明",
      sourceType: "course",
      courseId: env.courseId,
      courseName: "初一上",
      assignmentId: null,
      assignmentTitle: null,
      unitId: COURSE_UNIT,
      unitTitle: COURSE_UNIT,
      attemptNo: 2,
      unitCount: 1,
      questionCount: 2,
      status: "draft",
      scoreAuto: null,
      scoreFinal: null,
      pendingCount: 0,
      submittedAt: null,
      activeSec: null,
    });

    // 作业卡片（双单元、挂课程；得分双字段：scoreAuto 100 / scoreFinal null）
    const assignment = body.attempts[1];
    expect(assignment).toMatchObject({
      sourceType: "assignment",
      assignmentId: env.assignmentId,
      assignmentTitle: "第一周作业",
      courseId: env.courseId,
      courseName: "初一上",
      unitId: null,
      unitTitle: null,
      attemptNo: 1,
      unitCount: 2,
      questionCount: 4,
      status: "submitted",
      scoreAuto: 100,
      scoreFinal: null,
      pendingCount: 2,
    });

    // 课程练习第 1 次卡片
    expect(body.attempts[2]).toMatchObject({
      sourceType: "course",
      unitTitle: COURSE_UNIT,
      attemptNo: 1,
      questionCount: 2,
      status: "submitted",
      scoreAuto: 100,
      pendingCount: 1,
    });
  });

  it("各筛选与组合正确（studentId / courseId / assignmentId / unitId / sourceType / status / from / to）", async () => {
    const env = await makeEnv();
    const { app, cookieA, studentId, courseId, assignmentId } = env;

    // studentId：命中全部；陌生 UUID → 空
    expect(
      (await teacherList(app, cookieA, `?studentId=${studentId}`)).body.total,
    ).toBe(3);
    expect(
      (
        await teacherList(
          app,
          cookieA,
          "?studentId=0199bbbb-0000-4222-8333-444455556666",
        )
      ).body,
    ).toMatchObject({ attempts: [], total: 0 });

    // courseId：课程练习 2 次 + 挂该课程的作业作答 1 次（D6 课程视图口径）
    expect(
      (await teacherList(app, cookieA, `?courseId=${courseId}`)).body.total,
    ).toBe(3);
    // assignmentId：只命中作业作答
    const byAssignment = await teacherList(
      app,
      cookieA,
      `?assignmentId=${assignmentId}`,
    );
    expect(byAssignment.body.attempts.map((a) => a.attemptId)).toEqual([
      env.assignmentSubmittedId,
    ]);
    // unitId：DSL id，只命中 course 来源（assignment 来源不落单单元）
    const byUnit = await teacherList(app, cookieA, `?unitId=${COURSE_UNIT}`);
    expect(byUnit.body.total).toBe(2);
    expect(byUnit.body.attempts.every((a) => a.sourceType === "course")).toBe(
      true,
    );
    // sourceType
    expect(
      (await teacherList(app, cookieA, "?sourceType=assignment")).body.total,
    ).toBe(1);
    expect(
      (await teacherList(app, cookieA, "?sourceType=course")).body.total,
    ).toBe(2);
    // status
    expect((await teacherList(app, cookieA, "?status=draft")).body.total).toBe(
      1,
    );
    expect(
      (await teacherList(app, cookieA, "?status=submitted")).body.total,
    ).toBe(2);
    // from / to（按最近活动时间过滤）
    expect(
      (await teacherList(app, cookieA, "?from=2026-09-26T00:00:00.000Z")).body
        .total,
    ).toBe(1);
    expect(
      (await teacherList(app, cookieA, "?to=2026-09-26T00:00:00.000Z")).body
        .total,
    ).toBe(2);
    expect(
      (
        await teacherList(
          app,
          cookieA,
          "?from=2026-09-21T00:00:00.000Z&to=2026-09-26T00:00:00.000Z",
        )
      ).body.attempts.map((a) => a.attemptId),
    ).toEqual([env.assignmentSubmittedId]);
    // 组合：courseId + status=draft（时间范围 + 学生叠加）
    expect(
      (await teacherList(app, cookieA, `?courseId=${courseId}&status=draft`))
        .body.total,
    ).toBe(1);
    expect(
      (
        await teacherList(
          app,
          cookieA,
          `?studentId=${studentId}&from=2026-09-26T00:00:00.000Z&to=2026-09-30T00:00:00.000Z`,
        )
      ).body.total,
    ).toBe(1);
  });

  it("非法查询参数 → 400 VALIDATION_ERROR", async () => {
    const env = await makeEnv();
    for (const bad of [
      "?limit=0",
      "?limit=201",
      "?limit=abc",
      "?offset=-1",
      "?studentId=not-a-uuid",
      "?from=2026-09-28T18:00",
      "?status=archived",
    ] as const) {
      const res = await env.app.request(`/api/teacher/attempts${bad}`, {
        headers: { cookie: env.cookieA },
      });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as ApiErr).error, bad).toBe(
        "VALIDATION_ERROR",
      );
    }
  });
});

describe("T3.1 详情：draft（D5 进行中可查）", () => {
  it("含草稿答案与笔迹；判定字段全 null；不下发参考答案/详解；题干公开化", async () => {
    const env = await makeEnv();
    const { status, body } = await teacherDetail(
      env.app,
      env.cookieA,
      env.courseDraftId,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      attemptId: env.courseDraftId,
      studentName: "小明",
      sourceType: "course",
      courseId: env.courseId,
      unitId: COURSE_UNIT,
      unitTitle: COURSE_UNIT,
      attemptNo: 2,
      status: "draft",
      scoreAuto: null,
      scoreFinal: null,
      correctCount: 0,
      wrongCount: 0,
      pendingCount: 0,
      submittedAt: null,
    });

    const questions = body.questions as Record<string, unknown>[];
    expect(questions.map((q) => q.no)).toEqual([1, 2]);
    const judge = questions[0] as Record<string, unknown>;
    // 草稿答案回显；判定字段全 null（判定列显示「未交卷」）
    expect(judge).toMatchObject({
      questionId: Q.courseJudge,
      answer: { kind: "judge", value: false },
      autoCorrect: null,
      finalCorrect: null,
      teacherMark: null,
      teacherComment: null,
    });
    // 题干公开化（[[答案]] → [[]]），且整卷无 answers / solutionMd 键（D7）
    expect(judge.stemMd).toContain("[[]]");
    expect(judge.stemMd).not.toContain("[[正确]]");
    expect("answers" in judge).toBe(false);
    expect("solutionMd" in judge).toBe(false);

    // 未答题的 solve：无 responses 行也有题目行；笔迹按 ink 表关联（draft 期笔迹）
    const solve = questions[1] as Record<string, unknown>;
    expect(solve).toMatchObject({
      questionId: Q.courseSolve,
      answer: null,
      autoCorrect: null,
      ink: {
        hasStrokes: true,
        pngUrl: expect.stringMatching(/^\/api\/teacher\/ink\/.+\.png$/),
      },
    });
    expect("answers" in solve).toBe(false);
    expect("solutionMd" in solve).toBe(false);
  });
});

describe("T3.1 详情：已交卷（D7 快照 + ink 关联 + 连续题号）", () => {
  it("课程练习：快照题干原文、参考答案与详解；只写笔迹未填最终答案 → hasStrokes true", async () => {
    const env = await makeEnv();
    const { status, body } = await teacherDetail(
      env.app,
      env.cookieA,
      env.courseSubmittedId,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "submitted",
      scoreAuto: 100,
      scoreFinal: null,
      correctCount: 1,
      wrongCount: 0,
      pendingCount: 1,
      attemptNo: 1,
    });

    const questions = body.questions as Record<string, unknown>[];
    expect(questions).toHaveLength(2);
    const judge = questions[0] as Record<string, unknown>;
    // 快照题干含 [[答案]] 标记（教师端允许）；参考答案下发
    expect(judge.stemMd).toContain("[[正确]]");
    expect(judge.answers).toEqual({ kind: "judge", value: true });
    expect(judge).toMatchObject({
      questionId: Q.courseJudge,
      answer: { kind: "judge", value: true },
      autoCorrect: true,
      // D3（T3.2a）：交卷同时写 finalCorrect=autoCorrect——已自动判定的题不再为 null
      finalCorrect: true,
      teacherMark: null,
      teacherComment: null,
      knowledge: ["有理数的概念"],
      solutionMd: null,
    });

    // solve：answerJson null 但 ink 行存在 → hasStrokes true；详解照常
    const solve = questions[1] as Record<string, unknown>;
    expect(solve).toMatchObject({
      questionId: Q.courseSolve,
      answer: null,
      autoCorrect: null,
      answers: null,
      solutionMd: expect.stringContaining("$2+2=4$"),
      ink: {
        hasStrokes: true,
        pngUrl: expect.stringMatching(/^\/api\/teacher\/ink\/.+\.png$/),
      },
    });
  });

  it("作业（双单元）：全卷连续题号按布置顺序编排；来源头带作业标题与课程名", async () => {
    const env = await makeEnv();
    const { status, body } = await teacherDetail(
      env.app,
      env.cookieA,
      env.assignmentSubmittedId,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      sourceType: "assignment",
      assignmentId: env.assignmentId,
      assignmentTitle: "第一周作业",
      courseId: env.courseId,
      courseName: "初一上",
      unitId: null,
      attemptNo: 1,
      status: "submitted",
      scoreAuto: 100,
      correctCount: 2,
      wrongCount: 0,
      pendingCount: 2,
    });

    // 4 题 = 作业单元 2 题 + 课程单元 2 题（布置顺序），题号 1–4 连续
    const questions = body.questions as Record<string, unknown>[];
    expect(questions.map((q) => q.questionId)).toEqual([
      Q.assignJudge,
      Q.assignSolve,
      Q.courseJudge,
      Q.courseSolve,
    ]);
    expect(questions.map((q) => q.no)).toEqual([1, 2, 3, 4]);
    expect(questions.map((q) => q.unitTitle)).toEqual([
      ASSIGN_UNIT,
      ASSIGN_UNIT,
      COURSE_UNIT,
      COURSE_UNIT,
    ]);
    // 两道判断已答对；两道 solve 未作答（无笔迹 → ink null）
    expect(questions[0]).toMatchObject({
      autoCorrect: true,
      answer: { kind: "judge", value: true },
    });
    expect(questions[2]).toMatchObject({
      autoCorrect: true,
      answer: { kind: "judge", value: true },
    });
    expect(questions[1]).toMatchObject({
      answer: null,
      autoCorrect: null,
      ink: null,
    });
    expect(questions[3]).toMatchObject({
      answer: null,
      autoCorrect: null,
      ink: null,
    });
    // 已交卷逐题都带 answers / solutionMd 键（无标准答案 / 无详解为 null）
    for (const q of questions) {
      expect("answers" in q).toBe(true);
      expect("solutionMd" in q).toBe(true);
    }
    expect((questions[1] as Record<string, unknown>).solutionMd).toContain(
      "$1+1=2$",
    );
  });
});

describe("T3.1 域隔离（T2B 红线）", () => {
  it("教师乙列表查不到甲数据；按甲 attemptId 详情 → 404 ATTEMPT_NOT_FOUND", async () => {
    const env = await makeEnv();
    const listB = await teacherList(env.app, env.cookieB);
    expect(listB.status).toBe(200);
    expect(listB.body).toEqual({ attempts: [], total: 0 });

    for (const attemptId of [
      env.courseSubmittedId,
      env.courseDraftId,
      env.assignmentSubmittedId,
    ]) {
      const res = await env.app.request(`/api/teacher/attempts/${attemptId}`, {
        headers: { cookie: env.cookieB },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as ApiErr).error).toBe("ATTEMPT_NOT_FOUND");
    }

    // 甲本人照常（对照）
    expect(
      (await teacherDetail(env.app, env.cookieA, env.courseSubmittedId)).status,
    ).toBe(200);
  });
});

describe("T3.1 分页边界", () => {
  it("limit 默认 50 / 最大 200 / 非法 400；offset 越界返回空数组 + total 正确", async () => {
    const env = await makeEnv();
    // 直插 60 条已交卷课程 attempt（同学生同课程），连同夹具 3 条共 63
    for (let i = 0; i < 60; i += 1) {
      const startedAt = new Date(
        Date.parse("2026-09-01T00:00:00.000Z") + i * 60_000,
      ).toISOString();
      env.db
        .insert(attempts)
        .values({
          id: `a1000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          studentId: env.studentId,
          sourceType: "course",
          assignmentId: null,
          courseId: env.courseId,
          unitId: COURSE_UNIT,
          attemptNo: 3 + i,
          status: "submitted",
          startedAt,
          submittedAt: startedAt,
          activeSec: null,
          device: null,
          scoreAuto: null,
          scoreFinal: null,
        })
        .run();
    }

    // 默认 limit=50
    const def = await teacherList(env.app, env.cookieA);
    expect(def.body.attempts).toHaveLength(50);
    expect(def.body.total).toBe(63);
    // 最大 200（不足则全量）
    const max = await teacherList(env.app, env.cookieA, "?limit=200");
    expect(max.body.attempts).toHaveLength(63);
    expect(max.body.total).toBe(63);
    // limit=2 + offset 翻页（与默认排序衔接：两页不重叠）
    const page1 = await teacherList(env.app, env.cookieA, "?limit=2&offset=0");
    const page2 = await teacherList(env.app, env.cookieA, "?limit=2&offset=2");
    expect(page1.body.attempts.map((a) => a.attemptId)).not.toEqual(
      page2.body.attempts.map((a) => a.attemptId),
    );
    expect(page1.body.total).toBe(63);
    // offset 越界：空数组 + total 照常
    const beyond = await teacherList(env.app, env.cookieA, "?offset=999");
    expect(beyond.body.attempts).toEqual([]);
    expect(beyond.body.total).toBe(63);
    // 非法分页 400
    for (const bad of ["?limit=201", "?limit=0", "?offset=-1"] as const) {
      expect((await teacherList(env.app, env.cookieA, bad)).status, bad).toBe(
        400,
      );
    }
  });
});

describe("T3.1 软删单元（D16）：作业 attempt 照常可查", () => {
  it("单元软删后列表与详情不受影响（单元数/题数/单元节标题照常）", async () => {
    const env = await makeEnv();
    // 软删作业的第一个单元（教师端 DELETE /units/:id 为软删；作业照常，D16）
    const del = await request(
      env.app,
      `/api/teacher/units/${ASSIGN_UNIT}`,
      {},
      env.cookieA,
      "DELETE",
    );
    expect(del.status).toBe(200);

    // 列表：作业作答仍在，单元数 / 题数（responses 冻结口径）不变
    const list = await teacherList(
      env.app,
      env.cookieA,
      `?assignmentId=${env.assignmentId}`,
    );
    expect(list.body.total).toBe(1);
    expect(list.body.attempts[0]).toMatchObject({
      attemptId: env.assignmentSubmittedId,
      unitCount: 2,
      questionCount: 4,
    });

    // 详情：4 题照常、单元节标题仍可读（软删单元行保留）
    const { status, body } = await teacherDetail(
      env.app,
      env.cookieA,
      env.assignmentSubmittedId,
    );
    expect(status).toBe(200);
    const questions = body.questions as Record<string, unknown>[];
    expect(questions.map((q) => q.no)).toEqual([1, 2, 3, 4]);
    expect(questions.map((q) => q.unitTitle)).toEqual([
      ASSIGN_UNIT,
      ASSIGN_UNIT,
      COURSE_UNIT,
      COURSE_UNIT,
    ]);
  });
});
