import { gzipSync } from "node:zlib";
import type { ApiErr } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client";
import { attempts, responses, teachers } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * T3.2b 批注与待批队列服务测试（POST /api/teacher/responses/:id/mark 与
 * GET /api/teacher/pending-marks，Phase3 清单 §2 D3/D4）。
 *
 * 核心场景（清单 §4 T3.2b 验收原文）——8 题卷：
 * 6 客观（判断×2 + 单选×2 + 多选×1 + 填空×1：前 5 题答对、填空未作答 → false，
 * 不进队列）+ 1 手写题只写笔迹不填最终答案（有标准答案 → 待批）+ 1 无标准
 * 答案题（答了最终答案 → 待批）。交卷后队列恰含后两题（待批数 2）；
 * 两题都批对 → scoreFinal = 88（7÷8）、一对一错 → 75（6÷8）且 status=graded；
 * 清除批注（mark=null）→ finalCorrect 回落 autoCorrect、status 回 submitted、
 * scoreFinal 置 null；对自动判过的题改判生效（graded 卷重算）；评语空串按 null、
 * 超 2000 字 400；draft 批注 409 NOT_SUBMITTED；队列 submittedAt 升序与
 * courseId/assignmentId/studentId 筛选；域隔离（乙 404 / 空队列）。
 *
 * 夹具与 teacher-attempts.test.ts 同款：甲 = setup 教师；乙 = 直插教师行 +
 * createTeacherSession；学生经真实学生端接口作答（开卷 / 存答 / 传笔迹 / 交卷），
 * submittedAt 直写库获得确定的排序断言；responseId 从库内直查（接口不暴露）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
const TEACHER_B_ID = "teacher-b-t32b-0001";

/** 8 题卷单元：6 客观（题 1–6）+ 手写题（题 7，有标准答案）+ 开放题（题 8，无标准答案） */
const UNIT = "批改练习";
const UNIT_MD = `---
kind: practice
unit: ${UNIT}
topic: 有理数
---

# ${UNIT}

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是正数。[[错误]]
::::

::::question{type=choice difficulty=1 knowledge="计算"}
$1+1=$（　）

- [ ] $1$
- [x] $2$
- [ ] $3$
::::

::::question{type=choice difficulty=2 knowledge="计算"}
$3-0=$（　）

- [x] $3$
- [ ] $4$
- [ ] $5$
::::

::::question{type=multi difficulty=2 knowledge="计算"}
下列结果是正数的有（　）

- [x] $1$
- [ ] $-2$
- [x] $3$
- [ ] $-4$
::::

::::question{type=fill difficulty=2 knowledge="计算"}
$2+3=$ [[5]]。
::::

::::question{type=solve difficulty=3 knowledge="计算"}
计算 $1+2$，写出过程。

:::answer
3
:::

:::solution
$1+2=3$。
:::
::::

::::question{type=solve difficulty=3 knowledge="开放题"}
用一句话说说你对数学的感受。

:::solution
无标准答案，言之成理即可。
:::
::::
`;

/** 题目 id（单元 slug 缺省编号：按文档内题目顺序 1 起） */
const Q = {
  judge1: `${UNIT}-1`,
  judge2: `${UNIT}-2`,
  choice1: `${UNIT}-3`,
  choice2: `${UNIT}-4`,
  multi: `${UNIT}-5`,
  fill: `${UNIT}-6`,
  solve: `${UNIT}-7`,
  open: `${UNIT}-8`,
} as const;

/** 夹具时间戳（队列 submittedAt 升序断言；课程练习先交、作业后交） */
const T = {
  courseSubmitted: "2026-09-20T10:20:00.000Z",
  assignSubmitted: "2026-09-25T09:30:00.000Z",
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
  /** 课程练习（先交卷；5 对 + 1 未作答 + 2 待批） */
  courseSubmittedId: string;
  /** 作业作答（后交卷；同构作答，solve 无笔迹） */
  assignmentSubmittedId: string;
  /** 课程练习第 2 次（进行中草稿；judge1 有草稿行，409 用） */
  courseDraftId: string;
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 发 JSON 请求（POST/PUT；可带 Cookie） */
async function request(
  app: App,
  path: string,
  body: unknown,
  cookie?: string,
  method: "POST" | "PUT" = "POST",
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

/** 教师端待批队列（GET；返回 status 与解包后的 data） */
async function pendingList(
  app: App,
  cookie: string,
  query = "",
): Promise<{ status: number; body: { marks: Record<string, unknown>[] } }> {
  const res = await app.request(`/api/teacher/pending-marks${query}`, {
    headers: { cookie },
  });
  const json = (await res.json()) as {
    data: { marks: Record<string, unknown>[] };
  };
  return { status: res.status, body: json.data };
}

/** 教师批注（POST /responses/:id/mark；返回 status 与解包后的 data） */
async function mark(
  app: App,
  cookie: string,
  responseId: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown>; err?: ApiErr }> {
  const res = await request(
    app,
    `/api/teacher/responses/${responseId}/mark`,
    body,
    cookie,
  );
  if (res.status === 200) {
    return {
      status: res.status,
      data: ((await res.json()) as { data: Record<string, unknown> }).data,
    };
  }
  return { status: res.status, data: {}, err: (await res.json()) as ApiErr };
}

/** 直查 responseId（接口不暴露 responses.id；夹具从库内取批注定位 id） */
function responseIdOf(db: Db, attemptId: string, questionId: string): string {
  const row = db
    .select({ id: responses.id })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new Error(`夹具缺少 response 行：${attemptId} / ${questionId}`);
  }
  return row.id;
}

/** 直读 attempt 行（断言库内 status/scoreFinal 落库值） */
function attemptRowOf(
  db: Db,
  attemptId: string,
): { status: string; scoreFinal: number | null } {
  const row = db
    .select({ status: attempts.status, scoreFinal: attempts.scoreFinal })
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (row === undefined) throw new Error(`夹具缺少 attempt 行：${attemptId}`);
  return row;
}

/** 直写 attempt 时间戳（队列排序的确定性断言用） */
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

/** 5 道客观题答对（题 6 填空不答 → D1 判 false 不进队列） */
async function answerFiveCorrect(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<void> {
  await saveAnswer(app, cookie, attemptId, Q.judge1, {
    kind: "judge",
    value: true,
  });
  await saveAnswer(app, cookie, attemptId, Q.judge2, {
    kind: "judge",
    value: false,
  });
  await saveAnswer(app, cookie, attemptId, Q.choice1, {
    kind: "choice",
    index: 1,
  });
  await saveAnswer(app, cookie, attemptId, Q.choice2, {
    kind: "choice",
    index: 0,
  });
  await saveAnswer(app, cookie, attemptId, Q.multi, {
    kind: "multi",
    indexes: [0, 2],
  });
}

/**
 * 组装被测环境：甲导入 8 题单元 → 建学生/课程（成员+条目）/作业（挂课程）；
 * 学生作答三份 attempt（课程练习已交〔solve 只写笔迹〕/ 作业已交〔solve 无
 * 笔迹〕/ 课程练习草稿）；乙直插教师 + 会话。
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

  expect(
    (
      await request(
        app,
        "/api/teacher/import/commit",
        { markdown: UNIT_MD, filename: "批改练习.md" },
        cookieA,
      )
    ).status,
  ).toBe(200);

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
    { title: "初一上" },
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
        { items: [{ kind: "unit", refId: UNIT }] },
        cookieA,
      )
    ).status,
  ).toBe(201);

  // 作业（挂课程）：assignmentId 筛选与队列排序的后一份 attempt 用
  const assignmentRes = await request(
    app,
    "/api/teacher/assignments",
    {
      title: "第一周批改",
      courseId,
      unitIds: [UNIT],
      studentIds: [studentId],
    },
    cookieA,
  );
  expect(assignmentRes.status).toBe(201);
  const assignmentId = (
    (await assignmentRes.json()) as { data: { id: string } }
  ).data.id;

  // 课程练习第 1 次：5 对 + solve 只写笔迹不填最终答案 + 开放题答最终答案 → 交卷
  const c1Res = await request(
    app,
    `/api/student/courses/${courseId}/units/${UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(c1Res.status).toBe(201);
  const courseSubmittedId = ((await c1Res.json()) as { data: { id: string } })
    .data.id;
  await answerFiveCorrect(app, studentCookie, courseSubmittedId);
  await putInk(app, studentCookie, courseSubmittedId, Q.solve);
  await saveAnswer(app, studentCookie, courseSubmittedId, Q.open, {
    kind: "final",
    finalAnswer: "数学是美的。",
  });
  expect(
    (
      await request(
        app,
        `/api/student/attempts/${courseSubmittedId}/submit`,
        {},
        studentCookie,
      )
    ).status,
  ).toBe(200);
  setAttemptTimes(db, courseSubmittedId, {
    startedAt: "2026-09-20T10:00:00.000Z",
    submittedAt: T.courseSubmitted,
  });

  // 作业作答：同构作答（solve 不写笔迹）→ 交卷（队列第二份）
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
  await answerFiveCorrect(app, studentCookie, assignmentSubmittedId);
  await saveAnswer(app, studentCookie, assignmentSubmittedId, Q.open, {
    kind: "final",
    finalAnswer: "数学很有用。",
  });
  expect(
    (
      await request(
        app,
        `/api/student/attempts/${assignmentSubmittedId}/submit`,
        {},
        studentCookie,
      )
    ).status,
  ).toBe(200);
  setAttemptTimes(db, assignmentSubmittedId, {
    startedAt: "2026-09-25T09:00:00.000Z",
    submittedAt: T.assignSubmitted,
  });

  // 课程练习第 2 次：进行中草稿（judge1 存草稿行，draft 批注 409 用），不交卷
  const c2Res = await request(
    app,
    `/api/student/courses/${courseId}/units/${UNIT}/attempts`,
    {},
    studentCookie,
  );
  expect(c2Res.status).toBe(201);
  const courseDraftId = ((await c2Res.json()) as { data: { id: string } }).data
    .id;
  await saveAnswer(app, studentCookie, courseDraftId, Q.judge1, {
    kind: "judge",
    value: true,
  });

  // 乙：直插教师行 + 会话（teacher-domain-isolation / T3.1 同款）
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$t32b-fixture",
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
    assignmentSubmittedId,
    courseDraftId,
  };
}

describe("T3.2b 待批队列（D4 口径）：8 题卷交卷后恰含 2 题待批", () => {
  it("队列只含手写题与无标准答案题；未作答客观题（false）不在；卡片字段齐全", async () => {
    const env = await makeEnv();
    const { status, body } = await pendingList(env.app, env.cookieA);
    expect(status).toBe(200);
    expect(body.marks).toHaveLength(4); // 两份 attempt × 各 2 题待批

    const courseCards = body.marks.filter(
      (m) => m.attemptId === env.courseSubmittedId,
    );
    expect(courseCards.map((m) => m.questionId)).toEqual([Q.solve, Q.open]);
    // 未作答填空题（autoCorrect=false）与已判对的客观题都不在队列
    const allQuestionIds = new Set(body.marks.map((m) => m.questionId));
    expect(allQuestionIds).toEqual(new Set([Q.solve, Q.open]));

    // 手写题卡片：只写笔迹未填最终答案 → answerText null + ink hasStrokes
    const solve = courseCards[0] as Record<string, unknown>;
    expect(solve).toMatchObject({
      responseId: expect.stringMatching(/^[0-9a-f-]{36}$/ as RegExp),
      studentId: env.studentId,
      studentName: "小明",
      sourceType: "course",
      courseId: env.courseId,
      courseName: "初一上",
      assignmentId: null,
      assignmentTitle: null,
      unitId: UNIT,
      unitTitle: UNIT,
      attemptNo: 1,
      type: "solve",
      difficulty: 3,
      knowledge: ["计算"],
      answerText: null,
      answers: { kind: "final", answer: "3" },
      ink: {
        hasStrokes: true,
        pngUrl: expect.stringMatching(/^\/api\/teacher\/ink\/.+\.png$/),
      },
      activeSec: null,
      hintsUsed: 0,
      changeCount: 0,
      submittedAt: T.courseSubmitted,
    });
    expect(solve.stemMd).toContain("计算 $1+2$");

    // 无标准答案题卡片：answers null；最终答案序列化为文本；无笔迹 ink null
    const open = courseCards[1] as Record<string, unknown>;
    expect(open).toMatchObject({
      questionId: Q.open,
      answers: null,
      answerText: "数学是美的。",
      ink: null,
      submittedAt: T.courseSubmitted,
    });
  });

  it("队列按 submittedAt 升序（先交先批）；courseId/assignmentId/studentId 筛选与非法参数", async () => {
    const env = await makeEnv();
    const { app, cookieA, studentId, courseId, assignmentId } = env;

    // 全量排序：课程练习（09-20）在前、作业（09-25）在后；同 attempt 内按题号
    const full = await pendingList(app, cookieA);
    expect(full.body.marks.map((m) => [m.attemptId, m.questionId])).toEqual([
      [env.courseSubmittedId, Q.solve],
      [env.courseSubmittedId, Q.open],
      [env.assignmentSubmittedId, Q.solve],
      [env.assignmentSubmittedId, Q.open],
    ]);

    // courseId：课程练习 + 挂课程的作业作答都命中（D6 课程视图同口径）
    expect(
      (await pendingList(app, cookieA, `?courseId=${courseId}`)).body.marks,
    ).toHaveLength(4);
    // assignmentId：只命中作业作答的 2 题
    const byAssignment = await pendingList(
      app,
      cookieA,
      `?assignmentId=${assignmentId}`,
    );
    expect(byAssignment.body.marks).toHaveLength(2);
    expect(
      byAssignment.body.marks.every((m) => m.sourceType === "assignment"),
    ).toBe(true);
    expect(byAssignment.body.marks[0]).toMatchObject({
      assignmentTitle: "第一周批改",
      answerText: null, // 作业的 solve 没写笔迹也没填最终答案
    });
    // studentId：命中全部；陌生 UUID → 空
    expect(
      (await pendingList(app, cookieA, `?studentId=${studentId}`)).body.marks,
    ).toHaveLength(4);
    expect(
      (
        await pendingList(
          app,
          cookieA,
          "?studentId=0199bbbb-0000-4222-8333-444455556666",
        )
      ).body,
    ).toEqual({ marks: [] });
    // 组合筛选
    expect(
      (
        await pendingList(
          app,
          cookieA,
          `?courseId=${courseId}&assignmentId=${assignmentId}`,
        )
      ).body.marks,
    ).toHaveLength(2);
    // 非法参数 → 400
    for (const bad of ["?courseId=none", "?assignmentId=1", "?studentId=x"]) {
      expect((await pendingList(app, cookieA, bad)).status, bad).toBe(400);
    }
  });
});

describe("T3.2b 批注（D3 持久化 + D2 状态机重算）", () => {
  it("两题都批对 → scoreFinal=88（7÷8）、status=graded、队列清空", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;

    // 批第一题：仍有待批 → submitted、scoreFinal null
    const first = await mark(
      app,
      cookieA,
      responseIdOf(db, courseSubmittedId, Q.solve),
      {
        mark: "correct",
        comment: "过程完整",
      },
    );
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({
      questionId: Q.solve,
      attemptId: courseSubmittedId,
      teacherMark: "correct",
      teacherComment: "过程完整",
      finalCorrect: true,
      attemptStatus: "submitted",
      scoreFinal: null,
      pendingCount: 1,
    });

    // 批第二题：全部判定完成 → graded、scoreFinal = 7/8 = 88（四舍五入）
    const second = await mark(
      app,
      cookieA,
      responseIdOf(db, courseSubmittedId, Q.open),
      { mark: "correct", comment: null },
    );
    expect(second.status).toBe(200);
    expect(second.data).toMatchObject({
      teacherMark: "correct",
      teacherComment: null,
      finalCorrect: true,
      attemptStatus: "graded",
      scoreFinal: 88,
      pendingCount: 0,
    });

    // 库内落库值与该 attempt 的队列清空
    expect(attemptRowOf(db, courseSubmittedId)).toEqual({
      status: "graded",
      scoreFinal: 88,
    });
    const queue = await pendingList(app, cookieA);
    expect(
      queue.body.marks.filter((m) => m.attemptId === courseSubmittedId),
    ).toEqual([]);
  });

  it("一对一错 → scoreFinal=75（6÷8）且 status=graded", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;
    expect(
      (
        await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.solve), {
          mark: "correct",
          comment: null,
        })
      ).data,
    ).toMatchObject({ attemptStatus: "submitted", pendingCount: 1 });
    const second = await mark(
      app,
      cookieA,
      responseIdOf(db, courseSubmittedId, Q.open),
      { mark: "wrong", comment: "要联系生活实际" },
    );
    expect(second.data).toMatchObject({
      teacherMark: "wrong",
      finalCorrect: false,
      attemptStatus: "graded",
      scoreFinal: 75,
      pendingCount: 0,
    });
    expect(attemptRowOf(db, courseSubmittedId)).toEqual({
      status: "graded",
      scoreFinal: 75,
    });
  });

  it("清除批注（mark=null）→ finalCorrect 回落 autoCorrect、status 回 submitted、scoreFinal 置 null", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;

    // 先批完（graded 88）再清除其中一题
    await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.solve), {
      mark: "correct",
      comment: "过程完整",
    });
    await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.open), {
      mark: "correct",
      comment: "很好",
    });
    expect(attemptRowOf(db, courseSubmittedId)).toEqual({
      status: "graded",
      scoreFinal: 88,
    });

    const cleared = await mark(
      app,
      cookieA,
      responseIdOf(db, courseSubmittedId, Q.solve),
      { mark: null, comment: null },
    );
    expect(cleared.data).toMatchObject({
      teacherMark: null,
      teacherComment: null,
      // 手写题 autoCorrect 为 null → 回落 null 即重新待批（D4 共享谓词）
      finalCorrect: null,
      attemptStatus: "submitted",
      scoreFinal: null,
      pendingCount: 1,
    });
    expect(attemptRowOf(db, courseSubmittedId)).toEqual({
      status: "submitted",
      scoreFinal: null,
    });
    // 该题重新出现在队列
    const queue = await pendingList(app, cookieA);
    expect(
      queue.body.marks
        .filter((m) => m.attemptId === courseSubmittedId)
        .map((m) => m.questionId),
    ).toEqual([Q.solve]);
  });

  it("对自动判过的题改判 wrong 生效；清除后回落 autoCorrect（graded 卷重算）", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;

    // 批完两道待批题 → graded 88（5 对 + 未作答错 + 2 批对）
    await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.solve), {
      mark: "correct",
      comment: null,
    });
    await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.open), {
      mark: "correct",
      comment: null,
    });
    expect(attemptRowOf(db, courseSubmittedId)).toEqual({
      status: "graded",
      scoreFinal: 88,
    });

    // 对自动判对的单选题（judge1，autoCorrect=true）改判 wrong → 6/8 = 75
    const changed = await mark(
      app,
      cookieA,
      responseIdOf(db, courseSubmittedId, Q.judge1),
      { mark: "wrong", comment: "概念混淆" },
    );
    expect(changed.data).toMatchObject({
      questionId: Q.judge1,
      teacherMark: "wrong",
      finalCorrect: false,
      attemptStatus: "graded",
      scoreFinal: 75,
      pendingCount: 0,
    });
    expect(attemptRowOf(db, courseSubmittedId)).toEqual({
      status: "graded",
      scoreFinal: 75,
    });

    // 清除改判 → finalCorrect 回落 autoCorrect=true → 恢复 88
    const restored = await mark(
      app,
      cookieA,
      responseIdOf(db, courseSubmittedId, Q.judge1),
      { mark: null, comment: null },
    );
    expect(restored.data).toMatchObject({
      teacherMark: null,
      finalCorrect: true,
      attemptStatus: "graded",
      scoreFinal: 88,
      pendingCount: 0,
    });
  });

  it("评语空串按 null 存储；trim 生效；2000 字边界与超出 400；mark 非法 400", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;
    const solveResponseId = responseIdOf(db, courseSubmittedId, Q.solve);

    // 纯空白评语 → 归一化 null（契约层 transform，落库亦 null）
    const blank = await mark(app, cookieA, solveResponseId, {
      mark: "correct",
      comment: "   ",
    });
    expect(blank.data).toMatchObject({
      teacherMark: "correct",
      teacherComment: null,
      finalCorrect: true,
    });

    // 非空白评语 trim 后存储
    const trimmed = await mark(app, cookieA, solveResponseId, {
      mark: "correct",
      comment: "  步骤对，结论清楚。  ",
    });
    expect(trimmed.data.teacherComment).toBe("步骤对，结论清楚。");

    // 恰 2000 字可存；2001 字 → 400 VALIDATION_ERROR（契约层校验）
    expect(
      (
        await mark(app, cookieA, solveResponseId, {
          mark: "correct",
          comment: "好".repeat(2000),
        })
      ).status,
    ).toBe(200);
    const tooLong = await mark(app, cookieA, solveResponseId, {
      mark: "correct",
      comment: "好".repeat(2001),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.err?.error).toBe("VALIDATION_ERROR");

    // mark 非法 / 缺字段 → 400
    for (const bad of [
      { mark: "对", comment: null },
      { mark: "correct" },
      { comment: "缺 mark" },
    ] as const) {
      const res = await mark(app, cookieA, solveResponseId, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.err?.error).toBe("VALIDATION_ERROR");
    }
  });

  it("对 draft attempt 批注 → 409 NOT_SUBMITTED；不存在的 response → 404", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseDraftId } = env;

    const draftResponseId = responseIdOf(db, courseDraftId, Q.judge1);
    const res = await mark(app, cookieA, draftResponseId, {
      mark: "correct",
      comment: null,
    });
    expect(res.status).toBe(409);
    expect(res.err?.error).toBe("NOT_SUBMITTED");

    const notFound = await mark(
      app,
      cookieA,
      "0199bbbb-0000-4222-8333-444455556666",
      { mark: "correct", comment: null },
    );
    expect(notFound.status).toBe(404);
    expect(notFound.err?.error).toBe("RESPONSE_NOT_FOUND");
  });

  it("批注后详情视图携带教师判定与评语（D7 字段贯通）", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, courseSubmittedId } = env;
    await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.solve), {
      mark: "wrong",
      comment: "漏了进位",
    });
    const res = await app.request(
      `/api/teacher/attempts/${courseSubmittedId}`,
      { headers: { cookie: cookieA } },
    );
    expect(res.status).toBe(200);
    const detail = (
      (await res.json()) as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(detail).toMatchObject({
      status: "submitted",
      // scoreAuto 不受批注影响（5/6）；scoreFinal 仍有待批为 null
      scoreAuto: 83,
      scoreFinal: null,
      correctCount: 5,
      wrongCount: 2, // 未作答填空（false）+ 批错的 solve
      pendingCount: 1,
    });
    const solve = (detail.questions as Record<string, unknown>[]).find(
      (q) => q.questionId === Q.solve,
    );
    expect(solve).toMatchObject({
      teacherMark: "wrong",
      teacherComment: "漏了进位",
      finalCorrect: false,
      autoCorrect: null,
    });
  });
});

describe("T3.2b 域隔离（T2B 红线）", () => {
  it("教师乙批甲的 response → 404；乙待批队列为空；甲照常（对照）", async () => {
    const env = await makeEnv();
    const { app, db, cookieA, cookieB, courseSubmittedId } = env;

    const listB = await pendingList(app, cookieB);
    expect(listB.status).toBe(200);
    expect(listB.body).toEqual({ marks: [] });

    const res = await mark(
      app,
      cookieB,
      responseIdOf(db, courseSubmittedId, Q.solve),
      { mark: "correct", comment: null },
    );
    expect(res.status).toBe(404);
    expect(res.err?.error).toBe("RESPONSE_NOT_FOUND");

    // 甲本人批注与队列照常（对照）
    expect(
      (
        await mark(app, cookieA, responseIdOf(db, courseSubmittedId, Q.solve), {
          mark: "correct",
          comment: null,
        })
      ).status,
    ).toBe(200);
    expect((await pendingList(app, cookieA)).body.marks.length).toBe(3);
  });
});
