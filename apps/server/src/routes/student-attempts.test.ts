import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  type AttemptDraftData,
  type AttemptResultData,
  attemptDraftOkSchema,
  attemptResultOkSchema,
  attemptStartOkSchema,
  type StudentAssignmentListData,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { attempts, questions, responses } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

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
 * - 作业状态联动：开始作答 in_progress、交卷后 submitted。
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

/** 全套前置：教师 + 导入样例 + 张三（被指派）/李四（未被指派）+ 一份作业 */
async function makeAttemptApp(): Promise<{
  app: App;
  db: Db;
  teacherCookie: string;
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
  });
  const setup = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;

  const importRes = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(importRes.status).toBe(200);
  const imported = (await importRes.json()) as {
    data: { units: { id: string }[] };
  };
  const unitId = imported.data.units[0]?.id;
  if (!unitId) throw new Error("样例导入未产出单元");

  const aId = await createStudent(app, teacherCookie, "张三");
  await createStudent(app, teacherCookie, "李四");
  const assignmentId = await createAssignment(app, teacherCookie, unitId, aId);
  return {
    app,
    db,
    teacherCookie,
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
): Promise<string> {
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitId, studentIds: [studentId] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
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

/** POST 交卷 */
function postSubmit(
  app: App,
  cookie: string | undefined,
  attemptId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: cookie === undefined ? {} : { cookie },
    }),
  );
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
    expect(first.unitId).toBe("练习四");

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

  it("跨单元题 404 QUESTION_NOT_FOUND；已软删题 404", async () => {
    const { app, teacherCookie, aCookie, assignmentId } =
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

    // 软删本题后保存 → 404
    const del = await app.request(`/api/teacher/questions/${Q.apply}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);
    const gone = await putAnswer(app, aCookie, attemptId, Q.apply, {
      kind: "final",
      finalAnswer: "1.4",
    });
    expect(gone.status).toBe(404);
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
  it("全对组合：逐题 autoCorrect=true，scoreAuto=100，summary 齐全", async () => {
    const { app, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    for (const [questionId, answer] of Object.entries(ALL_CORRECT_ANSWERS)) {
      const res = await putAnswer(app, aCookie, attemptId, questionId, answer);
      expect(res.status, `保存 ${questionId} 失败`).toBe(200);
    }
    const res = await postSubmit(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(attemptResultOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: AttemptResultData }).data;
    expect(data.attempt.status).toBe("submitted");
    expect(data.attempt.scoreAuto).toBe(100);
    expect(data.summary).toEqual({
      total: 8,
      answered: 8,
      correct: 8,
      wrong: 0,
      pending: 0,
      unanswered: 0,
      autoGradable: 8,
    });
    expect(data.questions.every((q) => q.autoCorrect === true)).toBe(true);
  });

  it("部分错/未答组合：答错 false、未答 null 且不写 answerJson；scoreAuto=答对/可判分", async () => {
    const { app, db, aCookie, assignmentId } = await makeAttemptApp();
    const attemptId = (await startAttemptOk(app, aCookie, assignmentId))
      .id as string;
    // 对：judge、choice、solve；错：multi（漏选）、fill（第二空错）；未答：其余三题
    await putAnswer(app, aCookie, attemptId, Q.judge, {
      kind: "judge",
      value: true,
    });
    await putAnswer(app, aCookie, attemptId, Q.choice, {
      kind: "choice",
      index: 1,
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
    const byId = new Map(data.questions.map((q) => [q.questionId, q]));

    expect(byId.get(Q.judge)?.autoCorrect).toBe(true);
    expect(byId.get(Q.choice)?.autoCorrect).toBe(true);
    expect(byId.get(Q.solve)?.autoCorrect).toBe(true); // -3 与 \frac 写法数值等价
    expect(byId.get(Q.multi)?.autoCorrect).toBe(false); // 漏选 → false
    expect(byId.get(Q.fill)?.autoCorrect).toBe(false); // 部分空错 → false
    expect(byId.get(Q.fillMath)?.autoCorrect).toBeNull(); // 未答 → null
    expect(byId.get(Q.apply)?.autoCorrect).toBeNull();
    expect(byId.get(Q.findError)?.autoCorrect).toBeNull();

    // scoreAuto = 答对 3 / 可自动判分 5 = 60（四舍五入百分比）
    expect(data.attempt.scoreAuto).toBe(60);
    expect(data.summary.correct).toBe(3);
    expect(data.summary.wrong).toBe(2);
    expect(data.summary.pending).toBe(3);
    expect(data.summary.unanswered).toBe(3);
    expect(data.summary.autoGradable).toBe(5);

    // 未答题也写了 responses 行（answerJson=null、快照非空、版本冻结）
    const rows = db.select().from(responses).all();
    expect(rows.length).toBe(8);
    const unansweredRow = rows.find((row) => row.questionId === Q.apply);
    expect(unansweredRow?.answerJson).toBeNull();
    expect(unansweredRow?.questionSnapshotJson).toContain("水箱水位");
    expect(unansweredRow?.autoCorrect).toBeNull();
    expect(unansweredRow?.questionVersion).toBe(1);
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

    // 结果视图：仍是旧题干（含 [[4]]）与旧参考答案
    const { res, body } = await getAttempt(app, aCookie, attemptId);
    expect(res.status).toBe(200);
    const data = (body as { data: AttemptResultData }).data;
    const fill = data.questions.find((q) => q.questionId === Q.fill);
    expect(fill?.snapshot.stemMd).toContain("[[4]]");
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
    const draft = (body as { data: AttemptDraftData }).data;
    expect(draft.questions.length).toBe(8);
    expect(draft.questions.map((q) => q.id)).toEqual([
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
    expect(JSON.stringify(draft.questions)).not.toContain("[[4]]");
    expect(JSON.stringify(draft.questions)).not.toContain("[[正确]]");
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
    // 详解与参考答案确实下发了（交卷后语义）
    const data = (body as { data: AttemptResultData }).data;
    expect(JSON.stringify(data)).toContain("故选 B");
    expect(JSON.stringify(data)).toContain("[[4]]"); // 原始题干含答案标记
    const judge = data.questions.find((q) => q.questionId === Q.judge);
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
