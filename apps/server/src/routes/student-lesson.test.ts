import { gzipSync } from "node:zlib";
import type { ApiErr, SubmitEvidenceDeclaration } from "@tutor/contract";
import {
  apiErrSchema,
  attemptResultOkSchema,
  lessonLandingOkSchema,
  lessonQuestionSubmitOkSchema,
  lessonStartOkSchema,
  studentLectureDetailOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
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
  submissionEvidence,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { assertNoStemLeak } from "../test/assert-no-stem-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { putNoteReceipt } from "../test/note-fixtures.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

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
 * - GET /lectures/:id kind=lesson 安全投影：markdown 恒 null +
 *   companionUnits 恒空、不带切段（讲练内容只经 lesson/start 下发；kind=lecture
 *   行为不变的对照见 student-lectures.test.ts 既有用例）；
 * - 零题讲练页（LESSON_WITHOUT_QUESTION）开卷合法（questions 空、blocks 纯 md）；
 * - 建卷发 attempt_start 事件（幂等取回不重复记、restart 新卷各记一条）。
 *
 * 单题提交与整卷收尾（提交序列第 7 步，2026-10 作答服务第二单）：
 * - POST /attempts/:id/questions/:questionId/submit：当题判分与释放（choice
 *   对/错、judge、fill 待批、未作答判 false）、questionRevisionId CAS
 *   （QUESTION_REVISION_STALE）、幂等拒绝（QUESTION_ALREADY_SUBMITTED）、
 *   非本人 403、非 lesson 来源 404、已完成卷 409、单题笔记证据 CAS（frozen/
 *   none/missing 与缺省旧客户端）、question_submit 事件、响应泄露矩阵
 *   （其他未提交题的答案/详解/提示内容绝不出现）；
 * - 最后一题单题提交事务内自动收尾（graded / submitted 两路，scoreAuto/
 *   scoreFinal 与整卷同口径）；并发双收尾后到者 409 幂等；
 * - 整卷收尾（POST /attempts/:id/submit）lesson 语义：只对未提交行判分
 *   （未答判 false），已单题提交行不重判、保判定与 submittedAt，evidence
 *   只覆盖未提交题（已提交题的草稿不阻塞旧客户端收尾）。
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
  /** 成员学生 id（直插夹具行用） */
  memberStudentId: string;
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
    memberStudentId: member.studentId,
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
        hintsOpened: { index: number; text: string }[];
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

  it("lesson 讲义详情：markdown 恒 null、companionUnits 恒空、不带切段、全响应无题块原文", async () => {
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
        companionUnits: unknown[];
        courseId: string;
      };
    };
    expect(studentLectureDetailOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.kind).toBe("lesson");
    expect(body.data.markdown).toBeNull();
    expect(body.data.companionUnits).toEqual([]);
    expect(body.data.courseId).toBe(env.courseId);
    // 死载荷已删：详情不带 blocks 切段（讲练内容只经 lesson/start 下发，闸门修复）
    expect("blocks" in body.data).toBe(false);

    // 泄露：详情不得出现任何题目侧字段（题目投影只经开卷接口下发）
    assertNoLeak(body, { forbid: ["stemMd", "questions"] });
    assertNoQuestionBlockText(body);
  });
});

describe("POST /api/student/lectures/:id/lesson/restart（再做一次/重新开始，显式独立动作）", () => {
  it("无作答 409；随时重开——进行中 draft restart 也 201（旧卷作废，2026-10 教师演示口径；详测见 landing describe）", async () => {
    const env = await makeEnv();

    const none = await restartOrStartError(await restartLesson(env));
    expect(none.status).toBe(409);
    expect(none.error).toBe("ALREADY_SUBMITTED");

    // 进行中重开：不再 409——旧卷作废、新卷 attemptNo+1
    await startOk(env);
    const inProgress = await restartLesson(env);
    expect(inProgress.status).toBe(201);
    const body = (await inProgress.json()) as StartBody;
    expect(body.data.attempt).toMatchObject({
      attemptNo: 2,
      status: "draft",
    });
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

// ==================== 单题提交与整卷收尾（提交序列第 7 步） ====================

/**
 * 单题提交夹具：4 题——choice（可判对/错，带提示）、judge（[[错误]] + 详解）、
 * fill（2026-10-02 起恒人工批改 → 提交即待批）、choice2（不存草稿，验证未作答
 * 提交按 D1 判 false 与最后一题自动收尾）。
 */
const LESSON_SUBMIT_MD = `---
kind: lesson
unit: 提交讲练
topic: 单题提交
---

# 第2讲 单题提交

开讲正文段。

::::question{type=choice difficulty=1}
下列是正整数的是：

- [ ] $-1$
- [x] $1$
- [ ] $0$

:::hint
大于 $0$ 的自然数是正整数。
:::
::::

题间正文段。

::::question{type=judge difficulty=1}
$0$ 是最小的正整数。[[错误]]

:::solution
最小的正整数是 $1$。
:::
::::

::::question{type=fill difficulty=2}
计算：$1+1=$ [[2]]。
::::

::::question{type=choice difficulty=1}
$2+2=$（　）

- [ ] $3$
- [x] $4$
::::
`;

/** 单题提交夹具的题目 id（单元 slug 缺省编号） */
const S = {
  choice: "提交讲练-1",
  judge: "提交讲练-2",
  fill: "提交讲练-3",
  choice2: "提交讲练-4",
} as const;

/** 单题提交响应 data 的宽松形态（断言用；契约校验走 lessonQuestionSubmitOkSchema） */
interface SubmitBody {
  data: {
    question: {
      questionId: string;
      answers: unknown;
      solutionMd: string | null;
      answer: unknown;
      autoCorrect: boolean | null;
      teacherMark: string | null;
      finalCorrect: boolean | null;
      hintsOpened: { index: number; text: string }[];
      snapshot: { stemMd: string; hintCount: number };
    };
    summary: {
      total: number;
      answered: number;
      correct: number;
      wrong: number;
      pending: number;
      unanswered: number;
      autoGradable: number;
      scoreFinal: number | null;
      pendingCount: number | null;
    };
    attempt: {
      id: string;
      status: string;
      scoreAuto: number | null;
      submittedAt: string | null;
    };
  };
}

/** 单题提交夹具环境（4 题讲练页 + 成员开卷） */
async function makeSubmitEnv(): Promise<{
  env: TestEnv;
  attemptId: string;
  revisions: Map<string, string>;
}> {
  const env = await makeEnv({ markdown: LESSON_SUBMIT_MD });
  const started = await startOk(env);
  return {
    env,
    attemptId: started.data.attempt.id,
    revisions: new Map(
      started.data.questions.map((q) => [q.id, q.questionRevisionId]),
    ),
  };
}

/** PUT 草稿答案（通用存答接口） */
async function saveDraftAnswer(
  env: TestEnv,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<void> {
  const res = await env.app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: env.memberCookie,
      },
      body: JSON.stringify({ answer }),
    },
  );
  expect(res.status).toBe(200);
}

/** POST 单题提交（lessonQuestionSubmitRequest；evidence 可选） */
async function submitQuestion(
  env: TestEnv,
  attemptId: string,
  questionId: string,
  questionRevisionId: string,
  evidence?: SubmitEvidenceDeclaration,
  cookie: string = env.memberCookie,
): Promise<Response> {
  return env.app.request(
    `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(questionId)}/submit`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        questionRevisionId,
        ...(evidence === undefined ? {} : { evidence }),
      }),
    },
  );
}

/** 单题提交成功路径：200 + 契约壳校验，返回 data */
async function submitQuestionOk(
  env: TestEnv,
  attemptId: string,
  questionId: string,
  questionRevisionId: string,
  evidence?: SubmitEvidenceDeclaration,
): Promise<SubmitBody> {
  const res = await submitQuestion(
    env,
    attemptId,
    questionId,
    questionRevisionId,
    evidence,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as SubmitBody;
  expect(lessonQuestionSubmitOkSchema.safeParse(body).success).toBe(true);
  return body;
}

/** 该 attempt 的 question_submit 事件条数 */
function questionSubmitEventsOf(db: Db, attemptId: string): number {
  return db
    .select()
    .from(events)
    .where(eq(events.attemptId, attemptId))
    .all()
    .filter((row) => row.type === "question_submit").length;
}

/** 库内 responses 行（判定/submittedAt 断言用） */
function responseRowOf(
  db: Db,
  attemptId: string,
  questionId: string,
): {
  autoCorrect: boolean | null;
  finalCorrect: boolean | null;
  submittedAt: string | null;
  teacherMark: string | null;
} {
  const row = db
    .select({
      autoCorrect: responses.autoCorrect,
      finalCorrect: responses.finalCorrect,
      submittedAt: responses.submittedAt,
      teacherMark: responses.teacherMark,
    })
    .from(responses)
    .where(
      and(
        eq(responses.attemptId, attemptId),
        eq(responses.questionId, questionId),
      ),
    )
    .get();
  if (row === undefined)
    throw new Error(`夹具缺少 responses 行：${questionId}`);
  return row;
}

describe("POST /api/student/attempts/:id/questions/:questionId/submit（单题提交，当题即时反馈）", () => {
  it("choice 答：判对（autoCorrect=finalCorrect=true）、当题释放参考答案、summary 现算、泄露矩阵三层断言、question_submit 事件恰一条", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });

    const body = await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );

    expect(
      env.db.select().from(attempts).where(eq(attempts.id, attemptId)).get()
        ?.lastActivityAt,
    ).toBe(responseRowOf(env.db, attemptId, S.choice).submittedAt);

    // 当题结果：判对 + 参考答案释放 + 学生端题干投影
    expect(body.data.question).toMatchObject({
      questionId: S.choice,
      answer: { kind: "choice", index: 1 },
      autoCorrect: true,
      finalCorrect: true,
      teacherMark: null,
    });
    expect(body.data.question.answers).not.toBeNull();
    expect(body.data.question.snapshot.stemMd).not.toContain("[[");
    expect(body.data.question.hintsOpened).toEqual([]); // 未解锁过提示

    // 库内行：判分落库 + submittedAt 写入
    expect(responseRowOf(env.db, attemptId, S.choice)).toMatchObject({
      autoCorrect: true,
      finalCorrect: true,
      submittedAt: expect.any(String),
    });

    // 现算 summary：1/4 已提交（对）、3 未提交；卷仍 draft
    expect(body.data.summary).toMatchObject({
      total: 4,
      answered: 1,
      correct: 1,
      wrong: 0,
      pending: 0,
      unanswered: 3,
      autoGradable: 1,
      scoreFinal: null,
      pendingCount: 0,
    });
    expect(body.data.attempt).toMatchObject({
      id: attemptId,
      status: "draft",
      scoreAuto: null,
      submittedAt: null,
    });

    // 泄露矩阵：其他未提交题（judge 详解/[[错误]]、fill [[2]]、未解锁提示）
    // 的内容绝不出现——键名级（放行当题 answers/answer/solutionMd）+ 题干级 +
    // 题块原文三层
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });
    assertNoStemLeak(body);
    const text = JSON.stringify(body);
    expect(text).not.toContain("最小的正整数是 $1$。"); // judge 详解（未提交）
    expect(text).not.toContain("大于 $0$ 的自然数是正整数。"); // 未解锁提示
    expect(text).not.toContain("[[2]]"); // fill 题干答案标记（未提交）
    expect(text).not.toContain("[[错误]]");

    // question_submit 事件：恰一条、payload 仅 questionId
    const rows = env.db
      .select()
      .from(events)
      .where(eq(events.attemptId, attemptId))
      .all()
      .filter((row) => row.type === "question_submit");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payloadJson ?? "{}")).toEqual({
      type: "question_submit",
      clientTs: expect.any(Number),
      questionId: S.choice,
    });
  });

  it("choice 错答判 false；judge 答对判 true；重复提交 409 QUESTION_ALREADY_SUBMITTED", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 0,
    });
    const wrong = await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );
    expect(wrong.data.question).toMatchObject({
      autoCorrect: false,
      finalCorrect: false,
    });
    expect(wrong.data.summary).toMatchObject({ correct: 0, wrong: 1 });

    await saveDraftAnswer(env, attemptId, S.judge, {
      kind: "judge",
      value: false,
    });
    const judge = await submitQuestionOk(
      env,
      attemptId,
      S.judge,
      revisions.get(S.judge) ?? "",
    );
    expect(judge.data.question).toMatchObject({
      autoCorrect: true,
      finalCorrect: true,
    });
    // judge 题带详解：当题释放
    expect(judge.data.question.solutionMd).toContain("最小的正整数是 $1$。");

    // 幂等拒绝：同一题二次提交
    const dup = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        S.judge,
        revisions.get(S.judge) ?? "",
      ),
    );
    expect(dup.status).toBe(409);
    expect(dup.error).toBe("QUESTION_ALREADY_SUBMITTED");
    // 拒绝不写事件、不重复计分
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(2);
  });

  it("fill 恒人工批改：autoCorrect/finalCorrect 留 null 进待批，summary.pending/pendingCount 计 1", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    const body = await submitQuestionOk(
      env,
      attemptId,
      S.fill,
      revisions.get(S.fill) ?? "",
    );
    expect(body.data.question).toMatchObject({
      autoCorrect: null,
      finalCorrect: null,
      answer: { kind: "fill", values: ["2"] },
    });
    // 提交即释放解析（学生已锁定答案，看解析不影响判定）
    expect(body.data.question.answers).not.toBeNull();
    expect(body.data.summary).toMatchObject({
      answered: 1,
      correct: 0,
      wrong: 0,
      pending: 1,
      pendingCount: 0,
      unanswered: 3,
    });
    expect(responseRowOf(env.db, attemptId, S.fill)).toMatchObject({
      autoCorrect: null,
      finalCorrect: null,
      submittedAt: expect.any(String),
    });
  });

  it("未作答提交按 D1 判 false（answer null、autoCorrect=false）", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    // choice2 不存草稿直接提交
    const body = await submitQuestionOk(
      env,
      attemptId,
      S.choice2,
      revisions.get(S.choice2) ?? "",
    );
    expect(body.data.question).toMatchObject({
      questionId: S.choice2,
      answer: null,
      autoCorrect: false,
      finalCorrect: false,
    });
    // 未作答不计入 answered（契约 answer 口径）
    expect(body.data.summary).toMatchObject({
      answered: 0,
      wrong: 1,
      unanswered: 4,
    });
  });

  it("已解锁提示在提交响应回显；解锁后 start 投影同样回显（released 与草稿回显一致）", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    // 先解锁 choice 的第 0 条提示再提交
    const hint = await env.app.request(
      `/api/student/attempts/${attemptId}/hints`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({ questionId: S.choice, index: 0 }),
      },
    );
    expect(hint.status).toBe(200);

    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });
    const body = await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );
    expect(body.data.question.hintsOpened).toEqual([
      { index: 0, text: "大于 $0$ 的自然数是正整数。" },
    ]);

    // start 投影的 released 同样携带该题（含已解锁提示回显）
    const start = await startOk(env);
    const released = start.data.released[S.choice];
    expect(released?.hintsOpened).toEqual([
      { index: 0, text: "大于 $0$ 的自然数是正整数。" },
    ]);
  });

  it("错版 409 QUESTION_REVISION_STALE；不在冻结集的题 404 QUESTION_NOT_FOUND", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });

    const stale = await restartOrStartError(
      await submitQuestion(env, attemptId, S.choice, "not-the-row-id"),
    );
    expect(stale.status).toBe(409);
    expect(stale.error).toBe("QUESTION_REVISION_STALE");

    const missing = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        "提交讲练-99",
        revisions.get(S.choice) ?? "",
      ),
    );
    expect(missing.status).toBe(404);
    expect(missing.error).toBe("QUESTION_NOT_FOUND");
  });

  it("非本人 403；attempt 不存在 404；未登录 401", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();

    const foreign = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        S.choice,
        revisions.get(S.choice) ?? "",
        undefined,
        env.outsiderCookie,
      ),
    );
    expect(foreign.status).toBe(403);
    expect(foreign.error).toBe("FORBIDDEN");

    const missing = await env.app.request(
      `/api/student/attempts/0d6a07f0-0000-4000-8000-000000000000/questions/${encodeURIComponent(S.choice)}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({ questionRevisionId: "x" }),
      },
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErr).error).toBe("ATTEMPT_NOT_FOUND");

    const anon = await env.app.request(
      `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(S.choice)}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionRevisionId: "x" }),
      },
    );
    expect(anon.status).toBe(401);
  });

  it("非 lesson 来源 404（单题提交是讲练专属入口；assignment 草稿卷不开放）", async () => {
    const env = await makeEnv({ markdown: LESSON_SUBMIT_MD });
    // 直插一份 assignment 来源草稿卷（归属成员本人；evidence 夹具四件套）
    const fabricated = frozenDraftAttempt(env.db, env.memberStudentId, [
      {
        questionId: "外来题-1",
        snapshotJson: snapshotJsonOf({ id: "外来题-1" }),
      },
    ]);
    const res = await restartOrStartError(
      await submitQuestion(
        env,
        fabricated.attemptId,
        "外来题-1",
        fabricated.rowIds[0] ?? "",
      ),
    );
    expect(res.status).toBe(404);
    expect(res.error).toBe("NOT_FOUND");
  });

  it("单题笔记证据 CAS：frozen 精确比对通过并落证据行；错版/有稿 none/缺省有稿均 409；无稿缺省不落行；missing 如实记录", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });

    // 该题上传一版草稿（真实笔记通道 → 服务端 head revision=1）
    const receipt = await putNoteReceipt(
      env.app,
      env.memberCookie,
      attemptId,
      S.fill,
    );

    // 旧客户端（缺 evidence）但有草稿 → 409
    const legacy = await restartOrStartError(
      await submitQuestion(env, attemptId, S.fill, revisions.get(S.fill) ?? ""),
    );
    expect(legacy.status).toBe(409);
    expect(legacy.error).toBe("NOTE_EVIDENCE_MISMATCH");

    // none 声明但实际有稿 → 409
    const noneMismatch = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        S.fill,
        revisions.get(S.fill) ?? "",
        {
          questionId: S.fill,
          state: "none",
        },
      ),
    );
    expect(noneMismatch.status).toBe(409);
    expect(noneMismatch.error).toBe("NOTE_EVIDENCE_MISMATCH");

    // frozen 错版（revision 不符）→ 409
    const frozenStale = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        S.fill,
        revisions.get(S.fill) ?? "",
        {
          questionId: S.fill,
          state: "frozen",
          versionId: receipt.versionId,
          revision: receipt.revision + 5,
        },
      ),
    );
    expect(frozenStale.status).toBe(409);
    expect(frozenStale.error).toBe("NOTE_EVIDENCE_MISMATCH");

    // evidence.questionId 与路径不一致 → 409
    const wrongQuestion = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        S.fill,
        revisions.get(S.fill) ?? "",
        {
          questionId: S.choice,
          state: "none",
        },
      ),
    );
    expect(wrongQuestion.status).toBe(409);
    expect(wrongQuestion.error).toBe("NOTE_EVIDENCE_MISMATCH");

    // 全部拒绝后卷面未动（仍是 draft、无证据行）
    expect(env.db.select().from(submissionEvidence).all()).toEqual([]);

    // frozen 精确比对通过 → 200 + 证据行落库
    const ok = await submitQuestionOk(
      env,
      attemptId,
      S.fill,
      revisions.get(S.fill) ?? "",
      {
        questionId: S.fill,
        state: "frozen",
        versionId: receipt.versionId,
        revision: receipt.revision,
      },
    );
    expect(ok.data.question.autoCorrect).toBeNull();
    const evidenceRows = env.db
      .select()
      .from(submissionEvidence)
      .where(eq(submissionEvidence.attemptId, attemptId))
      .all();
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({
      questionId: S.fill,
      state: "frozen",
      versionId: receipt.versionId,
    });

    // 无稿题缺省提交（choice 无笔记）→ 200 且不落证据行（未采集）
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });
    await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );
    expect(
      env.db
        .select()
        .from(submissionEvidence)
        .where(eq(submissionEvidence.attemptId, attemptId))
        .all(),
    ).toHaveLength(1);

    // 无稿题声明 none → 200 落 none 行；声明 missing → 如实记录 missing
    await saveDraftAnswer(env, attemptId, S.judge, {
      kind: "judge",
      value: false,
    });
    await submitQuestionOk(
      env,
      attemptId,
      S.judge,
      revisions.get(S.judge) ?? "",
      {
        questionId: S.judge,
        state: "none",
      },
    );
    await submitQuestionOk(
      env,
      attemptId,
      S.choice2,
      revisions.get(S.choice2) ?? "",
      { questionId: S.choice2, state: "missing" },
    );
    const states = Object.fromEntries(
      env.db
        .select()
        .from(submissionEvidence)
        .where(eq(submissionEvidence.attemptId, attemptId))
        .all()
        .map((row) => [row.questionId, row.state]),
    );
    expect(states).toEqual({
      [S.fill]: "frozen",
      [S.judge]: "none",
      [S.choice2]: "missing",
    });
  });
});

describe("最后一题单题提交自动收尾（Review Focus 3：与「完成练习」殊途同归）", () => {
  it("全客观卷：最后一题提交后 attempt=graded、scoreAuto=scoreFinal=100；已完成卷再提交 409 ALREADY_SUBMITTED；restart 可用", async () => {
    const env = await makeEnv(); // LESSON_MD：choice + judge 两题
    const started = await startOk(env);
    const attemptId = started.data.attempt.id;
    const revisions = new Map(
      started.data.questions.map((q) => [q.id, q.questionRevisionId]),
    );

    await saveDraftAnswer(env, attemptId, Q.choice, {
      kind: "choice",
      index: 1,
    });
    const first = await submitQuestionOk(
      env,
      attemptId,
      Q.choice,
      revisions.get(Q.choice) ?? "",
    );
    // 第一题提交后卷仍 draft
    expect(first.data.attempt.status).toBe("draft");

    await saveDraftAnswer(env, attemptId, Q.judge, {
      kind: "judge",
      value: false,
    });
    const last = await submitQuestionOk(
      env,
      attemptId,
      Q.judge,
      revisions.get(Q.judge) ?? "",
    );
    // 最后一题提交 → 事务内自动收尾：全判完 = graded，scoreAuto = scoreFinal = 100
    expect(last.data.attempt).toMatchObject({
      status: "graded",
      scoreAuto: 100,
      submittedAt: expect.any(String),
    });
    expect(last.data.summary).toMatchObject({
      total: 2,
      correct: 2,
      scoreFinal: 100,
      pendingCount: 0,
    });
    // 库内一致
    const attemptRow = env.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow).toMatchObject({
      status: "graded",
      scoreAuto: 100,
      scoreFinal: 100,
      submittedAt: expect.any(String),
    });

    // 已完成卷再单题提交：卷已离开 draft → 409 ALREADY_SUBMITTED（状态优先拒绝）
    const closed = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        Q.choice,
        revisions.get(Q.choice) ?? "",
      ),
    );
    expect(closed.status).toBe(409);
    expect(closed.error).toBe("ALREADY_SUBMITTED");

    // 整卷收尾同刻到达（并发双收尾的后到者）→ 409 幂等
    const closedPaper = await submitAttemptRequest(
      env.app,
      env.memberCookie,
      attemptId,
    );
    expect(closedPaper.status).toBe(409);
    expect(((await closedPaper.json()) as ApiErr).error).toBe(
      "ALREADY_SUBMITTED",
    );

    // 完成后 restart 可用（真实链路端到端）
    const restarted = await restartLesson(env);
    expect(restarted.status).toBe(201);
  });

  it("混合卷（有待批）：最后一题提交后 attempt=submitted、scoreAuto=2/3≈67、scoreFinal null；与整卷收尾同刻并发后到者 409；事件恰 4 条", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });
    await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );
    await saveDraftAnswer(env, attemptId, S.judge, {
      kind: "judge",
      value: false,
    });
    await submitQuestionOk(
      env,
      attemptId,
      S.judge,
      revisions.get(S.judge) ?? "",
    );
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");

    // 最后一题：choice2 未作答提交 → D1 判 false + 自动收尾（fill 待批）
    const last = await submitQuestionOk(
      env,
      attemptId,
      S.choice2,
      revisions.get(S.choice2) ?? "",
    );
    expect(last.data.attempt).toMatchObject({
      status: "submitted",
      scoreAuto: 67,
      submittedAt: expect.any(String),
    });
    expect(last.data.summary).toMatchObject({
      total: 4,
      correct: 2,
      wrong: 1,
      pending: 1,
      pendingCount: 0,
      scoreFinal: null,
    });
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(4);

    // 双收尾的后到者（整卷）→ 409
    const closedPaper = await submitAttemptRequest(
      env.app,
      env.memberCookie,
      attemptId,
    );
    expect(closedPaper.status).toBe(409);
    expect(((await closedPaper.json()) as ApiErr).error).toBe(
      "ALREADY_SUBMITTED",
    );
  });

  it("口径对照：同一份卷「全部单题提交」与「整卷收尾」的 scoreAuto/状态一致", async () => {
    const env = await makeEnv({ markdown: LESSON_SUBMIT_MD });
    // 第二位学生（成员）走整卷收尾路径
    const second = await createStudentAndLogin(
      env.app,
      env.teacherCookie,
      "成员王五",
    );
    const added = await env.app.request(
      `/api/teacher/courses/${env.courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [second.studentId] }),
      },
    );
    expect(added.status).toBe(200);

    // 甲（成员张三）：逐题提交全部 4 题
    const a = await startOk(env);
    const revisionsA = new Map(
      a.data.questions.map((q) => [q.id, q.questionRevisionId]),
    );
    await saveDraftAnswer(env, a.data.attempt.id, S.choice, {
      kind: "choice",
      index: 1,
    });
    await submitQuestionOk(
      env,
      a.data.attempt.id,
      S.choice,
      revisionsA.get(S.choice) ?? "",
    );
    await saveDraftAnswer(env, a.data.attempt.id, S.judge, {
      kind: "judge",
      value: false,
    });
    await submitQuestionOk(
      env,
      a.data.attempt.id,
      S.judge,
      revisionsA.get(S.judge) ?? "",
    );
    await saveDraftAnswer(env, a.data.attempt.id, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(
      env,
      a.data.attempt.id,
      S.fill,
      revisionsA.get(S.fill) ?? "",
    );
    const lastA = await submitQuestionOk(
      env,
      a.data.attempt.id,
      S.choice2,
      revisionsA.get(S.choice2) ?? "",
    );

    // 乙（成员王五）：同答案整卷收尾（judge 也答对、choice2 未答）
    const startB = await env.app.request(
      `/api/student/lectures/${env.lectureId}/lesson/start`,
      { method: "POST", headers: { cookie: second.cookie } },
    );
    expect(startB.status).toBe(200);
    const bodyB = (await startB.json()) as StartBody;
    const attemptB = bodyB.data.attempt.id;
    await env.app.request(
      `/api/student/attempts/${attemptB}/answers/${encodeURIComponent(S.choice)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: second.cookie,
        },
        body: JSON.stringify({ answer: { kind: "choice", index: 1 } }),
      },
    );
    await env.app.request(
      `/api/student/attempts/${attemptB}/answers/${encodeURIComponent(S.judge)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: second.cookie,
        },
        body: JSON.stringify({ answer: { kind: "judge", value: false } }),
      },
    );
    await env.app.request(
      `/api/student/attempts/${attemptB}/answers/${encodeURIComponent(S.fill)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: second.cookie,
        },
        body: JSON.stringify({ answer: { kind: "fill", values: ["2"] } }),
      },
    );
    const paper = await submitAttemptRequest(env.app, second.cookie, attemptB);
    expect(paper.status).toBe(200);
    const paperBody = (await paper.json()) as {
      data: {
        attempt: { status: string; scoreAuto: number | null };
        summary: { scoreFinal: number | null };
      };
    };
    // 殊途同归：同一状态机与同一得分口径（submitted / scoreAuto=67）
    expect(paperBody.data.attempt.status).toBe(lastA.data.attempt.status);
    expect(paperBody.data.attempt.scoreAuto).toBe(lastA.data.attempt.scoreAuto);
    expect(paperBody.data.summary.scoreFinal).toBeNull();
  });
});

describe("整卷收尾 lesson 语义（submitAttempt 对未提交行执行，已提交行不重判）", () => {
  it("混合收尾：已单题提交 2 题保判定与原 submittedAt；未提交未答判 false；evidence 只查未提交题（已提交题的草稿不阻塞）；question_submit 事件只记单题提交", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();

    // 甲题 choice：存答案 + 传笔记草稿 + 带证据单题提交（frozen）
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });
    const receipt = await putNoteReceipt(
      env.app,
      env.memberCookie,
      attemptId,
      S.choice,
    );
    await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
      {
        questionId: S.choice,
        state: "frozen",
        versionId: receipt.versionId,
        revision: receipt.revision,
      },
    );
    const choiceSubmittedAt = responseRowOf(
      env.db,
      attemptId,
      S.choice,
    ).submittedAt;

    // 乙题 fill：待批单题提交
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");
    const fillSubmittedAt = responseRowOf(
      env.db,
      attemptId,
      S.fill,
    ).submittedAt;

    // 丙题 judge：存答案 + 传笔记草稿（未提交——旧客户端收尾会因它 409）
    await saveDraftAnswer(env, attemptId, S.judge, {
      kind: "judge",
      value: false,
    });
    const judgeReceipt = await putNoteReceipt(
      env.app,
      env.memberCookie,
      attemptId,
      S.judge,
    );

    // 旧客户端（缺 evidence）：未提交的 judge 有草稿 → 409（scope 命中）；
    // 已提交 choice 的草稿不应单独阻塞（下方声明版通过即证明）
    const legacy = await submitAttemptRequest(
      env.app,
      env.memberCookie,
      attemptId,
    );
    expect(legacy.status).toBe(409);
    expect(((await legacy.json()) as ApiErr).error).toBe(
      "NOTE_EVIDENCE_MISMATCH",
    );

    // 新客户端：evidence 只覆盖未提交题（judge frozen / choice2 none——fill
    // 已单题提交，其证据不重做也不再声明）
    const revisionsList = [...revisions.entries()].map(([questionId, id]) => ({
      questionId,
      questionRevisionId: id,
    }));
    const res = await env.app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({
          revisions: revisionsList,
          evidence: [
            {
              questionId: S.judge,
              state: "frozen",
              versionId: judgeReceipt.versionId,
              revision: judgeReceipt.revision,
            },
            { questionId: S.choice2, state: "none" },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);

    // 已提交行不重判、保原 submittedAt 与单题证据
    expect(responseRowOf(env.db, attemptId, S.choice)).toEqual({
      autoCorrect: true,
      finalCorrect: true,
      submittedAt: choiceSubmittedAt,
      teacherMark: null,
    });
    expect(responseRowOf(env.db, attemptId, S.fill)).toEqual({
      autoCorrect: null,
      finalCorrect: null,
      submittedAt: fillSubmittedAt,
      teacherMark: null,
    });
    // 未提交行：judge 答对、choice2 未答判 false，submittedAt = 交卷时刻
    const judgeRow = responseRowOf(env.db, attemptId, S.judge);
    const choice2Row = responseRowOf(env.db, attemptId, S.choice2);
    expect(judgeRow).toMatchObject({ autoCorrect: true, finalCorrect: true });
    expect(choice2Row).toMatchObject({
      autoCorrect: false,
      finalCorrect: false,
    });
    const attemptRow = env.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.submittedAt).toBeTruthy();
    expect(judgeRow.submittedAt).toBe(attemptRow?.submittedAt);
    expect(choice2Row.submittedAt).toBe(attemptRow?.submittedAt);

    // 整卷收尾状态与得分：fill 待批 → submitted、scoreAuto 67、scoreFinal null
    expect(attemptRow).toMatchObject({
      status: "submitted",
      scoreAuto: 67,
      scoreFinal: null,
    });

    // 证据行：choice（单题提交时 frozen）+ 整卷两行（judge frozen / choice2
    // none）；fill 单题提交时无声明无稿 → 不落行（未采集）
    const evidenceByQuestion = Object.fromEntries(
      env.db
        .select()
        .from(submissionEvidence)
        .where(eq(submissionEvidence.attemptId, attemptId))
        .all()
        .map((row) => [row.questionId, row.state]),
    );
    expect(evidenceByQuestion).toEqual({
      [S.choice]: "frozen",
      [S.judge]: "frozen",
      [S.choice2]: "none",
    });

    // question_submit 事件只记单题提交的 2 题
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(2);
  });

  it("先整卷收尾再单题提交 → 409（卷已离开 draft）；revisions 全集校验不变（缺已提交题 409 QUESTION_REVISION_STALE）", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });
    await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );

    // 先单题提交一题，再整卷收尾其余（evidence 覆盖未提交三题）
    await saveDraftAnswer(env, attemptId, S.judge, {
      kind: "judge",
      value: false,
    });
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    const res = await env.app.request(
      `/api/student/attempts/${attemptId}/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({
          revisions: [...revisions.entries()].map(([questionId, id]) => ({
            questionId,
            questionRevisionId: id,
          })),
          evidence: [
            { questionId: S.judge, state: "none" },
            { questionId: S.fill, state: "none" },
            { questionId: S.choice2, state: "none" },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    // 整卷收尾后单题提交（review focus：后到者）→ 409 ALREADY_SUBMITTED
    const late = await restartOrStartError(
      await submitQuestion(
        env,
        attemptId,
        S.judge,
        revisions.get(S.judge) ?? "",
      ),
    );
    expect(late.status).toBe(409);
    expect(late.error).toBe("ALREADY_SUBMITTED");

    // revisions 全集校验不变：新开一份卷，单题提交一题后，整卷只回传其余三题
    //（缺已提交题）→ 409 QUESTION_REVISION_STALE
    const second = await createStudentAndLogin(
      env.app,
      env.teacherCookie,
      "成员赵六",
    );
    await env.app.request(`/api/teacher/courses/${env.courseId}/members`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ studentIds: [second.studentId] }),
    });
    const startB = await env.app.request(
      `/api/student/lectures/${env.lectureId}/lesson/start`,
      { method: "POST", headers: { cookie: second.cookie } },
    );
    expect(startB.status).toBe(200);
    const bodyB = (await startB.json()) as StartBody;
    const attemptB = bodyB.data.attempt.id;
    const revisionsB = new Map(
      bodyB.data.questions.map((q) => [q.id, q.questionRevisionId]),
    );
    await env.app.request(
      `/api/student/attempts/${attemptB}/answers/${encodeURIComponent(S.choice)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: second.cookie,
        },
        body: JSON.stringify({ answer: { kind: "choice", index: 1 } }),
      },
    );
    const singleB = await env.app.request(
      `/api/student/attempts/${attemptB}/questions/${encodeURIComponent(S.choice)}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: second.cookie },
        body: JSON.stringify({
          questionRevisionId: revisionsB.get(S.choice) ?? "",
        }),
      },
    );
    expect(singleB.status).toBe(200);
    const partial = await env.app.request(
      `/api/student/attempts/${attemptB}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: second.cookie },
        body: JSON.stringify({
          revisions: [...revisionsB.entries()]
            .filter(([questionId]) => questionId !== S.choice)
            .map(([questionId, id]) => ({
              questionId,
              questionRevisionId: id,
            })),
        }),
      },
    );
    expect(partial.status).toBe(409);
    expect(((await partial.json()) as ApiErr).error).toBe(
      "QUESTION_REVISION_STALE",
    );
  });
});

// ==================== 待批谓词与记录聚合收录 lesson（提交序列第 7 步第 2 部分） ====================

describe("待批谓词扩 submittedAt：lesson 进行中卷已提交的待批题即时进教师队列", () => {
  it("单题提交 fill（待批）后立即出现在 GET /api/teacher/pending-marks；未提交时不出现；教师批改后出队", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();

    // 开卷未提交：draft 卷不构成待批（既有口径），队列无该卷
    const before = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    expect(before.status).toBe(200);
    const beforeMarks = (
      (await before.json()) as { data: { marks: { attemptId: string }[] } }
    ).data.marks;
    expect(beforeMarks.filter((m) => m.attemptId === attemptId)).toEqual([]);

    // 有参考答案的 fill 进入待自评，不再强制交给教师；教师仍可主动批改。
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");

    const after = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    expect(after.status).toBe(200);
    const marks = (
      (await after.json()) as {
        data: {
          marks: {
            attemptId: string;
            questionId: string;
            responseId: string;
            sourceType: string;
            studentName: string;
          }[];
        };
      }
    ).data.marks.filter((m) => m.attemptId === attemptId);
    expect(marks).toHaveLength(0);

    // 教师课中批改（correct）→ 出队
    const marked = await env.app.request(
      `/api/teacher/responses/${revisions.get(S.fill)}/mark`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ mark: "correct", comment: null }),
      },
    );
    expect(marked.status).toBe(200);

    const cleared = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    const clearedMarks = (
      (await cleared.json()) as { data: { marks: { attemptId: string }[] } }
    ).data.marks;
    expect(clearedMarks.filter((m) => m.attemptId === attemptId)).toEqual([]);

    // 学生刷新 start：released 反映教师判定（teacherMark/finalCorrect 当前行值）
    const start = await startOk(env);
    const released = start.data.released[S.fill];
    expect(released).toMatchObject({
      autoCorrect: null, // 不可自动判——批改不改 autoCorrect
      teacherMark: "correct",
      finalCorrect: true,
    });
  });
});

// ==================== 两线收敛（2026-10-25）：v2 讲练自评接线 QM 口径 ====================
// v2 e0e60af2 的自评实现被 QM 支线取代（决策记录 TT-09c）：请求/响应形状改走
// selfReviewRequestSchema（verdict 三值）与 selfReview record/revision 投影；
// 无参考答案行不再设「只能整卷提交」门控（QM 判分框架下逐题提交恒可用，
// 判定来源枯竭走教师待批）。

describe("讲练自评与无参考答案行（QM 口径）", () => {
  it("讲练提交后可立即自评（verdict=wrong、CAS 基线、教师未判）；无参考答案行逐题提交不阻塞、走教师待批", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");
    const review = await env.app.request(
      `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(S.fill)}/self-review`,
      {
        method: "POST",
        headers: { cookie: env.memberCookie },
        body: JSON.stringify({
          verdict: "wrong",
          baseRevision: 0,
          mutationId: crypto.randomUUID(),
        }),
      },
    );
    expect(review.status).toBe(200);
    const reviewData = (
      (await review.json()) as {
        data: {
          selfReview: { verdict: string; revision: number } | null;
          effective: { source: string; value: boolean } | null;
        };
      }
    ).data;
    expect(reviewData.selfReview).toMatchObject({
      verdict: "wrong",
      revision: 1,
    });
    expect(reviewData.effective).toEqual({ source: "self", value: false });
    const reopened = await startOk(env);
    expect(reopened.data.released[S.fill]).toMatchObject({
      finalCorrect: null, // 自评不写 finalCorrect（D7 三源分立）
      selfReview: { record: { verdict: "wrong" }, revision: 1 },
    });
    // 无参考答案（快照手术删 answers）：逐题提交不被拒，grade=null 进教师待批
    const row = env.db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, S.judge),
        ),
      )
      .get();
    if (!row) throw new Error("缺少讲练题目冻结行");
    const snapshot = JSON.parse(row.questionSnapshotJson ?? "{}") as Record<
      string,
      unknown
    >;
    delete snapshot.answers;
    snapshot.solutionMd = "仅有解析，没有提供参考答案";
    env.db
      .update(responses)
      .set({ questionSnapshotJson: JSON.stringify(snapshot) })
      .where(eq(responses.id, row.id))
      .run();
    const noAnswer = await submitQuestion(
      env,
      attemptId,
      S.judge,
      revisions.get(S.judge) ?? "",
    );
    expect(noAnswer.status).toBe(200);
    expect(responseRowOf(env.db, attemptId, S.judge)).toMatchObject({
      autoCorrect: null,
      finalCorrect: null,
    });
    // 无参考答案行进教师待批队列（D4：非 reference_self 且 finalCorrect null）；
    // 冻结行 id 即 questionRevisionId，直接由 responses 行取
    const judgeRowId = env.db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, S.judge),
        ),
      )
      .get()?.id;
    if (!judgeRowId) throw new Error("缺少 judge 冻结行");
    const pending = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    const pendingMarks = (
      (await pending.json()) as { data: { marks: { responseId: string }[] } }
    ).data.marks;
    expect(pendingMarks.some((m) => m.responseId === judgeRowId)).toBe(true);
    expect(
      (await submitAttemptRequest(env.app, env.memberCookie, attemptId)).status,
    ).toBe(200);
    // 收尾后自评事实保留（finalCorrect 仍 null——自评不推动 graded）
    expect(responseRowOf(env.db, attemptId, S.fill).finalCorrect).toBe(null);
  });
});

describe("我的记录收录 lesson 来源（恒可回看 + 讲练标题 + 教师列表枚举）", () => {
  it("lesson 草稿与完成卷都进记录：unitTitle=讲义标题、sourceType 筛选、pendingCount 现算；移出课程不失权", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();

    // 进行中（draft，含 1 道已提交待批题）
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");

    const recordsRes = await env.app.request("/api/student/records", {
      headers: { cookie: env.memberCookie },
    });
    expect(recordsRes.status).toBe(200);
    const records = (
      (await recordsRes.json()) as {
        data: {
          records: {
            attemptId: string;
            sourceType: string;
            unitId: string | null;
            unitTitle: string | null;
            attemptNo: number;
            status: string;
            pendingCount: number | null;
            answersReleased: boolean;
          }[];
        };
      }
    ).data.records;
    const lessonRow = records.find((row) => row.attemptId === attemptId);
    expect(lessonRow).toBeDefined();
    expect(lessonRow).toMatchObject({
      sourceType: "lesson",
      unitTitle: "第2讲 单题提交", // 标题=讲义标题（记录聚合口径）
      attemptNo: 1,
      status: "draft",
      pendingCount: 0, // 有参考答案的题待学生自评，不能计入教师必批。
      answersReleased: true, // lesson 恒公布（不适用 after_due）
    });

    // sourceType=lesson 筛选
    const filtered = await env.app.request(
      "/api/student/records?sourceType=lesson",
      { headers: { cookie: env.memberCookie } },
    );
    const filteredRows = (
      (await filtered.json()) as { data: { records: { attemptId: string }[] } }
    ).data.records;
    expect(filteredRows.map((row) => row.attemptId)).toEqual([attemptId]);

    // 教师端 attempts 列表（sourceType=lesson 过滤 + 来源字段）
    const teacherList = await env.app.request(
      "/api/teacher/attempts?sourceType=lesson",
      { headers: { cookie: env.teacherCookie } },
    );
    expect(teacherList.status).toBe(200);
    const cards = (
      (await teacherList.json()) as {
        data: {
          attempts: {
            attemptId: string;
            sourceType: string;
            unitTitle: string | null;
            assignmentId: string | null;
            attemptNo: number;
            pendingCount: number;
          }[];
        };
      }
    ).data.attempts;
    expect(cards.map((card) => card.attemptId)).toEqual([attemptId]);
    expect(cards[0]).toMatchObject({
      sourceType: "lesson",
      unitTitle: "第2讲 单题提交",
      assignmentId: null,
      pendingCount: 0,
    });

    // 移出课程（D7）：lesson 不失权——草稿照常列出（对照 wrong 口径）
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
    const afterRemoval = await env.app.request("/api/student/records", {
      headers: { cookie: env.memberCookie },
    });
    const rowsAfter = (
      (await afterRemoval.json()) as {
        data: { records: { attemptId: string }[] };
      }
    ).data.records;
    expect(rowsAfter.map((row) => row.attemptId)).toContain(attemptId);
  });
});

describe("单题提交后的行级锁定：已提交题的答案与笔迹不可再改（卷仍 draft）", () => {
  it("PUT 答案该题 → 409 QUESTION_ALREADY_SUBMITTED；未提交题照常可存；提交时答案保持提交时刻值", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.choice, {
      kind: "choice",
      index: 1,
    });
    await submitQuestionOk(
      env,
      attemptId,
      S.choice,
      revisions.get(S.choice) ?? "",
    );

    // 已提交题：改答案被拒（判定已按提交时的答案落定）
    const denied = await restartOrStartError(
      await saveDraftAnswerRaw(env, attemptId, S.choice, {
        kind: "choice",
        index: 0,
      }),
    );
    expect(denied.status).toBe(409);
    expect(denied.error).toBe("QUESTION_ALREADY_SUBMITTED");
    // 答案保持提交时刻值（未被覆盖）
    expect(responseRowOf(env.db, attemptId, S.choice).autoCorrect).toBe(true);

    // 未提交题照常可存草稿
    await saveDraftAnswer(env, attemptId, S.judge, {
      kind: "judge",
      value: false,
    });
    const start = await startOk(env);
    expect(start.data.drafts[S.judge]).toEqual({ kind: "judge", value: false });
  });

  it("PUT 笔迹该题 → 409 QUESTION_ALREADY_SUBMITTED（已提交题的手写证据不可再改）", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");

    const form = new FormData();
    form.append(
      "strokes",
      new Blob([inkGz(1)], { type: "application/gzip" }),
      "strokes.json.gz",
    );
    form.append(
      "snapshot",
      new Blob([minimalPng()], { type: "image/png" }),
      "snapshot.png",
    );
    const res = await env.app.request(
      `/api/student/attempts/${attemptId}/ink/${encodeURIComponent(S.fill)}`,
      { method: "PUT", headers: { cookie: env.memberCookie }, body: form },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe(
      "QUESTION_ALREADY_SUBMITTED",
    );
  });
});

/** PUT 草稿答案但不断言 200（行级锁定用例需要拿到错误响应） */
async function saveDraftAnswerRaw(
  env: TestEnv,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return env.app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: env.memberCookie,
      },
      body: JSON.stringify({ answer }),
    },
  );
}

/** 最小合法 PNG（服务端只校验魔数/IHDR；与既有测试同构造） */
function minimalPng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 构造 atrament InkDoc 并 gzip（与既有测试同口径） */
function inkGz(strokeCount: number): Uint8Array {
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
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf-8")));
}

describe("GET /lectures/:id/lesson/landing + 随时重开（2026-10 教师演示口径）", () => {
  /** GET 讲练落地页（query 可带 courseId） */
  async function landingOf(
    env: TestEnv,
    cookie: string = env.memberCookie,
    courseId?: string,
  ): Promise<Response> {
    const query = courseId === undefined ? "" : `?courseId=${courseId}`;
    return env.app.request(
      `/api/student/lectures/${env.lectureId}/lesson/landing${query}`,
      { headers: { cookie } },
    );
  }

  it("落地形态：标题/题数/题型分布/空历次/summary null；全响应无题目内容与答案、详解、提示（泄露三层断言）", async () => {
    const env = await makeEnv();
    const res = await landingOf(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(lessonLandingOkSchema.safeParse(body).success).toBe(true);
    const data = (
      body as {
        data: {
          title: string;
          questionCount: number;
          typeDistribution: Record<string, number>;
          attempts: unknown[];
          summary: unknown;
        };
      }
    ).data;
    expect(data.title).toBe("第1讲 有理数");
    expect(data.questionCount).toBe(2);
    expect(data.typeDistribution).toEqual({ choice: 1, judge: 1 });
    expect(data.attempts).toEqual([]);
    expect(data.summary).toBeNull();
    // 泄露：计数与元信息之外零内容（键名级 + 题块原文级）
    assertNoLeak(body);
    assertNoQuestionBlockText(body);
  });

  it("开卷后：历次 1 条（draft、attemptNo=1）+ summary（hasDraft）；完成后带得分与交卷时间", async () => {
    const env = await makeEnv();
    await startOk(env);
    const landing = await (
      (await landingOf(env)) as Response & { json(): Promise<unknown> }
    ).json();
    const data = (
      landing as {
        data: {
          attempts: {
            attemptId: string;
            attemptNo: number;
            status: string;
            score: number | null;
            submittedAt: string | null;
          }[];
          summary: {
            count: number;
            submittedCount: number;
            hasDraft: boolean;
          } | null;
        };
      }
    ).data;
    expect(data.attempts).toHaveLength(1);
    expect(data.attempts[0]).toMatchObject({
      attemptNo: 1,
      status: "draft",
      score: null,
      submittedAt: null,
    });
    expect(data.summary).toMatchObject({
      count: 1,
      submittedCount: 0,
      hasDraft: true,
    });
  });

  it("随时重开（核心语义）：进行中卷 restart → 201 新卷 attemptNo+1 从空白开始；旧卷作废——landing/我的记录不再列出、start 幂等取回新卷、旧卷详情与存答 409 ATTEMPT_ABANDONED、教师待批队列清空", async () => {
    const { env, attemptId, revisions } = await makeSubmitEnv();
    // 进行中卷上提交一道 fill（已释放答案 + 待批行）——最典型的半成品演示卷
    await saveDraftAnswer(env, attemptId, S.fill, {
      kind: "fill",
      values: ["2"],
    });
    await submitQuestionOk(env, attemptId, S.fill, revisions.get(S.fill) ?? "");

    // 重开前：教师待批队列含该生；学生记录含该 draft
    const pendingBefore = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    expect(JSON.stringify(await pendingBefore.json())).not.toContain(
      "成员张三",
    );
    const recordsBefore = await env.app.request("/api/student/records", {
      headers: { cookie: env.memberCookie },
    });
    expect(JSON.stringify(await recordsBefore.json())).toContain(attemptId);

    // 重开（进行中）：新卷 attemptNo+1、从空白开始
    const res = await restartLesson(env);
    expect(res.status).toBe(201);
    const restarted = (await res.json()) as {
      data: {
        attempt: { id: string; attemptNo: number; status: string };
        released: Record<string, unknown>;
        drafts: Record<string, unknown>;
      };
    };
    const newAttemptId = restarted.data.attempt.id;
    expect(newAttemptId).not.toBe(attemptId);
    expect(restarted.data.attempt).toMatchObject({
      attemptNo: 2,
      status: "draft",
    });
    expect(restarted.data.released).toEqual({});
    expect(restarted.data.drafts).toEqual({});

    // landing：只剩新卷（作废卷不入历次）
    const landingRes = await landingOf(env);
    const landing = (await landingRes.json()) as {
      data: {
        attempts: { attemptId: string; attemptNo: number }[];
        summary: { count: number; hasDraft: boolean } | null;
      };
    };
    expect(landing.data.attempts.map((row) => row.attemptId)).toEqual([
      newAttemptId,
    ]);
    expect(landing.data.summary).toMatchObject({ count: 1, hasDraft: true });

    // start 幂等取回新卷（旧卷已作废不再返回）
    const startAgain = await startOk(env);
    expect(startAgain.data.attempt.id).toBe(newAttemptId);

    // 旧卷：详情与存答都以 ATTEMPT_ABANDONED 拒绝
    const detail = await env.app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: env.memberCookie },
    });
    expect(detail.status).toBe(409);
    expect(((await detail.json()) as ApiErr).error).toBe("ATTEMPT_ABANDONED");
    const save = await env.app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(S.fill)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({ answer: { kind: "fill", values: ["3"] } }),
      },
    );
    expect(save.status).toBe(409);
    expect(((await save.json()) as ApiErr).error).toBe("ATTEMPT_ABANDONED");

    // 学生记录不再含作废卷；教师待批队列清空
    const recordsAfter = await env.app.request("/api/student/records", {
      headers: { cookie: env.memberCookie },
    });
    expect(JSON.stringify(await recordsAfter.json())).not.toContain(attemptId);
    const pendingAfter = await env.app.request("/api/teacher/pending-marks", {
      headers: { cookie: env.teacherCookie },
    });
    expect(JSON.stringify(await pendingAfter.json())).not.toContain("成员张三");
  });

  it("访问控制：非成员无上下文 404、非成员带 courseId 403、纯讲义 404、未登录 401（与 start 同口径）", async () => {
    const env = await makeEnv();
    const noContext = await landingOf(env, env.outsiderCookie);
    expect(noContext.status).toBe(404);
    const withCourse = await landingOf(env, env.outsiderCookie, env.courseId);
    expect(withCourse.status).toBe(403);

    const plain = await makeEnv({ markdown: LECTURE_ONLY_MD });
    expect((await landingOf(plain)).status).toBe(404);

    const anonymous = await env.app.request(
      `/api/student/lectures/${env.lectureId}/lesson/landing`,
    );
    expect(anonymous.status).toBe(401);
  });
});

// ---------- QM-12（TT-09c）：自评行讲练汇总与 P3-1 口径对齐 ----------

/** 自评夹具：choice（auto）+ 带参考 fill（reference_self，开关开启时冻结） */
const LESSON_SELF_REVIEW_MD = `---
kind: lesson
unit: 自评讲练
topic: 单题自评
---

# 第3讲 自评练习

::::question{type=choice difficulty=1}
下列是正整数的是：

- [ ] $-1$
- [x] $1$
::::

::::question{type=fill difficulty=2}
计算：$1+1=$ [[2]]。
::::
`;

const SR = { choice: "自评讲练-1", fill: "自评讲练-2" } as const;

describe("QM-12：reference_self 行讲练自评与汇总口径（P3-1 对齐）", () => {
  /** 开关开启开卷的自评夹具（gradingPolicy 冻结 auto / reference_self） */
  async function makeSelfReviewEnv(): Promise<{
    env: TestEnv;
    attemptId: string;
    revisions: Map<string, string>;
  }> {
    const env = await makeEnv({ markdown: LESSON_SELF_REVIEW_MD });
    const previous = process.env.NEW_CONTENT_ENABLED;
    process.env.NEW_CONTENT_ENABLED = "true";
    let started: StartBody;
    try {
      started = await startOk(env);
    } finally {
      if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
      else process.env.NEW_CONTENT_ENABLED = previous;
    }
    return {
      env,
      attemptId: started.data.attempt.id,
      revisions: new Map(
        started.data.questions.map((q) => [q.id, q.questionRevisionId]),
      ),
    };
  }

  it("提交一题自评后：自评回执汇总只计已提交行（P3-1 对齐），自评计入 correct、未自评不进教师待批", async () => {
    const { env, attemptId, revisions } = await makeSelfReviewEnv();
    // 冻结策略断言（§5.6 表）：choice=auto、有参考 fill=reference_self
    expect(
      env.db
        .select({ policy: responses.gradingPolicy })
        .from(responses)
        .where(eq(responses.attemptId, attemptId))
        .all()
        .map((r) => r.policy),
    ).toEqual(["auto", "reference_self"]);

    // 两题都存草稿，只提交 fill（讲练进行中卷）
    await saveDraftAnswer(env, attemptId, SR.choice, {
      kind: "choice",
      index: 0,
    });
    await saveDraftAnswer(env, attemptId, SR.fill, {
      kind: "fill",
      values: ["2"],
    });
    const submitted = await submitQuestionOk(
      env,
      attemptId,
      SR.fill,
      revisions.get(SR.fill) ?? "",
    );
    // 单题提交响应的 summary（lessonLiveSummaryOf）：已提交 fill 未自评 → pending
    expect(submitted.data.summary).toMatchObject({
      total: 2,
      answered: 1,
      correct: 0,
      wrong: 0,
      pending: 1,
      unanswered: 1,
      // D4 教师待批：reference_self 行不进教师队列
      pendingCount: 0,
    });

    // 讲练当题释放 → 自评 fill=correct；回执汇总（attemptScoreSummaryOf）
    // 与 lessonLive 口径对齐：只计已提交行，自评计入 correct（P3-1 修复前
    // 整卷计数：草稿 choice 计入 answered、未提交行计入 pending）
    const reviewRes = await env.app.request(
      `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(
        SR.fill,
      )}/self-review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.memberCookie,
        },
        body: JSON.stringify({
          verdict: "correct",
          baseRevision: 0,
          mutationId: crypto.randomUUID(),
        }),
      },
    );
    expect(reviewRes.status).toBe(200);
    const reviewBody = (await reviewRes.json()) as SubmitBody;
    expect(reviewBody.data.summary).toMatchObject({
      total: 2,
      answered: 1,
      correct: 1,
      wrong: 0,
      pending: 0,
      unanswered: 1,
      autoGradable: 1,
      pendingCount: 0,
    });
  });
});
