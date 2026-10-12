import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  lessonStartOkSchema,
  studentLectureDetailOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  attempts,
  events,
  lectures,
  questions,
  responses,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { assertNoStemLeak } from "../test/assert-no-stem-leak.ts";

/**
 * 讲练一体（2026-10）开卷与学生安全投影集成测试（app.request() 直调路由 +
 * 内存库）——本计划防泄露最关键的一组：
 *
 * - POST /lectures/:id/lesson/start：幂等 create-or-return（重复 start 同一份
 *   draft；**已完成返回最新那份，绝不重开**）、建卷冻结（教师改题库不影响）、
 *   访问控制复用 getStudentLecture 三分谓词（非成员 403 / 不可见 404 / 不存在
 *   404 / 纯讲义 404）；
 * - POST /lectures/:id/lesson/restart：进行中 409 ALREADY_SUBMITTED、已完成
 *   201 新卷 attemptNo+1；
 * - **泄露矩阵（AGENTS.md 规则 3）**：start 响应与 lesson 讲义详情响应中，
 *   未提交题的 answers/solutionMd/hint 内容绝不下发；讲义 markdown 原文
 *   （含题块、- [x]、:::solution/:::hint）绝不出现（键名级 assertNoLeak +
 *   内容级 assertNoStemLeak + 题块原文字符串级断言三层）；released 只含已
 *   提交题；
 * - GET /lectures/:id kind=lesson 安全投影：markdown 恒 null + blocks 切段 +
 *   companionUnits 恒空（kind=lecture 行为不变的对照见 student-lectures.test.ts
 *   既有用例）；
 * - 零题讲练页（LESSON_WITHOUT_QUESTION）开卷合法（questions 空、blocks 纯 md）；
 * - 建卷发 attempt_start 事件（幂等取回不重复记、restart 新卷各记一条）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/**
 * 讲练页样例：单讲 + 两题（choice 带 - [x] 正确项与提示 / judge 带 [[答案]] 与
 * 详解+提示），题间与题后都有正文段（验证 blocks 切段与题块剔除）。
 */
const LESSON_MD = `---
kind: lesson
unit: 随堂讲练
topic: 有理数
---

# 第1讲 有理数

$0$ 既不是正数也不是负数。

::::question{type=choice difficulty=1}
下列是正整数的是：

- [ ] $-1$
- [x] $1$
- [ ] $0$

:::hint
大于 $0$ 的自然数是正整数。
:::
::::

题间正文。

::::question{type=judge difficulty=1}
$0$ 是最小的正整数。[[错误]]

:::solution
$0$ 既不是正数也不是负数；最小的正整数是 $1$。
:::

:::hint
最小的正整数是 $1$。
:::
::::

题后一段正文。
`;

/** 零题讲练页（解析记 LESSON_WITHOUT_QUESTION warning，讲义照常产出、无单元） */
const LESSON_NO_QUESTION_MD = `---
kind: lesson
unit: 空讲练
---

# 只有正文的讲练页

这一页没有题目，只有讲解。
`;

/** 纯讲义对照（kind=lecture 无题块，同 H1 标题以便夹具定位） */
const LECTURE_ONLY_MD = `---
kind: lecture
---

# 第1讲 有理数

$0$ 既不是正数也不是负数。
`;

/** 题目 id（单元 slug 缺省编号） */
const Q = { choice: "随堂讲练-1", judge: "随堂讲练-2" } as const;

/**
 * 学生载荷不得出现的题块原文片段（题块围栏、正确项标记、答案标记、未解锁
 * 提示与详解内容）——服务端切段/投影后这些只应存在于教师域。
 */
const QUESTION_BLOCK_SECRETS = [
  "::::question",
  ":::solution",
  ":::hint",
  "[[错误]]",
  "- [x]",
  "大于 $0$ 的自然数是正整数。",
  "$0$ 既不是正数也不是负数；最小的正整数是 $1$。",
];

/** 字符串级断言：整个响应 JSON 里绝不出现题块原文片段 */
function assertNoQuestionBlockText(body: unknown): void {
  const text = JSON.stringify(body);
  for (const secret of QUESTION_BLOCK_SECRETS) {
    expect(text, `学生端响应出现题块原文片段：${secret}`).not.toContain(secret);
  }
}

type App = ReturnType<typeof createApp>;

interface TestEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  memberCookie: string;
  outsiderCookie: string;
  courseId: string;
  lectureId: string;
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
    cookie: `tutor_student_session=${extractSessionToken(login, "tutor_student_session")}`,
  };
}

/** 教师导入一份文档进课程（commit；有 error 级 issue 时 422 直接让测试失败） */
async function importDoc(
  app: App,
  teacherCookie: string,
  markdown: string,
  filename: string,
  courseId?: string,
): Promise<void> {
  const res = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify(
      courseId === undefined
        ? { markdown, filename }
        : { markdown, filename, courseId },
    ),
  });
  expect(res.status).toBe(200);
}

/** 组装被测环境：教师 + 课程 + 讲练页导入（courseId 路径：讲义条目可见）+ 成员/非成员 */
async function makeEnv(options?: { markdown?: string }): Promise<TestEnv> {
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

  await importDoc(
    app,
    teacherCookie,
    options?.markdown ?? LESSON_MD,
    "随堂讲练.md",
    courseId,
  );
  // 三份夹具都只产出一条讲义行（含零题/纯讲义对照），取唯一行即被测讲义
  const lectureRows = db.select().from(lectures).all();
  const lecture = lectureRows.find((row) => row.deletedAt === null);
  if (lecture === undefined) throw new Error("导入未产出讲练页讲义");

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
    outsiderCookie: outsider.cookie,
    courseId,
    lectureId: lecture.id,
  };
}

/** POST 讲练开卷（start；query 可带 courseId） */
async function startLesson(
  env: TestEnv,
  cookie: string = env.memberCookie,
  courseId?: string,
): Promise<Response> {
  const query = courseId === undefined ? "" : `?courseId=${courseId}`;
  return env.app.request(
    `/api/student/lectures/${env.lectureId}/lesson/start${query}`,
    {
      method: "POST",
      headers: { cookie },
    },
  );
}

/** POST 讲练重做（restart；无参数） */
async function restartLesson(
  env: TestEnv,
  cookie: string = env.memberCookie,
): Promise<Response> {
  return env.app.request(
    `/api/student/lectures/${env.lectureId}/lesson/restart`,
    { method: "POST", headers: { cookie } },
  );
}

/** start 响应 data 的宽松形态（断言用；契约校验走 lessonStartOkSchema） */
interface StartBody {
  data: {
    lecture: {
      id: string;
      title: string;
      topic: string | null;
      courseId: string | null;
      courseName: string | null;
    };
    blocks: { type: string; md?: string; questionId?: string }[];
    attempt: {
      id: string;
      sourceType: string;
      lectureId: string | null;
      assignmentId: string | null;
      courseId: string | null;
      unitId: string | null;
      attemptNo: number;
      status: string;
    };
    questions: {
      id: string;
      stemMd: string;
      options?: string[];
      hintCount: number;
      questionRevisionId: string;
    }[];
    drafts: Record<string, unknown>;
    hintsOpened: Record<string, { index: number; text: string }[]>;
    released: Record<
      string,
      {
        answers: unknown;
        solutionMd: string | null;
        answer: unknown;
        autoCorrect: boolean | null;
        teacherMark: string | null;
        finalCorrect: boolean | null;
        snapshot: { stemMd: string };
      }
    >;
    summary: {
      total: number;
      answered: number;
      correct: number;
      wrong: number;
      pending: number;
      scoreFinal: number | null;
      pendingCount: number | null;
    } | null;
    enabledCapabilities: string[];
  };
}

async function startOk(
  env: TestEnv,
  cookie?: string,
  courseId?: string,
): Promise<StartBody> {
  const res = await startLesson(env, cookie, courseId);
  expect(res.status).toBe(200);
  const body = (await res.json()) as StartBody;
  expect(lessonStartOkSchema.safeParse(body).success).toBe(true);
  return body;
}

describe("POST /api/student/lectures/:id/lesson/start（讲练开卷，幂等 create-or-return）", () => {
  it("开卷投影：blocks 切段（无题块）、questions 公开平铺、attempt 归属与 lecture 上下文；三层泄露断言", async () => {
    const env = await makeEnv();
    const body = await startOk(env);

    // 讲义切段：md 段（可渲染正文）与题目槽交替，题块原文绝不在段内
    expect(body.data.blocks.map((b) => b.type)).toEqual([
      "md",
      "question",
      "md",
      "question",
      "md",
    ]);
    expect(body.data.blocks[0]?.md).toContain("# 第1讲 有理数");
    expect(body.data.blocks[1]).toEqual({
      type: "question",
      questionId: Q.choice,
    });
    expect(body.data.blocks[2]?.md).toContain("题间正文。");
    expect(body.data.blocks[3]).toEqual({
      type: "question",
      questionId: Q.judge,
    });
    expect(body.data.blocks[4]?.md).toContain("题后一段正文。");

    // 冻结题公开投影平铺：studentStemMd 口径 + questionRevisionId + hintCount
    expect(body.data.questions.map((q) => q.id)).toEqual([Q.choice, Q.judge]);
    const choice = body.data.questions[0] as { options?: string[] };
    expect(choice.options).toEqual(["$-1$", "$1$", "$0$"]);
    expect(body.data.questions.every((q) => q.hintCount === 1)).toBe(true);
    expect(
      body.data.questions.every(
        (q) =>
          typeof q.questionRevisionId === "string" &&
          q.questionRevisionId !== "",
      ),
    ).toBe(true);

    // attempt：lesson 来源归属不变式（契约 superRefine 锁定）
    expect(body.data.attempt).toMatchObject({
      sourceType: "lesson",
      lectureId: env.lectureId,
      assignmentId: null,
      courseId: env.courseId,
      unitId: "随堂讲练",
      attemptNo: 1,
      status: "draft",
    });

    // lecture 上下文：标题 / 主题（嵌入单元 topic）/ 课程
    expect(body.data.lecture).toEqual({
      id: env.lectureId,
      title: "第1讲 有理数",
      topic: "有理数",
      courseId: env.courseId,
      courseName: "初一上",
    });

    // 初始空白：无草稿、无已解锁提示、无已释放题；进行中 summary 现算全零
    expect(body.data.drafts).toEqual({});
    expect(body.data.hintsOpened).toEqual({});
    expect(body.data.released).toEqual({});
    expect(body.data.summary).toMatchObject({
      total: 2,
      answered: 0,
      correct: 0,
      wrong: 0,
      pending: 0,
      unanswered: 2,
      scoreFinal: null,
      pendingCount: 0,
    });

    // 泄露矩阵（未提交状态：released 空，无需 allow）三层断言
    assertNoLeak(body);
    assertNoStemLeak(body);
    assertNoQuestionBlockText(body);
  });

  it("幂等：重复 start 返回同一份 draft（同 attemptId）；attempt_start 事件只记一条", async () => {
    const env = await makeEnv();
    const first = await startOk(env);
    const second = await startOk(env, env.memberCookie, env.courseId);
    expect(second.data.attempt.id).toBe(first.data.attempt.id);

    const startEvents = env.db
      .select()
      .from(events)
      .where(eq(events.attemptId, first.data.attempt.id))
      .all()
      .filter((row) => row.type === "attempt_start");
    expect(startEvents).toHaveLength(1);
  });

  it("草稿与已解锁提示回显：本人答案进 drafts、已解锁提示进 hintsOpened（未解锁的绝不出现）", async () => {
    const env = await makeEnv();
    const started = await startOk(env);
    const attemptId = started.data.attempt.id;

    const saved = await env.app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(Q.choice)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({ answer: { kind: "choice", index: 1 } }),
      },
    );
    expect(saved.status).toBe(200);

    // 只解锁 judge 题的第 0 条提示（choice 题的提示保持未解锁）
    const hint = await env.app.request(
      `/api/student/attempts/${attemptId}/hints`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({ questionId: Q.judge, index: 0 }),
      },
    );
    expect(hint.status).toBe(200);

    const body = await startOk(env);
    expect(body.data.drafts[Q.choice]).toEqual({ kind: "choice", index: 1 });
    expect(body.data.hintsOpened[Q.judge]).toEqual([
      { index: 0, text: "最小的正整数是 $1$。" },
    ]);
    expect(body.data.hintsOpened[Q.choice]).toBeUndefined();

    // 未解锁的提示内容（choice 题）绝不出现；键名级断言照常通过
    const text = JSON.stringify(body);
    expect(text).not.toContain("大于 $0$ 的自然数是正整数。");
    assertNoLeak(body);

    // 讲练卷流经的通用作答接口（详情草稿视图 / 取卷）同样零题块原文：
    // 讲义 markdown 从不进入这些路径，钉住「任何学生端响应」口径
    const detail = await env.app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: env.memberCookie },
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    assertNoLeak(detailBody);
    assertNoQuestionBlockText(detailBody);
    const paper = await env.app.request(
      `/api/student/attempts/${attemptId}/paper`,
      { headers: { cookie: env.memberCookie } },
    );
    expect(paper.status).toBe(200);
    const paperBody = await paper.json();
    assertNoLeak(paperBody);
    assertNoQuestionBlockText(paperBody);
  });

  it("冻结语义：开卷后教师改题库，再次 start 返回的题目内容不变（快照冻结）", async () => {
    const env = await makeEnv();
    const first = await startOk(env);
    const before = first.data.questions.find((q) => q.id === Q.choice);

    // 教师直接改题库行（模拟题库编辑）
    env.db
      .update(questions)
      .set({ stemMd: "教师改后的题干：完全不同的内容" })
      .where(eq(questions.id, Q.choice))
      .run();

    const second = await startOk(env);
    const after = second.data.questions.find((q) => q.id === Q.choice);
    expect(after?.stemMd).toBe(before?.stemMd);
    expect(after?.stemMd).toContain("下列是正整数的是：");
    expect(after?.stemMd).not.toContain("教师改后的题干");
  });

  it("访问控制（三分谓词同 getStudentLecture）：非成员带 courseId 403；非成员无上下文 404；不存在 404", async () => {
    const env = await makeEnv();

    const denied = await restartOrStartError(
      await startLesson(env, env.outsiderCookie, env.courseId),
    );
    expect(denied.status).toBe(403);
    expect(denied.error).toBe("COURSE_ACCESS_DENIED");

    const outsiderNoCourse = await restartOrStartError(
      await startLesson(env, env.outsiderCookie),
    );
    expect(outsiderNoCourse.status).toBe(404);
    expect(outsiderNoCourse.error).toBe("NOT_FOUND");

    const missing = await env.app.request(
      "/api/student/lectures/0d6a07f0-0000-4000-8000-000000000000/lesson/start",
      { method: "POST", headers: { cookie: env.memberCookie } },
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErr).error).toBe("NOT_FOUND");
  });

  it("条目隐藏后 404；纯讲义（kind=lecture）不是讲练页 404", async () => {
    const env = await makeEnv();

    // 隐藏讲练页条目 → 404（D22 不暴露存在性）
    const detail = await env.app.request(
      `/api/teacher/courses/${env.courseId}`,
      {
        headers: { cookie: env.teacherCookie },
      },
    );
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === env.lectureId);
    expect(item).toBeDefined();
    const patched = await env.app.request(
      `/api/teacher/course-items/${item?.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ visible: false }),
      },
    );
    expect(patched.status).toBe(200);
    const hidden = await startLesson(env);
    expect(hidden.status).toBe(404);
    expect(((await hidden.json()) as ApiErr).error).toBe("NOT_FOUND");

    // 纯讲义（kind=lecture）：讲练开卷入口不存在（404）
    const env2 = await makeEnv({ markdown: LECTURE_ONLY_MD });
    const lectureKind = await startLesson(env2);
    expect(lectureKind.status).toBe(404);
    expect(((await lectureKind.json()) as ApiErr).error).toBe("NOT_FOUND");
  });

  it("未登录 401；query courseId 非法 400", async () => {
    const env = await makeEnv();
    const anon = await env.app.request(
      `/api/student/lectures/${env.lectureId}/lesson/start`,
      { method: "POST" },
    );
    expect(anon.status).toBe(401);

    const bad = await startLesson(env, env.memberCookie, "not-a-uuid");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });
});

/** 错误响应的统一解包（status + 契约壳校验） */
async function restartOrStartError(res: Response): Promise<{
  status: number;
  error: string;
}> {
  const body = (await res.json()) as ApiErr;
  expect(apiErrSchema.safeParse(body).success).toBe(true);
  return { status: res.status, error: body.error };
}

describe("泄露矩阵：released 只含已提交题（AGENTS.md 规则 3 核心面）", () => {
  it("已单题提交的题进 released（含教师已批的当前行值）；未提交题的投影零泄露", async () => {
    const env = await makeEnv();
    await startOk(env);

    // 造一行「已单题提交 + 教师课中已批」的数据（单题提交接口在下一单接入）
    const now = new Date().toISOString();
    env.db
      .update(responses)
      .set({
        submittedAt: now,
        autoCorrect: true,
        finalCorrect: true,
        teacherMark: "correct",
      })
      .where(eq(responses.questionId, Q.choice))
      .run();

    const body = await startOk(env);
    // released 只含已提交的 choice 题
    expect(Object.keys(body.data.released)).toEqual([Q.choice]);
    const releasedChoice = body.data.released[Q.choice];
    expect(releasedChoice?.autoCorrect).toBe(true);
    expect(releasedChoice?.teacherMark).toBe("correct"); // 进行中卷教师已批 → 读当前行值
    expect(releasedChoice?.finalCorrect).toBe(true);
    expect(releasedChoice?.snapshot.stemMd).not.toContain("[["); // 学生端题干投影

    // 已提交题携带参考答案/详解（当题已释放）——allow 放行后整壳仍无其余泄露键
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });
    assertNoStemLeak(body);

    // 未提交题（judge）的公开投影单独过键名断言：零答案/详解/提示内容
    const judgeProjection = body.data.questions.filter((q) => q.id === Q.judge);
    assertNoLeak(judgeProjection);
    // 未提交题的详解/提示原文绝不出现（judge 题从未解锁提示）
    const text = JSON.stringify(body);
    expect(text).not.toContain(
      "$0$ 既不是正数也不是负数；最小的正整数是 $1$。",
    );
    expect(text).not.toContain("大于 $0$ 的自然数是正整数。");

    // 进行中 summary：已提交题计入对错、未提交计入 unanswered（本题提交时未
    // 填答案 → 按契约 answer 口径不计 answered）
    expect(body.data.summary).toMatchObject({
      total: 2,
      answered: 0,
      correct: 1,
      wrong: 0,
      pending: 0,
      unanswered: 2,
      scoreFinal: null, // attempt 级得分只在离开 draft 时写（下一单）
      pendingCount: 0, // finalCorrect 已定（教师已批）
    });
  });

  it("lesson 讲义详情：markdown 恒 null、blocks 切段、companionUnits 恒空、全响应无题块原文", async () => {
    const env = await makeEnv();
    const res = await env.app.request(
      `/api/student/lectures/${env.lectureId}`,
      {
        headers: { cookie: env.memberCookie },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        kind: string;
        markdown: string | null;
        blocks: { type: string; questionId?: string }[];
        companionUnits: unknown[];
        courseId: string;
      };
    };
    expect(studentLectureDetailOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.kind).toBe("lesson");
    expect(body.data.markdown).toBeNull();
    expect(body.data.blocks.map((b) => b.type)).toEqual([
      "md",
      "question",
      "md",
      "question",
      "md",
    ]);
    expect(body.data.blocks[1]).toEqual({
      type: "question",
      questionId: Q.choice,
    });
    expect(body.data.companionUnits).toEqual([]);
    expect(body.data.courseId).toBe(env.courseId);

    // 泄露：详情不得出现任何题目侧字段（题目投影只经开卷接口下发）
    assertNoLeak(body, { forbid: ["stemMd", "questions"] });
    assertNoQuestionBlockText(body);
  });
});

describe("POST /api/student/lectures/:id/lesson/restart（再做一次，显式独立动作）", () => {
  it("无作答 409；进行中 409 ALREADY_SUBMITTED", async () => {
    const env = await makeEnv();

    const none = await restartOrStartError(await restartLesson(env));
    expect(none.status).toBe(409);
    expect(none.error).toBe("ALREADY_SUBMITTED");

    await startOk(env);
    const inProgress = await restartOrStartError(await restartLesson(env));
    expect(inProgress.status).toBe(409);
    expect(inProgress.error).toBe("ALREADY_SUBMITTED");
  });

  it("已完成：201 新卷 attemptNo+1、从空白开始；start 幂等取回新 draft；两卷各记一条 attempt_start", async () => {
    const env = await makeEnv();
    const first = await startOk(env);
    const attemptId = first.data.attempt.id;

    // 造「已完成」终态：全部行已提交 + attempt graded（收尾链路在下一单接入）
    const now = new Date().toISOString();
    env.db
      .update(responses)
      .set({ submittedAt: now, autoCorrect: true, finalCorrect: true })
      .where(eq(responses.attemptId, attemptId))
      .run();
    env.db
      .update(attempts)
      .set({
        status: "graded",
        submittedAt: now,
        scoreAuto: 100,
        scoreFinal: 100,
      })
      .where(eq(attempts.id, attemptId))
      .run();

    // 已完成后再 start：返回最新那份（绝不重开，方案决策 7）
    const completed = await startOk(env);
    expect(completed.data.attempt.id).toBe(attemptId);
    expect(completed.data.attempt.status).toBe("graded");
    expect(Object.keys(completed.data.released).sort()).toEqual(
      [Q.choice, Q.judge].sort(),
    );
    expect(completed.data.summary?.scoreFinal).toBe(100);

    // restart：新卷 attemptNo+1、draft、空白（无草稿/已释放题）
    const restarted = await restartLesson(env);
    expect(restarted.status).toBe(201);
    const restartBody = (await restarted.json()) as StartBody;
    expect(lessonStartOkSchema.safeParse(restartBody).success).toBe(true);
    expect(restartBody.data.attempt.attemptNo).toBe(2);
    expect(restartBody.data.attempt.status).toBe("draft");
    expect(restartBody.data.attempt.id).not.toBe(attemptId);
    expect(restartBody.data.attempt).toMatchObject({
      lectureId: env.lectureId,
      sourceType: "lesson",
    });
    expect(restartBody.data.drafts).toEqual({});
    expect(restartBody.data.released).toEqual({});
    expect(restartBody.data.questions.map((q) => q.id)).toEqual([
      Q.choice,
      Q.judge,
    ]);

    // start 幂等取回 restart 的新 draft
    const after = await startOk(env);
    expect(after.data.attempt.id).toBe(restartBody.data.attempt.id);
    expect(after.data.attempt.attemptNo).toBe(2);

    // 事件：两个 attempt 各一条 attempt_start（建卷直记；幂等取回不重复）
    for (const id of [attemptId, restartBody.data.attempt.id]) {
      expect(
        env.db
          .select()
          .from(events)
          .where(eq(events.attemptId, id))
          .all()
          .filter((row) => row.type === "attempt_start"),
      ).toHaveLength(1);
    }
  });

  it("restart 守卫与访问控制同 start：非成员 404（无 courseId 上下文，D22 不暴露存在性）", async () => {
    const env = await makeEnv();
    const denied = await restartOrStartError(
      await restartLesson(env, env.outsiderCookie),
    );
    // restart 无 courseId 参数：非成员在任何课程都看不到该讲练页 → 404
    //（start 带 courseId 才走 403 分支，见上方访问控制用例）
    expect(denied.status).toBe(404);
    expect(denied.error).toBe("NOT_FOUND");
  });
});

describe("零题讲练页（LESSON_WITHOUT_QUESTION）开卷合法", () => {
  it("questions 空、blocks 纯 md、unitId 非空占位（契约 lesson 不变式）", async () => {
    const env = await makeEnv({ markdown: LESSON_NO_QUESTION_MD });
    const body = await startOk(env);

    expect(body.data.questions).toEqual([]);
    expect(body.data.blocks.length).toBeGreaterThan(0);
    expect(body.data.blocks.every((b) => b.type === "md")).toBe(true);
    expect(body.data.blocks[0]?.md).toContain("# 只有正文的讲练页");
    // 无嵌入单元：unitId 落讲义 id 非空占位（该卷无题目行，unitId 无功能消费方）
    expect(typeof body.data.attempt.unitId).toBe("string");
    expect(body.data.attempt.unitId).not.toBe("");
    expect(body.data.lecture.topic).toBeNull();
    expect(body.data.summary).toMatchObject({ total: 0, unanswered: 0 });
    assertNoLeak(body);
    assertNoQuestionBlockText(body);
  });
});
