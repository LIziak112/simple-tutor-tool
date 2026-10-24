import type { ApiErr } from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { type ResponseRow, responses } from "../db/schema";
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
  const unitId = ((await importRes.json()) as { data: { units: { id: string }[] } })
    .data.units[0]?.id;
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

/** 在开关指定状态下开卷（§5.8.4：gradingPolicy 冻结读开卷时点的部署开关） */
async function startAttempt(
  app: App,
  aCookie: string,
  assignmentId: string,
  newContentEnabled: boolean,
): Promise<string> {
  const previous = process.env.NEW_CONTENT_ENABLED;
  process.env.NEW_CONTENT_ENABLED = newContentEnabled ? "true" : "false";
  let attemptId: string | undefined;
  try {
    const res = await app.request(
      `/api/student/assignments/${assignmentId}/attempt`,
      { method: "POST", headers: { cookie: aCookie } },
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

/** 混合作答：choice 答对、fill 与参考相同、solve 与参考相同、无参考 solve 随笔 */
async function saveAllAnswers(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<void> {
  await putAnswer(app, cookie, attemptId, Q.choice, { kind: "choice", index: 0 });
  await putAnswer(app, cookie, attemptId, Q.fill, {
    kind: "fill",
    blanks: ["0.5"],
  });
  await putAnswer(app, cookie, attemptId, Q.solveWithRef, {
    kind: "final",
    finalAnswer: "1",
  });
  await putAnswer(app, cookie, attemptId, Q.solveNoRef, {
    kind: "final",
    finalAnswer: "先通分再相加",
  });
}

/** 直接读库取该卷全部 responses 行（判分事实断言的单一取数处） */
function responseRowsOf(db: Db, attemptId: string): ResponseRow[] {
  return db.select().from(responses).where(eq(responses.attemptId, attemptId)).all();
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
    const assignmentId = await createAssignment(app, teacherCookie, unitId, studentId);
    const aCookie = await loginStudent(app, "张三");
    const attemptId = await startAttempt(app, aCookie, assignmentId, true);

    // 冻结策略断言（§5.6 表）：choice=auto、fill/solve 有参考=reference_self、
    // 无参考 solve=manual_only
    expect(rowOf(db, attemptId, Q.choice).gradingPolicy).toBe("auto");
    expect(rowOf(db, attemptId, Q.fill).gradingPolicy).toBe("reference_self");
    expect(rowOf(db, attemptId, Q.solveWithRef).gradingPolicy).toBe(
      "reference_self",
    );
    expect(rowOf(db, attemptId, Q.solveNoRef).gradingPolicy).toBe("manual_only");

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
    const assignmentId = await createAssignment(app, teacherCookie, unitId, studentId);
    const aCookie = await loginStudent(app, "张三");
    const attemptId = await startAttempt(app, aCookie, assignmentId, true);
    await putAnswer(app, aCookie, attemptId, Q.fill, {
      kind: "fill",
      blanks: ["1/2"],
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
    const assignmentId = await createAssignment(app, teacherCookie, unitId, studentId);
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
