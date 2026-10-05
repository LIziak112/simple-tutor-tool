import { readFileSync } from "node:fs";
import type { ApiErr, AttemptDraftData } from "@tutor/contract";
import {
  attemptDraftOkSchema,
  attemptStartOkSchema,
  studentPaperDataSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, questions, responses, students } from "../db/schema";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak";
import { submitAttemptRequest } from "../test/submit-revisions";

/**
 * T6R.3 全来源 attempt 题目版本冻结集成测试（app.request() 直调 + 内存库）。
 * 方案 §5.1 口径：新 attempt 建立时（assignment/course/wrong 三来源统一）冻结
 * 题目集合、题序与完整服务端快照；此后取卷、草稿读题、提示、判分、结果一律
 * 走冻结快照（responses.questionSnapshotJson，questionRevisionId=行 id）；
 * 题库修改只影响之后新建的卷。冻结内容不冻结权限（既有访问权守卫不动）。
 *
 * 覆盖：
 * - 建卷冻结：开卷后教师改题干数值/答案（version+1）→ 当前卷显示与判分一致
 *   （按冻结旧版判分）；新开的卷使用新版；软删题留在当前卷、可继续作答、
 *   参与判分，但不再进新卷；
 * - 三来源各自冻结（assignment/course/wrong）；wrong 维持既有 rowid 题序；
 * - 提示走冻结快照（openHint 与草稿视图回显都是建卷时文本）；
 * - 学生端零泄露：草稿视图/取卷 assertNoLeak（含 questionRevisionId 新字段）；
 * - 迁移三分支：升级前已交卷沿用既有快照不重写；升级前进行中 attempt 首次
 *   恢复访问懒冻结当前可取得版本、保留答案、标记 legacy_unverified；空/损坏
 *   快照按缺失计，不拿当前题库回填伪造；旧标签页陈旧提交被可诊断拒绝。
 * 夹具用 samples/v2/练习样例.md（八题七题型；题号顺序与 student-attempts 一致）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

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

type App = ReturnType<typeof createApp>;

interface Env {
  app: App;
  db: Db;
  teacherCookie: string;
  aId: string;
  aCookie: string;
  bCookie: string;
  assignmentId: string;
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
  return `tutor_session=${extractSessionToken(res)}`;
}

/** 全套前置：教师 + 导入样例 + 张三/李四（都被指派）+ 一份双学生作业 */
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

  const aId = await createStudent(app, teacherCookie, "张三");
  const bId = await createStudent(app, teacherCookie, "李四");
  const assignRes = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds: [aId, bId] }),
  });
  expect(assignRes.status).toBe(201);
  const assignmentId = (
    (await assignRes.json()) as { data: { assignments: { id: string }[] } }
  ).data.assignments[0]?.id;
  if (!assignmentId) throw new Error("布置作业响应缺少作业 id");
  return {
    app,
    db,
    teacherCookie,
    aId,
    aCookie: await loginStudent(app, "张三"),
    bCookie: await loginStudent(app, "李四"),
    assignmentId,
  };
}

/** POST /attempt（断言 200）取 id */
async function startAttemptId(
  app: App,
  cookie: string,
  assignmentId: string,
): Promise<string> {
  const res = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string } };
  expect(attemptStartOkSchema.safeParse(body).success).toBe(true);
  return body.data.id;
}

/** GET attempt 详情（200 时取 body） */
async function getAttempt(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<{ res: Response; body: unknown }> {
  const res = await app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie },
  });
  return { res, body: res.status === 200 ? await res.json() : undefined };
}

/** GET 通用取卷 */
async function getPaper(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  return app.request(`/api/student/attempts/${attemptId}/paper`, {
    headers: { cookie },
  });
}

/** PUT 草稿答案 */
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
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ answer }),
      },
    ),
  );
}

/** POST 交卷（不带请求体——旧客户端/陈旧标签页形态） */
function postSubmit(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { cookie },
    }),
  );
}

/** POST 交卷（携带题目版本集合） */
function postSubmitWithRevisions(
  app: App,
  cookie: string,
  attemptId: string,
  revisions: { questionId: string; questionRevisionId: string }[],
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ revisions }),
    }),
  );
}

/** 教师编辑单题（改 sourceMd，version+1），返回新 version */
async function editQuestion(
  app: App,
  teacherCookie: string,
  questionId: string,
  replace: readonly (readonly [string, string])[],
): Promise<number> {
  const detail = await app.request(`/api/teacher/questions/${questionId}`, {
    headers: { cookie: teacherCookie },
  });
  expect(detail.status).toBe(200);
  const sourceMd = (await detail.json()) as { data: { sourceMd: string } };
  let edited = sourceMd.data.sourceMd;
  for (const [from, to] of replace) {
    if (!edited.includes(from)) throw new Error(`编辑源缺少片段：${from}`);
    edited = edited.replace(from, to);
  }
  const edit = await app.request(`/api/teacher/questions/${questionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ sourceMd: edited }),
  });
  expect(edit.status).toBe(200);
  return ((await edit.json()) as { data: { version: number } }).data.version;
}

/** 教师软删单题 */
async function softDeleteQuestion(
  app: App,
  teacherCookie: string,
  questionId: string,
): Promise<void> {
  const res = await app.request(`/api/teacher/questions/${questionId}`, {
    method: "DELETE",
    headers: { cookie: teacherCookie },
  });
  expect(res.status).toBe(200);
}

/** 解锁一道题的第 index 条提示 */
async function openHint(
  app: App,
  cookie: string,
  attemptId: string,
  questionId: string,
  index: number,
): Promise<{ res: Response; body: unknown }> {
  const res = await app.request(`/api/student/attempts/${attemptId}/hints`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ questionId, index }),
  });
  return { res, body: res.status === 200 ? await res.json() : undefined };
}

/** 草稿视图题目平铺（经契约解析，兼校验新形态） */
async function draftQuestions(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<AttemptDraftData["units"][number]["questions"]> {
  const { res, body } = await getAttempt(app, cookie, attemptId);
  expect(res.status).toBe(200);
  const parsed = attemptDraftOkSchema.safeParse(body);
  if (!parsed.success) throw new Error(`草稿视图契约解析失败：${parsed.error}`);
  return parsed.data.data.units.flatMap((unit) => unit.questions);
}

/** 正常交卷：先取草稿视图的版本集合，原样回传（前端同一流程） */
async function submitWithCurrentRevisions(
  app: App,
  cookie: string,
  attemptId: string,
): Promise<Response> {
  // 共享 submitAttemptRequest（自动取版本集合并回传；错版/缺项/多项的定向
  // 用例走 postSubmitWithRevisions 显式构造）
  return submitAttemptRequest(app, cookie, attemptId);
}

/**
 * 把「新代码建的卷」重置成升级前遗留草稿形态：清冻结标记、清快照、
 * 删未作答题的行（升级前行只随存答/解锁提示创建，未作答题没有行）。
 */
function downgradeToLegacyDraft(db: Db, attemptId: string): void {
  db.update(attempts)
    .set({ frozenAt: null, legacyUnverified: false })
    .where(eq(attempts.id, attemptId))
    .run();
  const rows = db
    .select()
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .all();
  for (const row of rows) {
    if (row.answerJson === null && row.hintsOpenedJson === null) {
      db.delete(responses).where(eq(responses.id, row.id)).run();
    } else {
      db.update(responses)
        .set({ questionSnapshotJson: null, questionVersion: 0 })
        .where(eq(responses.id, row.id))
        .run();
    }
  }
}

describe("T6R.3 建卷冻结：assignment 来源", () => {
  it("开卷即预插冻结行：八题全量快照 + frozenAt 置位 + 每题下发 questionRevisionId（= responses 行 id）", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);

    // 库：8 行冻结（含未作答题），快照齐全、版本冻结为当前 version=1
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all();
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.questionSnapshotJson !== null)).toBe(true);
    expect(rows.every((row) => row.questionVersion === 1)).toBe(true);
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.frozenAt).not.toBeNull();
    expect(attemptRow?.legacyUnverified).toBe(false);

    // 草稿视图：每题携带不透明 questionRevisionId，与 responses 行 id 一一对应
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions).toHaveLength(8);
    const idByQuestion = new Map(
      rows.map((row) => [row.questionId, row.id] as const),
    );
    for (const question of questions) {
      expect(question.questionRevisionId).toBe(
        idByQuestion.get(question.id) ?? "",
      );
    }

    // 通用取卷：同一冻结集合，同样携带 questionRevisionId
    const paperRes = await getPaper(app, aCookie, attemptId);
    expect(paperRes.status).toBe(200);
    const paperBody = (await paperRes.json()) as {
      data: { units: { questions: unknown[] }[] };
    };
    expect(studentPaperDataSchema.safeParse(paperBody.data).success).toBe(true);
    const paperQuestions = paperBody.data.units.flatMap(
      (unit) => unit.questions,
    );
    expect(paperQuestions).toHaveLength(8);
    for (const question of paperQuestions) {
      expect(
        (question as { questionRevisionId?: string }).questionRevisionId,
      ).toBeTypeOf("string");
    }
  });

  it("建卷冻结-内容与判分：开卷后教师改题干数值与答案（version+1），当前卷显示旧题干、判分按旧答案；新开的卷（另一学生）用新版", async () => {
    const { app, db, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);

    // 教师编辑：①fill 题干 $(-3)+7=$ → $(-3)+8=$、答案 [[4]] → [[5]]（题干显示用）；
    // ②choice 正确项从第 2 项挪到第 4 项（判分口径用——fill 已是全人工批改，
    // autoCorrect 恒 null，不能用 fill 证明「按冻结答案判分」）
    const version = await editQuestion(app, teacherCookie, Q.fill, [
      ["$(-3)+7=$", "$(-3)+8=$"],
      ["[[4]]", "[[5]]"],
    ]);
    expect(version).toBe(2);
    await editQuestion(app, teacherCookie, Q.choice, [
      ["- [x] $5$", "- [ ] $5$"],
      ["- [ ] $-\\frac{1}{5}$", "- [x] $-\\frac{1}{5}$"],
    ]);

    // 张三的当前卷：草稿视图仍是旧题干（7= 未变成 8=）
    const questions = await draftQuestions(app, aCookie, attemptId);
    const fill = questions.find((question) => question.id === Q.fill);
    expect(fill?.stemMd).toContain("$(-3)+7=$");
    expect(fill?.stemMd).not.toContain("$(-3)+8=$");

    // 张三按旧答案作答（choice 选旧正确项 1——对冻结版正确、对当前题库错误）
    // → 交卷判分按冻结快照 = true
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.choice, {
          kind: "choice",
          index: 1,
        })
      ).status,
    ).toBe(200);
    const submitRes = await submitWithCurrentRevisions(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const result = (await submitRes.json()) as {
      data: {
        units: {
          questions: { questionId: string; autoCorrect: boolean | null }[];
        }[];
      };
    };
    const choiceResult = result.data.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.questionId === Q.choice);
    expect(choiceResult?.autoCorrect).toBe(true);
    // 冻结行版本仍是 1（编辑只影响题库当前行，version=2）
    const fillRow = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all()
      .find((row) => row.questionId === Q.fill);
    expect(fillRow?.questionVersion).toBe(1);

    // 李四在编辑后才开卷 → 新卷用新版（题干 8=）
    const bAttemptId = await startAttemptId(app, bCookie, assignmentId);
    const bQuestions = await draftQuestions(app, bCookie, bAttemptId);
    const bFill = bQuestions.find((question) => question.id === Q.fill);
    expect(bFill?.stemMd).toContain("$(-3)+8=$");
    expect(bFill?.stemMd).not.toContain("$(-3)+7=$");
  });

  it("建卷冻结-软删：开卷后教师软删题，当前卷仍显示该题、可作答、参与判分；新卷不再包含", async () => {
    const { app, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await softDeleteQuestion(app, teacherCookie, Q.multi);

    // 张三当前卷：多选题仍在（8 题），可继续作答
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions).toHaveLength(8);
    expect(questions.some((question) => question.id === Q.multi)).toBe(true);
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.multi, {
          kind: "multi",
          indexes: [0, 2],
        })
      ).status,
    ).toBe(200);
    // 提示接口同样以冻结集合为准（软删题仍可解锁提示，内容来自冻结快照）
    const hint = await openHint(app, aCookie, attemptId, Q.fill, 0);
    expect(hint.res.status).toBe(200);

    // 交卷：软删题按冻结快照正常判分（多选全对 → true），总数仍 8
    const submitRes = await submitWithCurrentRevisions(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const result = (await submitRes.json()) as {
      data: {
        summary: { total: number };
        units: {
          questions: { questionId: string; autoCorrect: boolean | null }[];
        }[];
      };
    };
    expect(result.data.summary.total).toBe(8);
    const multiResult = result.data.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.questionId === Q.multi);
    expect(multiResult?.autoCorrect).toBe(true);

    // 李四的新卷不含软删题（7 题）
    const bAttemptId = await startAttemptId(app, bCookie, assignmentId);
    const bQuestions = await draftQuestions(app, bCookie, bAttemptId);
    expect(bQuestions).toHaveLength(7);
    expect(bQuestions.some((question) => question.id === Q.multi)).toBe(false);
  });

  it("建卷冻结-提示：开卷后教师改提示文本，解锁与回显都返回建卷时文本", async () => {
    const { app, teacherCookie, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);

    // 教师改 Q.fill 提示文案
    await editQuestion(app, teacherCookie, Q.fill, [
      ["同号相加，取相同的符号，并把绝对值相加；", "改过的提示文案；"],
    ]);

    // 解锁第 0 条 → 冻结版文本
    const { res, body } = await openHint(app, aCookie, attemptId, Q.fill, 0);
    expect(res.status).toBe(200);
    const hintText = (body as { data: { hint: string } }).data.hint;
    expect(hintText).toContain("同号相加，取相同的符号");
    expect(hintText).not.toContain("改过的提示文案");

    // 草稿视图回显同样是冻结版文本
    const { res: detailRes, body: detailBody } = await getAttempt(
      app,
      aCookie,
      attemptId,
    );
    expect(detailRes.status).toBe(200);
    const opened = (
      detailBody as {
        data: { hintsOpened: Record<string, { text: string }[]> };
      }
    ).data.hintsOpened[Q.fill]?.[0]?.text;
    expect(opened).toContain("同号相加，取相同的符号");
  });

  it("编排者裁决：建卷后教师重排题序，进行中卷的分组与题序不变（从冻结行自身重建）；新开的卷用新序", async () => {
    const { app, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    const before = (await draftQuestions(app, aCookie, attemptId)).map(
      (question) => question.id,
    );
    expect(before).toEqual(Object.values(Q)); // 建卷序 = 单元题序

    // 教师把单元内题目倒序重排（真实教师路径 POST /reorder，order 按下标重写）
    const reversed = [...Object.values(Q)].reverse();
    const reorder = await app.request("/api/teacher/reorder", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ kind: "question", ids: reversed }),
    });
    expect(reorder.status).toBe(200);

    // 张三的进行中卷：分组与题序不变（冻结行 unitId 首现序分组 + rowid 组内序，
    // 不读 questions.order）；判分与结果视图同序
    const after = (await draftQuestions(app, aCookie, attemptId)).map(
      (question) => question.id,
    );
    expect(after).toEqual(before);
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.judge, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    const submitRes = await submitWithCurrentRevisions(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const result = (await submitRes.json()) as {
      data: { units: { questions: { questionId: string }[] }[] };
    };
    expect(
      result.data.units
        .flatMap((unit) => unit.questions)
        .map((item) => item.questionId),
    ).toEqual(before); // 结果视图同一冻结序

    // 李四在重排后才开卷 → 新卷用新序（题库 order 已变，建卷冻结取当前序）
    const bAttemptId = await startAttemptId(app, bCookie, assignmentId);
    const bOrder = (await draftQuestions(app, bCookie, bAttemptId)).map(
      (question) => question.id,
    );
    expect(bOrder).toEqual(reversed);
  });

  it("真 bug 回归：冻结卷的坏快照题请求提示 → 400 HINT_INDEX_OUT_OF_RANGE（requireUsableAttempt 返回冻结后的行，分态正确，绝不回退当前题库）", async () => {
    const { app, db, teacherCookie, aCookie, assignmentId } = await makeEnv();
    void teacherCookie;
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    // 冻结后把某行快照改坏（数据异常模拟）：修复前 hintsOfAttempt 拿旧
    // attempt 对象（frozenAt=null）误走遗留分支，回退当前题库返回了提示内容
    db.update(responses)
      .set({ questionSnapshotJson: "{bad json" })
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.fill),
        ),
      )
      .run();

    const hintRes = await app.request(
      `/api/student/attempts/${attemptId}/hints`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: aCookie },
        body: JSON.stringify({ questionId: Q.fill, index: 0 }),
      },
    );
    expect(hintRes.status).toBe(400);
    expect(((await hintRes.json()) as ApiErr).error).toBe(
      "HINT_INDEX_OUT_OF_RANGE",
    );
    // 该题从草稿视图消失（按缺失计）；对照正常题（findError 有提示）照常解锁
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions.some((question) => question.id === Q.fill)).toBe(false);
    const okHint = await openHint(app, aCookie, attemptId, Q.findError, 0);
    expect(okHint.res.status).toBe(200);
  });

  it("泄露：草稿视图与取卷 assertNoLeak 全量通过（含 questionRevisionId 新字段后仍无答案/详解/提示内容）", async () => {
    const { app, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });

    const { body } = await getAttempt(app, aCookie, attemptId);
    assertNoLeak(body);
    const paperRes = await getPaper(app, aCookie, attemptId);
    assertNoLeak(await paperRes.json());
  });
});

describe("T6R.3 建卷冻结：course 与 wrong 来源", () => {
  /** course 夹具：两道判断题的课程练习单元（张三为成员、条目可见） */
  async function makeCourseEnv(): Promise<{
    app: App;
    db: Db;
    teacherCookie: string;
    aCookie: string;
    courseId: string;
    unitId: string;
  }> {
    const base = await makeEnv();
    const { app, teacherCookie } = base;
    const created = await app.request("/api/teacher/courses", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ title: "初一上" }),
    });
    expect(created.status).toBe(201);
    const courseId = ((await created.json()) as { data: { id: string } }).data
      .id;
    const COURSE_MD = `---
kind: practice
unit: 冻结课程练习
topic: 正数与负数
---

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$1$ 是正数。[[正确]]
::::

::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是正数。[[错误]]
::::
`;
    const imported = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        markdown: COURSE_MD,
        filename: "冻结课程练习.md",
        courseId,
      }),
    });
    expect(imported.status).toBe(200);
    const unitId = (
      (await imported.json()) as { data: { units: { id: string }[] } }
    ).data.units[0]?.id;
    if (!unitId) throw new Error("课程导入未产出单元");
    // 放开条目可见（导入兼容路径默认隐藏）
    const courseDetail = await app.request(`/api/teacher/courses/${courseId}`, {
      headers: { cookie: teacherCookie },
    });
    const item = (
      (await courseDetail.json()) as {
        data: { items: { id: string; refId: string | null }[] };
      }
    ).data.items.find((entry) => entry.refId === unitId);
    expect(item).toBeDefined();
    const patched = await app.request(`/api/teacher/course-items/${item?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ visible: true }),
    });
    expect(patched.status).toBe(200);
    const added = await app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ studentIds: [base.aId] }),
      },
    );
    expect(added.status).toBe(200);
    return {
      app,
      db: base.db,
      teacherCookie,
      aCookie: base.aCookie,
      courseId,
      unitId,
    };
  }

  it("course 来源：开卷后改题干与答案，当前卷旧内容、判分按旧答案；再做一次（新卷）用新版", async () => {
    const env = await makeCourseEnv();
    const start = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}/attempts`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(start.status).toBe(201);
    const attemptId = ((await start.json()) as { data: { id: string } }).data
      .id;

    // 教师改第一题：题干「是正数」→「是正整数」、答案 正确 → 错误
    await editQuestion(env.app, env.teacherCookie, "冻结课程练习-1", [
      ["$1$ 是正数。[[正确]]", "$1$ 是正整数。[[错误]]"],
    ]);

    // 当前卷（第 1 次）显示旧题干；按旧答案（true）判对
    const questions = await draftQuestions(env.app, env.aCookie, attemptId);
    expect(questions).toHaveLength(2);
    expect(questions[0]?.stemMd).toContain("$1$ 是正数。");
    expect(
      (
        await putAnswer(env.app, env.aCookie, attemptId, "冻结课程练习-1", {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    const submitRes = await submitWithCurrentRevisions(
      env.app,
      env.aCookie,
      attemptId,
    );
    expect(submitRes.status).toBe(200);
    const result = (await submitRes.json()) as {
      data: {
        units: {
          questions: { questionId: string; autoCorrect: boolean | null }[];
        }[];
      };
    };
    const first = result.data.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.questionId === "冻结课程练习-1");
    expect(first?.autoCorrect).toBe(true);

    // 再做一次（新卷）：新题干「是正整数」
    const again = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${env.unitId}/attempts`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(again.status).toBe(201);
    const newAttemptId = ((await again.json()) as { data: { id: string } }).data
      .id;
    const newQuestions = await draftQuestions(
      env.app,
      env.aCookie,
      newAttemptId,
    );
    expect(newQuestions[0]?.stemMd).toContain("$1$ 是正整数。");
  });

  it("wrong 来源：建卷即冻结（既有行为回归）——冻结行齐备、frozenAt 置位", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    // 张三交一份卷（两题判错），进入错题本
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: false,
    });
    await putAnswer(app, aCookie, attemptId, Q.choice, {
      kind: "choice",
      index: 0,
    });
    expect(
      (await submitWithCurrentRevisions(app, aCookie, attemptId)).status,
    ).toBe(200);

    const wrongRes = await app.request("/api/student/wrong-practice", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: JSON.stringify({ questionIds: [Q.judge, Q.choice] }),
    });
    expect(wrongRes.status).toBe(201);
    const wrongAttemptId = ((await wrongRes.json()) as { data: { id: string } })
      .data.id;
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, wrongAttemptId))
      .get();
    expect(attemptRow?.frozenAt).not.toBeNull();
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, wrongAttemptId))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.questionSnapshotJson !== null)).toBe(true);
  });
});

describe("T6R.3 迁移三分支（升级遗留行）", () => {
  it("分支①升级前已交卷：沿用既有交卷快照，不重写、不补冻结标记（frozenAt 保持 null）", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    expect(
      (await submitWithCurrentRevisions(app, aCookie, attemptId)).status,
    ).toBe(200);
    // 还原升级前形态：已交卷行本就没有冻结标记
    db.update(attempts)
      .set({ frozenAt: null, legacyUnverified: false })
      .where(eq(attempts.id, attemptId))
      .run();

    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const result = (body as { data: { summary: { total: number } } }).data;
    expect(result.summary.total).toBe(8);
    // 不懒冻结：已交卷读路径不写 frozenAt
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.frozenAt).toBeNull();
  });

  it("分支②升级前进行中：首次恢复访问懒冻结当前可取得版本，保留已有答案，标记 legacy_unverified", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    // 张三已答一题（有草稿）——随后系统「升级」，还原升级前草稿形态
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.judge, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    downgradeToLegacyDraft(db, attemptId);

    // 首次恢复访问：GET 详情触发懒冻结
    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const parsed = attemptDraftOkSchema.safeParse(body);
    if (!parsed.success)
      throw new Error(`草稿视图契约解析失败：${parsed.error}`);
    // 草稿视图带 legacy_unverified 标记（前端据此提示内容为恢复版本）
    expect(parsed.data.data.legacyUnverified).toBe(true);
    // 已有答案保留
    expect(parsed.data.data.drafts[Q.judge]).toEqual({
      kind: "judge",
      value: true,
    });
    // 库：全部 live 题补齐快照；frozenAt 置位；legacyUnverified 置位
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.frozenAt).not.toBeNull();
    expect(attemptRow?.legacyUnverified).toBe(true);
    const rows = db
      .select()
      .from(responses)
      .where(eq(responses.attemptId, attemptId))
      .all();
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.questionSnapshotJson !== null)).toBe(true);
    // 答案未被懒冻结破坏
    const judgeRow = rows.find((row) => row.questionId === Q.judge);
    expect(JSON.parse(judgeRow?.answerJson ?? "null")).toEqual({
      kind: "judge",
      value: true,
    });
  });

  it("分支②软删题：升级前答过、恢复时已被软删 → 行保留答案但按「历史题目缺失」计，不进视图、不拿当前题库回填", async () => {
    const { app, db, teacherCookie, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.fill, {
      kind: "fill",
      values: ["4", "-7", "1/2"],
    });
    await downgradeToLegacyDraft(db, attemptId);
    // 恢复访问前，教师软删了张三已作答的 fill 题
    await softDeleteQuestion(app, teacherCookie, Q.fill);

    // 首次恢复访问：fill 不出现在草稿视图（历史题目缺失），其余 7 题冻结
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions).toHaveLength(7);
    expect(questions.some((question) => question.id === Q.fill)).toBe(false);
    // 但答案行保留在库里（不删不回填）
    const fillRow = db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.fill),
        ),
      )
      .get();
    expect(fillRow).toBeDefined();
    expect(fillRow?.answerJson).not.toBeNull();
    expect(fillRow?.questionSnapshotJson).toBeNull();
  });

  it("分支③损坏快照：懒冻结不回填、视图按缺失计（不拿当前题伪造）", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    await downgradeToLegacyDraft(db, attemptId);
    // 造一个「快照损坏」的行：非空但不是合法 Question JSON
    db.update(responses)
      .set({ questionSnapshotJson: "{bad json" })
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.judge),
        ),
      )
      .run();

    // 懒冻结后：损坏行不被回填（仍非空坏数据）、该题不进视图
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions).toHaveLength(7);
    expect(questions.some((question) => question.id === Q.judge)).toBe(false);
    const judgeRow = db
      .select()
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.judge),
        ),
      )
      .get();
    expect(judgeRow?.questionSnapshotJson).toBe("{bad json");
  });

  it("陈旧提交：懒冻结后旧页面（不携带版本集合）提交非空卷被可诊断拒绝（409 QUESTION_REVISION_STALE）", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    await downgradeToLegacyDraft(db, attemptId);
    // 首次访问触发懒冻结（模拟系统已恢复），随后旧标签页直接交卷（无请求体）
    const { res } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);

    const submitRes = await postSubmit(app, aCookie, attemptId);
    expect(submitRes.status).toBe(409);
    expect(((await submitRes.json()) as ApiErr).error).toBe(
      "QUESTION_REVISION_STALE",
    );
    // 交卷被拒后 attempt 仍为 draft，答案仍在
    const attemptRow = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .get();
    expect(attemptRow?.status).toBe("draft");
  });
});

describe("T6R.3 交卷回传题目版本验证（questionRevisionId）", () => {
  it("携带完整正确版本集合 → 交卷成功；错误/缺项/多项 → 409 QUESTION_REVISION_STALE", async () => {
    const { app, aCookie, bCookie, assignmentId } = await makeEnv();

    // 张三：全量取版本集合后交卷
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    const questions = await draftQuestions(app, aCookie, attemptId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    const ok = await postSubmitWithRevisions(
      app,
      aCookie,
      attemptId,
      questions.map((question) => ({
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
      })),
    );
    expect(ok.status).toBe(200);

    // 李四：错版（指向张三卷的行 id）→ 409
    const bAttemptId = await startAttemptId(app, bCookie, assignmentId);
    const bQuestions = await draftQuestions(app, bCookie, bAttemptId);
    const wrong = await postSubmitWithRevisions(
      app,
      bCookie,
      bAttemptId,
      bQuestions.map((question, index) => ({
        questionId: question.id,
        // 用别的题的版本 id（错版）
        questionRevisionId:
          bQuestions[(index + 1) % bQuestions.length]?.questionRevisionId ??
          "x",
      })),
    );
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as ApiErr).error).toBe(
      "QUESTION_REVISION_STALE",
    );

    // 缺项（去掉最后一题）→ 409；多项（多塞一条未知题）→ 409
    const missing = await postSubmitWithRevisions(
      app,
      bCookie,
      bAttemptId,
      bQuestions.slice(0, -1).map((question) => ({
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
      })),
    );
    expect(missing.status).toBe(409);
    const extra = await postSubmitWithRevisions(app, bCookie, bAttemptId, [
      ...bQuestions.map((question) => ({
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
      })),
      {
        questionId: "不存在的题",
        questionRevisionId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    expect(extra.status).toBe(409);

    // 李四带正确集合 → 200（409 后可刷新重交）
    const retry = await postSubmitWithRevisions(
      app,
      bCookie,
      bAttemptId,
      bQuestions.map((question) => ({
        questionId: question.id,
        questionRevisionId: question.questionRevisionId,
      })),
    );
    expect(retry.status).toBe(200);
  });

  it("空卷（冻结集合为空）不带请求体交卷 → 200（空集合自然通过，不误伤）", async () => {
    const { app, teacherCookie, aCookie, assignmentId } = await makeEnv();
    // 开卷前教师把八题全部软删 → 张三开卷时冻结集合为空
    for (const questionId of Object.values(Q)) {
      await softDeleteQuestion(app, teacherCookie, questionId);
    }
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions).toHaveLength(0);

    // 空卷不带请求体：空集合自然通过（不误伤无题作业的交卷）
    const submitRes = await postSubmit(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const body = (await submitRes.json()) as {
      data: { summary: { total: number }; attempt: { status: string } };
    };
    expect(body.data.summary.total).toBe(0);
    expect(["submitted", "graded"]).toContain(body.data.attempt.status);
  });
});

describe("T6R.3 /code-review P0 回归：幽灵行 / 懒冻结展示序 / wrong 存量标记 / 导出序", () => {
  it("幽灵行不卡批改状态机：存量卷含软删已答的题 → 交卷后待批只含真实题，批完即 graded（幽灵行不计入重算/谓词/队列/题数）", async () => {
    const { app, db, teacherCookie, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    // 张三答对五道客观题 + 答过 fill（将被软删成幽灵行）；fillMath 不答（真实待批）
    for (const [qid, answer] of [
      [Q.judge, { kind: "judge", value: true }],
      [Q.choice, { kind: "choice", index: 1 }],
      [Q.multi, { kind: "multi", indexes: [0, 2] }],
      [Q.solve, { kind: "final", finalAnswer: "-3" }],
      [Q.apply, { kind: "final", finalAnswer: "1.4" }],
    ] as const) {
      expect(
        (await putAnswer(app, aCookie, attemptId, qid, answer)).status,
      ).toBe(200);
    }
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.fill, {
          kind: "fill",
          values: ["4", "-7", "1/2"],
        })
      ).status,
    ).toBe(200);
    await downgradeToLegacyDraft(db, attemptId);
    // 恢复访问前教师软删 fill（张三答过的题 → 幽灵行：快照空、答案保留）与
    // 未答的 findError（升级前无行 → 不进冻结集合，连幽灵行都不是）
    await softDeleteQuestion(app, teacherCookie, Q.fill);
    await softDeleteQuestion(app, teacherCookie, Q.findError);

    // 首次访问懒冻结：fill 的行不补快照（幽灵行），其余 live 题冻结
    const questions = await draftQuestions(app, aCookie, attemptId);
    expect(questions).toHaveLength(6); // fill/findError 缺席（历史题目缺失）
    expect(questions.some((question) => question.id === Q.fill)).toBe(false);

    // 交卷：参与判分 7 题；fillMath 真实待批 1 题（幽灵行不计入）
    const submitRes = await submitWithCurrentRevisions(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const submitted = (await submitRes.json()) as {
      data: {
        summary: { total: number; pending: number };
        attempt: { status: string };
      };
    };
    expect(submitted.data.summary.total).toBe(6);
    expect(submitted.data.summary.pending).toBe(1); // 仅 fillMath
    expect(submitted.data.attempt.status).toBe("submitted");

    // 教师待批队列：只有 fillMath 一张真实卡片（幽灵行绝不进队列）
    const queue = await app.request("/api/teacher/pending-marks", {
      headers: { cookie: teacherCookie },
    });
    expect(queue.status).toBe(200);
    const marks = (
      (await queue.json()) as { data: { marks: { questionId: string }[] } }
    ).data.marks;
    expect(marks.map((m) => m.questionId)).toEqual([Q.fillMath]);

    // 教师批完 fillMath → 整卷重算排除幽灵行 → graded（不再永卡 submitted）
    const fillMathRowId = db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(
          eq(responses.attemptId, attemptId),
          eq(responses.questionId, Q.fillMath),
        ),
      )
      .get()?.id;
    expect(fillMathRowId).toBeDefined();
    const mark = await app.request(
      `/api/teacher/responses/${fillMathRowId}/mark`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ mark: "correct", comment: null }),
      },
    );
    expect(mark.status).toBe(200);
    const marked = (await mark.json()) as {
      data: { attemptStatus: string; pendingCount: number; scoreFinal: number };
    };
    expect(marked.data.attemptStatus).toBe("graded");
    expect(marked.data.pendingCount).toBe(0);
    expect(marked.data.scoreFinal).toBe(100);

    // 教师列表题数同过滤（幽灵行不计数）
    const list = await app.request("/api/teacher/attempts?status=graded", {
      headers: { cookie: teacherCookie },
    });
    expect(list.status).toBe(200);
    const cards = (
      (await list.json()) as {
        data: { attempts: { attemptId: string; questionCount: number }[] };
      }
    ).data.attempts;
    const card = cards.find((c) => c.attemptId === attemptId);
    expect(card?.questionCount).toBe(6);
  });

  it("懒冻结存量卷展示序走遗留 join 序：多单元存量草稿（单元二先答）→ 懒冻结后展示序 = 组卷序（单元一在前）", async () => {
    const { app, db, teacherCookie, aCookie } = await makeEnv();
    // 导入第二份练习生成另一单元，布置双单元作业（单元一练习四、单元二练习五）
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
    const aIdRow = db
      .select()
      .from(students)
      .all()
      .find((row) => row.displayName === "张三");
    expect(aIdRow).toBeDefined();
    const assignRes = await app.request("/api/teacher/assignments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        unitIds: ["练习四", "练习五"],
        studentIds: [aIdRow?.id ?? ""],
      }),
    });
    expect(assignRes.status).toBe(201);
    const assignmentId = (
      (await assignRes.json()) as { data: { assignments: { id: string }[] } }
    ).data.assignments[0]?.id;
    if (assignmentId === undefined) throw new Error("布置双单元作业缺 id");

    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    // 先答单元二的题（升级前创建的行 rowid 靠前——若按冻结 rowid 序会置顶）
    expect(
      (
        await putAnswer(app, aCookie, attemptId, "练习五-1", {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    await downgradeToLegacyDraft(db, attemptId);

    // 懒冻结后：展示序走遗留 join（单元一在前、组内题序），不是 rowid 序
    const { body } = await getAttempt(app, aCookie, attemptId);
    const parsed = attemptDraftOkSchema.safeParse(body);
    if (!parsed.success) throw new Error(`草稿视图解析失败：${parsed.error}`);
    expect(parsed.data.data.legacyUnverified).toBe(true);
    expect(parsed.data.data.units[0]?.id).toBe("练习四");
    expect(parsed.data.data.units[1]?.id).toBe("练习五");
    expect(parsed.data.data.units[0]?.questions[0]?.id).toBe(Q.judge);
    expect(parsed.data.data.units[1]?.questions[0]?.id).toBe("练习五-1");
  });

  it("存量 wrong 卷：首次恢复访问只补冻结标记（frozenAt=startedAt、legacyUnverified=false），不重读题库", async () => {
    const { app, db, aCookie, assignmentId } = await makeEnv();
    // 交一份含判错题的卷 → 组 wrong 重练卷
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: false,
    });
    expect(
      (await submitWithCurrentRevisions(app, aCookie, attemptId)).status,
    ).toBe(200);
    const wrongRes = await app.request("/api/student/wrong-practice", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: JSON.stringify({ questionIds: [Q.judge] }),
    });
    expect(wrongRes.status).toBe(201);
    const wrongAttemptId = ((await wrongRes.json()) as { data: { id: string } })
      .data.id;
    // 还原升级前形态：行不变（快照齐备）、冻结标记清空
    const startedAt = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, wrongAttemptId))
      .get()?.startedAt;
    db.update(attempts)
      .set({ frozenAt: null, legacyUnverified: false })
      .where(eq(attempts.id, wrongAttemptId))
      .run();

    // 首次恢复访问：只补标记（frozenAt 回填 startedAt，非当下时刻；非 legacy）
    const { res } = await getAttempt(app, aCookie, wrongAttemptId);
    expect(res.status).toBe(200);
    const row = db
      .select()
      .from(attempts)
      .where(eq(attempts.id, wrongAttemptId))
      .get();
    expect(row?.frozenAt).toBe(startedAt);
    expect(row?.legacyUnverified).toBe(false);
  });

  it("重排后导出题序与学生视图一致（assignment 与 wrong 卷——考点列为指纹）", async () => {
    const { app, teacherCookie, aCookie, assignmentId } = await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    // judge/choice 答错（进错题本，供 wrong 重练组卷）
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: false,
    });
    await putAnswer(app, aCookie, attemptId, Q.choice, {
      kind: "choice",
      index: 0,
    });
    const frozenView = await draftQuestions(app, aCookie, attemptId);
    const frozenOrder = frozenView.map((question) => question.id);
    const frozenKnowledge = frozenView.map((question) =>
      question.knowledge.join("；"),
    );
    expect(
      (await submitWithCurrentRevisions(app, aCookie, attemptId)).status,
    ).toBe(200);

    // 教师倒序重排 → CSV 导出题序仍 = 学生冻结序（旧 join 实现会导出倒序）
    const reorder = await app.request("/api/teacher/reorder", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        kind: "question",
        ids: [...frozenOrder].reverse(),
      }),
    });
    expect(reorder.status).toBe(200);
    const csvRes = await app.request(
      `/api/teacher/export/csv?assignmentId=${assignmentId}`,
      { headers: { cookie: teacherCookie } },
    );
    expect(csvRes.status).toBe(200);
    const bytes = new Uint8Array(await csvRes.arrayBuffer());
    const text = new TextDecoder().decode(bytes.slice(3)); // 剥 BOM
    const lines = text.split("\r\n").filter((line) => line.trim() !== "");
    const body = lines.slice(1); // 去表头
    expect(body).toHaveLength(8);
    // 第 10 列（考点）= 各题冻结 knowledge，顺序 = 学生冻结序
    const csvKnowledge = body.map((line) => line.split(",")[9] ?? "");
    expect(csvKnowledge).toEqual(frozenKnowledge);

    // wrong 卷：导出同样按建卷 rowid 序（学生视图同一序）
    const wrongRes = await app.request("/api/student/wrong-practice", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: JSON.stringify({ questionIds: [Q.judge, Q.choice] }),
    });
    expect(wrongRes.status).toBe(201);
    const wrongAttemptId = ((await wrongRes.json()) as { data: { id: string } })
      .data.id;
    const wrongView = await draftQuestions(app, aCookie, wrongAttemptId);
    expect(wrongView.map((question) => question.id)).toEqual([
      Q.judge,
      Q.choice,
    ]);
    const wrongKnowledge = wrongView.map((question) =>
      question.knowledge.join("；"),
    );
    expect(
      (await submitWithCurrentRevisions(app, aCookie, wrongAttemptId)).status,
    ).toBe(200);
    const wrongCsv = await app.request(
      `/api/teacher/export/csv?sourceType=wrong`,
      { headers: { cookie: teacherCookie } },
    );
    expect(wrongCsv.status).toBe(200);
    const wrongBytes = new Uint8Array(await wrongCsv.arrayBuffer());
    const wrongText = new TextDecoder().decode(wrongBytes.slice(3));
    const wrongRows = wrongText
      .split("\r\n")
      .filter((line) => line.includes("错题重练") && line.trim() !== "");
    expect(wrongRows).toHaveLength(2);
    expect(wrongRows.map((line) => line.split(",")[9] ?? "")).toEqual(
      wrongKnowledge,
    );
  });
});

describe("T6R.3 /code-review 补口：开卷后加题 / 改选项文本与正确项", () => {
  it("开卷后教师往单元加新题：当前卷不含该题，新开的卷（另一学生）含", async () => {
    const { app, db, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    expect(await draftQuestions(app, aCookie, attemptId)).toHaveLength(8);

    // 教师往同单元加第九题（真实路径：同文件名重导入更新原单元，题目 id 缺省编号）
    const addedMd = `${PRACTICE_MD}
::::question{type=judge difficulty=1 knowledge="有理数的概念"}
$-1$ 是负数。[[正确]]
::::
`;
    const reimport = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown: addedMd, filename: "练习样例.md" }),
    });
    expect(reimport.status).toBe(200);
    // 前置自检：单元确已加上第九题（缺省 id 练习四-9）
    const addedRow = db
      .select()
      .from(questions)
      .all()
      .find((row) => row.id === "练习四-9" && row.deletedAt === null);
    expect(addedRow).toBeDefined();

    // 张三的进行中卷：不含新题（冻结集合固定）
    const current = await draftQuestions(app, aCookie, attemptId);
    expect(current).toHaveLength(8);
    expect(current.some((question) => question.id === "练习四-9")).toBe(false);

    // 李四后开卷：新卷含新题（9 题）
    const bAttemptId = await startAttemptId(app, bCookie, assignmentId);
    const bQuestions = await draftQuestions(app, bCookie, bAttemptId);
    expect(bQuestions).toHaveLength(9);
    expect(bQuestions.some((question) => question.id === "练习四-9")).toBe(
      true,
    );
  });

  it("开卷后教师改选项文本与正确项：当前卷显示旧选项文本、判分按旧正确项；新卷用新选项", async () => {
    const { app, teacherCookie, aCookie, bCookie, assignmentId } =
      await makeEnv();
    const attemptId = await startAttemptId(app, aCookie, assignmentId);
    const oldOptions = (await draftQuestions(app, aCookie, attemptId)).find(
      (question) => question.id === Q.choice,
    )?.options;
    expect(oldOptions).toEqual([
      "$-5$",
      "$5$",
      "$\\frac{1}{5}$",
      "$-\\frac{1}{5}$",
    ]);

    // 教师改选项文本（B 项 $5$ → $+5$）并把正确项从 B 挪到 D
    await editQuestion(app, teacherCookie, Q.choice, [
      ["- [x] $5$", "- [ ] $+5$"],
      ["- [ ] $-\\frac{1}{5}$", "- [x] $-\\frac{1}{5}$"],
    ]);

    // 张三当前卷：选项文本仍是旧版（含 $5$ 不含 $+5$）
    const current = (await draftQuestions(app, aCookie, attemptId)).find(
      (question) => question.id === Q.choice,
    );
    expect(current?.options).toEqual(oldOptions);

    // 判分按旧正确项：答旧正确 B（index 1）→ true（当前题库正确项已是 D）
    expect(
      (
        await putAnswer(app, aCookie, attemptId, Q.choice, {
          kind: "choice",
          index: 1,
        })
      ).status,
    ).toBe(200);
    const submitRes = await submitAttemptRequest(app, aCookie, attemptId);
    expect(submitRes.status).toBe(200);
    const result = (await submitRes.json()) as {
      data: {
        units: {
          questions: { questionId: string; autoCorrect: boolean | null }[];
        }[];
      };
    };
    const choiceResult = result.data.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.questionId === Q.choice);
    expect(choiceResult?.autoCorrect).toBe(true);

    // 李四的新卷：新选项文本（$+5$）
    const bAttemptId = await startAttemptId(app, bCookie, assignmentId);
    const newOptions = (await draftQuestions(app, bCookie, bAttemptId)).find(
      (question) => question.id === Q.choice,
    )?.options;
    expect(newOptions?.[1]).toBe("$+5$");
  });
});
