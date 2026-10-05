import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  type AttemptDraftData,
  type AttemptResultData,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  type StudentAssignmentListData,
  studentPaperDataSchema,
} from "@tutor/contract";
import { studentStemMd } from "@tutor/md-dsl";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, questions, responses, units } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { assertNoStemLeak } from "../test/assert-no-stem-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * 作答生命周期集成测试（T2.6 全部验收项，app.request() 直调路由 + 内存库）：
 * - 验收项 1：重复 submit → 409 ALREADY_SUBMITTED；
 * - 验收项 2：提交后编辑题目（PUT /api/teacher/questions/:id，version+1）→
 *   GET attempt 结果视图仍显示快照旧内容（responses.questionVersion 冻结）；
 * - 幂等创建：两次 POST /attempt 同 id；已提交后再 POST 返回已交的那份；
 * - 草稿保存/读取往返、changeCount 递增、非法 answer 400、跨单元题 404、已交后 PUT 409；
 * - 判分正确性（全对/部分错/未答组合）与 scoreAuto 口径（答对数/可自动判分数）；
 * - 泄露：draft 视图 assertNoLeak；submitted 视图放行答案/详解键后断言无提示内容；
 * - 越权：非本人 attempt 403、未登录 401、教师会话 401；
 * - 作业状态联动：开始作答 in_progress、交卷后 submitted；
 * - T2A.8 答案公布时机：after_due 截止前 submit/详情两份响应受限（逐字段 +
 *   assertNoLeak + 未解锁提示矩阵）、截止后完整、教师端 400 三态之创建/取消截止。
 * 夹具用 samples/v2/练习样例.md（八题七题型；题号顺序与 student-paper.test 一致）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
const NOT_FOUND_UUID = "00000000-0000-4000-8000-000000000000";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

/** 样例八题的 id（顺序 = 单元题序） */
const Q = {
  judge: "练习四-1",
  choice: "练习四-2",
  multi: "练习四-3",
  fill: "练习四-4",
  fillMath: "练习四-5",
  solve: "p4-q7",
  apply: "练习四-7",
  findError: "练习四-8",
} as const;

/** 全部答对的一套答案（fill 第三空用等价分数 1/2；solve/apply 用最终答案；
 *  find-error 的 :::answer 是长文本，逐字作答原文才能自动判对——顺带锁定文本类
 *  最终答案按归一化字符串比较的行为） */
const ALL_CORRECT_ANSWERS: Record<string, unknown> = {
  [Q.judge]: { kind: "judge", value: true },
  [Q.choice]: { kind: "choice", index: 1 },
  [Q.multi]: { kind: "multi", indexes: [0, 2] },
  [Q.fill]: { kind: "fill", values: ["4", "-7", "1/2"] },
  [Q.fillMath]: { kind: "fill", values: ["-3"] },
  [Q.solve]: { kind: "final", finalAnswer: "-3" },
  [Q.apply]: { kind: "final", finalAnswer: "1.4" },
  [Q.findError]: {
    kind: "final",
    finalAnswer:
      "第一步开始出错：$-8$ 与 $+3$ 是异号相加，应取绝对值较大的加数（$8$）的符号，并用 $8-3=5$，得 $-5$。",
  },
};

type App = ReturnType<typeof createApp>;

/**
 * 「全对 → 交卷即 graded」用例的整卷可自动判分夹具（2026-10-02 fill 全人工
 * 批改起需要）：把样例两道 fill（练习四-4/5）替换为同题号位置的 judge/choice，
 * 其余六题不动——样例原卷含 fill 后交卷必进待批（status=submitted），
 * 「客观题全对即 graded」的断言语义需要不含 fill 的卷才能保住。
 */
const NO_FILL_MD = PRACTICE_MD.replace(
  `::::question{type=fill difficulty=2 knowledge="有理数加法"}
计算：$(-3)+7=$ [[4]]；$(-2)+(-5)=$ [[-7]]。

写等价形式：$0.5=$ [[0.5|1/2]]（填小数或分数均可）。

:::hint
同号相加，取相同的符号，并把绝对值相加；异号相加，取绝对值较大的加数的符号，并用较大的绝对值减去较小的绝对值。
:::

:::solution
$(-3)+7=4$；$(-2)+(-5)=-7$；$0.5=\\dfrac{1}{2}$。
:::
::::`,
  `::::question{type=judge difficulty=2 knowledge="有理数加法"}
$(-3)+7=4$ 且 $(-2)+(-5)=-7$。[[正确]]

:::solution
异号相加取绝对值较大者的符号：$(-3)+7=4$；同号相加取相同的符号：$(-2)+(-5)=-7$。
:::
::::`,
).replace(
  `::::question{type=fill difficulty=3 knowledge="数轴与有理数加减"}
观察下面的下标记号：$a_{[[1]]}$ 与 $a_{[[2]]}$ 只是公式内部的记号（不构成作答空位）。若 $a_{1}=2$，$a_{2}=-5$，则 $a_{1}+a_{2}=$ [[-3]]。

:::solution
$a_{1}+a_{2}=2+(-5)=-3$。题干公式里的 $[[1]]$、$[[2]]$ 位于 $…$ 数学环境内，不是填空标记。
:::
::::`,
  `::::question{type=choice difficulty=3 knowledge="数轴与有理数加减"}
若 $a_{1}=2$，$a_{2}=-5$，则 $a_{1}+a_{2}=$（　）

- [ ] $7$
- [ ] $-7$
- [x] $-3$
- [ ] $3$

:::solution
$a_{1}+a_{2}=2+(-5)=-3$，故选 C。
:::
::::`,
);

/** NO_FILL_MD 卷的全部答对答案（练习四-4/5 已换为 judge/choice） */
const NO_FILL_ANSWERS: Record<string, unknown> = {
  ...ALL_CORRECT_ANSWERS,
  [Q.fill]: { kind: "judge", value: true },
  [Q.fillMath]: { kind: "choice", index: 2 },
};

/** 全套前置：教师 + 导入样例 + 张三（被指派）/李四（未被指派）+ 一份作业 */
async function makeAttemptApp(markdown: string = PRACTICE_MD): Promise<{
  app: App;
  db: Db;
  teacherCookie: string;
  aId: string;
  bId: string;
  aCookie: string;
  bCookie: string;
  assignmentId: string;
}> {
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
    body: JSON.stringify({ markdown, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  const imported = (await importRes.json()) as {
    data: { units: { id: string }[] };
  };
  const unitId = imported.data.units[0]?.id;
  if (!unitId) throw new Error("样例导入未产出单元");

  const aId = await createStudent(app, teacherCookie, "张三");
  const bId = await createStudent(app, teacherCookie, "李四");
  const assignmentId = await createAssignment(app, teacherCookie, unitId, aId);
  return {
    app,
    db,
    teacherCookie,
    aId,
    bId,
    aCookie: await loginStudent(app, "张三"),
    bCookie: await loginStudent(app, "李四"),
    assignmentId,
  };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
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
  const body = (await res.json()) as { data: { student: { id: string } } };
  return body.data.student.id;
}

async function loginStudent(app: App, name: string): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_session=${extractSessionToken(res)}`;
}

async function createAssignment(
  app: App,
  teacherCookie: string,
  unitId: string,
  studentId: string,
  extraBody: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      unitIds: [unitId],
      studentIds: [studentId],
      ...extraBody,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    data: { assignments: { id: string }[] };
  };
  const id = body.data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少作业 id");
  return id;
}

/** POST /attempt，返回原始 Response */
function postAttempt(
  app: App,
  cookie: string | undefined,
  assignmentId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/assignments/${assignmentId}/attempt`, {
      method: "POST",
      headers: cookie === undefined ? {} : { cookie },
    }),
  );
}

/** POST /attempt（断言 200）并取 data */
async function startAttemptOk(
  app: App,
  cookie: string,
  assignmentId: string,
): Promise<Record<string, unknown>> {
  const res = await postAttempt(app, cookie, assignmentId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** PUT 草稿答案 */
function putAnswer(
  app: App,
  cookie: string | undefined,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/answers/${questionId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ answer }),
    }),
  );
}

/** POST 交卷（T6R.3：经共享 submitAttemptRequest 自动回传题目版本集合） */
function postSubmit(
  app: App,
  cookie: string | undefined,
  attemptId: string,
): Promise<Response> {
  return submitAttemptRequest(app, cookie, attemptId);
}

/** GET attempt 详情（200 时一并取 body） */
async function getAttempt(
  app: App,
  cookie: string | undefined,
  attemptId: string,
): Promise<{ res: Response; body: unknown }> {
  const res = await app.request(`/api/student/attempts/${attemptId}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  return { res, body: res.status === 200 ? await res.json() : undefined };
}

/** 学生作业列表 */
async function listAssignments(
  app: App,
  cookie: string,
): Promise<StudentAssignmentListData> {
  const res = await app.request("/api/student/assignments", {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: StudentAssignmentListData }).data;
}

describe("POST /api/student/assignments/:id/attempt：创建与幂等", () => {
  it("创建进行中 attempt；两次 POST 返回同一 id（一人一份进行中，库里一行）", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const first = await startAttemptOk(app, aCookie, assignmentId);
    expect(
      attemptStartOkSchema.safeParse({ ok: true, data: first }).success,
    ).toBe(true);
    expect(first.status).toBe("draft");
    // T2A.7：多单元化后作业来源 attempt 的 unitId 为 null（题目集合走 assignment_units）
    expect(first.unitId).toBeNull();

    const second = await startAttemptOk(app, aCookie, assignmentId);
    expect(second.id).toBe(first.id);
    expect(db.select().from(attempts).all().length).toBe(1);
  });

  it("已交卷后再 POST 返回已交的那份（status=submitted，不另开新卷）", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    const again = await startAttemptOk(app, aCookie, assignmentId);
    expect(again.id).toBe(attemptId);
    expect(again.status).toBe("submitted");
    expect(db.select().from(attempts).all().length).toBe(1);
  });

  it("权限：未指派学生 403 FORBIDDEN；未登录 401；教师会话 401；作业不存在 404", async () => {
    const { app, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeAttemptApp();

    const forbidden = await postAttempt(app, bCookie, assignmentId);
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as ApiErr).error).toBe("FORBIDDEN");

    expect((await postAttempt(app, undefined, assignmentId)).status).toBe(401);
    expect((await postAttempt(app, teacherCookie, assignmentId)).status).toBe(
      401,
    );
    const notFound = await postAttempt(app, aCookie, NOT_FOUND_UUID);
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as ApiErr).error).toBe(
      "ASSIGNMENT_NOT_FOUND",
    );
  });
});

describe("学生侧 attempt 接口鉴权口径（T5：入口类查可见性 / 续作类归属即权限）", () => {
  /**
   * 口径（attempt-service 文件头注释为权威）：
   * - 入口类（从列表/目录进入）：GET /assignments、GET /assignments/:id/paper、
   *   POST /assignments/:id/attempt——被移出名单 → 403，作业软删 → 404；
   * - 续作类（已持有 attemptId 的 /attempts/:id/*）：归属即权限
   *   （requireOwnAttempt），assignment 来源不叠加可见性校验——与
   *   「删除作业不删除已有作答记录」「被移出后已建作答仍可继续」一致；
   *   course 来源 + draft 的重校验是 D7/D22 特例（见 student-course-attempts）。
   */

  /** 把张三移出作业名单（已开始的学生需 confirmStarted，D13 移出立即不可见） */
  async function removeFromRoster(
    app: App,
    teacherCookie: string,
    assignmentId: string,
    studentId: string,
  ): Promise<void> {
    const res = await app.request(`/api/teacher/assignments/${assignmentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        removeStudentIds: [studentId],
        confirmStarted: true,
      }),
    });
    expect(res.status).toBe(200);
  }

  it("入口类：被移出名单的学生 POST /assignments/:id/attempt → 403（不能再开新卷或取回旧卷）", async () => {
    const { app, db, teacherCookie, aCookie, aId, assignmentId } =
      await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    await removeFromRoster(app, teacherCookie, assignmentId, aId);

    // 移出前已有 draft：POST /attempt 也不得取回它（requireAssignmentVisible
    // 的在册判定含 removedAt IS NULL，与 T2.4 paper 接口同口径，D13）
    const reopened = await postAttempt(app, aCookie, assignmentId);
    expect(reopened.status).toBe(403);
    expect(((await reopened.json()) as ApiErr).error).toBe("FORBIDDEN");
    // 幂等取回确实被拦住：库里仍是那一份（没有被新建）
    const rows = db
      .select()
      .from(attempts)
      .where(eq(attempts.assignmentId, assignmentId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(attemptId);
  });

  it("续作类：被移出名单但已建 draft 的学生 GET /attempts/:id/paper → 200（与详情 200 同口径）", async () => {
    const { app, teacherCookie, aCookie, aId, assignmentId } =
      await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    await removeFromRoster(app, teacherCookie, assignmentId, aId);

    // 详情（归属即权限）照常 200
    expect((await getAttempt(app, aCookie, attemptId)).res.status).toBe(200);

    // 通用取卷与详情同口径：不再叠加 requireAssignmentVisible
    // （被移出后已建作答仍可继续，§5.2）
    const paper = await app.request(
      `/api/student/attempts/${attemptId}/paper`,
      {
        headers: { cookie: aCookie },
      },
    );
    expect(paper.status).toBe(200);
    const body = (await paper.json()) as unknown;
    expect(
      studentPaperDataSchema.safeParse((body as { data: unknown }).data)
        .success,
    ).toBe(true);
    // 续作类取卷仍是草稿阶段：不得泄露答案/详解（AGENTS 第 3 条）
    assertNoLeak(body);
    assertNoStemLeak(body);
  });

  it("续作类：作业软删后已建 draft 的学生 GET /attempts/:id/paper → 200（作答记录不随作业软删消失）", async () => {
    const { app, teacherCookie, aCookie, assignmentId } =
      await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    const del = await app.request(`/api/teacher/assignments/${assignmentId}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);

    expect((await getAttempt(app, aCookie, attemptId)).res.status).toBe(200);
    const paper = await app.request(
      `/api/student/attempts/${attemptId}/paper`,
      {
        headers: { cookie: aCookie },
      },
    );
    expect(paper.status).toBe(200);
    const paperJsonBody = await paper.json();
    assertNoLeak(paperJsonBody);
    assertNoStemLeak(paperJsonBody);
  });

  it("摘要归一化：旧库回填的 assignment 来源 attempt（unitId 非空）→ startAttempt/详情摘要 unitId 恒 null", async () => {
    const { app, db, aCookie, aId, assignmentId } = await makeAttemptApp();
    const unitId = db.select().from(units).all()[0]?.id;
    if (!unitId) throw new Error("样例未产出单元");

    // 模拟 D23-6 回填数据：assignment 来源行带历史非空 unitId（原值保留）
    const legacyId = crypto.randomUUID();
    db.insert(attempts)
      .values({
        id: legacyId,
        studentId: aId,
        sourceType: "assignment",
        assignmentId,
        courseId: null,
        unitId,
        attemptNo: 1,
        status: "draft",
        startedAt: new Date().toISOString(),
        submittedAt: null,
        activeSec: null,
        device: null,
        scoreAuto: null,
        scoreFinal: null,
      })
      .run();
    // 前置：库行确为历史非空值（归一化只发生在摘要层，不回写库）
    expect(
      db.select().from(attempts).where(eq(attempts.id, legacyId)).get()?.unitId,
    ).toBe(unitId);

    // startAttempt 幂等取回该 draft：摘要按契约口径归一化（assignment 恒 null）
    const started = await startAttemptOk(app, aCookie, assignmentId);
    expect(started.id).toBe(legacyId);
    expect(started.unitId).toBeNull();
    expect(
      attemptStartOkSchema.safeParse({ ok: true, data: started }).success,
    ).toBe(true);

    // 详情（草稿视图）内嵌摘要同样归一化
    const { res, body } = await getAttempt(app, aCookie, legacyId);
    expect(res.status).toBe(200);
    const draft = (body as { data: AttemptDraftData }).data;
    expect(draft.attempt.unitId).toBeNull();
    expect(attemptDraftOkSchema.safeParse(body).success).toBe(true);
  });
});

describe("PUT /api/student/attempts/:id/answers/:questionId：草稿保存", () => {
  it("保存后 GET 详情可读回（往返）；重复保存 changeCount 递增", async () => {
    const { app, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;

    const first = await putAnswer(
      app,
      aCookie,
      attemptId,
      Q.judge,
      ALL_CORRECT_ANSWERS[Q.judge],
    );
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { data: { changeCount: number } }).data
        .changeCount,
    ).toBe(1);

    // 改答案再存：changeCount=2
    const second = await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: false,
    });
    expect(
      ((await second.json()) as { data: { changeCount: number } }).data
        .changeCount,
    ).toBe(2);

    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const draft = (body as { data: AttemptDraftData }).data;
    expect(draft.attempt.status).toBe("draft");
    expect(draft.drafts[Q.judge]).toEqual({ kind: "judge", value: false });
  });

  it("非法 answer 400 VALIDATION_ERROR（下标为负 / kind 未知）", async () => {
    const { app, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;

    const bad1 = await putAnswer(app, aCookie, attemptId, Q.choice, {
      kind: "choice",
      index: -1,
    });
    expect(bad1.status).toBe(400);
    expect(((await bad1.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const bad2 = await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "essay",
      text: "不存在题型",
    });
    expect(bad2.status).toBe(400);
  });

  it("跨单元题 404 QUESTION_NOT_FOUND；开卷后软删的题仍在冻结集合（T6R.3 可继续作答）；开卷前软删的题不进卷（404）", async () => {
    const { app, teacherCookie, aCookie, bId, bCookie, assignmentId } =
      await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;

    // 导入第二份练习生成另一单元（题目 id 前缀不同）
    const otherMd = PRACTICE_MD.replace("unit: 练习四", "unit: 练习五").replace(
      /练习四-/g,
      "练习五-",
    );
    const commit = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: otherMd, filename: "练习五.md" }),
    });
    expect(commit.status).toBe(200);

    const cross = await putAnswer(app, aCookie, attemptId, "练习五-1", {
      kind: "judge",
      value: true,
    });
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");

    // T6R.3：开卷后软删——题在冻结集合内，继续可作答（当前卷显示与判分一致，
    // 软删不再把题从进行中的卷里移走；详见 attempt-freeze.test.ts）
    const del = await app.request(`/api/teacher/questions/${Q.apply}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);
    const frozenStill = await putAnswer(app, aCookie, attemptId, Q.apply, {
      kind: "final",
      finalAnswer: "1.4",
    });
    expect(frozenStill.status).toBe(200);

    // 对照：开卷前软删的题不进新卷（把李四加进名单后开新卷 → 该题 404）
    const del2 = await app.request(`/api/teacher/questions/${Q.judge}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del2.status).toBe(200);
    const addB = await app.request(`/api/teacher/assignments/${assignmentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ addStudentIds: [bId] }),
    });
    expect(addB.status).toBe(200);
    const bAttemptId = (await startAttemptOk(app, bCookie, assignmentId))
      .id as string;
    const neverFrozen = await putAnswer(app, bCookie, bAttemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    expect(neverFrozen.status).toBe(404);
  });

  it("已交卷后 PUT 409 ALREADY_SUBMITTED；非本人 attempt 403；attempt 不存在 404", async () => {
    const { app, aCookie, bCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    const put = await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    expect(put.status).toBe(409);
    expect(((await put.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");

    expect(
      (
        await putAnswer(app, bCookie, attemptId, Q.judge, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await putAnswer(app, aCookie, NOT_FOUND_UUID, Q.judge, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(404);
  });
});

describe("POST /api/student/attempts/:id/submit：判分与快照", () => {
  it("全对组合：逐题 autoCorrect=true，scoreAuto=100，summary 齐全；全客观题卷交卷即 graded（D2/D3）", async () => {
    // 2026-10-02 fill 全人工批改起换 NO_FILL_MD 卷（两道 fill → judge/choice）：
    // 「全对 → 交卷即 graded」的断言语义需要整卷可自动判分（含 fill 的卷恒进待批，
    // 见「部分错/未答组合」用例的 fill=null 断言）
    const { app, db, aCookie, assignmentId } = await makeAttemptApp(NO_FILL_MD);
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    for (const [questionId, answer] of Object.entries(NO_FILL_ANSWERS)) {
      const res = await putAnswer(app, aCookie, attemptId, questionId, answer);
      expect(res.status, `保存 ${questionId} 失败`).toBe(200);
    }
    const res = await postSubmit(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: AttemptResultData }).data;
    // D3：交卷同时写 finalCorrect=autoCorrect，全部非 null → 直接 graded；
    // D2：scoreFinal = 8/8 = 100（此时与 scoreAuto 分母相同、数值相等）
    expect(data.attempt.status).toBe("graded");
    expect(data.attempt.scoreAuto).toBe(100);
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.status).toBe("graded");
    expect(attemptRow?.scoreFinal).toBe(100);
    expect(data.summary).toEqual({
      total: 8,
      answered: 8,
      correct: 8,
      wrong: 0,
      pending: 0,
      unanswered: 0,
      autoGradable: 8,
      // D9：全部判定完成 → scoreFinal=100、待批 0
      scoreFinal: 100,
      pendingCount: 0,
    });
    // 展开全部题目后逐题断言（every 对空数组恒真，units 为空时会真空通过）：
    // 总数 8 与 summary.total 呼应，再逐题 autoCorrect=true
    const allQuestions = data.units.flatMap((unit) => unit.questions);
    expect(allQuestions).toHaveLength(8);
    for (const q of allQuestions) {
      expect(q.autoCorrect, `题目 ${q.questionId} 应判对`).toBe(true);
    }
  });

  it("部分错/未答组合：答错 false、未答客观题 false（D1）、未答手写题与 fill 恒 null；scoreAuto=答对/可判分；finalCorrect 同步写（D3）", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    // 对：judge、solve；错：multi（漏选）；fill 答但部分空错（2026-10-02 起恒 null
    // 不自动判）；未答：choice（D1 判错）、fillMath、apply、findError（null 进待批）
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    await putAnswer(app, aCookie, attemptId, Q.multi, {
      kind: "multi",
      indexes: [0],
    });
    await putAnswer(app, aCookie, attemptId, Q.fill, {
      kind: "fill",
      values: ["4", "-6", "0.5"],
    });
    await putAnswer(app, aCookie, attemptId, Q.solve, {
      kind: "final",
      finalAnswer: "-3",
    });

    const res = await postSubmit(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: AttemptResultData }).data;
    const byId = new Map(
      data.units
        .flatMap((unit) => unit.questions)
        .map((q) => [q.questionId, q]),
    );

    expect(byId.get(Q.judge)?.autoCorrect).toBe(true);
    expect(byId.get(Q.solve)?.autoCorrect).toBe(true); // -3 与 \frac 写法数值等价
    expect(byId.get(Q.multi)?.autoCorrect).toBe(false); // 漏选 → false
    expect(byId.get(Q.choice)?.autoCorrect).toBe(false); // 未答客观题 → false（D1）
    expect(byId.get(Q.fill)?.autoCorrect).toBeNull(); // fill 全人工批改：答了也不自动判
    expect(byId.get(Q.fillMath)?.autoCorrect).toBeNull(); // 未答 fill 亦进待批（2026-10-02）
    expect(byId.get(Q.apply)?.autoCorrect).toBeNull(); // 未答手写 → null（进待批）
    expect(byId.get(Q.findError)?.autoCorrect).toBeNull();

    // scoreAuto = 答对 2 / 可自动判分 4（judge/solve 对、multi 漏选错、未答 choice
    // 错；两道 fill 不进分母）= 50（四舍五入百分比）
    expect(data.attempt.scoreAuto).toBe(50);
    expect(data.summary.correct).toBe(2);
    expect(data.summary.wrong).toBe(2);
    expect(data.summary.pending).toBe(4);
    expect(data.summary.unanswered).toBe(4);
    expect(data.summary.autoGradable).toBe(4);
    // 存在待批（两道 fill + 两道手写）→ attempt 保持 submitted、scoreFinal=null（D2/D3）
    expect(data.attempt.status).toBe("submitted");

    // 未答题也写了 responses 行（answerJson=null、快照非空、版本冻结）
    const rows = db.select().from(responses).all();
    expect(rows.length).toBe(8);
    const unansweredRow = rows.find((row) => row.questionId === Q.apply);
    expect(unansweredRow?.answerJson).toBeNull();
    expect(unansweredRow?.questionSnapshotJson).toContain("水箱水位");
    expect(unansweredRow?.autoCorrect).toBeNull();
    expect(unansweredRow?.finalCorrect).toBeNull(); // 手写未答 → finalCorrect 仍空（待批）
    expect(unansweredRow?.questionVersion).toBe(1);
    // D3：finalCorrect = autoCorrect 逐题同步写入（已判题不再为 null）
    const judgeRow = rows.find((row) => row.questionId === Q.judge);
    expect(judgeRow?.finalCorrect).toBe(true);
    const choiceRow = rows.find((row) => row.questionId === Q.choice);
    expect(choiceRow?.autoCorrect).toBe(false); // D1：未作答客观题判错
    expect(choiceRow?.finalCorrect).toBe(false);
    const fillMathRow = rows.find((row) => row.questionId === Q.fillMath);
    expect(fillMathRow?.autoCorrect).toBeNull(); // 未答 fill → 待批（不判错）
    expect(fillMathRow?.finalCorrect).toBeNull();
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.status).toBe("submitted");
    expect(attemptRow?.scoreAuto).toBe(50);
    expect(attemptRow?.scoreFinal).toBeNull();
  });

  it("多选空选 = 未作答 → false（D1 集成验收：学生选后又全部取消）", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    // 先选后清空（保存空选集合），交卷后判 false 而非 null（不进待批）
    await putAnswer(app, aCookie, attemptId, Q.multi, {
      kind: "multi",
      indexes: [0, 2],
    });
    await putAnswer(app, aCookie, attemptId, Q.multi, {
      kind: "multi",
      indexes: [],
    });
    const res = await postSubmit(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: AttemptResultData }).data;
    const multi = data.units
      .flatMap((unit) => unit.questions)
      .find((q) => q.questionId === Q.multi);
    expect(multi?.answer).toEqual({ kind: "multi", indexes: [] });
    expect(multi?.autoCorrect).toBe(false);
    const multiRow = db
      .select()
      .from(responses)
      .all()
      .find((row) => row.questionId === Q.multi);
    expect(multiRow?.finalCorrect).toBe(false);
    // 空选不进待批：pending = 两道 fill（全人工批改）+ 三道手写未答 = 5
    expect(data.summary.pending).toBe(5);
  });

  it("验收项 1：重复 submit 返回 409 ALREADY_SUBMITTED", async () => {
    const { app, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);
    const second = await postSubmit(app, aCookie, attemptId);
    expect(second.status).toBe(409);
    expect(((await second.json()) as ApiErr).error).toBe("ALREADY_SUBMITTED");
  });

  it("验收项 2：提交后编辑题目（version+1），结果视图仍显示快照旧内容", async () => {
    const { app, db, teacherCookie, aCookie, assignmentId } =
      await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    await putAnswer(
      app,
      aCookie,
      attemptId,
      Q.fill,
      ALL_CORRECT_ANSWERS[Q.fill],
    );
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    // 教师编辑该题：改题干与答案（id 不变、version+1）
    const detail = await app.request(`/api/teacher/questions/${Q.fill}`, {
      headers: { cookie: teacherCookie },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { data: { sourceMd: string } };
    const editedSource = detailBody.data.sourceMd
      .replace("[[4]]", "[[5]]")
      .replace("$(-3)+7=$", "$(-3)+8=$");
    const edit = await app.request(`/api/teacher/questions/${Q.fill}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ sourceMd: editedSource }),
    });
    expect(edit.status).toBe(200);
    expect(
      ((await edit.json()) as { data: { version: number } }).data.version,
    ).toBe(2);

    // 结果视图：仍是旧题干（$(-3)+7=$ 未被编辑后的 $(-3)+8=$ 取代）与旧参考答案；
    // 题干为学生端投影形态——[[4]]/[[5]] 标记均不残留（旧答案经 answers 键断言）
    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const data = (body as { data: AttemptResultData }).data;
    const fill = data.units
      .flatMap((unit) => unit.questions)
      .find((q) => q.questionId === Q.fill);
    expect(fill?.snapshot.stemMd).toContain("$(-3)+7=$");
    expect(fill?.snapshot.stemMd).not.toContain("$(-3)+8=$");
    expect(fill?.snapshot.stemMd).not.toContain("[[4]]");
    expect(fill?.snapshot.stemMd).not.toContain("[[5]]");
    expect(fill?.answers).toEqual({
      kind: "fill",
      blanks: [["4"], ["-7"], ["0.5", "1/2"]],
    });
    // responses 行的 questionVersion 冻结在提交时（1），不随编辑变 2
    const row = db
      .select()
      .from(responses)
      .all()
      .find((r) => r.questionId === Q.fill);
    expect(row?.questionVersion).toBe(1);
    // 对照：库中题目当前版本确已 +1（编辑生效，仅历史行不变）
    const questionRow = db
      .select()
      .from(questions)
      .all()
      .find((r) => r.id === Q.fill);
    expect(questionRow?.version).toBe(2);

    // 交卷后不能再交（新内容不触发重新判分）
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(409);
  });

  it("非本人交卷 403；attempt 不存在 404；未登录 401", async () => {
    const { app, aCookie, bCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    expect((await postSubmit(app, bCookie, attemptId)).status).toBe(403);
    expect((await postSubmit(app, aCookie, NOT_FOUND_UUID)).status).toBe(404);
    expect((await postSubmit(app, undefined, attemptId)).status).toBe(401);
  });
});

describe("GET /api/student/attempts/:id：草稿视图与结果视图", () => {
  it("草稿视图：题目为公开形态（脱敏题干/无选项标记），assertNoLeak 全量通过", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    await putAnswer(app, aCookie, attemptId, Q.fill, {
      kind: "fill",
      values: ["4", "", ""],
    });

    // 前置：库里确实有答案/详解/提示（泄露才是有意义的风险）
    expect(
      db
        .select()
        .from(questions)
        .all()
        .some((q) => q.answersJson != null && q.hintsJson !== "[]"),
    ).toBe(true);

    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    expect(attemptDraftOkSchema.safeParse(body).success).toBe(true);
    assertNoLeak(body);
    assertNoStemLeak(body);
    const draft = (body as { data: AttemptDraftData }).data;
    // T2A.7：分组结构（样例单单元 → units 恰 1 组，组内 8 题按题序）
    expect(draft.units.length).toBe(1);
    const draftQuestions = draft.units[0]?.questions ?? [];
    expect(draftQuestions.length).toBe(8);
    expect(draftQuestions.map((q) => q.id)).toEqual([
      Q.judge,
      Q.choice,
      Q.multi,
      Q.fill,
      Q.fillMath,
      Q.solve,
      Q.apply,
      Q.findError,
    ]);
    // 题干脱敏：无任何 [[答案]] 残留；选项无正确项标记；详解文本绝不出现
    expect(JSON.stringify(draftQuestions)).not.toContain("[[4]]");
    expect(JSON.stringify(draftQuestions)).not.toContain("[[正确]]");
    expect(JSON.stringify(body)).not.toContain("correct");
    expect(JSON.stringify(body)).not.toContain("故选 B");
  });

  it("结果视图：允许答案/详解键（assertNoLeak allow），但提示内容绝不出现", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);
    // 交卷后允许下发参考答案（answers/answer）与详解（solutionMd）；
    // 提示内容（hint/hints 键）仍不得出现
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });
    assertNoStemLeak(body);
    // 逐条比对库里的提示文本：结果视图 JSON 不含任何一条
    const hintTexts = db
      .select({ hintsJson: questions.hintsJson })
      .from(questions)
      .all()
      .flatMap((row) => JSON.parse(row.hintsJson) as string[]);
    expect(hintTexts.length).toBeGreaterThanOrEqual(5); // 前置：样例确有提示
    const serialized = JSON.stringify(body);
    for (const hint of hintTexts) {
      expect(serialized).not.toContain(hint);
    }
    // 详解与参考答案确实下发了（交卷后语义）；题干为学生端投影——填空标记
    // 脱敏为 [[]]、原始 [[4]] 不残留（答案经 answers 键下发，下方逐题断言）
    const data = (body as { data: AttemptResultData }).data;
    expect(JSON.stringify(data)).toContain("故选 B");
    expect(JSON.stringify(data)).toContain("[[]]");
    expect(JSON.stringify(data)).not.toContain("[[4]]");
    const judge = data.units
      .flatMap((unit) => unit.questions)
      .find((q) => q.questionId === Q.judge);
    expect(judge?.answers).toEqual({ kind: "judge", value: true });
    expect(judge?.answer).toEqual({ kind: "judge", value: true });
    expect(judge?.autoCorrect).toBe(true);
  });

  it("非本人 GET 403；attempt 不存在 404；未登录 401；教师会话 401", async () => {
    const { app, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;

    expect((await getAttempt(app, bCookie, attemptId)).res.status).toBe(403);
    expect((await getAttempt(app, aCookie, NOT_FOUND_UUID)).res.status).toBe(
      404,
    );
    expect((await getAttempt(app, undefined, attemptId)).res.status).toBe(401);
    expect((await getAttempt(app, teacherCookie, attemptId)).res.status).toBe(
      401,
    );
    // 对照：本人可取
    expect((await getAttempt(app, aCookie, attemptId)).res.status).toBe(200);
  });
});

describe("作业状态联动（GET /api/student/assignments）", () => {
  it("开始作答后 in_progress，交卷后 submitted", async () => {
    const { app, aCookie, assignmentId } = await makeAttemptApp();

    const before = await listAssignments(app, aCookie);
    expect(before.assignments.find((a) => a.id === assignmentId)?.status).toBe(
      "not_started",
    );

    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    const during = await listAssignments(app, aCookie);
    expect(during.assignments.find((a) => a.id === assignmentId)?.status).toBe(
      "in_progress",
    );

    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);
    const after = await listAssignments(app, aCookie);
    expect(after.assignments.find((a) => a.id === assignmentId)?.status).toBe(
      "submitted",
    );
  });
});

describe("T2A.8 答案公布时机（after_due：截止前受限 / 截止后完整）", () => {
  /** 远期截止（真实时钟下恒未到）与早已过期截止 */
  const FAR_DUE = "2099-01-01T00:00:00.000Z";
  const PAST_DUE = "2000-01-01T00:00:00.000Z";

  it("after_due 截止前：submit 与 GET 详情两份响应都受限——无对错/参考答案/详解/含答案题干，assertNoLeak 通过", async () => {
    const { app, db, teacherCookie } = await makeAttemptApp();
    const importRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
    });
    expect(importRes.status).toBe(200);
    const unitId = (
      (await importRes.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!unitId) throw new Error("样例导入未产出单元");
    const studentsRes = await app.request("/api/teacher/students", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        displayName: "王五",
        loginName: "王五",
        password: STUDENT_PASSWORD,
      }),
    });
    expect(studentsRes.status).toBe(201);
    const studentId = (
      (await studentsRes.json()) as { data: { student: { id: string } } }
    ).data.student.id;
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
      { dueAt: FAR_DUE, answerRelease: "after_due" },
    );
    const cookie = await loginStudent(app, "王五");

    const attemptId = (await startAttemptOk(app, cookie, assignmentId))
      .id as string;
    await putAnswer(app, cookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    await putAnswer(app, cookie, attemptId, Q.fill, {
      kind: "fill",
      values: ["4", "-7", "1/2"],
    });

    // ① 交卷瞬间的 submit 响应：受限形态（交卷未到公布时机同样不下发）
    const submitRes = await postSubmit(app, cookie, attemptId);
    expect(submitRes.status).toBe(200);
    const submitBody = (await submitRes.json()) as {
      data: AttemptResultData;
    };
    expect(attemptResultOkSchema.safeParse(submitBody).success).toBe(true);
    const submitted = submitBody.data;
    expect(submitted.answersReleased).toBe(false);
    expect(submitted.attempt.scoreAuto).toBeNull();
    expect(submitted.summary).toEqual({
      total: 8,
      answered: 2,
      correct: 0,
      wrong: 0,
      pending: 2,
      unanswered: 6,
      autoGradable: 0,
      // D9：未公布口径下最终得分与待批数同样置 null 投影
      scoreFinal: null,
      pendingCount: null,
    });

    // ② GET 详情：同一受限形态，逐字段断言
    const { res, body } = await getAttempt(app, cookie, attemptId);
    expect(res.status).toBe(200);
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);
    const detail = (body as { data: AttemptResultData }).data;
    expect(detail.answersReleased).toBe(false);
    expect(detail.dueAt).toBe(FAR_DUE);
    expect(detail.attempt.scoreAuto).toBeNull();

    const qs = detail.units.flatMap((unit) => unit.questions);
    expect(qs.length).toBe(8);
    const rawStems = new Map(
      db
        .select({
          id: questions.id,
          stemMd: questions.stemMd,
          optionsJson: questions.optionsJson,
        })
        .from(questions)
        .all()
        .map(
          (row) =>
            [
              row.id,
              {
                stemMd: row.stemMd,
                options:
                  row.optionsJson === null
                    ? undefined
                    : (JSON.parse(row.optionsJson) as readonly unknown[]),
              },
            ] as const,
        ),
    );
    for (const q of qs) {
      expect(q.answers).toBeNull();
      expect(q.solutionMd).toBeNull();
      expect(q.autoCorrect).toBeNull();
      // 题干 = 学生端投影（比对 studentStemMd(库内原文)，[[答案]] 标记与
      // 选项任务列表的 [x] 正确项标记都不残留）
      expect(q.snapshot.stemMd).toBe(
        studentStemMd(rawStems.get(q.snapshot.id) ?? { stemMd: "" }),
      );
    }
    // 本人答案照常（已答 2 题）
    expect(qs.find((q) => q.questionId === Q.judge)?.answer).toEqual({
      kind: "judge",
      value: true,
    });
    expect(qs.find((q) => q.questionId === Q.fill)?.answer).toEqual({
      kind: "fill",
      values: ["4", "-7", "1/2"],
    });

    // 泄露矩阵：answer=本人答案放行；answers/solutionMd 键名放行（契约要求保留
    // 可空键、值恒 null 已逐字段断言）；详解/答案标记/提示文本绝不出现
    assertNoLeak(body, { allow: ["answer", "answers", "solutionMd"] });
    assertNoStemLeak(body);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("故选 B"); // 详解
    expect(serialized).not.toContain("[[4]]"); // 含答案标记的原始题干
    expect(serialized).not.toContain("[[正确]]");
    for (const row of db
      .select({ hintsJson: questions.hintsJson })
      .from(questions)
      .all()) {
      for (const hint of JSON.parse(row.hintsJson) as string[]) {
        expect(serialized).not.toContain(hint); // 未解锁提示内容（泄露矩阵）
      }
    }

    // 库里判分照常写入（受限只是投影，教师侧统计不受影响）
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.scoreAuto).not.toBeNull();
  });

  it("after_due 截止后（dueAt 已过）：交卷即完整形态", async () => {
    const { app, teacherCookie } = await makeAttemptApp();
    const importRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
    });
    expect(importRes.status).toBe(200);
    const unitId = (
      (await importRes.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!unitId) throw new Error("样例导入未产出单元");
    const studentsRes = await app.request("/api/teacher/students", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        displayName: "赵六",
        loginName: "赵六",
        password: STUDENT_PASSWORD,
      }),
    });
    const studentId = (
      (await studentsRes.json()) as { data: { student: { id: string } } }
    ).data.student.id;
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
      { dueAt: PAST_DUE, answerRelease: "after_due" },
    );
    const cookie = await loginStudent(app, "赵六");

    const attemptId = (await startAttemptOk(app, cookie, assignmentId))
      .id as string;
    await putAnswer(app, cookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    const res = await postSubmit(app, cookie, attemptId);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: AttemptResultData }).data;
    expect(data.answersReleased).toBe(true);
    // D1：仅判断题答对；未答 choice/multi 判错进分母、两道 fill 全人工不进
    // → scoreAuto = 1/3 = 33（四舍五入百分比）
    expect(data.attempt.scoreAuto).toBe(33);
    const judge = data.units
      .flatMap((unit) => unit.questions)
      .find((q) => q.questionId === Q.judge);
    expect(judge?.answers).toEqual({ kind: "judge", value: true });
    expect(judge?.autoCorrect).toBe(true);
    // 完整形态恢复=答案/详解照常下发；题干仍为学生端投影（[[正确]] 恒不残留）
    expect(JSON.stringify(data)).toContain("[[]]");
    expect(JSON.stringify(data)).not.toContain("[[正确]]");
  });

  it("教师端 400：创建 after_due 无截止；after_due 下 PATCH 取消截止（VALIDATION_ERROR 中文缘由）", async () => {
    const { app, teacherCookie, aCookie, assignmentId } =
      await makeAttemptApp();

    const listRes = await app.request("/api/teacher/assignments", {
      headers: { cookie: teacherCookie },
    });
    const units = (
      (await listRes.json()) as {
        data: { assignments: { units: { unitId: string }[] }[] };
      }
    ).data.assignments[0]?.units;
    const unitId = units?.[0]?.unitId;
    if (!unitId) throw new Error("前置作业缺单元");
    const studentId = await createStudent(app, teacherCookie, "孙七");

    // 创建 after_due 而无截止 → 400
    const badCreate = await app.request("/api/teacher/assignments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        unitIds: [unitId],
        studentIds: [studentId],
        answerRelease: "after_due",
      }),
    });
    expect(badCreate.status).toBe(400);
    const createErr = (await badCreate.json()) as ApiErr;
    expect(createErr.error).toBe("VALIDATION_ERROR");
    expect(createErr.message).toContain("截止时间");

    // 合法创建（带截止）后取消截止 → 400
    const okCreate = await app.request("/api/teacher/assignments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        unitIds: [unitId],
        studentIds: [studentId],
        dueAt: FAR_DUE,
        answerRelease: "after_due",
      }),
    });
    expect(okCreate.status).toBe(201);
    const dueAssignmentId = (
      (await okCreate.json()) as {
        data: { assignments: { id: string }[] };
      }
    ).data.assignments[0]?.id;
    if (dueAssignmentId === undefined) {
      throw new Error("布置作业响应缺少作业 id");
    }
    const badPatch = await app.request(
      `/api/teacher/assignments/${dueAssignmentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ dueAt: null }),
      },
    );
    expect(badPatch.status).toBe(400);
    const patchErr = (await badPatch.json()) as ApiErr;
    expect(patchErr.error).toBe("VALIDATION_ERROR");
    expect(patchErr.message).toContain("截止后公布");

    // 对照：默认 on_submit 作业照常交卷即完整（回归）
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);
    const { body } = await getAttempt(app, aCookie, attemptId);
    expect((body as { data: AttemptResultData }).data.answersReleased).toBe(
      true,
    );
  });
});

describe("T3.5 D9 结果视图扩展（teacherMark/teacherComment/finalCorrect/scoreFinal/pendingCount）", () => {
  /** 教师批注单题（改判 + 评语；responseId 从库内取——teacher-marks 同款口径） */
  async function teacherMark(
    app: App,
    teacherCookie: string,
    db: Db,
    attemptId: string,
    questionId: string,
    body: { mark: "correct" | "wrong" | null; comment: string | null },
  ): Promise<void> {
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
    if (!row) throw new Error(`夹具缺少 response 行：${questionId}`);
    const res = await app.request(`/api/teacher/responses/${row.id}/mark`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  }

  it("批注（改判）后：结果视图逐题含 teacherMark/teacherComment/finalCorrect，汇总含 scoreFinal/pendingCount；他人 attemptId 403", async () => {
    // NO_FILL_MD 卷（见全对组合用例说明）：scoreFinal=88（7÷8）需要交卷后全部
    // finalCorrect 非 null——含 fill 的卷交卷即进待批，批注一题仍到不了 graded
    const { app, db, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeAttemptApp(NO_FILL_MD);
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    for (const [questionId, answer] of Object.entries(NO_FILL_ANSWERS)) {
      await putAnswer(app, aCookie, attemptId, questionId, answer);
    }
    expect((await postSubmit(app, aCookie, attemptId)).status).toBe(200);

    // 教师改判一道自动判过的题（错 + 评语）——D3：允许对已判定题批注
    await teacherMark(app, teacherCookie, db, attemptId, Q.choice, {
      mark: "wrong",
      comment: "选项看串了，这题按错算。",
    });

    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: AttemptResultData }).data;
    expect(data.attempt.status).toBe("graded");
    const choice = data.units
      .flatMap((unit) => unit.questions)
      .find((q) => q.questionId === Q.choice);
    expect(choice?.teacherMark).toBe("wrong");
    expect(choice?.teacherComment).toBe("选项看串了，这题按错算。");
    expect(choice?.finalCorrect).toBe(false); // 教师判定优先（D3）
    expect(choice?.autoCorrect).toBe(true); // 自动判定原值保留
    // 其余未批注题：teacherMark/teacherComment null，finalCorrect=autoCorrect
    const others = data.units
      .flatMap((unit) => unit.questions)
      .filter((q) => q.questionId !== Q.choice);
    for (const q of others) {
      expect(q.teacherMark).toBeNull();
      expect(q.teacherComment).toBeNull();
      expect(q.finalCorrect).toBe(q.autoCorrect);
    }
    // 汇总：scoreAuto 不变 100；scoreFinal = 7/8 → 88（D2 分母=全部题）；待批 0
    expect(data.attempt.scoreAuto).toBe(100);
    expect(data.summary.scoreFinal).toBe(88);
    expect(data.summary.pendingCount).toBe(0);

    // 他人 attemptId → 403（学生端既有口径，结果视图扩展不变）
    expect((await getAttempt(app, bCookie, attemptId)).res.status).toBe(403);

    // 已交卷内容允许下发（AGENTS 第 3 条限制的是未交卷题目）；
    // 放行参考答案/详解键后无禁用键
    assertNoLeak(body, { allow: ["answer", "answers", "solutionMd"] });
    assertNoStemLeak(body);
  });

  it("after_due 截止前：批注字段与汇总新字段全 null（教师已批也不泄露）；库里已算好，截止后恢复", async () => {
    // NO_FILL_MD 卷（见全对组合用例说明）：库里 graded、scoreFinal=88 的断言
    // 需要整卷可自动判分（含 fill 的卷恒为 submitted/待批）
    const { app, db, teacherCookie } = await makeAttemptApp(NO_FILL_MD);
    const importRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: NO_FILL_MD, filename: "练习样例.md" }),
    });
    expect(importRes.status).toBe(200);
    const unitId = (
      (await importRes.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!unitId) throw new Error("样例导入未产出单元");
    const studentId = await createStudent(app, teacherCookie, "批注钱八");
    const assignmentId = await createAssignment(
      app,
      teacherCookie,
      unitId,
      studentId,
      { dueAt: "2099-01-01T00:00:00.000Z", answerRelease: "after_due" },
    );
    const cookie = await loginStudent(app, "批注钱八");

    const attemptId = (await startAttemptOk(app, cookie, assignmentId))
      .id as string;
    for (const [questionId, answer] of Object.entries(NO_FILL_ANSWERS)) {
      await putAnswer(app, cookie, attemptId, questionId, answer);
    }
    expect((await postSubmit(app, cookie, attemptId)).status).toBe(200);
    // 截止前教师已改判 + 评语（库里已批好，学生侧不泄露）
    await teacherMark(app, teacherCookie, db, attemptId, Q.choice, {
      mark: "wrong",
      comment: "改判：符号看错了。",
    });

    const { res, body } = await getAttempt(app, cookie, attemptId);
    expect(res.status).toBe(200);
    const data = (body as { data: AttemptResultData }).data;
    expect(data.answersReleased).toBe(false);
    expect(data.attempt.scoreAuto).toBeNull();
    // D9 新字段全部置 null 投影：逐题批注三件套 + 汇总两件套
    for (const q of data.units.flatMap((unit) => unit.questions)) {
      expect(q.teacherMark).toBeNull();
      expect(q.teacherComment).toBeNull();
      expect(q.finalCorrect).toBeNull();
    }
    expect(data.summary.scoreFinal).toBeNull();
    expect(data.summary.pendingCount).toBeNull();

    // 泄露：教师评语文本绝不出现（批改进度不提前泄露）；
    // 放行答案/详解键后无禁用键
    assertNoLeak(body, { allow: ["answer", "answers", "solutionMd"] });
    assertNoStemLeak(body);
    expect(JSON.stringify(body)).not.toContain("改判：符号看错了。");
    expect(JSON.stringify(body)).not.toContain("选项看串了");

    // 库里已按 D2/D3 算好（投影只是读侧口径）：graded、scoreFinal=88
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.status).toBe("graded");
    expect(attemptRow?.scoreFinal).toBe(88);
  });
});
