import type { ApiErr } from "@tutor/contract";
import {
  type StudentRecordsData,
  studentRecordsOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { assignments, attempts, ink, responses } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { saveDraftAnswer } from "../services/attempt-service";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * T3.5「我的记录」集成测试（D10；app.request() 直调路由 + 内存库）：
 * - 索引与排序：作业与课程练习混排、按最近活动时间（submittedAt ?? startedAt）
 *   倒序；draft 行 score null / pendingCount 0；行字段（来源上下文、状态、得分
 *   D2 口径、待批数）；
 * - after_due 未公布：得分与待批数置 null、answersReleased=false（不泄露对错）；
 *   截止后（dueAt 改为已过）读时自动恢复；
 * - 筛选组合与边界：sourceType / courseId / assignmentId / status / from / to
 *   （最近活动时间轴，闭区间）任意组合；分页 limit/offset 与 total；
 * - 可见性：本人记录隔离；移出课程后已交卷保留、失权课程草稿不列（D7）；
 *   作业移出名单后已交卷保留、进行中草稿不列（D13 口径）；
 * - 参数与权限：非法参数 400、未登录 401；
 * - 泄露：索引行不含任何答案/详解/提示内容键（assertNoLeak）。
 * 夹具：两道判断（自动判分）+ 一道无标准答案手写题（待批）——与
 * student-course-attempts.test.ts 同款练习 markdown。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 课程练习夹具：两道判断（可自动判分）+ 一道无标准答案手写题（待批） */
const COURSE_PRACTICE_MD = `---
kind: practice
unit: 有理数课程练习
topic: 正数与负数
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是正数。[[错误]]
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

/** after_due 远期截止（真实时钟下恒未到）与早已过期截止 */
const FAR_DUE = "2099-01-01T00:00:00.000Z";
const PAST_DUE = "2000-01-01T00:00:00.000Z";

/** 各记录的确定性时间轴（最近活动时间倒序断言用） */
const T = {
  course1Start: "2026-09-01T09:00:00.000Z",
  course1Submit: "2026-09-01T10:00:00.000Z",
  a1Start: "2026-09-02T09:00:00.000Z",
  a1Submit: "2026-09-02T10:00:00.000Z",
  a2Start: "2026-09-03T09:00:00.000Z",
  a2Submit: "2026-09-03T10:00:00.000Z",
  course2Start: "2026-09-04T09:00:00.000Z",
  a3Start: "2026-09-05T09:00:00.000Z",
  bCourseStart: "2026-09-06T09:00:00.000Z",
} as const;

type App = ReturnType<typeof createApp>;

interface RecordsEnv {
  app: App;
  db: Db;
  teacherCookie: string;
  /** 记录主角（甲）的会话与 id */
  aCookie: string;
  aStudentId: string;
  /** 另一学生（乙）的会话——数据隔离断言用 */
  bCookie: string;
  courseId: string;
  unitId: string;
  /** 作业 A1（on_submit，交卷后教师批注 → graded） */
  a1Id: string;
  a1AttemptId: string;
  /** 作业 A2（after_due 未公布 → 得分/待批 null） */
  a2Id: string;
  a2AttemptId: string;
  /** 作业 A3（甲的进行中草稿 → 移出名单后不列） */
  a3Id: string;
  a3AttemptId: string;
  /** 课程练习第 1 次（已交，submitted）与第 2 次（草稿） */
  course1AttemptId: string;
  course2AttemptId: string;
  /** 乙的课程草稿 */
  bCourseAttemptId: string;
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

/** 直写 attempt 时间戳（排序/筛选的确定性断言用，与 teacher-marks 同款） */
function setAttemptTimes(
  db: Db,
  attemptId: string,
  times: { startedAt: string; submittedAt: string | null },
): void {
  db.update(attempts)
    .set({
      startedAt: times.startedAt,
      submittedAt: times.submittedAt,
      lastActivityAt: null,
    })
    .where(eq(attempts.id, attemptId))
    .run();
}

/** 直查批注定位 id（接口不暴露 responses.id；teacher-marks 同款口径） */
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

/** POST 开卷（作业来源），返回 attemptId */
async function startAssignmentAttempt(
  app: App,
  cookie: string,
  assignmentId: string,
): Promise<string> {
  const res = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    {
      method: "POST",
      headers: { cookie },
    },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** POST 课程练习入口，返回 attemptId（新建 201 / 取回进行中 200 都合法） */
async function startCourseAttempt(
  app: App,
  cookie: string,
  courseId: string,
  unitId: string,
): Promise<string> {
  const res = await app.request(
    `/api/student/courses/${courseId}/units/${encodeURIComponent(unitId)}/attempts`,
    { method: "POST", headers: { cookie } },
  );
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** PUT 草稿答案 */
async function saveAnswer(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<void> {
  const res = await app.request(
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ answer }),
    },
  );
  expect(res.status, `保存 ${questionId} 失败`).toBe(200);
}

/** POST 交卷（T6R.3：自动回传题目版本集合，与前端同流程） */
async function submit(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<void> {
  const res = await submitAttemptRequest(app, cookie, attemptId);
  expect(res.status).toBe(200);
}

/** GET /api/student/records（返回 status 与解包后的 data；失败壳一并给 body） */
async function getRecords(
  app: App,
  cookie: string | undefined,
  query = "",
): Promise<{
  status: number;
  body: unknown;
  data: StudentRecordsData | undefined;
}> {
  const res = await app.request(`/api/student/records${query}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const json = (await res.json()) as unknown;
  return {
    status: res.status,
    body: json,
    data:
      res.status === 200
        ? (json as { data: StudentRecordsData }).data
        : undefined,
  };
}

/**
 * 组装被测环境（时间轴见 T 常量；倒序 = a3 草稿 > course2 草稿 > a2 > a1 > course1）：
 * - course1：judge1/judge2 全对、solve 未答 → submitted，scoreAuto=100、待批 1；
 * - a1（on_submit）：全对 + solve 已答 → 教师批 solve 对 → graded，scoreFinal=100、待批 0；
 * - a2（after_due FAR_DUE）：两判断全错、solve 未答 → 未公布（得分/待批 null）；
 * - course2：课程练习第 2 次草稿（未答）；
 * - a3（on_submit）：作业草稿（未答）。
 */
async function makeRecordsEnv(): Promise<RecordsEnv> {
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

  const a = await createStudentAndLogin(app, teacherCookie, "记录甲");
  const b = await createStudentAndLogin(app, teacherCookie, "隔离乙");
  const addMembers = await app.request(
    `/api/teacher/courses/${courseId}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ studentIds: [a.studentId, b.studentId] }),
    },
  );
  expect(addMembers.status).toBe(200);

  // 布置三份作业（同一单元）：a1 默认 on_submit、a2 after_due、a3 给草稿失权用
  const assignmentIds: string[] = [];
  for (const extra of [
    {},
    { dueAt: FAR_DUE, answerRelease: "after_due" },
    {},
  ] as Record<string, unknown>[]) {
    const res = await app.request("/api/teacher/assignments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        unitIds: [unitId],
        studentIds: [a.studentId],
        ...extra,
      }),
    });
    expect(res.status).toBe(201);
    const createdId = (
      (await res.json()) as { data: { assignments: { id: string }[] } }
    ).data.assignments[0]?.id;
    if (createdId === undefined) {
      throw new Error("布置作业响应缺少作业 id");
    }
    assignmentIds.push(createdId);
  }

  // course1：课程练习第 1 次（全对 + solve 未答 → submitted / 待批 1）
  const course1AttemptId = await startCourseAttempt(
    app,
    a.cookie,
    courseId,
    unitId,
  );
  await saveAnswer(app, a.cookie, course1AttemptId, Q.judge1, {
    kind: "judge",
    value: true,
  });
  await saveAnswer(app, a.cookie, course1AttemptId, Q.judge2, {
    kind: "judge",
    value: false,
  });
  await submit(app, a.cookie, course1AttemptId);
  setAttemptTimes(db, course1AttemptId, {
    startedAt: T.course1Start,
    submittedAt: T.course1Submit,
  });

  // a1：作业（全对 + solve 已答待批 → 教师批对 → graded）
  const a1Id = assignmentIds[0] as string;
  const a1AttemptId = await startAssignmentAttempt(app, a.cookie, a1Id);
  await saveAnswer(app, a.cookie, a1AttemptId, Q.judge1, {
    kind: "judge",
    value: true,
  });
  await saveAnswer(app, a.cookie, a1AttemptId, Q.judge2, {
    kind: "judge",
    value: false,
  });
  await saveAnswer(app, a.cookie, a1AttemptId, Q.solve, {
    kind: "final",
    finalAnswer: "2",
  });
  await submit(app, a.cookie, a1AttemptId);
  setAttemptTimes(db, a1AttemptId, {
    startedAt: T.a1Start,
    submittedAt: T.a1Submit,
  });
  // 教师批注 solve（对）→ 整卷 graded、scoreFinal=100（接口不暴露 responses.id，
  // 夹具从库内取批注定位 id——teacher-marks 同款口径）
  const markTarget = responseIdOf(db, a1AttemptId, Q.solve);
  const markRes = await app.request(
    `/api/teacher/responses/${markTarget}/mark`,
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ mark: "correct", comment: "过程完整，判对。" }),
    },
  );
  expect(markRes.status).toBe(200);

  // a2：after_due 未公布作业（judge1 答错、judge2 答对、solve 未答）
  const a2Id = assignmentIds[1] as string;
  const a2AttemptId = await startAssignmentAttempt(app, a.cookie, a2Id);
  await saveAnswer(app, a.cookie, a2AttemptId, Q.judge1, {
    kind: "judge",
    value: false,
  });
  await saveAnswer(app, a.cookie, a2AttemptId, Q.judge2, {
    kind: "judge",
    value: false,
  });
  await submit(app, a.cookie, a2AttemptId);
  setAttemptTimes(db, a2AttemptId, {
    startedAt: T.a2Start,
    submittedAt: T.a2Submit,
  });

  // course2：课程练习第 2 次（草稿，未答）
  const course2AttemptId = await startCourseAttempt(
    app,
    a.cookie,
    courseId,
    unitId,
  );
  setAttemptTimes(db, course2AttemptId, {
    startedAt: T.course2Start,
    submittedAt: null,
  });

  // a3：作业草稿（未答；移出名单测试用）
  const a3Id = assignmentIds[2] as string;
  const a3AttemptId = await startAssignmentAttempt(app, a.cookie, a3Id);
  setAttemptTimes(db, a3AttemptId, { startedAt: T.a3Start, submittedAt: null });

  // 乙的课程草稿（隔离断言用）
  const bCourseAttemptId = await startCourseAttempt(
    app,
    b.cookie,
    courseId,
    unitId,
  );
  setAttemptTimes(db, bCourseAttemptId, {
    startedAt: T.bCourseStart,
    submittedAt: null,
  });

  return {
    app,
    db,
    teacherCookie,
    aCookie: a.cookie,
    aStudentId: a.studentId,
    bCookie: b.cookie,
    courseId,
    unitId,
    a1Id,
    a1AttemptId,
    a2Id,
    a2AttemptId,
    a3Id,
    a3AttemptId,
    course1AttemptId,
    course2AttemptId,
    bCourseAttemptId,
  };
}

describe("GET /api/student/records（T3.5 D10 我的记录）", () => {
  it("旧卷有效续作置顶，相同答案和幂等重试不再次更新时间；开始排序在分页前执行", async () => {
    const env = await makeRecordsEnv();
    saveDraftAnswer(
      env.db,
      env.aStudentId,
      env.course2AttemptId,
      Q.judge1,
      { kind: "judge", value: true },
      { baseRevision: 0, mutationId: crypto.randomUUID() },
    );
    const result = await getRecords(env.app, env.aCookie, "?status=draft");
    expect(result.data?.records[0]?.attemptId).toBe(env.course2AttemptId);
    const activityAt = result.data?.records[0]?.lastActivityAt;
    expect(activityAt).toBeTruthy();
    saveDraftAnswer(
      env.db,
      env.aStudentId,
      env.course2AttemptId,
      Q.judge1,
      { kind: "judge", value: true },
      { baseRevision: 1, mutationId: crypto.randomUUID() },
    );
    const again = await getRecords(env.app, env.aCookie, "?status=draft");
    expect(again.data?.records[0]?.lastActivityAt).toBe(activityAt);
    const oldest = await getRecords(
      env.app,
      env.aCookie,
      "?sort=started_asc&limit=1&offset=1",
    );
    expect(oldest.data?.records[0]?.attemptId).toBe(env.a1AttemptId);
    const newest = await getRecords(
      env.app,
      env.aCookie,
      "?sort=started_desc&limit=1",
    );
    expect(newest.data?.records[0]?.attemptId).toBe(env.a3AttemptId);
    assertNoLeak(result.body);
    assertNoLeak(oldest.body);
  });

  it("时间过滤固定活动轴，活动并列按开始时间和 ID 稳定分页，非法排序拒绝", async () => {
    const env = await makeRecordsEnv();
    const active = "2026-10-24T00:00:00.000Z";
    for (const id of [env.a3AttemptId, env.course2AttemptId]) {
      env.db
        .update(attempts)
        .set({ lastActivityAt: active })
        .where(eq(attempts.id, id))
        .run();
    }
    for (const sort of ["activity_desc", "started_desc", "started_asc"]) {
      const result = await getRecords(
        env.app,
        env.aCookie,
        `?sort=${sort}&from=${active}&to=${active}`,
      );
      expect(result.data?.total).toBe(2);
      expect(result.data?.records.map((row) => row.attemptId)).toEqual(
        sort === "started_asc"
          ? [env.course2AttemptId, env.a3AttemptId]
          : [env.a3AttemptId, env.course2AttemptId],
      );
      assertNoLeak(result.body);
    }
    env.db
      .update(attempts)
      .set({ startedAt: T.a3Start })
      .where(eq(attempts.id, env.course2AttemptId))
      .run();
    const expected = [env.a3AttemptId, env.course2AttemptId].sort().reverse();
    const first = await getRecords(
      env.app,
      env.aCookie,
      "?status=draft&limit=1",
    );
    const second = await getRecords(
      env.app,
      env.aCookie,
      "?status=draft&limit=1&offset=1",
    );
    expect([
      first.data?.records[0]?.attemptId,
      second.data?.records[0]?.attemptId,
    ]).toEqual(expected);
    expect(
      (await getRecords(env.app, env.aCookie, "?sort=broken")).status,
    ).toBe(400);
  });

  it("索引与排序：作业与课程练习混排、最近活动时间倒序；各状态行字段与 D2 得分口径正确；assertNoLeak 通过", async () => {
    const env = await makeRecordsEnv();
    const { status, body, data } = await getRecords(env.app, env.aCookie);
    expect(status).toBe(200);
    expect(studentRecordsOkSchema.safeParse(body).success).toBe(true);
    expect(data?.total).toBe(5);
    expect(data?.records.map((row) => row.attemptId)).toEqual([
      env.a3AttemptId,
      env.course2AttemptId,
      env.a2AttemptId,
      env.a1AttemptId,
      env.course1AttemptId,
    ]);

    const byId = new Map(data?.records.map((row) => [row.attemptId, row]));
    // 课程练习第 1 次（submitted）：D2 口径 scoreFinal ?? scoreAuto = 100，待批 1
    const course1 = byId.get(env.course1AttemptId);
    expect(course1?.sourceType).toBe("course");
    expect(course1?.courseName).toBe("初一上");
    expect(course1?.unitTitle).toBe("有理数课程练习");
    expect(course1?.attemptNo).toBe(1);
    expect(course1?.status).toBe("submitted");
    expect(course1?.score).toBe(100);
    expect(course1?.resultCounts).toEqual({
      correctCount: 2,
      totalCount: 3,
      pendingCount: 1,
      pendingSelfReviewCount: 0,
    });
    expect(course1?.pendingCount).toBe(1);
    expect(course1?.answersReleased).toBe(true);
    expect(course1?.startedAt).toBe(T.course1Start);
    expect(course1?.submittedAt).toBe(T.course1Submit);

    // a1（graded，教师已批）：scoreFinal=100、待批 0；来源为作业标题
    const a1 = byId.get(env.a1AttemptId);
    expect(a1?.sourceType).toBe("assignment");
    expect(a1?.assignmentId).toBe(env.a1Id);
    expect(a1?.status).toBe("graded");
    expect(a1?.score).toBe(100);
    expect(a1?.pendingCount).toBe(0);

    // a2（after_due 未公布）：得分与待批数置 null、answersReleased=false
    const a2 = byId.get(env.a2AttemptId);
    expect(a2?.status).toBe("submitted");
    expect(a2?.score).toBeNull();
    expect(a2?.resultCounts).toBeNull();
    expect(a2?.pendingCount).toBeNull();
    expect(a2?.answersReleased).toBe(false);

    // 两个草稿行：score null、待批 0、进行中
    for (const draftId of [env.course2AttemptId, env.a3AttemptId]) {
      const draft = byId.get(draftId);
      expect(draft?.status).toBe("draft");
      expect(draft?.score).toBeNull();
      expect(draft?.resultCounts).toBeNull();
      expect(draft?.answerProgress).toEqual({
        answeredCount: 0,
        totalCount: 3,
      });
      expect(draft?.pendingCount).toBe(0);
      expect(draft?.answersReleased).toBe(true);
      expect(draft?.submittedAt).toBeNull();
    }
    // course2 是第 2 次（attemptNo 递增）
    expect(byId.get(env.course2AttemptId)?.attemptNo).toBe(2);

    // 索引行不含任何答案/详解/提示内容键（AGENTS 第 3 条；D10 行数据只有
    // 元信息与来源名）
    assertNoLeak(body);
  });

  it("筛选组合：sourceType / courseId / assignmentId / status 各自与组合；from/to 按最近活动时间闭区间", async () => {
    const env = await makeRecordsEnv();
    const q = async (query: string) => {
      const { data } = await getRecords(env.app, env.aCookie, query);
      return data?.records.map((row) => row.attemptId) ?? [];
    };

    expect(await q("?sourceType=course")).toEqual([
      env.course2AttemptId,
      env.course1AttemptId,
    ]);
    expect(await q("?sourceType=assignment")).toEqual([
      env.a3AttemptId,
      env.a2AttemptId,
      env.a1AttemptId,
    ]);
    expect(await q(`?courseId=${env.courseId}`)).toEqual([
      env.course2AttemptId,
      env.course1AttemptId,
    ]);
    expect(await q(`?assignmentId=${env.a2Id}`)).toEqual([env.a2AttemptId]);
    expect(await q("?status=draft")).toEqual([
      env.a3AttemptId,
      env.course2AttemptId,
    ]);
    expect(await q("?status=graded")).toEqual([env.a1AttemptId]);
    expect(await q("?status=submitted")).toEqual([
      env.a2AttemptId,
      env.course1AttemptId,
    ]);
    expect(await q("?sourceType=assignment&status=submitted")).toEqual([
      env.a2AttemptId,
    ]);

    // from/to 闭区间（含边界时刻）：from=a1Submit → a1 仍在；to=a2Submit → a2 仍在
    expect(await q(`?from=${T.a1Submit}`)).toEqual([
      env.a3AttemptId,
      env.course2AttemptId,
      env.a2AttemptId,
      env.a1AttemptId,
    ]);
    expect(await q(`?to=${T.a2Submit}`)).toEqual([
      env.a2AttemptId,
      env.a1AttemptId,
      env.course1AttemptId,
    ]);
    // 组合区间取中段
    expect(await q(`?from=${T.course1Submit}&to=${T.a1Submit}`)).toEqual([
      env.a1AttemptId,
      env.course1AttemptId,
    ]);
    // 陌生 courseId → 空但 total 0
    const empty = await getRecords(
      env.app,
      env.aCookie,
      "?courseId=00000000-0000-4000-8000-000000000000",
    );
    expect(empty.data?.records).toEqual([]);
    expect(empty.data?.total).toBe(0);
  });

  it("分页：limit/offset 切页、total 不随分页变化；offset 越界空页", async () => {
    const env = await makeRecordsEnv();
    const page1 = await getRecords(env.app, env.aCookie, "?limit=2");
    expect(page1.data?.records.map((row) => row.attemptId)).toEqual([
      env.a3AttemptId,
      env.course2AttemptId,
    ]);
    expect(page1.data?.total).toBe(5);
    const page3 = await getRecords(env.app, env.aCookie, "?limit=2&offset=4");
    expect(page3.data?.records.map((row) => row.attemptId)).toEqual([
      env.course1AttemptId,
    ]);
    expect(page3.data?.total).toBe(5);
    const beyond = await getRecords(
      env.app,
      env.aCookie,
      "?limit=50&offset=20",
    );
    expect(beyond.data?.records).toEqual([]);
    expect(beyond.data?.total).toBe(5);
  });

  it("参数校验：limit=0 / limit=201 / 非法 status / 非法 courseId / 非法 from → 400 VALIDATION_ERROR；未登录 401", async () => {
    const env = await makeRecordsEnv();
    for (const query of [
      "?limit=0",
      "?limit=201",
      "?status=doing",
      "?courseId=not-an-uuid",
      "?from=2026-09-01",
      "?offset=-1",
    ]) {
      const { status, body } = await getRecords(env.app, env.aCookie, query);
      expect(status, query).toBe(400);
      expect((body as ApiErr).error).toBe("VALIDATION_ERROR");
    }
    const anon = await getRecords(env.app, undefined);
    expect(anon.status).toBe(401);
  });

  it("本人隔离：乙只见自己的作答，甲的五条记录一条不漏给乙", async () => {
    const env = await makeRecordsEnv();
    const { data } = await getRecords(env.app, env.bCookie);
    expect(data?.total).toBe(1);
    expect(data?.records.map((row) => row.attemptId)).toEqual([
      env.bCourseAttemptId,
    ]);
  });

  it("移出课程（D7）：已交卷记录保留可见，进行中草稿不列", async () => {
    const env = await makeRecordsEnv();
    const removed = await env.app.request(
      `/api/teacher/courses/${env.courseId}/members`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: env.teacherCookie,
        },
        body: JSON.stringify({ studentIds: [env.aStudentId] }),
      },
    );
    expect(removed.status).toBe(200);

    const { data } = await getRecords(env.app, env.aCookie);
    expect(data?.total).toBe(4);
    const ids = data?.records.map((row) => row.attemptId);
    // course2 草稿消失；course1 已交卷保留
    expect(ids).not.toContain(env.course2AttemptId);
    expect(ids).toContain(env.course1AttemptId);
    expect(ids).toEqual([
      env.a3AttemptId,
      env.a2AttemptId,
      env.a1AttemptId,
      env.course1AttemptId,
    ]);
  });

  it("作业移出名单（D13 口径）：进行中草稿不列，已交卷记录保留", async () => {
    const env = await makeRecordsEnv();
    // a3（草稿）与 a1（已交卷）都移出甲——两者都属「已开始」，须 confirmStarted
    for (const assignmentId of [env.a3Id, env.a1Id]) {
      const res = await env.app.request(
        `/api/teacher/assignments/${assignmentId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: env.teacherCookie,
          },
          body: JSON.stringify({
            removeStudentIds: [env.aStudentId],
            confirmStarted: true,
          }),
        },
      );
      expect(res.status).toBe(200);
    }

    const { data } = await getRecords(env.app, env.aCookie);
    expect(data?.total).toBe(4);
    const ids = data?.records.map((row) => row.attemptId);
    expect(ids).not.toContain(env.a3AttemptId); // 草稿失权 → 不列
    expect(ids).toContain(env.a1AttemptId); // 已交卷 → 保留
  });

  it("进行中普通卷公开已做进度，包含正式手写但不含判定或答案", async () => {
    const env = await makeRecordsEnv();
    await saveAnswer(env.app, env.aCookie, env.course2AttemptId, Q.judge1, {
      kind: "judge",
      value: false,
    });
    env.db
      .insert(ink)
      .values({
        id: crypto.randomUUID(),
        attemptId: env.course2AttemptId,
        questionId: Q.solve,
        strokesPath: "test.json.gz",
        pngPath: "test.png",
        width: 100,
        height: 100,
        strokeCount: 1,
        updatedAt: T.course2Start,
      })
      .run();
    const { data, body } = await getRecords(env.app, env.aCookie);
    const row = data?.records.find(
      (record) => record.attemptId === env.course2AttemptId,
    );
    expect(row?.answerProgress).toEqual({ answeredCount: 2, totalCount: 3 });
    expect(row?.resultCounts).toBeNull();
    assertNoLeak(body);
  });

  it("未冻结且无 response 的历史草稿也有总题数，读取不会冻结或创建答案", async () => {
    const env = await makeRecordsEnv();
    env.db
      .update(attempts)
      .set({ frozenAt: null })
      .where(eq(attempts.id, env.a3AttemptId))
      .run();
    env.db
      .delete(responses)
      .where(eq(responses.attemptId, env.a3AttemptId))
      .run();
    const { data, body } = await getRecords(env.app, env.aCookie);
    expect(
      data?.records.find((row) => row.attemptId === env.a3AttemptId)
        ?.answerProgress,
    ).toEqual({ answeredCount: 0, totalCount: 3 });
    expect(
      env.db
        .select({ frozenAt: attempts.frozenAt })
        .from(attempts)
        .where(eq(attempts.id, env.a3AttemptId))
        .get()?.frozenAt,
    ).toBeNull();
    expect(
      env.db
        .select({ id: responses.id })
        .from(responses)
        .where(eq(responses.attemptId, env.a3AttemptId))
        .all(),
    ).toHaveLength(0);
    assertNoLeak(body);
  });

  it("after_due 截止后（读时比较）：得分与待批数自动恢复真实值", async () => {
    const env = await makeRecordsEnv();
    // 直接把 a2 的截止改为已过（无定时任务；下一次请求自动恢复）
    env.db
      .update(assignments)
      .set({ dueAt: PAST_DUE })
      .where(eq(assignments.id, env.a2Id))
      .run();

    const { data } = await getRecords(env.app, env.aCookie);
    const a2 = data?.records.find((row) => row.attemptId === env.a2AttemptId);
    expect(a2?.answersReleased).toBe(true);
    // 两判断一错一对 → scoreAuto=50；solve 未答待批 1（submitted）
    expect(a2?.score).toBe(50);
    expect(a2?.resultCounts).toEqual({
      correctCount: 1,
      totalCount: 3,
      pendingCount: 1,
      pendingSelfReviewCount: 0,
    });
    expect(a2?.pendingCount).toBe(1);
  });
});

// ---------- QM 两线收敛（TT-09c 审查 P2-1）：记录行待自评计数 ----------

/** 自评夹具：judge（auto）+ 带参考 fill（NEW_CONTENT_ENABLED 开卷冻结 reference_self） */
const SELF_REVIEW_RECORDS_MD = `---
kind: practice
unit: 记录自评练习
topic: 对照自评
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=fill difficulty=2 knowledge="填空对照"}
把二分之一化成小数：[[0.5|1/2]]
::::
`;

/** 题目 id（单元 slug 缺省编号） */
const SRQ = {
  judge: "记录自评练习-1",
  fill: "记录自评练习-2",
} as const;

/** 开关开启下开卷（行冻结 reference_self；student-wrong-questions 同款口径） */
async function startNewContentAttempt(
  start: () => Promise<string>,
): Promise<string> {
  const previous = process.env.NEW_CONTENT_ENABLED;
  process.env.NEW_CONTENT_ENABLED = "true";
  try {
    return await start();
  } finally {
    if (previous === undefined) delete process.env.NEW_CONTENT_ENABLED;
    else process.env.NEW_CONTENT_ENABLED = previous;
  }
}

describe("GET /api/student/records（QM-12：待自评计数两线收敛接线）", () => {
  /**
   * pendingSelfReviewCount 零覆盖补测（审查 P2-1）：reference_self 已提交未
   * 自评计 1 / 已自评归零 / after_due 未公布 null 投影——谓词与教师详情
   * selfReviewPendingCount（teacher-attempt-service）同一语义（有判定来源即
   * 归零，pending-mark.pendingSelfReviewCounts 注释互指），此处锁路由投影。
   */
  it("reference_self 已提交未自评计 1；自评后归零；after_due 未公布 null 投影；auto 行不计入", async () => {
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
      body: JSON.stringify({
        loginName: "teacher",
        password: TEACHER_PASSWORD,
      }),
    });
    const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
    const created = await app.request("/api/teacher/courses", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ title: "初一上" }),
    });
    expect(created.status).toBe(201);
    const courseId = ((await created.json()) as { data: { id: string } }).data
      .id;
    const imported = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        markdown: SELF_REVIEW_RECORDS_MD,
        filename: "记录自评练习.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    const srUnitId = (
      (await imported.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!srUnitId) throw new Error("自评夹具导入未产出单元");
    // 导入兼容路径默认单元隐藏 → 放开可见（D23-3 口径）
    const detail = await app.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: teacherCookie },
    });
    const item = (
      (await detail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === srUnitId);
    if (!item) throw new Error("课程目录中未找到自评单元条目");
    const patched = await app.request(`/api/teacher/course-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ visible: true }),
    });
    expect(patched.status).toBe(200);

    const a = await createStudentAndLogin(app, teacherCookie, "自评甲");
    const addMembers = await app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ studentIds: [a.studentId] }),
      },
    );
    expect(addMembers.status).toBe(200);

    // 课程练习：开关开启开卷（judge 冻结 auto、fill 冻结 reference_self），
    // 答完交卷（course 恒公布）
    const courseAttemptId = await startNewContentAttempt(() =>
      startCourseAttempt(app, a.cookie, courseId, srUnitId),
    );
    await saveAnswer(app, a.cookie, courseAttemptId, SRQ.judge, {
      kind: "judge",
      value: true,
    });
    await saveAnswer(app, a.cookie, courseAttemptId, SRQ.fill, {
      kind: "fill",
      values: ["0.5"],
    });
    await submit(app, a.cookie, courseAttemptId);
    // 冻结策略断言（防止夹具漂移导致计数为 0 的空过）
    expect(
      db
        .select({ policy: responses.gradingPolicy })
        .from(responses)
        .where(eq(responses.attemptId, courseAttemptId))
        .all()
        .map((row) => row.policy),
    ).toEqual(["auto", "reference_self"]);

    // after_due 未公布作业（同款冻结；已交卷但整体不公布）
    const assignmentRes = await app.request("/api/teacher/assignments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        unitIds: [srUnitId],
        studentIds: [a.studentId],
        dueAt: FAR_DUE,
        answerRelease: "after_due",
      }),
    });
    expect(assignmentRes.status).toBe(201);
    const dueAssignmentId = (
      (await assignmentRes.json()) as {
        data: { assignments: { id: string }[] };
      }
    ).data.assignments[0]?.id;
    if (dueAssignmentId === undefined) {
      throw new Error("布置作业响应缺少作业 id");
    }
    const dueAttemptId = await startNewContentAttempt(() =>
      startAssignmentAttempt(app, a.cookie, dueAssignmentId),
    );
    await saveAnswer(app, a.cookie, dueAttemptId, SRQ.judge, {
      kind: "judge",
      value: true,
    });
    await saveAnswer(app, a.cookie, dueAttemptId, SRQ.fill, {
      kind: "fill",
      values: ["0.5"],
    });
    await submit(app, a.cookie, dueAttemptId);

    // ① 未自评：reference_self 已提交未自评计 1（auto 行不计入、不进待批）
    const before = await getRecords(app, a.cookie);
    const course = before.data?.records.find(
      (row) => row.attemptId === courseAttemptId,
    );
    expect(course?.answersReleased).toBe(true);
    expect(course?.pendingSelfReviewCount).toBe(1);
    expect(course?.pendingCount).toBe(0); // reference_self 不进教师待批（分列）
    // ③ 未公布 null 投影（与 score/pendingCount 同法，不泄露对错）
    const due = before.data?.records.find(
      (row) => row.attemptId === dueAttemptId,
    );
    expect(due?.answersReleased).toBe(false);
    expect(due?.pendingSelfReviewCount).toBeNull();

    // ② 已自评归零（有判定来源即归零——与教师详情 selfReviewPendingCount 同语义）
    const review = await app.request(
      `/api/student/attempts/${courseAttemptId}/questions/${encodeURIComponent(
        SRQ.fill,
      )}/self-review`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: a.cookie },
        body: JSON.stringify({
          verdict: "wrong",
          baseRevision: 0,
          mutationId: crypto.randomUUID(),
        }),
      },
    );
    expect(review.status).toBe(200);
    const after = await getRecords(app, a.cookie);
    expect(
      after.data?.records.find((row) => row.attemptId === courseAttemptId)
        ?.pendingSelfReviewCount,
    ).toBe(0);
  });
});
