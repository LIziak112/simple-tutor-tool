import type { ApiErr } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, lectures, type ResponseRow, responses } from "../db/schema";
import { createTestDb, createTestDir } from "../db/test-utils";
import { assertNoLeak } from "../test/assert-no-leak";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * QM-10（TT-09a）服务级验收：取消主观匹配与自评后端。
 * - 细项 1/3：新策略行（开卷冻结 gradingPolicy）fill 与 solve/apply/find-error
 *   交卷不自动匹配（reference 相同/等价/不同/空白恒 null）；旧行（NULL，开关
 *   关闭部署开的卷）solve 等价比较照旧——历史不重释；
 * - 细项 7：graded 放宽（§5.5.5：全部行已提交且无教师待处理行即 graded，
 *   不用空值把完成卷改成教师必批）；reference_self 行不进教师待批队列；
 * - 细项 4/5/6：自评端点校验链、CAS/幂等、教师与自评竞争、assertNoLeak。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-10";
const STUDENT_PASSWORD = "stu-pass-10";

/**
 * 混合练习夹具：choice（客观 auto）+ fill（带参考 reference_self）+ solve
 * （带 :::answer reference_self）+ solve（无参考 manual_only）。旧七型语法，
 * 导入不依赖发布开关；开关只在开卷（冻结 gradingPolicy）时生效。
 */
const QM10_MD = `---
kind: practice
unit: 主观匹配
topic: 混合练习
---

::::question{type=choice difficulty=1 knowledge="客观题"}
单选：$\\frac{1}{2}+\\frac{1}{2}$ 等于几？
- [x] 1
- [ ] 2
::::

::::question{type=fill difficulty=2 knowledge="填空"}
把二分之一化成小数：[[0.5|1/2]]
::::

::::question{type=solve difficulty=3 knowledge="解答"}
计算 $\\frac{1}{2}+\\frac{1}{2}$，写出结果。
:::answer
1
:::

:::solution
详解哨兵：先通分再相加，分母不变分子相加。
:::
::::

::::question{type=solve difficulty=3 knowledge="解答思路"}
用一句话说说你的解题思路。（本题无参考答案，由教师批改。）
::::`;

/** 夹具题目 id（默认规则：单元名-序号） */
const Q = {
  choice: "主观匹配-1",
  fill: "主观匹配-2",
  solveWithRef: "主观匹配-3",
  solveNoRef: "主观匹配-4",
} as const;

type App = ReturnType<typeof createApp>;

interface Qm10Fixture {
  app: App;
  db: Db;
  teacherCookie: string;
  unitId: string;
}

/** 基础夹具：教师 + 导入混合练习单元（旧七型语法，无需发布开关） */
async function makeQm10App(): Promise<Qm10Fixture> {
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
  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: QM10_MD, filename: "主观匹配.md" }),
  });
  if (importRes.status !== 200) {
    throw new Error(`夹具导入失败：${JSON.stringify(await importRes.json())}`);
  }
  const unitId = (
    (await importRes.json()) as { data: { units: { id: string }[] } }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("夹具导入未产出单元");
  return { app, db, teacherCookie, unitId };
}

function extractSessionToken(res: Response, cookie = "tutor_session"): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith(`${cookie}=`));
  if (!line) throw new Error(`响应中没有 ${cookie} cookie`);
  return line.slice(`${cookie}=`.length).split(";")[0] ?? "";
}

async function createStudent(
  app: App,
  teacherCookie: string,
  name: string,
): Promise<string> {
  const res = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: name,
      loginName: name,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { student: { id: string } } }).data
    .student.id;
}

async function loginStudent(app: App, name: string): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_student_session=${extractSessionToken(res, "tutor_student_session")}`;
}

async function createAssignment(
  app: App,
  teacherCookie: string,
  unitId: string,
  studentId: string,
): Promise<string> {
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds: [studentId] }),
  });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { data: { assignments: { id: string }[] } })
    .data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少作业 id");
  return id;
}

/** 在开关指定状态下开卷（§5.8.4：gradingPolicy 冻结读开卷时点的部署开关）。
 *  v1=true 显式请求新协议卷（workflowVersion: 1，M1b 建卷口径——不显式
 *  请求按旧协议建卷）；false 开旧协议卷（legacy 对照）。 */
async function startAttempt(
  app: App,
  aCookie: string,
  assignmentId: string,
  newContentEnabled: boolean,
  v1 = true,
): Promise<string> {
  const previous = process.env.NEW_CONTENT_ENABLED;
  process.env.NEW_CONTENT_ENABLED = newContentEnabled ? "true" : "false";
  let attemptId: string | undefined;
  try {
    const res = await app.request(
      `/api/student/assignments/${assignmentId}/attempt`,
      {
        method: "POST",
        headers: { cookie: aCookie, "content-type": "application/json" },
        ...(v1 ? { body: JSON.stringify({ workflowVersion: 1 }) } : {}),
      },
    );
    expect(res.status).toBe(200);
    attemptId = ((await res.json()) as { data: { id: string } }).data.id;
  } finally {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
  }
  return attemptId;
}

/** PUT 草稿答案（无版本字段 = 旧客户端口径） */
function putAnswer(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
      {
        method: "PUT",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      },
    ),
  );
}

/** 混合作答：choice 答对、fill 与参考相同、solve 与参考相同、无参考 solve 随笔。
 *  逐题断言保存成功（PUT 200）——静默丢稿会让「与参考相同」前提失效 */
async function saveAllAnswers(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<void> {
  const saves: ReadonlyArray<[string, unknown]> = [
    [Q.choice, { kind: "choice", index: 0 }],
    [Q.fill, { kind: "fill", values: ["0.5"] }],
    [Q.solveWithRef, { kind: "final", finalAnswer: "1" }],
    [Q.solveNoRef, { kind: "final", finalAnswer: "先通分再相加" }],
  ];
  for (const [questionId, answer] of saves) {
    const res = await putAnswer(app, cookie, attemptId, questionId, answer);
    expect(res.status).toBe(200);
  }
}

/** 直接读库取该卷全部 responses 行（判分事实断言的单一取数处） */
function responseRowsOf(db: Db, attemptId: string): ResponseRow[] {
  return db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
}

function rowOf(db: Db, attemptId: string, questionId: string): ResponseRow {
  const row = responseRowsOf(db, attemptId).find(
    (r) => r.questionId === questionId,
  );
  if (row === undefined) throw new Error(`测试夹具缺题行：${questionId}`);
  return row;
}

describe("QM-10 细项1/3：新策略行交卷不自动匹配，旧行历史不重释", () => {
  it("reference 相同/等价/不同/空白：新策略 fill 与 solve 均 autoCorrect=null", async () => {
    const { app, db, teacherCookie, unitId } = await makeQm10App();
    const studentId = await createStudent(app, teacherCookie, "张三");
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
    );
    const aCookie = await loginStudent(app, "张三");
    const attemptId = await startAttempt(app, aCookie, assignmentId, true);

    // 冻结策略断言（§5.6 表）：choice=auto、fill/solve 有参考=reference_self、
    // 无参考 solve=manual_only
    expect(rowOf(db, attemptId, Q.choice).gradingPolicy).toBe("auto");
    expect(rowOf(db, attemptId, Q.fill).gradingPolicy).toBe("reference_self");
    expect(rowOf(db, attemptId, Q.solveWithRef).gradingPolicy).toBe(
      "reference_self",
    );
    expect(rowOf(db, attemptId, Q.solveNoRef).gradingPolicy).toBe(
      "manual_only",
    );

    await saveAllAnswers(app, aCookie, attemptId);
    const res = await submitAttemptRequest(app, aCookie, attemptId);
    expect(res.status).toBe(200);

    // 新策略行：fill/solve 答案与参考相同也不自动判（主观匹配取消）
    expect(rowOf(db, attemptId, Q.choice).autoCorrect).toBe(true);
    expect(rowOf(db, attemptId, Q.fill).autoCorrect).toBeNull();
    expect(rowOf(db, attemptId, Q.fill).finalCorrect).toBeNull();
    expect(rowOf(db, attemptId, Q.solveWithRef).autoCorrect).toBeNull();
    expect(rowOf(db, attemptId, Q.solveWithRef).finalCorrect).toBeNull();
    expect(rowOf(db, attemptId, Q.solveNoRef).autoCorrect).toBeNull();
  });

  it("等价形式（1/2 vs 0.5）与不同、空白答案同样不触发新策略行自动判定", async () => {
    const { app, db, teacherCookie, unitId } = await makeQm10App();
    const studentId = await createStudent(app, teacherCookie, "张三");
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
    );
    const aCookie = await loginStudent(app, "张三");
    const attemptId = await startAttempt(app, aCookie, assignmentId, true);
    await putAnswer(app, aCookie, attemptId, Q.fill, {
      kind: "fill",
      values: ["1/2"],
    });
    await putAnswer(app, aCookie, attemptId, Q.solveWithRef, {
      kind: "final",
      finalAnswer: "2.0",
    });
    const res = await submitAttemptRequest(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    expect(rowOf(db, attemptId, Q.fill).autoCorrect).toBeNull();
    expect(rowOf(db, attemptId, Q.solveWithRef).autoCorrect).toBeNull();
  });

  it("旧行（开关关闭开的卷，gradingPolicy=NULL）：solve 等价比较照旧、fill 恒 null、choice 照旧", async () => {
    const { app, db, teacherCookie, unitId } = await makeQm10App();
    const studentId = await createStudent(app, teacherCookie, "李四");
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
    );
    const aCookie = await loginStudent(app, "李四");
    const attemptId = await startAttempt(app, aCookie, assignmentId, false);

    const rows = responseRowsOf(db, attemptId);
    expect(rows.every((r) => r.gradingPolicy === null)).toBe(true);

    await saveAllAnswers(app, aCookie, attemptId);
    const res = await submitAttemptRequest(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    // 历史口径零变化：solve 与参考相同 → true（等价比较），fill 恒 null
    expect(rowOf(db, attemptId, Q.solveWithRef).autoCorrect).toBe(true);
    expect(rowOf(db, attemptId, Q.fill).autoCorrect).toBeNull();
    expect(rowOf(db, attemptId, Q.choice).autoCorrect).toBe(true);
    expect(rowOf(db, attemptId, Q.solveNoRef).autoCorrect).toBeNull();
  });
});

/** 读 attempts 行（status/scoreFinal 断言） */
function attemptRowOf(db: Db, attemptId: string) {
  const row = db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (row === undefined) throw new Error("测试夹具缺 attempt 行");
  return row;
}

/** 教师批注（mark=null 清除） */
async function markResponse(
  app: App,
  teacherCookie: string,
  responseId: string,
  mark: "correct" | "wrong" | null,
): Promise<Response> {
  return app.request(`/api/teacher/responses/${responseId}/mark`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ mark, comment: null }),
  });
}

/** 教师待批队列的题目 id 集合 */
async function pendingMarkQuestionIds(
  app: App,
  teacherCookie: string,
): Promise<string[]> {
  const res = await app.request("/api/teacher/pending-marks", {
    headers: { cookie: teacherCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { marks: { questionId: string }[] };
  };
  return body.data.marks.map((m) => m.questionId);
}

/** 新策略卷开卷→作答→交卷的公共前导（张三 + 交卷回执） */
async function newPolicySubmittedAttempt(): Promise<
  Qm10Fixture & { aCookie: string; attemptId: string }
> {
  const fixture = await makeQm10App();
  const studentId = await createStudent(
    fixture.app,
    fixture.teacherCookie,
    "张三",
  );
  const assignmentId = await createAssignment(
    fixture.app,
    fixture.teacherCookie,
    fixture.unitId,
    studentId,
  );
  const aCookie = await loginStudent(fixture.app, "张三");
  const attemptId = await startAttempt(
    fixture.app,
    aCookie,
    assignmentId,
    true,
  );
  await saveAllAnswers(fixture.app, aCookie, attemptId);
  const res = await submitAttemptRequest(fixture.app, aCookie, attemptId);
  expect(res.status).toBe(200);
  return { ...fixture, aCookie, attemptId };
}

describe("QM-10 细项7：graded 放宽与教师待批边界（§5.5.5/§5.5.3）", () => {
  it("含 manual_only 行的新策略卷交卷 → submitted（教师待处理阻塞 graded），reference_self 行不进必批队列", async () => {
    const { app, db, teacherCookie, attemptId } =
      await newPolicySubmittedAttempt();
    const attempt = attemptRowOf(db, attemptId);
    // manual_only（无参考 solve）未判 → 整卷停留 submitted；scoreFinal 未写
    expect(attempt.status).toBe("submitted");
    expect(attempt.scoreFinal).toBeNull();
    // scoreAuto 分母只含可自动判分行（choice 一题）
    expect(attempt.scoreAuto).toBe(100);
    // 必批队列：只有 manual_only 行；reference_self（fill/solve 有参考）不入队
    const pending = await pendingMarkQuestionIds(app, teacherCookie);
    expect(pending).toContain(Q.solveNoRef);
    expect(pending).not.toContain(Q.fill);
    expect(pending).not.toContain(Q.solveWithRef);
  });

  it("教师判完 manual_only 行 → graded（scoreFinal=round(对/全部)），清除后回落 submitted", async () => {
    const { app, db, teacherCookie, attemptId } =
      await newPolicySubmittedAttempt();
    const manualRow = rowOf(db, attemptId, Q.solveNoRef);
    const markRes = await markResponse(
      app,
      teacherCookie,
      manualRow.id,
      "correct",
    );
    expect(markRes.status).toBe(200);
    // 全部行已提交且无教师待处理行 → graded；scoreFinal = round(2/4×100)=50
    //（choice 对 + 教师判对；reference_self 两行 finalCorrect 恒 null 计分母）
    let attempt = attemptRowOf(db, attemptId);
    expect(attempt.status).toBe("graded");
    expect(attempt.scoreFinal).toBe(50);
    // 清除教师判定 → 该行回到教师待处理 → 整卷回落 submitted、scoreFinal 置 null
    const clearRes = await markResponse(app, teacherCookie, manualRow.id, null);
    expect(clearRes.status).toBe(200);
    attempt = attemptRowOf(db, attemptId);
    expect(attempt.status).toBe("submitted");
    expect(attempt.scoreFinal).toBeNull();
  });

  it("教师批改 reference_self 行写 finalCorrect 且整卷保持 graded；清除后该行不回必批队列", async () => {
    const { app, db, teacherCookie, attemptId } =
      await newPolicySubmittedAttempt();
    // 先判掉 manual_only 行使整卷 graded
    await markResponse(
      app,
      teacherCookie,
      rowOf(db, attemptId, Q.solveNoRef).id,
      "correct",
    );
    expect(attemptRowOf(db, attemptId).status).toBe("graded");

    const fillRow = rowOf(db, attemptId, Q.fill);
    const markRes = await markResponse(
      app,
      teacherCookie,
      fillRow.id,
      "correct",
    );
    expect(markRes.status).toBe(200);
    expect(rowOf(db, attemptId, Q.fill).finalCorrect).toBe(true);
    // 整卷仍 graded（无教师待处理行）；scoreFinal 更新 = round(3/4×100)=75
    //（choice 对 + manual 行教师判对 + fill 教师判对）
    expect(attemptRowOf(db, attemptId).status).toBe("graded");
    expect(attemptRowOf(db, attemptId).scoreFinal).toBe(75);

    // 清除：finalCorrect 回落 autoCorrect（null），不回必批队列（有参考行
    // 恒不进教师必批——§5.5.3）；整卷保持 graded
    const clearRes = await markResponse(app, teacherCookie, fillRow.id, null);
    expect(clearRes.status).toBe(200);
    expect(rowOf(db, attemptId, Q.fill).finalCorrect).toBeNull();
    expect(attemptRowOf(db, attemptId).status).toBe("graded");
    expect(attemptRowOf(db, attemptId).scoreFinal).toBe(50);
    const pending = await pendingMarkQuestionIds(app, teacherCookie);
    expect(pending).not.toContain(Q.fill);
  });

  it("历史卷（旧行 NULL）graded 口径零变化：有待批行停留 submitted，待批队列含旧行", async () => {
    const { app, db, teacherCookie, unitId } = await makeQm10App();
    const studentId = await createStudent(app, teacherCookie, "李四");
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
    );
    const aCookie = await loginStudent(app, "李四");
    // 旧协议卷（不请求 workflowVersion——升级前历史卷的真实形态）
    const attemptId = await startAttempt(
      app,
      aCookie,
      assignmentId,
      false,
      false,
    );
    await saveAllAnswers(app, aCookie, attemptId);
    const res = await submitAttemptRequest(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    // 旧口径：fill 与无参考 solve finalCorrect null → submitted（不放宽）
    const attempt = attemptRowOf(db, attemptId);
    expect(attempt.status).toBe("submitted");
    // 旧行按原语义进待批队列（fill 恒 null 进待批、无参考 solve 待批）
    const pending = await pendingMarkQuestionIds(app, teacherCookie);
    expect(pending).toContain(Q.fill);
    expect(pending).toContain(Q.solveNoRef);
    expect(pending).not.toContain(Q.solveWithRef); // solve 等价判 true 不待批
  });
});

// ---------- 自评端点（QM-10 细项4/5/6） ----------

const uuid = (): string => crypto.randomUUID();

/** POST 自评请求 */
function postSelfReview(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/student/attempts/${attemptId}/questions/${encodeURIComponent(
        questionId,
      )}/self-review`,
      {
        method: "POST",
        headers: {
          ...(cookie === undefined ? {} : { cookie }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

interface SelfReviewDataBody {
  data: {
    selfReview: { verdict: string; at: string; revision: number } | null;
    effective: { source: string; value: boolean } | null;
    summary: Record<string, unknown>;
  };
}

async function selfReviewJson(
  ...args: Parameters<typeof postSelfReview>
): Promise<{
  res: Response;
  body: (SelfReviewDataBody & Record<string, unknown>) | ApiErr;
}> {
  const res = await postSelfReview(...args);
  return {
    res,
    body: (await res.json()) as
      | (SelfReviewDataBody & Record<string, unknown>)
      | ApiErr,
  };
}

const review = (verdict: string, baseRevision = 0) => ({
  verdict,
  baseRevision,
  mutationId: uuid(),
});

/** 响应体错误码（错误壳形态 {ok:false, error}） */
function errCodeOf(body: unknown): string {
  const err = (body as { error?: unknown }).error;
  return typeof err === "string" ? err : "";
}

describe("QM-10 细项4：自评校验链（登录/归属/子题/已提交/公布/策略/参考）", () => {
  it("未登录 401；他人卷 403；题目不在本卷 404；非法参数 400", async () => {
    const { app, teacherCookie, aCookie, attemptId } =
      await newPolicySubmittedAttempt();
    const noAuth = await postSelfReview(
      app,
      undefined,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(noAuth.status).toBe(401);

    await createStudent(app, teacherCookie, "王五");
    const bCookie = await loginStudent(app, "王五");
    const other = await postSelfReview(
      app,
      bCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(other.status).toBe(403);

    const notInPaper = await postSelfReview(
      app,
      aCookie,
      attemptId,
      "主观匹配-999",
      review("correct"),
    );
    expect(notInPaper.status).toBe(404);

    const badVerdict = await postSelfReview(app, aCookie, attemptId, Q.fill, {
      ...review("correct"),
      verdict: "maybe",
    });
    expect(badVerdict.status).toBe(400);
    const badRevision = await postSelfReview(app, aCookie, attemptId, Q.fill, {
      ...review("correct"),
      baseRevision: -1,
    });
    expect(badRevision.status).toBe(400);
  });

  it("未提交行（进行中 per_question 卷）→ 403 SELF_REVIEW_NOT_RELEASED", async () => {
    const { app, teacherCookie, unitId } = await makeQm10App();
    const studentId = await createStudent(app, teacherCookie, "张三");
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
    );
    const aCookie = await loginStudent(app, "张三");
    const attemptId = await startAttempt(app, aCookie, assignmentId, true);
    const { res, body } = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(res.status).toBe(403);
    expect(errCodeOf(body)).toBe("SELF_REVIEW_NOT_RELEASED");
  });

  it("after_due 已收尾未到截止 → 403 SELF_REVIEW_NOT_RELEASED（公布 gate）", async () => {
    const { app, teacherCookie, unitId } = await makeQm10App();
    const studentId = await createStudent(app, teacherCookie, "张三");
    const created = await app.request("/api/teacher/assignments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        unitIds: [unitId],
        studentIds: [studentId],
        answerRelease: "after_due",
        dueAt: "2099-01-01T00:00:00.000Z",
      }),
    });
    expect(created.status).toBe(201);
    const assignmentId = (
      (await created.json()) as {
        data: { assignments: { id: string }[] };
      }
    ).data.assignments[0]?.id;
    if (assignmentId === undefined) throw new Error("after_due 作业创建失败");
    const aCookie = await loginStudent(app, "张三");
    const attemptId = await startAttempt(app, aCookie, assignmentId, true);
    await saveAllAnswers(app, aCookie, attemptId);
    const submitted = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitted.status).toBe(200);
    const { res, body } = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(res.status).toBe(403);
    expect(errCodeOf(body)).toBe("SELF_REVIEW_NOT_RELEASED");
  });

  it("manual_only 行、auto 客观行、旧行（NULL 策略）→ 403 SELF_REVIEW_NOT_ALLOWED", async () => {
    const { app, aCookie, attemptId } = await newPolicySubmittedAttempt();
    for (const questionId of [Q.solveNoRef, Q.choice]) {
      const { res, body } = await selfReviewJson(
        app,
        aCookie,
        attemptId,
        questionId,
        review("correct"),
      );
      expect(res.status).toBe(403);
      expect(errCodeOf(body)).toBe("SELF_REVIEW_NOT_ALLOWED");
    }
    // 历史卷（旧行 NULL）无自评入口（§5.5.4——历史不重释）
    const legacyEnv = await makeQm10App();
    const studentId = await createStudent(
      legacyEnv.app,
      legacyEnv.teacherCookie,
      "李四",
    );
    const assignmentId = await createAssignment(
      legacyEnv.app,
      legacyEnv.teacherCookie,
      legacyEnv.unitId,
      studentId,
    );
    const legacyCookie = await loginStudent(legacyEnv.app, "李四");
    const legacyAttempt = await startAttempt(
      legacyEnv.app,
      legacyCookie,
      assignmentId,
      false,
      false,
    );
    await saveAllAnswers(legacyEnv.app, legacyCookie, legacyAttempt);
    expect(
      (await submitAttemptRequest(legacyEnv.app, legacyCookie, legacyAttempt))
        .status,
    ).toBe(200);
    const { res, body } = await selfReviewJson(
      legacyEnv.app,
      legacyCookie,
      legacyAttempt,
      Q.fill,
      review("correct"),
    );
    expect(res.status).toBe(403);
    expect(errCodeOf(body)).toBe("SELF_REVIEW_NOT_ALLOWED");
  });
});

describe("QM-10 细项5/6：自评写入、幂等/CAS、教师竞争与投影", () => {
  it("首评 correct：写入自评记录、不写 teacherMark/finalCorrect、回 effective=self、汇总随行", async () => {
    const { app, db, aCookie, attemptId } = await newPolicySubmittedAttempt();
    const { res, body } = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(res.status).toBe(200);
    const data = (body as SelfReviewDataBody).data;
    expect(data.selfReview).toMatchObject({ verdict: "correct", revision: 1 });
    expect(data.effective).toEqual({ source: "self", value: true });
    // 汇总随行（已收尾卷：scoreFinal 不因自评变化——教师权威线）
    expect(data.summary).toMatchObject({ total: 4 });
    const row = rowOf(db, attemptId, Q.fill);
    expect(row.selfReviewVerdict).toBe("correct");
    expect(row.selfReviewRevision).toBe(1);
    // 自评不写 teacherMark、不写 finalCorrect（D7）
    expect(row.teacherMark).toBeNull();
    expect(row.finalCorrect).toBeNull();
    expect(attemptRowOf(db, attemptId).status).toBe("submitted");
    assertNoLeak(body, { forbid: ["answers", "solutionMd", "详解哨兵"] });
  });

  it("重复提交（同 mutationId 重试）→ 同回执、revision 不递增", async () => {
    const { app, db, aCookie, attemptId } = await newPolicySubmittedAttempt();
    const mutationId = uuid();
    const first = await selfReviewJson(app, aCookie, attemptId, Q.fill, {
      verdict: "correct",
      baseRevision: 0,
      mutationId,
    });
    expect(first.res.status).toBe(200);
    const replay = await selfReviewJson(app, aCookie, attemptId, Q.fill, {
      verdict: "correct",
      baseRevision: 0,
      mutationId,
    });
    expect(replay.res.status).toBe(200);
    expect((replay.body as SelfReviewDataBody).data.selfReview).toEqual(
      (first.body as SelfReviewDataBody).data.selfReview,
    );
    expect(rowOf(db, attemptId, Q.fill).selfReviewRevision).toBe(1);
  });

  it("旧回执（stale baseRevision）→ 409 SELF_REVIEW_REVISION_CONFLICT 附 _current", async () => {
    const { app, aCookie, attemptId } = await newPolicySubmittedAttempt();
    const first = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(first.res.status).toBe(200);
    // 基于过期基线（应为 1）再次自评
    const stale = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("wrong"),
    );
    expect(stale.res.status).toBe(409);
    expect(errCodeOf(stale.body)).toBe("SELF_REVIEW_REVISION_CONFLICT");
    const current = (stale.body as { _current?: unknown })._current;
    expect(current).toMatchObject({
      selfReview: { verdict: "correct", revision: 1 },
      revision: 1,
    });
    assertNoLeak(stale.body, { forbid: ["answers", "solutionMd", "详解哨兵"] });
  });

  it("修正自评 correct → wrong（新基线）；undecided 撤回清除记录且 revision 递增", async () => {
    const { app, db, aCookie, attemptId } = await newPolicySubmittedAttempt();
    const first = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(first.res.status).toBe(200);
    const corrected = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("wrong", 1),
    );
    expect(corrected.res.status).toBe(200);
    const correctedData = (corrected.body as SelfReviewDataBody).data;
    expect(correctedData.selfReview).toMatchObject({
      verdict: "wrong",
      revision: 2,
    });
    expect(correctedData.effective).toEqual({ source: "self", value: false });
    // 撤回：undecided = 清除自评记录的幂等写（revision 递增）
    const withdrawn = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("undecided", 2),
    );
    expect(withdrawn.res.status).toBe(200);
    const withdrawnData = (withdrawn.body as SelfReviewDataBody).data;
    expect(withdrawnData.selfReview).toBeNull();
    expect(withdrawnData.effective).toBeNull();
    const row = rowOf(db, attemptId, Q.fill);
    expect(row.selfReviewVerdict).toBeNull();
    expect(row.selfReviewRevision).toBe(3);
    // 再评（新基线 3）恢复生效
    const again = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct", 3),
    );
    expect(again.res.status).toBe(200);
    expect((again.body as SelfReviewDataBody).data.effective).toEqual({
      source: "self",
      value: true,
    });
  });

  it("教师先判 → 409 SELF_REVIEW_TEACHER_MARKED（教师优先）", async () => {
    const { app, db, teacherCookie, aCookie, attemptId } =
      await newPolicySubmittedAttempt();
    await markResponse(
      app,
      teacherCookie,
      rowOf(db, attemptId, Q.fill).id,
      "wrong",
    );
    const { res, body } = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("correct"),
    );
    expect(res.status).toBe(409);
    expect(errCodeOf(body)).toBe("SELF_REVIEW_TEACHER_MARKED");
  });

  it("自评先写、教师后判：自评记录保留、教师判定不被覆盖；教师清除后自评恢复生效前提事实保留", async () => {
    const { app, db, teacherCookie, aCookie, attemptId } =
      await newPolicySubmittedAttempt();
    const first = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      Q.fill,
      review("wrong"),
    );
    expect(first.res.status).toBe(200);
    const markRes = await markResponse(
      app,
      teacherCookie,
      rowOf(db, attemptId, Q.fill).id,
      "correct",
    );
    expect(markRes.status).toBe(200);
    const row = rowOf(db, attemptId, Q.fill);
    // 教师判定生效（finalCorrect=teacherMark）；自评记录保留展示（§5.5.1）
    expect(row.teacherMark).toBe("correct");
    expect(row.finalCorrect).toBe(true);
    expect(row.selfReviewVerdict).toBe("wrong");
    expect(row.selfReviewRevision).toBe(1);
    // 教师清除 → teacherMark 回落、自评记录仍在（有效判定回落 self——投影语义）
    await markResponse(
      app,
      teacherCookie,
      rowOf(db, attemptId, Q.fill).id,
      null,
    );
    const cleared = rowOf(db, attemptId, Q.fill);
    expect(cleared.teacherMark).toBeNull();
    expect(cleared.finalCorrect).toBeNull();
    expect(cleared.selfReviewVerdict).toBe("wrong");
  });

  it("assertNoLeak：全部自评响应与错误体无答案/详解/提示内容", async () => {
    const { app, aCookie, attemptId } = await newPolicySubmittedAttempt();
    const forbidden = ["answers", "solutionMd", "hints", "详解哨兵"];
    const cases = [
      await selfReviewJson(app, aCookie, attemptId, Q.fill, review("correct")),
      await selfReviewJson(app, aCookie, attemptId, Q.fill, review("wrong")),
      await selfReviewJson(
        app,
        aCookie,
        attemptId,
        Q.choice,
        review("correct"),
      ),
      await selfReviewJson(
        app,
        aCookie,
        attemptId,
        "主观匹配-999",
        review("correct"),
      ),
    ];
    for (const { body } of cases) {
      assertNoLeak(body, { forbid: forbidden });
    }
  });
});

describe("QM-10：lesson 讲练卷自评（恒当题释放）", () => {
  const LESSON_SELF_MD = `---
kind: lesson
unit: 讲练自评
topic: 测试
---

# 讲练自评页

先算一算。

::::question{type=solve difficulty=2 knowledge="解答"}
计算 1/2 + 1/2。
:::answer
1
:::
::::
`;

  it("单题提交后当题即可自评（进行中卷）", async () => {
    const { app, db, teacherCookie } = await makeQm10App();
    // 讲练页导入需挂在课程下并加学生为成员（学生可见目录前提，与
    // student-lesson.test.ts 夹具同款）
    const created = await app.request("/api/teacher/courses", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ title: "讲练自评课程" }),
    });
    expect(created.status).toBe(201);
    const courseId = ((await created.json()) as { data: { id: string } }).data
      .id;
    const importRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        markdown: LESSON_SELF_MD,
        filename: "讲练自评.md",
        courseId,
      }),
    });
    expect(importRes.status).toBe(200);
    const lecture = db
      .select()
      .from(lectures)
      .all()
      .find((row) => row.deletedAt === null);
    if (lecture === undefined) throw new Error("导入未产出讲练页");
    const studentId = await createStudent(app, teacherCookie, "赵六");
    const added = await app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ studentIds: [studentId] }),
      },
    );
    expect(added.status).toBe(200);
    const aCookie = await loginStudent(app, "赵六");

    // 讲练开卷（开关开启冻结 reference_self）
    const previous = process.env.NEW_CONTENT_ENABLED;
    process.env.NEW_CONTENT_ENABLED = "true";
    let attemptId: string;
    try {
      const startRes = await app.request(
        `/api/student/lectures/${lecture.id}/lesson/start`,
        { method: "POST", headers: { cookie: aCookie } },
      );
      expect(startRes.status).toBe(200);
      attemptId = (
        (await startRes.json()) as { data: { attempt: { id: string } } }
      ).data.attempt.id;
    } finally {
      if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
      else process.env.NEW_CONTENT_ENABLED = previous;
    }
    const lessonRow = rowOf(db, attemptId, "讲练自评-1");
    expect(lessonRow.gradingPolicy).toBe("reference_self");

    // 未提交 → NOT_RELEASED
    const before = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      "讲练自评-1",
      review("correct"),
    );
    expect(before.res.status).toBe(403);
    expect(errCodeOf(before.body)).toBe("SELF_REVIEW_NOT_RELEASED");

    // 单题提交（lesson 旧协议形态）→ 当题释放 → 自评成功
    const submitRes = await app.request(
      `/api/student/attempts/${attemptId}/questions/${encodeURIComponent("讲练自评-1")}/submit`,
      {
        method: "POST",
        headers: { cookie: aCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ questionRevisionId: lessonRow.id }),
      },
    );
    expect(submitRes.status).toBe(200);
    const { res, body } = await selfReviewJson(
      app,
      aCookie,
      attemptId,
      "讲练自评-1",
      review("correct"),
    );
    expect(res.status).toBe(200);
    expect((body as SelfReviewDataBody).data.effective).toEqual({
      source: "self",
      value: true,
    });
    assertNoLeak(body, { forbid: ["answers", "solutionMd"] });
  });
});
