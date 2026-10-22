import type { ApiErr, SubmitEvidenceDeclaration } from "@tutor/contract";
import {
  practiceQuestionFeedbackOkSchema,
  practiceQuestionSubmitOkSchema,
} from "@tutor/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  assignments,
  attempts,
  events,
  lectures,
  responses,
  submissionEvidence,
  teachers,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { assertNoStemLeak } from "../test/assert-no-stem-leak.ts";
import { putNoteReceipt } from "../test/note-fixtures.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";
import { submitAttemptRequest } from "../test/submit-revisions.ts";

/**
 * M2 通用逐题提交与题级反馈集成测试（2026-10-22 计划 §5.3/§5.4/§6.1/
 * §10.1–§10.4）：POST /attempts/:id/questions/:questionId/submit 的新协议路径
 * 与 GET /attempts/:id/questions/:questionId/feedback 的完整矩阵——
 * - 端到端闭环：新协议卷 → 逐题提交（per_question 出 released）→ 同
 *   mutationId 幂等重试 → 最后一题事务内自动收尾 → feedback GET 可读；
 * - 版本核对（事务内顺序 §10.2）：workflowRevision / questionRevisionId /
 *   expectedAnswerRevision（学生答案版本，非题目版本）/ 证据声明；
 - 教师收紧矩阵（§5.4）：后续逐题提交 409、已提交行与成绩保留、feedback
 *   按当前 gate 受限、重试不重放旧正文、剩余题仍可整卷提交收尾；
 * - 整卷混跑（§10.1 末行）：已单题提交的行不重判、只判剩余行；
 * - 泄露矩阵（§10.4）：未授权形态完整 assertNoLeak；released 正断言（答案
 *   解析确实在）+ 邻题未提交答案/教师私注/整卷原文负断言；逐题提交后普通
 *   取卷/草稿视图仍全绿。
 * lesson 旧协议路径的行为回归由 routes/student-lesson.test.ts 既有用例承载
 * （本文件只补协议分流守卫：新协议请求打到 lesson 卷、旧协议形态打到新协议卷
 * 都被 409 拒绝并提示刷新）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 三题练习（choice 带提示 / judge 带详解+提示 / fill 恒人工批改），各题携带
 * 互不重叠的答案秘密供邻题泄露负断言 */
const PRACTICE_MD = `---
kind: practice
unit: 逐题练习
topic: 测试
---

::::question{type=choice difficulty=1}
下列是正整数的是：

- [ ] $-1$
- [x] $1$
- [ ] $0$

:::hint
大于 $0$ 的自然数是正整数。
:::
::::

::::question{type=judge difficulty=1}
$0$ 是最小的正整数。[[错误]]

:::solution
最小的正整数是 $1$，不是 $0$。
:::

:::hint
从 $1$ 开始数。
:::
::::

::::question{type=fill difficulty=1}
最小的正整数是 [[1]]。
::::
`;

/** 讲练页夹具（协议分流守卫用：新协议请求打到 lesson 卷 → 409） */
const LESSON_MD = `---
kind: lesson
unit: 随堂讲练
---
# 第1讲

::::question{type=judge difficulty=1}
$1+1=2$。[[正确]]
::::
`;

/** 课程练习夹具（单元名与库内「逐题练习」不同名，避免导入按同名合并到库单元
 * 而不落课程条目）；单题 judge */
const COURSE_MD = `---
kind: practice
unit: 课程练习单元
topic: 测试
---

::::question{type=judge difficulty=1}
$1+1=2$。[[正确]]
::::
`;
const COURSE_Q = "课程练习单元-1";

/** 题目 id（单元 slug 缺省编号） */
const Q = {
  choice: "逐题练习-1",
  judge: "逐题练习-2",
  fill: "逐题练习-3",
} as const;
const LESSON_Q = "随堂讲练-1";

/** 各题的答案秘密片段（邻题未提交时绝不出现） */
const SECRETS = {
  choiceHint: "大于 $0$ 的自然数是正整数。",
  judgeSolution: "最小的正整数是 $1$，不是 $0$。",
  judgeHint: "从 $1$ 开始数。",
  fillMarker: "[[1]]",
  judgeAnswerMarker: "[[错误]]",
} as const;

type App = ReturnType<typeof createApp>;

interface Env {
  app: App;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  bCookie: string;
  unitId: string;
}

// 会话三件套复用（../test/note-world.ts）：建学生 + 登录拼 cookie；密码与
// 共享件默认值一致，仍显式传 STUDENT_PASSWORD 保持单源

async function createStudentAndLogin(
  app: App,
  teacherCookie: string,
  name: string,
): Promise<string> {
  await createStudent(app, teacherCookie, name, STUDENT_PASSWORD);
  return loginStudent(app, name, STUDENT_PASSWORD);
}

/** 基础环境：教师 + 导入三题练习单元 + 张三/李四 */
async function makeEnv(): Promise<Env> {
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
  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "逐题练习.md" }),
  });
  expect(imported.status).toBe(200);
  const unitId = (
    (await imported.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("导入未产出单元");
  const aCookie = await createStudentAndLogin(app, teacherCookie, "张三");
  const bCookie = await createStudentAndLogin(app, teacherCookie, "李四");
  return { app, db, teacherCookie, aCookie, bCookie, unitId };
}

async function studentIdOfLogin(
  app: App,
  teacherCookie: string,
  loginName: string,
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    headers: { cookie: teacherCookie },
  });
  const list = (
    (await res.json()) as {
      data: { students: { id: string; loginName: string | null }[] };
    }
  ).data.students;
  const found = list.find((entry) => entry.loginName === loginName);
  if (!found) throw new Error(`未找到学生 ${loginName}`);
  return found.id;
}

/** 布置作业（缺省单位一份 merged），返回作业 id */
async function createAssignment(
  app: App,
  teacherCookie: string,
  unitId: string,
  studentLoginName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const studentId = await studentIdOfLogin(
    app,
    teacherCookie,
    studentLoginName,
  );
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      unitIds: [unitId],
      studentIds: [studentId],
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { data: { assignments: { id: string }[] } })
    .data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少 id");
  return id;
}

/** 新协议开卷（assignment 来源；缺省 allowPerQuestionFeedback=true） */
async function startPracticeAttempt(
  env: Env,
  extraAssignment: Record<string, unknown> = {},
  startOptions: Record<string, unknown> = { workflowVersion: 1 },
): Promise<string> {
  const asgId = await createAssignment(
    env.app,
    env.teacherCookie,
    env.unitId,
    "张三",
    { allowPerQuestionFeedback: true, ...extraAssignment },
  );
  const res = await env.app.request(
    `/api/student/assignments/${asgId}/attempt`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: env.aCookie },
      body: JSON.stringify(startOptions),
    },
  );
  expect(res.status).toBe(200);
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  if (!id) throw new Error("开卷响应缺少 attempt id");
  return id;
}

/** 草稿视图（取 questionRevisionId / draftRevisions / practiceWorkflow） */
interface DraftView {
  revisions: Map<string, string>;
  answerRevisions: Record<string, number>;
  workflowRevision: number;
  questionProgress: {
    questionId: string;
    submittedAt: string | null;
    feedbackReadable: boolean;
  }[];
}

async function fetchDraft(env: Env, attemptId: string): Promise<DraftView> {
  const res = await env.app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie: env.aCookie },
  });
  expect(res.status).toBe(200);
  const data = (
    (await res.json()) as {
      data: {
        units: { questions: { id: string; questionRevisionId: string }[] }[];
        draftRevisions?: Record<string, number>;
        practiceWorkflow?: { revision: number };
        questionProgress?: DraftView["questionProgress"];
      };
    }
  ).data;
  return {
    revisions: new Map(
      data.units.flatMap((unit) =>
        unit.questions.map((q) => [q.id, q.questionRevisionId] as const),
      ),
    ),
    answerRevisions: data.draftRevisions ?? {},
    workflowRevision: data.practiceWorkflow?.revision ?? 0,
    questionProgress: data.questionProgress ?? [],
  };
}

/** 逐题提交回执的宽松形态（断言用；契约校验走 practiceQuestionSubmitOkSchema；
 * question 按released 形态必填断言——仅在 status=released 断言后访问） */
interface SubmitBody {
  data: {
    feedback: {
      status: string;
      restrictionReason?: string;
      question: {
        questionId: string;
        answer: unknown;
        answers: unknown;
        solutionMd: string | null;
        autoCorrect: boolean | null;
        teacherMark: string | null;
        teacherComment: string | null;
        finalCorrect: boolean | null;
        snapshot: { stemMd: string };
      };
    };
    questionProgress: {
      questionId: string;
      submittedAt: string | null;
      feedbackReadable: boolean;
    }[];
    attempt: {
      status: string;
      submittedAt: string | null;
      scoreAuto: number | null;
    };
    practiceWorkflow: {
      canChangeFeedback?: boolean;
      canSubmitQuestion?: boolean;
      feedbackMode?: string;
    };
  };
}

interface PracticeSubmitOptions {
  questionRevisionId?: string;
  expectedAnswerRevision?: number;
  workflowRevision?: number;
  mutationId?: string;
  evidence?: SubmitEvidenceDeclaration;
  cookie?: string;
}

/** POST 新协议逐题提交（缺省按草稿视图的最新值组装） */
async function practiceSubmit(
  env: Env,
  draft: DraftView,
  attemptId: string,
  questionId: string,
  options: PracticeSubmitOptions = {},
): Promise<Response> {
  const questionRevisionId =
    options.questionRevisionId ?? draft.revisions.get(questionId);
  if (!questionRevisionId)
    throw new Error(`草稿视图缺少 ${questionId} 的版本引用`);
  return env.app.request(
    `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(questionId)}/submit`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: options.cookie ?? env.aCookie,
      },
      body: JSON.stringify({
        workflowVersion: 1,
        workflowRevision: options.workflowRevision ?? draft.workflowRevision,
        questionRevisionId,
        expectedAnswerRevision:
          options.expectedAnswerRevision ??
          draft.answerRevisions[questionId] ??
          0,
        submissionMutationId: options.mutationId ?? crypto.randomUUID(),
        evidence: options.evidence ?? { questionId, state: "none" },
      }),
    },
  );
}

/** 提交成功路径：200 + 契约壳校验，返回 data 与响应 */
async function practiceSubmitOk(
  env: Env,
  draft: DraftView,
  attemptId: string,
  questionId: string,
  options: PracticeSubmitOptions = {},
): Promise<{ data: SubmitBody["data"]; res: Response }> {
  const res = await practiceSubmit(env, draft, attemptId, questionId, options);
  expect(res.status).toBe(200);
  const body = (await res.json()) as SubmitBody;
  expect(practiceQuestionSubmitOkSchema.safeParse(body).success).toBe(true);
  return { data: body.data, res };
}

/** GET 题级反馈 */
async function getFeedback(
  env: Env,
  attemptId: string,
  questionId: string,
  cookie: string = env.aCookie,
): Promise<Response> {
  return env.app.request(
    `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(questionId)}/feedback`,
    { headers: { cookie } },
  );
}

async function getFeedbackOk(
  env: Env,
  attemptId: string,
  questionId: string,
): Promise<unknown> {
  const res = await getFeedback(env, attemptId, questionId);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown };
  expect(practiceQuestionFeedbackOkSchema.safeParse(body).success).toBe(true);
  return body;
}

/** PUT 草稿答案 */
async function saveAnswer(
  env: Env,
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
  expect(res.status).toBe(200);
}

async function expectErr(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as ApiErr).error).toBe(code);
}

function questionSubmitEventsOf(db: Db, attemptId: string): number {
  return db
    .select()
    .from(events)
    .where(eq(events.attemptId, attemptId))
    .all()
    .filter((row) => row.type === "question_submit").length;
}

function responseRowOf(db: Db, attemptId: string, questionId: string) {
  const row = db
    .select()
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

describe("M2 端到端闭环：新协议卷逐题提交（per_question 出 released）", () => {
  it("首题提交：released 当题反馈 + 全卷题级进度白名单 + 幂等凭据落库 + 事件恰一条 + no-store", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    // 存答后 answerRevision 升 1：重取草稿拿最新 expectedAnswerRevision
    const fresh = await fetchDraft(env, attemptId);

    const mutationId = crypto.randomUUID();
    const { data, res } = await practiceSubmitOk(
      env,
      fresh,
      attemptId,
      Q.choice,
      {
        mutationId,
      },
    );

    // 回执四键：feedback（released 当题结果）+ questionProgress + attempt + workflow
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(data.feedback.status).toBe("released");
    const question = data.feedback.question;
    expect(question.questionId).toBe(Q.choice);
    expect(question.answer).toEqual({ kind: "choice", index: 1 });
    expect(question.autoCorrect).toBe(true);
    expect(question.answers).not.toBeNull();
    // 未交卷期间教师域三字段恒 null（提交瞬间教师必未批）
    expect(question.teacherMark).toBeNull();
    expect(question.teacherComment).toBeNull();
    expect(question.finalCorrect).toBeNull();
    // stemMd 经 studentStemMd：不含正确项标记与 [[…]] 答案标记
    expect(question.snapshot.stemMd).not.toContain("[[");
    expect(question.snapshot.stemMd).not.toContain("- [x]");

    expect(data.questionProgress).toEqual([
      {
        questionId: Q.choice,
        submittedAt: expect.any(String),
        feedbackReadable: true,
      },
      { questionId: Q.judge, submittedAt: null, feedbackReadable: false },
      { questionId: Q.fill, submittedAt: null, feedbackReadable: false },
    ]);
    expect(data.attempt).toMatchObject({
      id: attemptId,
      status: "draft",
      submittedAt: null,
      scoreAuto: null,
    });
    // 任一提交后节奏冻结
    expect(data.practiceWorkflow).toMatchObject({
      canChangeFeedback: false,
      canSubmitQuestion: true,
      feedbackMode: "per_question",
    });

    // 库内行：判分 + submittedAt + 幂等凭据
    expect(responseRowOf(env.db, attemptId, Q.choice)).toMatchObject({
      autoCorrect: true,
      finalCorrect: true,
      submittedAt: expect.any(String),
      practiceMutationId: mutationId,
      practiceRequestDigest: expect.any(String),
    });

    // 泄露三层：键名级（放行当题 answers/answer/solutionMd）+ 题干级 + 邻题内容级
    assertNoLeak({ data }, { allow: ["answers", "answer", "solutionMd"] });
    assertNoStemLeak({ data });
    const text = JSON.stringify({ data });
    expect(text).not.toContain(SECRETS.judgeSolution);
    expect(text).not.toContain(SECRETS.judgeHint);
    expect(text).not.toContain(SECRETS.choiceHint); // 邻题未解锁提示（当题 hint 也未解锁）
    expect(text).not.toContain(SECRETS.fillMarker);
    expect(text).not.toContain(SECRETS.judgeAnswerMarker);

    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(1);
  });

  it("同 mutationId 同请求重试 → 200 同一提交事实（不重判、不重复事件、submittedAt 不变、按当前规则投影）", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    const draft = await fetchDraft(env, attemptId);
    const mutationId = crypto.randomUUID();
    const first = await practiceSubmitOk(env, draft, attemptId, Q.choice, {
      mutationId,
    });
    expect(first.data.feedback.question.autoCorrect).toBe(true);
    const firstSubmittedAt = responseRowOf(
      env.db,
      attemptId,
      Q.choice,
    ).submittedAt;

    // 模拟「结果未知可恢复」：同 mutationId 原样重试（practiceSubmitOk 内含
    // 200 与契约壳校验，与其他用例同一断言强度）
    const retry = await practiceSubmitOk(env, draft, attemptId, Q.choice, {
      mutationId,
    });
    expect(retry.data.feedback.status).toBe("released");
    expect(retry.data.feedback.question.autoCorrect).toBe(true);
    expect(retry.data.questionProgress[0]).toMatchObject({
      questionId: Q.choice,
      feedbackReadable: true,
    });

    // 不重判、不重复事件、幂等凭据与提交时刻不变
    expect(responseRowOf(env.db, attemptId, Q.choice).submittedAt).toBe(
      firstSubmittedAt,
    );
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(1);
    expect(first.data.attempt.status).toBe("draft");
  });

  it("同 mutationId 异请求摘要 → 409 WORKFLOW_MUTATION_CONFLICT（不重放、不覆盖）", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);
    const mutationId = crypto.randomUUID();
    await practiceSubmitOk(env, draft, attemptId, Q.choice, { mutationId });

    // 同 id 不同正文（换证据声明形态 → 摘要不同）
    const conflict = await practiceSubmit(env, draft, attemptId, Q.choice, {
      mutationId,
      evidence: { questionId: Q.choice, state: "missing" },
    });
    await expectErr(conflict, 409, "WORKFLOW_MUTATION_CONFLICT");
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(1);
  });

  it("异 mutationId 重复提交 → 409 QUESTION_ALREADY_SUBMITTED；最后一题自动收尾（attempt 转 submitted）后同 mutationId 重试仍 200", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    let draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    draft = await fetchDraft(env, attemptId);
    await practiceSubmitOk(env, draft, attemptId, Q.choice);

    // 异 mutationId 打已提交行 → 可诊断 409
    const dup = await practiceSubmit(env, draft, attemptId, Q.choice, {
      mutationId: crypto.randomUUID(),
    });
    await expectErr(dup, 409, "QUESTION_ALREADY_SUBMITTED");

    // 第 2 题：judge 答错（value true → 判 false）
    await saveAnswer(env, attemptId, Q.judge, { kind: "judge", value: true });
    draft = await fetchDraft(env, attemptId);
    const second = await practiceSubmitOk(env, draft, attemptId, Q.judge);
    expect(second.data.feedback.status).toBe("released");
    expect(second.data.feedback.question.autoCorrect).toBe(false);
    expect(second.data.attempt.status).toBe("draft");

    // 第 3 题（最后一题）：fill 恒人工批改 → 提交后事务内自动收尾
    await saveAnswer(env, attemptId, Q.fill, { kind: "fill", values: ["1"] });
    draft = await fetchDraft(env, attemptId);
    const lastMutation = crypto.randomUUID();
    const last = await practiceSubmitOk(env, draft, attemptId, Q.fill, {
      mutationId: lastMutation,
    });
    expect(last.data.attempt).toMatchObject({
      status: "submitted",
      submittedAt: expect.any(String),
      scoreAuto: 50, // 1 对 / 2 可自动判（fill 待批不入分母）
    });
    // 收尾后 released 仍可读（on_submit 公布；canSubmitQuestion=false 与 released 并存合法）
    expect(last.data.feedback.status).toBe("released");
    expect(last.data.practiceWorkflow.canSubmitQuestion).toBe(false);
    // 题级进度可读性与反馈四态同一裁决：收尾公布后已提交行 readable=true
    //（修复前 wiring 自写谓词在此恒 false，与 released 反馈自相矛盾）
    expect(last.data.questionProgress).toEqual([
      {
        questionId: Q.choice,
        submittedAt: expect.any(String),
        feedbackReadable: true,
      },
      {
        questionId: Q.judge,
        submittedAt: expect.any(String),
        feedbackReadable: true,
      },
      {
        questionId: Q.fill,
        submittedAt: expect.any(String),
        feedbackReadable: true,
      },
    ]);

    // 已收尾卷：同 mutationId 重试确认提交事实（§10.3「已完成整卷也能确认」）
    const replay = await practiceSubmit(env, draft, attemptId, Q.fill, {
      mutationId: lastMutation,
    });
    expect(replay.status).toBe(200);
    // 异 mutationId → 已提交行 409
    const late = await practiceSubmit(env, draft, attemptId, Q.fill, {
      mutationId: crypto.randomUUID(),
    });
    await expectErr(late, 409, "QUESTION_ALREADY_SUBMITTED");

    // feedback GET 三题全部 released
    for (const questionId of [Q.choice, Q.judge, Q.fill]) {
      const body = (await getFeedbackOk(env, attemptId, questionId)) as {
        data: { feedback: { status: string } };
      };
      expect(body.data.feedback.status).toBe("released");
    }
  });

  it("feedback GET：未提交题 not_submitted、无任何题目秘密；响应 no-store", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);
    await practiceSubmitOk(env, draft, attemptId, Q.choice);

    const res = await getFeedback(env, attemptId, Q.judge);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { data: { feedback: unknown } };
    expect(body.data.feedback).toEqual({ status: "not_submitted" });
    assertNoLeak(body);
    assertNoStemLeak(body);
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRETS.judgeSolution);
    expect(text).not.toContain(SECRETS.judgeAnswerMarker);
  });
});

describe("M2 协议分流与守卫", () => {
  it("旧协议形态打到新协议卷 → 409 WORKFLOW_PROTOCOL_MISMATCH（提示刷新）；历史卷维持 404 NOT_FOUND", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);

    const legacyShape = await env.app.request(
      `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(Q.choice)}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          questionRevisionId: draft.revisions.get(Q.choice) ?? "",
        }),
      },
    );
    await expectErr(legacyShape, 409, "WORKFLOW_PROTOCOL_MISMATCH");

    // 历史卷（无工作流版本）旧协议形态 → 既有 404（讲练专属入口口径不变）
    const legacyAttemptId = await startPracticeAttempt(env, {}, {});
    const legacy = await env.app.request(
      `/api/student/attempts/${legacyAttemptId}/questions/${encodeURIComponent(Q.choice)}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          questionRevisionId: (
            await fetchDraft(env, legacyAttemptId)
          ).revisions.get(Q.choice),
        }),
      },
    );
    await expectErr(legacy, 404, "NOT_FOUND");
  });

  it("新协议请求打到 lesson 卷 → 409 WORKFLOW_PROTOCOL_MISMATCH；打到历史卷 → 409 WORKFLOW_LEGACY", async () => {
    const env = await makeEnv();
    // lesson 卷：导入讲练页进课程 + 成员开卷
    const courseRes = await env.app.request("/api/teacher/courses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ title: "讲练课" }),
    });
    expect(courseRes.status).toBe(201);
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    const imported = await env.app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        markdown: LESSON_MD,
        filename: "随堂讲练.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    const lessonLecture = env.db
      .select()
      .from(lectures)
      .all()
      .find((row) => row.kind === "lesson" && row.deletedAt === null);
    if (!lessonLecture) throw new Error("导入未产出讲练页");
    const aStudentId = await studentIdOfLogin(
      env.app,
      env.teacherCookie,
      "张三",
    );
    const addedMember = await env.app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [aStudentId] }),
      },
    );
    expect(addedMember.status).toBe(200);
    const started = await env.app.request(
      `/api/student/lectures/${lessonLecture.id}/lesson/start?courseId=${courseId}`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(started.status).toBe(200);
    const lessonBody = (await started.json()) as {
      data: {
        attempt: { id: string };
        questions: { id: string; questionRevisionId: string }[];
      };
    };
    const lessonAttempt = lessonBody.data.attempt.id;
    const qid = lessonBody.data.questions[0]?.id ?? LESSON_Q;
    const qrev = lessonBody.data.questions[0]?.questionRevisionId ?? "";

    const practiceShapeOnLesson = await env.app.request(
      `/api/student/attempts/${lessonAttempt}/questions/${encodeURIComponent(qid)}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          workflowVersion: 1,
          workflowRevision: 0,
          questionRevisionId: qrev,
          expectedAnswerRevision: 0,
          submissionMutationId: crypto.randomUUID(),
          evidence: { questionId: qid, state: "none" },
        }),
      },
    );
    await expectErr(practiceShapeOnLesson, 409, "WORKFLOW_PROTOCOL_MISMATCH");

    // 历史卷 + 新协议请求
    const legacyAttemptId = await startPracticeAttempt(env, {}, {});
    const legacyDraft = await fetchDraft(env, legacyAttemptId);
    const practiceShapeOnLegacy = await practiceSubmit(
      env,
      legacyDraft,
      legacyAttemptId,
      Q.choice,
    );
    await expectErr(practiceShapeOnLegacy, 409, "WORKFLOW_LEGACY");
  });

  it("未登录 401；跨学生 404；attempt 不存在 404；作废卷 409 ATTEMPT_ABANDONED", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);

    const unauth = await practiceSubmit(env, draft, attemptId, Q.choice, {
      cookie: "",
    });
    expect(unauth.status).toBe(401);

    const foreign = await practiceSubmit(env, draft, attemptId, Q.choice, {
      cookie: env.bCookie,
    });
    await expectErr(foreign, 404, "ATTEMPT_NOT_FOUND");

    const missing = await practiceSubmit(
      env,
      draft,
      "no-such-attempt",
      Q.choice,
    );
    await expectErr(missing, 404, "ATTEMPT_NOT_FOUND");

    env.db
      .update(attempts)
      .set({ abandonedAt: new Date().toISOString() })
      .where(eq(attempts.id, attemptId))
      .run();
    const abandoned = await practiceSubmit(env, draft, attemptId, Q.choice);
    await expectErr(abandoned, 409, "ATTEMPT_ABANDONED");
  });

  it("不在冻结集的题 404 QUESTION_NOT_FOUND；草稿视图/feedback GET 同口径守卫", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);
    const unknown = await practiceSubmit(env, draft, attemptId, "不存在的题", {
      questionRevisionId: "unknown-question-revision",
    });
    await expectErr(unknown, 404, "QUESTION_NOT_FOUND");
    const feedbackUnknown = await getFeedback(env, attemptId, "不存在的题");
    await expectErr(feedbackUnknown, 404, "QUESTION_NOT_FOUND");
  });

  it("feedback GET：lesson 卷与历史卷 409 WORKFLOW_LEGACY；未登录 401；跨学生 403（与取卷同口径）", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const unauth = await getFeedback(env, attemptId, Q.choice, "");
    expect(unauth.status).toBe(401);
    const foreign = await getFeedback(env, attemptId, Q.choice, env.bCookie);
    await expectErr(foreign, 403, "FORBIDDEN");

    const legacyAttemptId = await startPracticeAttempt(env, {}, {});
    const legacy = await getFeedback(env, legacyAttemptId, Q.choice);
    await expectErr(legacy, 409, "WORKFLOW_LEGACY");
  });
});

describe("M2 版本核对（§10.2 事务内顺序）", () => {
  it("questionRevisionId 错版 → 409 QUESTION_REVISION_STALE", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);
    const wrong = await practiceSubmit(env, draft, attemptId, Q.choice, {
      questionRevisionId: "not-the-frozen-row-id",
    });
    await expectErr(wrong, 409, "QUESTION_REVISION_STALE");
  });

  it("expectedAnswerRevision 陈旧（他端又存了一版答案）→ 409 ANSWER_REVISION_CONFLICT；刷新后按新版本可提交", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    const seen = await fetchDraft(env, attemptId);
    // 他端（另一保存）把答案版本推高
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 2 });
    const stale = await practiceSubmit(env, seen, attemptId, Q.choice);
    await expectErr(stale, 409, "ANSWER_REVISION_CONFLICT");

    // 刷新草稿拿到最新 answerRevision（2）后提交成功，判分按行内最新答案
    const fresh = await fetchDraft(env, attemptId);
    const ok = await practiceSubmitOk(env, fresh, attemptId, Q.choice);
    expect(ok.data.feedback.status).toBe("released");
    expect(ok.data.feedback.question.answer).toEqual({
      kind: "choice",
      index: 2,
    });
    expect(ok.data.feedback.question.autoCorrect).toBe(false);
  });

  it("workflowRevision 陈旧（PATCH 升版后提交）→ 409 WORKFLOW_REVISION_STALE", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const draft = await fetchDraft(env, attemptId);
    // 首次提交前把节奏改一次（revision 0→1），旧 revision 提交须被拒
    const patched = await env.app.request(
      `/api/student/attempts/${attemptId}/workflow`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({
          feedbackMode: "per_question",
          workflowRevision: 0,
        }),
      },
    );
    expect(patched.status).toBe(200);
    const stale = await practiceSubmit(env, draft, attemptId, Q.choice);
    await expectErr(stale, 409, "WORKFLOW_REVISION_STALE");

    const fresh = await fetchDraft(env, attemptId);
    const ok = await practiceSubmitOk(env, fresh, attemptId, Q.choice);
    expect(ok.data.feedback.status).toBe("released");
  });

  it("证据声明：questionId 不一致 409；有稿 none 409；frozen 精确比对通过并落证据行；missing 如实记录", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    let draft = await fetchDraft(env, attemptId);

    const mismatch = await practiceSubmit(env, draft, attemptId, Q.choice, {
      evidence: { questionId: Q.judge, state: "none" },
    });
    await expectErr(mismatch, 409, "NOTE_EVIDENCE_MISMATCH");

    // 有稿题声明 none → 409（本机读取失败/未核对不得伪装 missing/none 放行）
    const receipt = await putNoteReceipt(
      env.app,
      env.aCookie,
      attemptId,
      Q.judge,
    );
    draft = await fetchDraft(env, attemptId);
    const noneWithNote = await practiceSubmit(env, draft, attemptId, Q.judge, {
      evidence: { questionId: Q.judge, state: "none" },
    });
    await expectErr(noneWithNote, 409, "NOTE_EVIDENCE_MISMATCH");

    // frozen 精确比对 → 通过并同事务落证据行
    await saveAnswer(env, attemptId, Q.judge, { kind: "judge", value: false });
    draft = await fetchDraft(env, attemptId);
    const frozen = await practiceSubmitOk(env, draft, attemptId, Q.judge, {
      evidence: {
        questionId: Q.judge,
        state: "frozen",
        versionId: receipt.versionId,
        revision: receipt.revision,
      },
    });
    expect(frozen.data.feedback.status).toBe("released");
    const evidenceRow = env.db
      .select()
      .from(submissionEvidence)
      .where(
        and(
          eq(submissionEvidence.attemptId, attemptId),
          eq(submissionEvidence.questionId, Q.judge),
        ),
      )
      .get();
    expect(evidenceRow).toMatchObject({
      state: "frozen",
      versionId: receipt.versionId,
    });

    // missing：用户明示后如实记录（不自动升格 frozen）
    draft = await fetchDraft(env, attemptId);
    const missing = await practiceSubmitOk(env, draft, attemptId, Q.choice, {
      evidence: { questionId: Q.choice, state: "missing" },
    });
    expect(missing.data.feedback.status).toBe("released");
    expect(
      env.db
        .select()
        .from(submissionEvidence)
        .where(
          and(
            eq(submissionEvidence.attemptId, attemptId),
            eq(submissionEvidence.questionId, Q.choice),
          ),
        )
        .get(),
    ).toMatchObject({ state: "missing", versionId: null });
  });
});

describe("M2 教师收紧矩阵（§5.4）", () => {
  it("作业撤授权（allow=false）：后续逐题提交 409 WORKFLOW_RESTRICTED、已提交行保留、feedback 按当前 gate restricted、重试不重放旧正文、剩余题整卷提交收尾、收尾后 released", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    const asgId = env.db
      .select({ id: attempts.assignmentId })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get()?.id;
    if (!asgId) throw new Error("夹具缺少作业行");

    let draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    draft = await fetchDraft(env, attemptId);
    const firstMutation = crypto.randomUUID();
    const first = await practiceSubmitOk(env, draft, attemptId, Q.choice, {
      mutationId: firstMutation,
    });
    expect(first.data.feedback.status).toBe("released");

    // 教师收紧（保留 on_submit）
    env.db
      .update(assignments)
      .set({ allowPerQuestionFeedback: false })
      .where(eq(assignments.id, asgId))
      .run();

    // 后续逐题提交被拒（可诊断 409）
    draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.judge, { kind: "judge", value: false });
    draft = await fetchDraft(env, attemptId);
    const blocked = await practiceSubmit(env, draft, attemptId, Q.judge);
    await expectErr(blocked, 409, "WORKFLOW_RESTRICTED");

    // 已提交行与成绩保留（不回滚、不改写）
    expect(responseRowOf(env.db, attemptId, Q.choice)).toMatchObject({
      autoCorrect: true,
      submittedAt: expect.any(String),
      practiceMutationId: firstMutation,
    });

    // feedback GET 对已提交题按当前 gate 回 restricted（不重放旧正文）
    const restrictedBody = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: { status: string; restrictionReason?: string } };
    };
    expect(restrictedBody.data.feedback).toEqual({
      status: "restricted",
      restrictionReason: "teacher_after_attempt",
    });
    assertNoLeak(restrictedBody);
    assertNoStemLeak(restrictedBody);
    expect(JSON.stringify(restrictedBody)).not.toContain(SECRETS.choiceHint);

    // 同 mutationId 重试同样按当前规则投影为 restricted（不重放带答案旧正文）
    const replay = await practiceSubmit(env, draft, attemptId, Q.choice, {
      mutationId: firstMutation,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      data: SubmitBody["data"];
    };
    expect(replayBody.data.feedback).toEqual({
      status: "restricted",
      restrictionReason: "teacher_after_attempt",
    });
    assertNoLeak(replayBody);
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(1);

    // 剩余题仍可整卷提交收尾（题级进度白名单同步受限）
    const submitRes = await submitAttemptRequest(
      env.app,
      env.aCookie,
      attemptId,
    );
    expect([200, 201]).toContain(submitRes.status);
    const attemptRow = env.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    // choice 对（逐题提交）+ judge 对（整卷判分）+ fill 未作答 null → submitted 待批
    expect(attemptRow?.status).toBe("submitted");
    expect(attemptRow?.scoreAuto).toBe(100); // 2/2 可自动判分全对

    // 收尾后（on_submit 公布）feedback GET 恢复 released
    const releasedBody = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: { status: string } };
    };
    expect(releasedBody.data.feedback.status).toBe("released");
  });

  it("教师默认策略收紧（course 来源 practiceFeedbackPolicy=after_attempt）：新协议卷逐题提交 409 WORKFLOW_RESTRICTED", async () => {
    const env = await makeEnv();
    env.db
      .update(teachers)
      .set({ practiceFeedbackPolicy: "after_attempt" })
      .where(eq(teachers.loginName, "teacher"))
      .run();
    const courseRes = await env.app.request("/api/teacher/courses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({ title: "课程练习" }),
    });
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    const imported = await env.app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: env.teacherCookie,
      },
      body: JSON.stringify({
        markdown: COURSE_MD,
        filename: "课程练习.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    const courseUnitId = (
      (await imported.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!courseUnitId) throw new Error("课程导入未产出单元");
    // 课程条目默认不可见（D22）：发布后学生才能开卷
    const courseDetail = await env.app.request(
      `/api/teacher/courses/${courseId}`,
      { headers: { cookie: env.teacherCookie } },
    );
    const item = (
      (await courseDetail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === courseUnitId);
    if (!item) throw new Error("课程目录中未找到单元条目");
    const patched = await env.app.request(
      `/api/teacher/course-items/${item.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ visible: true }),
      },
    );
    expect(patched.status).toBe(200);
    const aStudentId = await studentIdOfLogin(
      env.app,
      env.teacherCookie,
      "张三",
    );
    const added = await env.app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [aStudentId] }),
      },
    );
    expect(added.status).toBe(200);
    const started = await env.app.request(
      `/api/student/courses/${courseId}/units/${courseUnitId}/attempts`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify({ workflowVersion: 1 }),
      },
    );
    expect(started.status).toBe(201);
    const attemptId = ((await started.json()) as { data: { id: string } }).data
      .id;
    await saveAnswer(env, attemptId, COURSE_Q, { kind: "judge", value: true });
    const fresh = await fetchDraft(env, attemptId);
    const blocked = await practiceSubmit(env, fresh, attemptId, COURSE_Q);
    await expectErr(blocked, 409, "WORKFLOW_RESTRICTED");
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(0);
  });
});

describe("M2 after_attempt 节奏与公布 gate", () => {
  it("学生自选 after_attempt：逐题提交 409（canSubmitQuestion=false）；整卷提交后 feedback GET released", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(
      env,
      {},
      { workflowVersion: 1, feedbackMode: "after_attempt" },
    );
    const draft = await fetchDraft(env, attemptId);
    expect(draft.questionProgress.length).toBe(3);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    const fresh = await fetchDraft(env, attemptId);
    const blocked = await practiceSubmit(env, fresh, attemptId, Q.choice);
    await expectErr(blocked, 409, "WORKFLOW_RESTRICTED");

    // 未提交题 feedback not_submitted；整卷提交（发布即时）→ released
    await submitAttemptRequest(env.app, env.aCookie, attemptId);
    const body = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: { status: string } };
    };
    expect(body.data.feedback.status).toBe("released");
  });

  it("after_due 作业：交卷后截止前 feedback GET pending_attempt（无答案）；过截止后 released", async () => {
    const env = await makeEnv();
    const futureDue = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const attemptId = await startPracticeAttempt(env, {
      answerRelease: "after_due",
      dueAt: futureDue,
      allowPerQuestionFeedback: false,
    });
    await submitAttemptRequest(env.app, env.aCookie, attemptId);
    const pendingBody = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: unknown };
    };
    expect(pendingBody.data.feedback).toEqual({ status: "pending_attempt" });
    assertNoLeak(pendingBody);
    assertNoStemLeak(pendingBody);

    // 截止过后（读时比较，无定时任务）→ released
    const pastDue = new Date(Date.now() - 1000).toISOString();
    env.db
      .update(assignments)
      .set({ dueAt: pastDue })
      .where(
        eq(
          assignments.id,
          env.db
            .select({ id: attempts.assignmentId })
            .from(attempts)
            .where(eq(attempts.id, attemptId))
            .get()?.id ?? "",
        ),
      )
      .run();
    const releasedBody = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: { status: string; question?: { answers: unknown } } };
    };
    expect(releasedBody.data.feedback.status).toBe("released");
    expect(releasedBody.data.feedback.question?.answers).not.toBeNull();
  });
});

describe("M2 异常数据降级（作业授权行悬挂——v2 加固 d7c84b89 语义接线）", () => {
  it("读侧工作流投影缺失：新协议提交降级 409 WORKFLOW_LEGACY 不打 500；已提交题 feedback restricted(legacy_attempt)", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    await saveAnswer(env, attemptId, Q.judge, { kind: "judge", value: false });
    // 悬挂前取全版本引用（悬挂后取卷/草稿自身会按 ASSIGNMENT_NOT_FOUND 拒绝）
    const draft = await fetchDraft(env, attemptId);
    const first = await practiceSubmitOk(env, draft, attemptId, Q.choice);
    expect(first.data.feedback.status).toBe("released");

    // 手工改库模拟异常数据：临时关 FK 硬删作业行（正常链路软删且 FK 约束；
    // 加固语义针对的正是这种库内一致性被外力破坏的形态）
    const asgId = env.db
      .select({ id: attempts.assignmentId })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get()?.id;
    if (!asgId) throw new Error("夹具缺少作业行");
    env.db.run(sql`PRAGMA foreign_keys = OFF`);
    try {
      env.db.delete(assignments).where(eq(assignments.id, asgId)).run();
    } finally {
      env.db.run(sql`PRAGMA foreign_keys = ON`);
    }

    // 后续提交：读侧投影缺失（作业授权行悬挂按「缺失=旧协议」降级）→ 409 非 500
    const blocked = await practiceSubmit(env, draft, attemptId, Q.judge);
    await expectErr(blocked, 409, "WORKFLOW_LEGACY");
    expect(questionSubmitEventsOf(env.db, attemptId)).toBe(1);

    // 已提交题重取：按当前（降级）gate 收敛 restricted(legacy_attempt)，零题目秘密
    const body = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: { status: string; restrictionReason?: string } };
    };
    expect(body.data.feedback).toEqual({
      status: "restricted",
      restrictionReason: "legacy_attempt",
    });
    assertNoLeak(body);
    assertNoStemLeak(body);
  });

  it("已收尾卷作业行悬挂：公布 gate fail-closed 收敛 pending_attempt，不裸抛 404", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    // 三题全逐题提交：最后一题在事务内收尾（on_submit 作业，行在 → released）
    for (const questionId of [Q.judge, Q.choice, Q.fill]) {
      const draft = await fetchDraft(env, attemptId);
      await practiceSubmitOk(env, draft, attemptId, questionId);
    }
    const before = (await getFeedbackOk(env, attemptId, Q.judge)) as {
      data: { feedback: { status: string } };
    };
    expect(before.data.feedback.status).toBe("released");

    const asgId = env.db
      .select({ id: attempts.assignmentId })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get()?.id;
    if (!asgId) throw new Error("夹具缺少作业行");
    env.db.run(sql`PRAGMA foreign_keys = OFF`);
    try {
      env.db.delete(assignments).where(eq(assignments.id, asgId)).run();
    } finally {
      env.db.run(sql`PRAGMA foreign_keys = ON`);
    }

    // fail closed：行缺失按「未公布」收敛 pending_attempt（题目笔记本同口径
    // 取严），不把题级反馈读取裸抛成 404 ASSIGNMENT_NOT_FOUND
    const body = (await getFeedbackOk(env, attemptId, Q.judge)) as {
      data: { feedback: { status: string } };
    };
    expect(body.data.feedback).toEqual({ status: "pending_attempt" });
    assertNoLeak(body);
    assertNoStemLeak(body);
  });
});

describe("M2 整卷混跑（§10.1 末行：已提交行不重判、只判剩余行）", () => {
  it("部分逐题提交后整卷提交：已提交行判定/submittedAt/幂等凭据保留，剩余行判分，attempt 只收尾一次", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    let draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 0 }); // 判错
    draft = await fetchDraft(env, attemptId);
    const mutationId = crypto.randomUUID();
    await practiceSubmitOk(env, draft, attemptId, Q.choice, { mutationId });
    const submittedAt = responseRowOf(env.db, attemptId, Q.choice).submittedAt;

    // 教师对已提交行课中批改（「教师改判后收尾不得覆盖」预埋——§13.5）
    env.db
      .update(responses)
      .set({
        teacherMark: "correct",
        teacherComment: "教师评语-公布后可见",
        finalCorrect: true,
      })
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.choice),
        ),
      )
      .run();

    // 整卷提交：judge 未答判 false、fill 未答判 false → 全判定 graded
    const submitRes = await submitAttemptRequest(
      env.app,
      env.aCookie,
      attemptId,
    );
    expect([200, 201]).toContain(submitRes.status);

    const keptRow = responseRowOf(env.db, attemptId, Q.choice);
    expect(keptRow.autoCorrect).toBe(false); // 不重判
    expect(keptRow.finalCorrect).toBe(true); // 教师改判保留
    expect(keptRow.teacherMark).toBe("correct");
    expect(keptRow.submittedAt).toBe(submittedAt); // 单题提交时刻不被交卷时刻覆盖
    expect(keptRow.practiceMutationId).toBe(mutationId);

    const judgeRow = responseRowOf(env.db, attemptId, Q.judge);
    expect(judgeRow.autoCorrect).toBe(false); // 剩余行判分（未作答 judge 判 false）
    expect(judgeRow.submittedAt).not.toBeNull(); // 整卷收尾对剩余行写交卷时刻
    const fillRow = responseRowOf(env.db, attemptId, Q.fill);
    expect(fillRow.autoCorrect).toBeNull(); // fill 恒人工批改（未作答 null 进待批）
    expect(fillRow.submittedAt).not.toBeNull();

    const attemptRow = env.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    // finalCorrect: true(教师改判)/false(判错)/null(fill 待批) → submitted
    expect(attemptRow?.status).toBe("submitted");
    expect(attemptRow?.scoreAuto).toBe(0); // 可自动判 2 题全错（教师改判不影响 scoreAuto 口径）
    expect(attemptRow?.scoreFinal).toBeNull();

    // 重复交卷 409（只收尾一次）
    const again = await submitAttemptRequest(env.app, env.aCookie, attemptId);
    await expectErr(again, 409, "ALREADY_SUBMITTED");

    // 交卷公布后教师评语随行（与结果视图同口径；draft 期间恒 null 由泄露矩阵用例覆盖）
    const feedbackBody = (await getFeedbackOk(env, attemptId, Q.choice)) as {
      data: { feedback: { question?: { teacherComment: string | null } } };
    };
    expect(feedbackBody.data.feedback.question?.teacherComment).toBe(
      "教师评语-公布后可见",
    );
  });
});

describe("M2 泄露矩阵（§10.4）：普通接口不因逐题提交放宽", () => {
  it("逐题提交后普通取卷/草稿视图仍全绿：assertNoLeak、drafts 仍本人答案、questionProgress 白名单无对错", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    let draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    draft = await fetchDraft(env, attemptId);
    await practiceSubmitOk(env, draft, attemptId, Q.choice);

    const detail = await env.app.request(`/api/student/attempts/${attemptId}`, {
      headers: { cookie: env.aCookie },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: Record<string, unknown> & {
        drafts: Record<string, unknown>;
        questionProgress?: {
          questionId: string;
          submittedAt: string | null;
          feedbackReadable: boolean;
        }[];
      };
    };
    assertNoLeak(detailBody, { allow: ["drafts"] });
    assertNoStemLeak(detailBody);
    // 已提交行答案锁定后草稿区不再回显（assertRowNotSubmitted 阻止覆盖，草稿
    // 回显按行内 answerJson——提交后仍为学生自己的答案，允许出现）
    expect(detailBody.data.drafts[Q.choice]).toEqual({
      kind: "choice",
      index: 1,
    });
    expect(detailBody.data.questionProgress).toEqual([
      {
        questionId: Q.choice,
        submittedAt: expect.any(String),
        feedbackReadable: true,
      },
      { questionId: Q.judge, submittedAt: null, feedbackReadable: false },
      { questionId: Q.fill, submittedAt: null, feedbackReadable: false },
    ]);

    const paper = await env.app.request(
      `/api/student/attempts/${attemptId}/paper`,
      { headers: { cookie: env.aCookie } },
    );
    expect(paper.status).toBe(200);
    const paperBody = (await paper.json()) as Record<string, unknown>;
    assertNoLeak(paperBody);
    assertNoStemLeak(paperBody);
  });

  it("released 正断言（答案解析确实在）+ 负断言：邻题未提交答案、教师私注、整卷原文绝不出现", async () => {
    const env = await makeEnv();
    const attemptId = await startPracticeAttempt(env);
    let draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.judge, { kind: "judge", value: false });
    draft = await fetchDraft(env, attemptId);
    const { data } = await practiceSubmitOk(env, draft, attemptId, Q.judge);

    // 正断言：judge 详解与参考答案确实在（授权出口的存在性）
    expect(data.feedback.status).toBe("released");
    expect(data.feedback.question.solutionMd).toContain(SECRETS.judgeSolution);
    expect(data.feedback.question.answers).not.toBeNull();

    // 库内预埋教师私注（draft 期间不得外发——恒 null 投影）
    env.db
      .update(responses)
      .set({ teacherComment: "教师私注-绝不外发" })
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.judge),
        ),
      )
      .run();
    const afterMark = (await getFeedbackOk(env, attemptId, Q.judge)) as {
      data: {
        feedback: {
          status: string;
          question?: { teacherComment: string | null };
        };
      };
    };
    expect(afterMark.data.feedback.status).toBe("released");
    expect(afterMark.data.feedback.question?.teacherComment).toBeNull();
    expect(JSON.stringify(afterMark)).not.toContain("教师私注-绝不外发");

    // 负断言：邻题（choice/fill 未提交）的答案内容绝不出现；整卷题块原文绝不出现
    const text = JSON.stringify({ data }) + JSON.stringify(afterMark);
    expect(text).not.toContain("- [x]");
    expect(text).not.toContain("::::question");
    expect(text).not.toContain(":::solution");
    expect(text).not.toContain(":::hint");
    expect(text).not.toContain(SECRETS.fillMarker);
  });
});

describe("M4-D3 进行中进度计数与结果页节奏摘要（§13/§13.8）", () => {
  /** 开卷并返回 (作业 id, attempt id)（作业列表 n/N 断言需要作业 id 定位） */
  async function startTrackedAttempt(
    env: Env,
    startOptions: Record<string, unknown> = { workflowVersion: 1 },
  ): Promise<{ asgId: string; attemptId: string }> {
    const asgId = await createAssignment(
      env.app,
      env.teacherCookie,
      env.unitId,
      "张三",
      { allowPerQuestionFeedback: true },
    );
    const res = await env.app.request(
      `/api/student/assignments/${asgId}/attempt`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: env.aCookie },
        body: JSON.stringify(startOptions),
      },
    );
    expect(res.status).toBe(200);
    const attemptId = ((await res.json()) as { data: { id: string } }).data.id;
    if (!attemptId) throw new Error("开卷响应缺少 attempt id");
    return { asgId, attemptId };
  }

  interface RecordRow {
    attemptId: string;
    status: string;
    practiceSubmittedCount?: number;
    practiceQuestionCount?: number;
  }

  async function fetchRecords(env: Env): Promise<RecordRow[]> {
    const res = await env.app.request("/api/student/records", {
      headers: { cookie: env.aCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    // 红线：进度计数只是公开进度事实，索引行绝不含答案/详解/提示键
    assertNoLeak(body);
    return (body as { data: { records: RecordRow[] } }).data.records;
  }

  it("v1 draft 部分提交：记录行与作业列表带 practiceSubmittedCount=n / N；legacy 草稿缺省（前端回落既有呈现）", async () => {
    const env = await makeEnv();
    const v1 = await startTrackedAttempt(env);
    await saveAnswer(env, v1.attemptId, Q.choice, { kind: "choice", index: 1 });
    // 存答案会推进答案版本 → 提交前重取草稿（与既有闭环用例同序）
    const draft = await fetchDraft(env, v1.attemptId);
    await practiceSubmitOk(env, draft, v1.attemptId, Q.choice);
    // 不带 workflowVersion 的开卷 = 旧协议草稿（对照：不带字段）
    const legacy = await startTrackedAttempt(env, {});

    const rows = await fetchRecords(env);
    const v1Row = rows.find((row) => row.attemptId === v1.attemptId);
    expect(v1Row?.status).toBe("draft");
    expect(v1Row?.practiceSubmittedCount).toBe(1);
    expect(v1Row?.practiceQuestionCount).toBe(3);
    const legacyRow = rows.find((row) => row.attemptId === legacy.attemptId);
    expect(legacyRow?.status).toBe("draft");
    expect(legacyRow?.practiceSubmittedCount).toBeUndefined();
    expect(legacyRow?.practiceQuestionCount).toBeUndefined();

    const asgRes = await env.app.request("/api/student/assignments", {
      headers: { cookie: env.aCookie },
    });
    expect(asgRes.status).toBe(200);
    const asgBody = (await asgRes.json()) as unknown;
    assertNoLeak(asgBody);
    const list = (
      asgBody as {
        data: {
          assignments: {
            id: string;
            status: string;
            questionCount: number;
            practiceSubmittedCount?: number;
          }[];
        };
      }
    ).data.assignments;
    const v1Asg = list.find((entry) => entry.id === v1.asgId);
    expect(v1Asg?.status).toBe("in_progress");
    expect(v1Asg?.questionCount).toBe(3);
    expect(v1Asg?.practiceSubmittedCount).toBe(1);
    const legacyAsg = list.find((entry) => entry.id === legacy.asgId);
    expect(legacyAsg?.status).toBe("in_progress");
    expect(legacyAsg?.practiceSubmittedCount).toBeUndefined();
  });

  it("v1 卷全部题提交自动收尾：记录行整卷口径 n=N；结果视图（GET 详情）携带 practiceWorkflow；legacy 卷结果视图缺省", async () => {
    const env = await makeEnv();
    const { attemptId } = await startTrackedAttempt(env);
    let draft = await fetchDraft(env, attemptId);
    await saveAnswer(env, attemptId, Q.choice, { kind: "choice", index: 1 });
    draft = await fetchDraft(env, attemptId);
    await practiceSubmitOk(env, draft, attemptId, Q.choice);
    await saveAnswer(env, attemptId, Q.judge, { kind: "judge", value: true });
    draft = await fetchDraft(env, attemptId);
    await practiceSubmitOk(env, draft, attemptId, Q.judge);
    await saveAnswer(env, attemptId, Q.fill, { kind: "fill", values: ["1"] });
    draft = await fetchDraft(env, attemptId);
    const last = await practiceSubmitOk(env, draft, attemptId, Q.fill);
    expect(last.data.attempt.status).toBe("submitted");

    const rows = await fetchRecords(env);
    const row = rows.find((entry) => entry.attemptId === attemptId);
    // 已收尾卷 → 整卷口径：整卷已交，行级计数收敛到 N（前端只按 status 呈现）
    expect(row?.status).toBe("submitted");
    expect(row?.practiceSubmittedCount).toBe(3);
    expect(row?.practiceQuestionCount).toBe(3);

    // §13.8：v1 结果视图携带裁决投影（节奏摘要行数据源）；普通接口投影不放宽
    const detailRes = await env.app.request(
      `/api/student/attempts/${attemptId}`,
      {
        headers: { cookie: env.aCookie },
      },
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      data: {
        attempt: { status: string };
        practiceWorkflow?: { feedbackMode: string };
      };
    };
    expect(detail.data.attempt.status).toBe("submitted");
    expect(detail.data.practiceWorkflow?.feedbackMode).toBe("per_question");

    // legacy 卷（旧协议）草稿视图不携带 → 前端不渲染节奏摘要行
    const legacy = await startTrackedAttempt(env, {});
    const legacyRes = await env.app.request(
      `/api/student/attempts/${legacy.attemptId}`,
      { headers: { cookie: env.aCookie } },
    );
    expect(legacyRes.status).toBe(200);
    const legacyDetail = (await legacyRes.json()) as {
      data: { practiceWorkflow?: unknown };
    };
    expect(legacyDetail.data.practiceWorkflow).toBeUndefined();
  });
});
