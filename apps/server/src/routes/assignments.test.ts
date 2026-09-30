import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  assignmentCreateOkSchema,
  studentAssignmentListOkSchema,
  studentPaperOkSchema,
  teacherAssignmentListOkSchema,
} from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  assignmentStudents,
  assignments,
  assignmentUnits,
  questions,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import {
  type AssignmentAttemptSummary,
  computeAssignmentStatus,
} from "../services/assignment-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * 作业接口集成测试（T2.2 验收项起家；T2A.7 大改后覆盖 D12–D16）：
 * - 多单元布置：unitIds 顺序 = 作业内单元顺序；重复 400 DUPLICATE_UNIT；
 *   缺省标题 = 首个单元标题 /「首个单元标题 等 n 个单元」；courseId 校验；
 * - 多单元取卷（paper.units 分组、顺序、空单元跳过）与题号全卷连续的作答链路
 *   （跨单元草稿、判分全卷口径、他作业单元题 404）；
 * - 名单增删（D13）：addStudentIds 立即可见、removeStudentIds 未开始直接移除、
 *   移出已开始学生 409 CONFIRM_REQUIRED（附 _students）→ confirmStarted 后成功
 *   且已交卷结果仍可查、作业待办消失；add/remove 交集 400；课程成员变化不
 *   影响已布置名单（快照语义）；
 * - 内容锁定（D14）：首个 attempt 后 PATCH unitIds 409 ASSIGNMENT_CONTENT_LOCKED，
 *   标题/截止/名单仍可改；
 * - check 接口（D15）：课程练习已交卷次数；未做/仅草稿无行；作业作答不计入；
 * - 软删单元（D16）：paper/判分不含已删单元题目、作业照常作答；
 * - D4：关联作业的课程删除被拒；纯成员课程可删；
 * - 学生端新结构 assertNoLeak（列表 / 分组试卷 / 分组草稿视图 / 分组结果视图）；
 * - 迁移兼容：旧单单元作业（D23-5 回填形态）经新接口照常；
 * - 删除 = 软删、会话隔离、computeAssignmentStatus 纯函数。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
/** 合法 UTC 截止时间（契约要求带 Z 后缀） */
const DUE_AT = "2026-10-01T12:00:00.000Z";

/** 单题练习文档（1 个单元、1 道带答案的填空题；泄露测试需库里真实存在答案） */
const PRACTICE_MD = (unit: string): string => `---
kind: practice
unit: ${unit}
topic: 方程
---

::::question{type=fill difficulty=2}
解方程 $x+1=3$，则 $x=$ [[2]]
::::
`;

/** 双题单元 A（判断 + 填空，均可自动判分） */
const UNIT_A = "一元一次方程";
const UNIT_A_MD = `---
kind: practice
unit: ${UNIT_A}
topic: 方程
---

::::question{type=judge difficulty=1}
等式两边同时加上同一个数，等式仍然成立。[[正确]]
::::

::::question{type=fill difficulty=2}
解方程 $x+1=3$，则 $x=$ [[2]]
::::
`;

/** 双题单元 B（两道填空，均可自动判分） */
const UNIT_B = "有理数乘除";
const UNIT_B_MD = `---
kind: practice
unit: ${UNIT_B}
topic: 有理数
---

::::question{type=fill difficulty=1}
计算：$(-3) \\times 2=$ [[-6]]
::::

::::question{type=fill difficulty=2}
计算：$12 \\div (-4)=$ [[-3]]
::::
`;

/** 组装被测应用：内存库 + 教师 Cookie（每条用例独立实例） */
async function makeApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
}> {
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
  return {
    app,
    db,
    teacherCookie: `tutor_session=${extractSessionToken(setup)}`,
  };
}

/** 发带 JSON body 的请求（POST/PATCH 默认 POST，可带 Cookie） */
async function request(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  cookie?: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return app.request(path, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

/** 从 set-cookie 里取出 tutor_session 的值 */
function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) {
    throw new Error("响应中没有 tutor_session cookie");
  }
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 导入一份练习文档，返回单元 id（= frontmatter unit，来自 DSL） */
async function importDoc(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  markdown: string,
): Promise<string> {
  const res = await request(
    app,
    "/api/teacher/import/commit",
    { markdown, filename: "练习.md" },
    teacherCookie,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { units: { id: string }[] } };
  const unitId = body.data.units[0]?.id;
  if (!unitId) throw new Error("导入未产出单元");
  return unitId;
}

/** 导入最小单题练习文档（默认单元名可覆盖） */
async function importUnit(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  unit = "一元一次方程",
): Promise<string> {
  return importDoc(app, teacherCookie, PRACTICE_MD(unit));
}

/** 创建学生并返回 id（密码固定，便于登录） */
async function createStudent(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  name: string,
): Promise<string> {
  const res = await request(
    app,
    "/api/teacher/students",
    { displayName: name, loginName: name, password: STUDENT_PASSWORD },
    teacherCookie,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { student: { id: string } } };
  return body.data.student.id;
}

/** 学生密码登录，返回学生 Cookie */
async function loginStudent(
  app: ReturnType<typeof createApp>,
  name: string,
): Promise<string> {
  const res = await request(app, "/api/public/student/login", {
    loginName: name,
    password: STUDENT_PASSWORD,
  });
  expect(res.status).toBe(200);
  return `tutor_session=${extractSessionToken(res)}`;
}

/** 布置作业（断言 201），返回响应 data */
async function createAssignment(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request(
    app,
    "/api/teacher/assignments",
    body,
    teacherCookie,
  );
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { data: Record<string, unknown> };
  return parsed.data;
}

/** PATCH 作业（返回原始 Response） */
function patchAssignment(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  id: string,
  body: unknown,
): Promise<Response> {
  return request(
    app,
    `/api/teacher/assignments/${id}`,
    body,
    teacherCookie,
    "PATCH",
  );
}

/** 教师作业列表（可带 courseId 筛选与 includeDeleted） */
async function teacherList(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  options: { includeDeleted?: boolean; courseId?: string } = {},
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (options.includeDeleted) params.set("includeDeleted", "true");
  if (options.courseId !== undefined) params.set("courseId", options.courseId);
  const qs = params.toString();
  const res = await app.request(
    qs.length > 0
      ? `/api/teacher/assignments?${qs}`
      : "/api/teacher/assignments",
    { headers: { cookie: teacherCookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { assignments: Record<string, unknown>[] };
  };
  return body.data.assignments;
}

/** 学生作业列表（原始 Response，泄露测试需要原文） */
async function studentListRes(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
): Promise<Response> {
  return app.request("/api/student/assignments", {
    headers: { cookie: studentCookie },
  });
}

/** 学生作业列表（解析后的 data.assignments） */
async function studentList(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
): Promise<Record<string, unknown>[]> {
  const res = await studentListRes(app, studentCookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { assignments: Record<string, unknown>[] };
  };
  return body.data.assignments;
}

/** 学生列表条目 units 的最小形状提取（按内容定位作业用，不做完整契约解析）：
 *  units 非数组或元素无 id 时返回空列表，由调用方的「找不到即 throw」兜底 */
function rowUnitIds(row: Record<string, unknown>): { id: unknown }[] {
  const units = row.units;
  if (!Array.isArray(units)) return [];
  return units.filter(
    (unit): unit is { id: unknown } =>
      typeof unit === "object" && unit !== null && "id" in unit,
  );
}

/** 学生取分组试卷（解析后的 data） */
async function studentPaper(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
  assignmentId: string,
): Promise<{
  units: { id: string; title: string; questions: { id: string }[] }[];
}> {
  const res = await app.request(
    `/api/student/assignments/${assignmentId}/paper`,
    { headers: { cookie: studentCookie } },
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        units: { id: string; title: string; questions: { id: string }[] }[];
      };
    }
  ).data;
}

/** 学生开始/取回作业 attempt（断言 200），返回摘要 */
async function startAttempt(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
  assignmentId: string,
): Promise<Record<string, unknown>> {
  const res = await app.request(
    `/api/student/assignments/${assignmentId}/attempt`,
    { method: "POST", headers: { cookie: studentCookie } },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** 保存草稿答案（返回原始 Response） */
function saveAnswer(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
): Promise<Response> {
  return request(
    app,
    `/api/student/attempts/${attemptId}/answers/${encodeURIComponent(questionId)}`,
    { answer },
    studentCookie,
    "PUT",
  );
}

/** 交卷（断言 200），返回结果视图 data */
async function submitAttempt(
  app: ReturnType<typeof createApp>,
  studentCookie: string,
  attemptId: string,
): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/student/attempts/${attemptId}/submit`, {
    method: "POST",
    headers: { cookie: studentCookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/**
 * 作业列表接口的泄露断言（AGENTS.md 第 3 条；T2.4 起复用通用 assertNoLeak）：
 * 通用禁用集合之外，列表条目只含公开元信息——额外禁用题干与选项字段
 * （stemMd/options/optionsJson；题目本体只经 paper 接口下发）。
 */
function assertNoTeacherSideFields(value: unknown): void {
  assertNoLeak(value, { forbid: ["stemMd", "options", "optionsJson"] });
}

// ---------- 创建（多单元 + 课程，D12/D13） ----------

describe("教师布置作业：POST /api/teacher/assignments（T2A.7 多单元）", () => {
  it("创建成功：201 + 契约壳；units 顺序 = 布置顺序；totalQuestionCount = 各单元 live 题数之和；名单去重计数", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    const aId = await createStudent(app, teacherCookie, "王五");
    const bId = await createStudent(app, teacherCookie, "张三");

    const data = await createAssignment(app, teacherCookie, {
      unitIds: [unitB, unitA],
      studentIds: [aId, bId, aId],
      dueAt: DUE_AT,
    });
    expect(assignmentCreateOkSchema.safeParse({ ok: true, data }).success).toBe(
      true,
    );
    // 缺省标题：多单元 =「首个单元标题 等 n 个单元」（快照语义）
    expect(data.title).toBe(`${UNIT_B} 等 2 个单元`);
    expect(data.dueAt).toBe(DUE_AT);
    expect(data.courseId).toBeNull();
    expect(data.courseName).toBeNull();
    // units 按布置顺序（先 B 后 A），各单元 live 题数与总题数
    expect(data.units).toEqual([
      { unitId: unitB, title: UNIT_B, questionCount: 2, deleted: false },
      { unitId: unitA, title: UNIT_A, questionCount: 2, deleted: false },
    ]);
    expect(data.totalQuestionCount).toBe(4);
    expect(data.containsDeletedUnit).toBe(false);
    expect(data.locked).toBe(false);
    // 重复 studentIds 去重后计数；全员未开始
    expect(data.studentCount).toBe(2);
    expect(data.rosterStats).toEqual({
      notStarted: 2,
      inProgress: 0,
      submitted: 0,
      graded: 0,
    });
    expect(data.deleted).toBe(false);
  });

  it("单单元作业缺省标题 = 该单元标题", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importDoc(app, teacherCookie, UNIT_A_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    const data = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
    });
    expect(data.title).toBe(UNIT_A);
    expect(data.units).toEqual([
      { unitId, title: UNIT_A, questionCount: 2, deleted: false },
    ]);
  });

  it("unitIds 含不存在的单元返回 404 UNIT_NOT_FOUND", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const res = await request(
      app,
      "/api/teacher/assignments",
      { unitIds: [unitId, "no-such-unit"], studentIds: [aId] },
      teacherCookie,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("UNIT_NOT_FOUND");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("unitIds 重复返回 400 DUPLICATE_UNIT（D12）", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const res = await request(
      app,
      "/api/teacher/assignments",
      { unitIds: [unitId, unitId], studentIds: [aId] },
      teacherCookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("DUPLICATE_UNIT");
  });

  it("courseId 不存在返回 404 COURSE_NOT_FOUND；有效课程写入并回带课程名", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");

    const bad = await request(
      app,
      "/api/teacher/assignments",
      {
        unitIds: [unitId],
        studentIds: [aId],
        courseId: "99999999-9999-4999-8999-999999999999",
      },
      teacherCookie,
    );
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");

    const courseRes = await request(
      app,
      "/api/teacher/courses",
      {
        title: "初一上",
      },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    const data = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      courseId,
    });
    expect(data.courseId).toBe(courseId);
    expect(data.courseName).toBe("初一上");
  });

  it("unitIds 为空数组 / studentIds 为空数组 / 含未知学生 / dueAt 非 UTC 返回 4xx", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");

    const noUnits = await request(
      app,
      "/api/teacher/assignments",
      { unitIds: [], studentIds: [aId] },
      teacherCookie,
    );
    expect(noUnits.status).toBe(400);
    expect(((await noUnits.json()) as ApiErr).message).toContain(
      "至少包含一个练习单元",
    );

    const noStudents = await request(
      app,
      "/api/teacher/assignments",
      { unitIds: [unitId], studentIds: [] },
      teacherCookie,
    );
    expect(noStudents.status).toBe(400);
    expect(((await noStudents.json()) as ApiErr).message).toContain(
      "至少指派一名学生",
    );

    const unknownStudent = await request(
      app,
      "/api/teacher/assignments",
      {
        unitIds: [unitId],
        studentIds: ["99999999-9999-4999-8999-999999999999"],
      },
      teacherCookie,
    );
    expect(unknownStudent.status).toBe(404);
    expect(((await unknownStudent.json()) as ApiErr).error).toBe(
      "STUDENT_NOT_FOUND",
    );

    const local = await request(
      app,
      "/api/teacher/assignments",
      { unitIds: [unitId], studentIds: [aId], dueAt: "2026-10-01T20:00" },
      teacherCookie,
    );
    expect(local.status).toBe(400);
    const offset = await request(
      app,
      "/api/teacher/assignments",
      {
        unitIds: [unitId],
        studentIds: [aId],
        dueAt: "2026-10-01T20:00:00+08:00",
      },
      teacherCookie,
    );
    expect(offset.status).toBe(400);
  });
});

// ---------- 多单元取卷与作答（D12：题号全卷连续） ----------

describe("多单元取卷与作答（D12）", () => {
  async function makeTwoUnitAssignment() {
    const { app, db, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitA, unitB],
      studentIds: [aId],
    });
    const cookie = await loginStudent(app, "张三");
    return {
      app,
      // makeApp 的真实内存库（透传，供库层断言；不再恒 undefined 误导维护者）
      db,
      teacherCookie,
      cookie,
      unitA,
      unitB,
      studentId: aId,
      assignmentId: created.id as string,
    };
  }

  it("paper.units 顺序 = 布置顺序；每单元题按题序；unitCount/questionCount 聚合正确", async () => {
    const env = await makeTwoUnitAssignment();
    const paper = await studentPaper(env.app, env.cookie, env.assignmentId);
    expect(
      studentPaperOkSchema.safeParse({ ok: true, data: paper }).success,
    ).toBe(true);
    expect(paper.units.map((unit) => unit.id)).toEqual([env.unitA, env.unitB]);
    expect(paper.units.map((unit) => unit.title)).toEqual([UNIT_A, UNIT_B]);
    // 每单元 2 题（按题序：judge→fill / fill→fill）
    expect(paper.units[0]?.questions.map((q) => q.id)).toHaveLength(2);
    expect(paper.units[1]?.questions.map((q) => q.id)).toHaveLength(2);

    const list = await studentList(env.app, env.cookie);
    expect(list.length).toBe(1);
    expect(list[0]?.unitCount).toBe(2);
    expect(list[0]?.questionCount).toBe(4);
    expect(list[0]?.units).toEqual([
      { id: env.unitA, title: UNIT_A },
      { id: env.unitB, title: UNIT_B },
    ]);
  });

  it("跨单元草稿保存成功；判分全卷口径（scoreAuto 覆盖两单元）；结果视图分组", async () => {
    const env = await makeTwoUnitAssignment();
    const attempt = await startAttempt(env.app, env.cookie, env.assignmentId);
    const attemptId = attempt.id as string;
    expect(attempt.unitId).toBeNull(); // 多单元 attempt 不再落单单元

    const paper = await studentPaper(env.app, env.cookie, env.assignmentId);
    const unitAQuestions = paper.units[0]?.questions ?? [];
    const unitBQuestions = paper.units[1]?.questions ?? [];
    const judgeQ = unitAQuestions[0];
    const fillA = unitAQuestions[1];
    const fillB1 = unitBQuestions[0];
    const fillB2 = unitBQuestions[1];
    if (!judgeQ || !fillA || !fillB1 || !fillB2) {
      throw new Error("试卷题目缺失");
    }

    // 跨单元保存草稿（单元 A 判断题对 + 填空答错，单元 B 填空对）
    expect(
      (
        await saveAnswer(env.app, env.cookie, attemptId, judgeQ.id, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await saveAnswer(env.app, env.cookie, attemptId, fillA.id, {
          kind: "fill",
          values: ["5"], // 答错（正确答案 2）——验证跨单元的错题计入全卷口径
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await saveAnswer(env.app, env.cookie, attemptId, fillB1.id, {
          kind: "fill",
          values: ["-6"],
        })
      ).status,
    ).toBe(200);
    // fillB2 不作答（未答也进 responses，计待批/未答）

    const result = await submitAttempt(env.app, env.cookie, attemptId);
    // 全卷口径：4 题、答 3、对 2、错 1（对错分布在两个单元）、可判 3 → scoreAuto=67
    expect(result.summary).toEqual({
      total: 4,
      answered: 3,
      correct: 2,
      wrong: 1,
      pending: 1,
      unanswered: 1,
      autoGradable: 3,
    });
    expect((result.attempt as Record<string, unknown>).scoreAuto).toBe(67);
    // 结果视图按单元分组（顺序 = 布置顺序，组内按题序）
    const units = result.units as {
      id: string;
      questions: { questionId: string }[];
    }[];
    expect(units.map((unit) => unit.id)).toEqual([env.unitA, env.unitB]);
    expect(units[0]?.questions.map((q) => q.questionId)).toEqual(
      unitAQuestions.map((q) => q.id),
    );
    expect(units[1]?.questions.map((q) => q.questionId)).toEqual(
      unitBQuestions.map((q) => q.id),
    );
  });

  it("别的作业单元的题保存草稿 → 404 QUESTION_NOT_FOUND", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    // 作业 1 只含单元 B；作业 2 含单元 A
    const onlyB = (await createAssignment(app, teacherCookie, {
      unitIds: [unitB],
      studentIds: [aId],
    })) as { id: string };
    await createAssignment(app, teacherCookie, {
      unitIds: [unitA],
      studentIds: [aId],
    });

    const cookie = await loginStudent(app, "张三");
    const attempt = await startAttempt(app, cookie, onlyB.id);
    const paperB = await studentPaper(app, cookie, onlyB.id);
    // 按内容定位「单元 A 作业」（units 含单元 A 的那份），不依赖列表排序：
    // 两份作业若同毫秒创建，倒序假设不可靠
    const unitAAssignmentId = (await studentList(app, cookie)).find((row) =>
      rowUnitIds(row).some((unit) => unit.id === unitA),
    )?.id;
    if (typeof unitAAssignmentId !== "string") {
      throw new Error("学生列表中未找到包含单元 A 的作业");
    }
    const paperA = await studentPaper(app, cookie, unitAAssignmentId);
    const questionOfA = paperA.units[0]?.questions[0];
    if (!questionOfA) throw new Error("单元 A 试卷题目缺失");
    // 单元 A 的题不属于作业 1 的单元集合 → 404
    const res = await saveAnswer(
      app,
      cookie,
      attempt.id as string,
      questionOfA.id,
      { kind: "judge", value: true },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");
    // 单元 B 自己的题正常
    const ownQ = paperB.units[0]?.questions[0];
    if (!ownQ) throw new Error("单元 B 试卷题目缺失");
    expect(
      (
        await saveAnswer(app, cookie, attempt.id as string, ownQ.id, {
          kind: "fill",
          values: ["-6"],
        })
      ).status,
    ).toBe(200);
  });
});

// ---------- 名单增删（D13） ----------

describe("名单增删（D13：addStudentIds / removeStudentIds）", () => {
  async function makeEnv() {
    const { app, db, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const bId = await createStudent(app, teacherCookie, "李四");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
    });
    return {
      app,
      // makeApp 的真实内存库（行复用等库层断言用）
      db,
      teacherCookie,
      unitId,
      aId,
      bId,
      assignmentId: created.id as string,
      aCookie: await loginStudent(app, "张三"),
      bCookie: await loginStudent(app, "李四"),
    };
  }

  /** 直查库：某学生在某作业下的名单行（本表复合主键 assignmentId+studentId，
   *  无独立行 id——「行复用」的可观测不变式 = 同键行不删不插、removedAt/addedAt 变化） */
  function rosterRow(
    db: Db,
    assignmentId: string,
    studentId: string,
  ):
    | {
        assignmentId: string;
        studentId: string;
        addedAt: string | null;
        removedAt: string | null;
      }
    | undefined {
    return db
      .select()
      .from(assignmentStudents)
      .where(
        and(
          eq(assignmentStudents.assignmentId, assignmentId),
          eq(assignmentStudents.studentId, studentId),
        ),
      )
      .get();
  }

  it("addStudentIds 后学生列表立即可见；详情 roster 增加", async () => {
    const env = await makeEnv();
    expect((await studentList(env.app, env.bCookie)).length).toBe(0);
    const res = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        addStudentIds: [env.bId],
      },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { studentCount: number } }).data
        .studentCount,
    ).toBe(2);
    expect((await studentList(env.app, env.bCookie)).length).toBe(1);

    const detailRes = await env.app.request(
      `/api/teacher/assignments/${env.assignmentId}`,
      { headers: { cookie: env.teacherCookie } },
    );
    expect(detailRes.status).toBe(200);
    const detail = (
      (await detailRes.json()) as {
        data: {
          roster: {
            studentId: string;
            status: string;
            attemptId: string | null;
            addedAt: string;
          }[];
        };
      }
    ).data;
    expect(detail.roster.map((entry) => entry.studentId).sort()).toEqual(
      [env.aId, env.bId].sort(),
    );
    expect(detail.roster.every((entry) => entry.status === "not_started")).toBe(
      true,
    );
    // T3.1（D8）：未开始学生的名单行不带 attemptId（无 attempt 可跳转）
    expect(detail.roster.every((entry) => entry.attemptId === null)).toBe(true);
    expect(
      detail.roster.every((entry) => typeof entry.addedAt === "string"),
    ).toBe(true);
  });

  it("移出未开始学生直接移除：学生作业列表消失、paper 403", async () => {
    const env = await makeEnv();
    const res = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        removeStudentIds: [env.aId],
      },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { studentCount: number } }).data
        .studentCount,
    ).toBe(0);
    expect((await studentList(env.app, env.aCookie)).length).toBe(0);
    const paper = await env.app.request(
      `/api/student/assignments/${env.assignmentId}/paper`,
      { headers: { cookie: env.aCookie } },
    );
    expect(paper.status).toBe(403);
    expect(((await paper.json()) as ApiErr).error).toBe("FORBIDDEN");
  });

  it("移出已开始学生：无 confirmStarted → 409 CONFIRM_REQUIRED 且 _students 含姓名；带 confirmStarted 成功且已交卷结果仍可查、不在作业列表", async () => {
    const env = await makeEnv();
    // 张三开始作答并交卷
    const attempt = await startAttempt(env.app, env.aCookie, env.assignmentId);
    const paper = await studentPaper(env.app, env.aCookie, env.assignmentId);
    const qid = paper.units[0]?.questions[0]?.id;
    if (!qid) throw new Error("试卷题目缺失");
    await saveAnswer(env.app, env.aCookie, attempt.id as string, qid, {
      kind: "fill",
      values: ["2"],
    });
    await submitAttempt(env.app, env.aCookie, attempt.id as string);

    const blocked = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        removeStudentIds: [env.aId],
      },
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as ApiErr & {
      _students?: { studentId: string; displayName: string }[];
    };
    expect(blockedBody.error).toBe("CONFIRM_REQUIRED");
    expect(blockedBody._students).toEqual([
      { studentId: env.aId, displayName: "张三" },
    ]);

    const confirmed = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        removeStudentIds: [env.aId],
        confirmStarted: true,
      },
    );
    expect(confirmed.status).toBe(200);

    // 已交卷 attempt 经 GET /api/student/attempts/:id 仍可查（结果视图正常）
    const detail = await env.app.request(
      `/api/student/attempts/${attempt.id as string}`,
      { headers: { cookie: env.aCookie } },
    );
    expect(detail.status).toBe(200);
    const detailData = (
      (await detail.json()) as { data: Record<string, unknown> }
    ).data;
    expect((detailData.attempt as Record<string, unknown>).status).toBe(
      "submitted",
    );
    expect(Array.isArray(detailData.units)).toBe(true);
    // 但作业从其待办消失
    expect((await studentList(env.app, env.aCookie)).length).toBe(0);
  });

  it("移出已开始（仅草稿未交卷）学生同样需要 confirmStarted", async () => {
    const env = await makeEnv();
    await startAttempt(env.app, env.aCookie, env.assignmentId);
    const blocked = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        removeStudentIds: [env.aId],
      },
    );
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as ApiErr).error).toBe("CONFIRM_REQUIRED");
  });

  it("批量移出混合名单：已开始者按移出顺序完整列入 _students，未开始者不混入", async () => {
    const env = await makeEnv();
    // 王五加入名单但不动笔；李四加入并开始；张三开始（合并查询取已开始集合的回归）
    const cId = await createStudent(env.app, env.teacherCookie, "王五");
    const added = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      { addStudentIds: [env.bId, cId] },
    );
    expect(added.status).toBe(200);
    await startAttempt(env.app, env.aCookie, env.assignmentId);
    await startAttempt(env.app, env.bCookie, env.assignmentId);

    const blocked = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      { removeStudentIds: [cId, env.bId, env.aId] },
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as ApiErr & {
      _students?: { studentId: string; displayName: string }[];
    };
    expect(blockedBody.error).toBe("CONFIRM_REQUIRED");
    // 只含已开始的李四/张三，且按 removeStudentIds 原序；王五未开始不出现
    expect(blockedBody._students).toEqual([
      { studentId: env.bId, displayName: "李四" },
      { studentId: env.aId, displayName: "张三" },
    ]);
  });

  it("add 与 remove 交集返回 400 VALIDATION_ERROR", async () => {
    const env = await makeEnv();
    const res = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        addStudentIds: [env.bId],
        removeStudentIds: [env.bId],
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("移出不在册学生返回 400；曾移出再加回恢复在册（行复用）", async () => {
    const env = await makeEnv();
    // 李四从未在册
    const notOnRoster = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        removeStudentIds: [env.bId],
      },
    );
    expect(notOnRoster.status).toBe(400);

    // 库层基线：张三的在册行 + 该作业名单总行数
    const before = rosterRow(env.db, env.assignmentId, env.aId);
    if (!before || before.addedAt === null) {
      throw new Error("基线名单行缺失或 addedAt 为空");
    }
    const rowsOfAssignment = () =>
      env.db
        .select()
        .from(assignmentStudents)
        .where(eq(assignmentStudents.assignmentId, env.assignmentId))
        .all();
    expect(rowsOfAssignment()).toHaveLength(1);

    // 张三移出：库层只置 removedAt 不删行（行数不变），学生待办消失
    const removed = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        removeStudentIds: [env.aId],
      },
    );
    expect(removed.status).toBe(200);
    expect((await studentList(env.app, env.aCookie)).length).toBe(0);
    expect(rosterRow(env.db, env.assignmentId, env.aId)?.removedAt).toEqual(
      expect.any(String),
    );
    expect(rowsOfAssignment()).toHaveLength(1);

    // 隔 3ms 保证「加回刷新 addedAt」可观测：addedAt 为毫秒精度 ISO 字符串，
    // 同毫秒内创建与加回无法区分（与教师列表排序的同毫秒教训同因）
    await new Promise((resolve) => setTimeout(resolve, 3));

    // 再加回：名单恢复、可继续作答
    const back = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        addStudentIds: [env.aId],
      },
    );
    expect(back.status).toBe(200);
    expect((await studentList(env.app, env.aCookie)).length).toBe(1);

    // 库层锁死行复用：同键行置回在册（removedAt=null）而非删行插行——
    // 名单总行数不增；addedAt 口径 = **刷新为加回时间**（updateAssignment 的
    // onConflictDoUpdate set addedAt=now，schema 注释「行复用，addedAt 刷新」）
    const after = rosterRow(env.db, env.assignmentId, env.aId);
    if (!after || after.addedAt === null) {
      throw new Error("加回后名单行缺失或 addedAt 为空");
    }
    expect(after.removedAt).toBeNull();
    expect(rowsOfAssignment()).toHaveLength(1);
    expect(after.addedAt > before.addedAt).toBe(true); // ISO 字典序 = 时间序
  });
});

describe("课程成员变化不影响已布置作业名单（D13 快照语义）", () => {
  it("课程加/减成员后：作业名单与作答入口不变", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const cId = await createStudent(app, teacherCookie, "王五");
    const courseRes = await request(
      app,
      "/api/teacher/courses",
      { title: "初一上" },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    await request(
      app,
      `/api/teacher/courses/${courseId}/members`,
      { studentIds: [aId] },
      teacherCookie,
    );

    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      courseId,
    });
    const assignmentId = created.id as string;

    // 课程新成员王五：不影响作业（不在名单，看不到作业）
    await request(
      app,
      `/api/teacher/courses/${courseId}/members`,
      { studentIds: [cId] },
      teacherCookie,
    );
    const cCookie = await loginStudent(app, "王五");
    expect((await studentList(app, cCookie)).length).toBe(0);

    // 课程移出张三：作业名单不变（独立快照），仍可作答（前置必须真成立）
    const removedMember = await request(
      app,
      `/api/teacher/courses/${courseId}/members`,
      { studentIds: [aId] },
      teacherCookie,
      "DELETE",
    );
    expect(removedMember.status).toBe(200);
    const list = await teacherList(app, teacherCookie, { courseId });
    expect(list.length).toBe(1);
    expect(list[0]?.studentCount).toBe(1);
    const aCookie = await loginStudent(app, "张三");
    expect((await studentList(app, aCookie)).length).toBe(1);
    const attempt = await startAttempt(app, aCookie, assignmentId);
    expect(attempt.id).toBeTruthy();
  });
});

// ---------- 内容锁定（D14） ----------

describe("内容锁定（D14：首个 attempt 后 unitIds 不可改）", () => {
  async function makeEnv() {
    const { app, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitA],
      studentIds: [aId],
    });
    return {
      app,
      teacherCookie,
      unitA,
      unitB,
      assignmentId: created.id as string,
      cookie: await loginStudent(app, "张三"),
      bId: await createStudent(app, teacherCookie, "李四"),
    };
  }

  it("无 attempt 时可整组替换 unitIds（paper 反映新单元）", async () => {
    const env = await makeEnv();
    const res = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        unitIds: [env.unitB, env.unitA],
      },
    );
    expect(res.status).toBe(200);
    const data = (
      (await res.json()) as { data: { units: { unitId: string }[] } }
    ).data;
    expect(data.units.map((unit) => unit.unitId)).toEqual([
      env.unitB,
      env.unitA,
    ]);
    const paper = await studentPaper(env.app, env.cookie, env.assignmentId);
    expect(paper.units.map((unit) => unit.id)).toEqual([env.unitB, env.unitA]);
  });

  it("未锁定时 PATCH unitIds 重复 → 400 DUPLICATE_UNIT（与 create 同口径）", async () => {
    const env = await makeEnv();
    const res = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      { unitIds: [env.unitB, env.unitB] },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("DUPLICATE_UNIT");
  });

  it("首个 attempt 创建后 PATCH unitIds → 409 ASSIGNMENT_CONTENT_LOCKED；标题/截止/名单仍可改", async () => {
    const env = await makeEnv();
    const attempt = await startAttempt(env.app, env.cookie, env.assignmentId);

    const locked = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        unitIds: [env.unitB],
      },
    );
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as ApiErr).error).toBe(
      "ASSIGNMENT_CONTENT_LOCKED",
    );

    const title = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        title: "周末加练",
        dueAt: DUE_AT,
      },
    );
    expect(title.status).toBe(200);
    const roster = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        addStudentIds: [env.bId],
      },
    );
    expect(roster.status).toBe(200);
    expect(
      ((await roster.json()) as { data: { studentCount: number } }).data
        .studentCount,
    ).toBe(2);

    // 列表行 locked=true；详情 startedCount=1
    const list = await teacherList(env.app, env.teacherCookie);
    expect(list[0]?.locked).toBe(true);
    const detail = (
      (await (
        await env.app.request(`/api/teacher/assignments/${env.assignmentId}`, {
          headers: { cookie: env.teacherCookie },
        })
      ).json()) as {
        data: {
          startedCount: number;
          roster: { studentId: string; attemptId: string | null }[];
        };
      }
    ).data;
    expect(detail.startedCount).toBe(1);
    // T3.1（D8）：已开始学生（张三）的名单行带 attemptId（跳 attempt 详情的定位 id）
    const started = detail.roster.find((entry) => entry.attemptId !== null);
    expect(started?.attemptId).toBe(attempt.id);
  });

  it("锁定后即使 unitIds 重复也报 409（锁定判定优先于内容校验，D14）", async () => {
    const env = await makeEnv();
    await startAttempt(env.app, env.cookie, env.assignmentId);
    const res = await patchAssignment(
      env.app,
      env.teacherCookie,
      env.assignmentId,
      {
        unitIds: [env.unitB, env.unitB],
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe(
      "ASSIGNMENT_CONTENT_LOCKED",
    );
  });
});

// ---------- check 接口（D15） ----------

describe("POST /api/teacher/assignments/check（D15 已做过提示）", () => {
  async function makeEnv() {
    const { app, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    const bId = await createStudent(app, teacherCookie, "李四");
    const courseRes = await request(
      app,
      "/api/teacher/courses",
      { title: "初一上" },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    // 课程目录加入单元 A（可见）+ 两名成员
    await request(
      app,
      `/api/teacher/courses/${courseId}/items`,
      { items: [{ kind: "unit", refId: unitA }] },
      teacherCookie,
    );
    await request(
      app,
      `/api/teacher/courses/${courseId}/members`,
      { studentIds: [aId, bId] },
      teacherCookie,
    );
    return {
      app,
      teacherCookie,
      courseId,
      unitA,
      unitB,
      aId,
      bId,
      aCookie: await loginStudent(app, "张三"),
      bCookie: await loginStudent(app, "李四"),
    };
  }

  it("学生在课程练习交卷过 → 返回正确次数（含课程名/单元标题）；再交一次次数递增", async () => {
    const env = await makeEnv();
    // 张三在课程中做单元 A 一次（交卷）
    const started = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitA)}/attempts`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(started.status).toBe(201);
    const attemptId = ((await started.json()) as { data: { id: string } }).data
      .id;
    const submitted = await env.app.request(
      `/api/student/attempts/${attemptId}/submit`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(submitted.status).toBe(200);

    // 「再做一次」补齐标题承诺的递增链路（D10：已交卷后再 POST 课程练习
    // 入口 → 开新卷 attemptNo+1，从空白开始），走完整「取卷 → 答题 → 交卷」
    const redo = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitA)}/attempts`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(redo.status).toBe(201);
    const redoData = (
      (await redo.json()) as { data: { id: string; attemptNo: number } }
    ).data;
    expect(redoData.id).not.toBe(attemptId); // 新开一卷，而非返回已交卷那份
    expect(redoData.attemptNo).toBe(2);
    const redoPaperRes = await env.app.request(
      `/api/student/attempts/${redoData.id}/paper`,
      { headers: { cookie: env.aCookie } },
    );
    expect(redoPaperRes.status).toBe(200);
    const redoQid = (
      (await redoPaperRes.json()) as {
        data: { units: { questions: { id: string }[] }[] };
      }
    ).data.units[0]?.questions[0]?.id;
    if (!redoQid) throw new Error("重做试卷题目缺失");
    expect(
      (
        await saveAnswer(env.app, env.aCookie, redoData.id, redoQid, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    const redoSubmitted = await env.app.request(
      `/api/student/attempts/${redoData.id}/submit`,
      { method: "POST", headers: { cookie: env.aCookie } },
    );
    expect(redoSubmitted.status).toBe(200);

    const check = await request(
      env.app,
      "/api/teacher/assignments/check",
      { unitIds: [env.unitA, env.unitB], studentIds: [env.aId, env.bId] },
      env.teacherCookie,
    );
    expect(check.status).toBe(200);
    const hints = (
      (await check.json()) as {
        data: {
          hints: {
            studentId: string;
            studentName: string;
            courseId: string | null;
            courseName: string | null;
            unitId: string;
            unitTitle: string;
            submittedCount: number;
          }[];
        };
      }
    ).data.hints;
    expect(hints).toEqual([
      {
        studentId: env.aId,
        studentName: "张三",
        courseId: env.courseId,
        courseName: "初一上",
        unitId: env.unitA,
        unitTitle: UNIT_A,
        submittedCount: 2, // 两份已交卷的课程练习都计入（次数递增）
      },
    ]);
  });

  it("未做过 / 仅草稿 → 无行；作业作答不计入", async () => {
    const env = await makeEnv();
    // 李四只开草稿不交卷
    const started = await env.app.request(
      `/api/student/courses/${env.courseId}/units/${encodeURIComponent(env.unitA)}/attempts`,
      { method: "POST", headers: { cookie: env.bCookie } },
    );
    expect(started.status).toBe(201);

    // 张三做的是**作业**（单元 A），不是课程练习
    const assignment = await createAssignment(env.app, env.teacherCookie, {
      unitIds: [env.unitA],
      studentIds: [env.aId],
    });
    const aAttempt = await startAttempt(
      env.app,
      env.aCookie,
      assignment.id as string,
    );
    const paper = await studentPaper(
      env.app,
      env.aCookie,
      assignment.id as string,
    );
    const qid = paper.units[0]?.questions[0]?.id;
    if (!qid) throw new Error("试卷题目缺失");
    expect(
      (
        await saveAnswer(env.app, env.aCookie, aAttempt.id as string, qid, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);
    // submitAttempt helper 内部已断言 200（交卷失败会让本用例在此先红）
    await submitAttempt(env.app, env.aCookie, aAttempt.id as string);

    const check = await request(
      env.app,
      "/api/teacher/assignments/check",
      { unitIds: [env.unitA], studentIds: [env.aId, env.bId] },
      env.teacherCookie,
    );
    expect(check.status).toBe(200);
    const hints = ((await check.json()) as { data: { hints: unknown[] } }).data
      .hints;
    expect(hints).toEqual([]);
  });
});

// ---------- 软删单元（D16） ----------

describe("软删单元的作业（D16：单元软删不影响作业通道）", () => {
  it("单元软删后 paper 仍含该单元及其题目、判分含其题、作答交卷成功；列表含已删标记", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitA, unitB],
      studentIds: [aId],
    });
    const assignmentId = created.id as string;
    const cookie = await loginStudent(app, "张三");

    // 教师软删单元 A（D3：进回收站；作业是显式布置的快照，不受影响）
    const del = await app.request(
      `/api/teacher/units/${encodeURIComponent(unitA)}`,
      {
        method: "DELETE",
        headers: { cookie: teacherCookie },
      },
    );
    expect(del.status).toBe(200);

    // D16：paper 仍含单元 A 及其题目（只有 questions.deletedAt 才从试卷排除）
    const paper = await studentPaper(app, cookie, assignmentId);
    expect(paper.units.map((unit) => unit.id)).toEqual([unitA, unitB]);
    expect(paper.units[0]?.questions).toHaveLength(2);

    // 教师列表：containsDeletedUnit=true，单元 A 标记 deleted（题数照常统计）
    const list = await teacherList(app, teacherCookie);
    expect(list[0]?.containsDeletedUnit).toBe(true);
    expect(list[0]?.units).toEqual([
      { unitId: unitA, title: UNIT_A, questionCount: 2, deleted: true },
      { unitId: unitB, title: UNIT_B, questionCount: 2, deleted: false },
    ]);

    // 学生列表题数 = 全部单元 live 题数之和（软删单元照常计入）
    const mine = await studentList(app, cookie);
    expect(mine[0]?.questionCount).toBe(4);

    // 已删单元的题照常可作答（归属集合 = assignment_units，不看单元软删）
    const attempt = await startAttempt(app, cookie, assignmentId);
    const qa = paper.units[0]?.questions[0];
    if (!qa) throw new Error("单元 A 试卷题目缺失");
    expect(
      (
        await saveAnswer(app, cookie, attempt.id as string, qa.id, {
          kind: "judge",
          value: true,
        })
      ).status,
    ).toBe(200);

    // 交卷成功；判分含已删单元的题（全卷 4 题）
    const result = await submitAttempt(app, cookie, attempt.id as string);
    expect(result.summary).toMatchObject({ total: 4 });
    expect((result.units as { id: string }[]).map((unit) => unit.id)).toEqual([
      unitA,
      unitB,
    ]);
  });

  it("单元的题目全部软删（questions 级，T1.12）→ 该单元从 paper 消失；全部为空 → units 空数组", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitA],
      studentIds: [aId],
    });
    const cookie = await loginStudent(app, "张三");

    // 库内软删该单元全部题目（等价于教师逐题删除；单元本身未删）
    for (const q of db.select().from(questions).all()) {
      if (q.unitId === unitA) {
        db.update(questions)
          .set({ deletedAt: new Date().toISOString() })
          .where(eq(questions.id, q.id))
          .run();
      }
    }
    const paper = await studentPaper(app, cookie, created.id as string);
    expect(paper.units).toEqual([]);
  });
});

// ---------- D4：课程删除与作业关联 ----------

describe("D4：课程删除条件（attempts.courseId OR assignments.courseId）", () => {
  it("作业关联课程的删除被拒（409 COURSE_HAS_ATTEMPTS）", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const courseRes = await request(
      app,
      "/api/teacher/courses",
      { title: "初一上" },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      courseId,
    });
    const del = await app.request(`/api/teacher/courses/${courseId}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(409);
    expect(((await del.json()) as ApiErr).error).toBe("COURSE_HAS_ATTEMPTS");
  });

  it("纯成员课程（无作业无 attempt）可删除", async () => {
    const { app, teacherCookie } = await makeApp();
    const aId = await createStudent(app, teacherCookie, "张三");
    const courseRes = await request(
      app,
      "/api/teacher/courses",
      { title: "空课程" },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    await request(
      app,
      `/api/teacher/courses/${courseId}/members`,
      { studentIds: [aId] },
      teacherCookie,
    );
    const del = await app.request(`/api/teacher/courses/${courseId}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);
  });
});

// ---------- 学生可见性与基础行为（T2.2 遗留口径） ----------

describe("学生可见性（学生只能看到指派给自己的作业）", () => {
  it("学生 A 看不到指派给学生 B 的作业；各自只看到自己的", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const bId = await createStudent(app, teacherCookie, "李四");

    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [bId],
      title: "给李四的作业",
    });
    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      title: "给张三的作业",
    });

    const aCookie = await loginStudent(app, "张三");
    const bCookie = await loginStudent(app, "李四");
    const aList = await studentList(app, aCookie);
    const bList = await studentList(app, bCookie);

    expect(aList.length).toBe(1);
    expect(aList[0]?.title).toBe("给张三的作业");
    expect(bList.length).toBe(1);
    expect(bList[0]?.title).toBe("给李四的作业");

    // 响应符合契约壳；条目附状态（T2.2 内恒为 not_started）
    expect(aList[0]?.status).toBe("not_started");
    expect(aList[0]?.questionCount).toBe(1);
    expect(aList[0]?.unitCount).toBe(1);
  });
});

describe("删除作业 = 软删（作答保留在 T2.6 口径）", () => {
  it("DELETE 后：教师默认列表不显示、includeDeleted=true 可见并带标记；学生端立即不可见", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
    });
    const id = created.id as string;

    const del = await app.request(`/api/teacher/assignments/${id}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { data: unknown }).data).toBeNull();

    expect((await teacherList(app, teacherCookie)).length).toBe(0);
    const withDeleted = await teacherList(app, teacherCookie, {
      includeDeleted: true,
    });
    expect(withDeleted.length).toBe(1);
    expect(withDeleted[0]?.deleted).toBe(true);
    expect(typeof withDeleted[0]?.deletedAt).toBe("string");

    const aCookie = await loginStudent(app, "张三");
    expect((await studentList(app, aCookie)).length).toBe(0);

    // 软删：库行保留（assignments / assignment_units / assignment_students 均不物理删）
    expect(db.select().from(assignments).all().length).toBe(1);
    expect(
      db
        .select()
        .from(assignmentUnits)
        .where(eq(assignmentUnits.assignmentId, id))
        .all().length,
    ).toBe(1);
    expect(
      db
        .select()
        .from(assignmentStudents)
        .where(eq(assignmentStudents.assignmentId, id))
        .all().length,
    ).toBe(1);
  });

  it("重复删除幂等成功；对已删除作业 PATCH 返回 404", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
    });
    const id = created.id as string;

    for (let i = 0; i < 2; i++) {
      const again = await app.request(`/api/teacher/assignments/${id}`, {
        method: "DELETE",
        headers: { cookie: teacherCookie },
      });
      expect(again.status).toBe(200);
    }

    const patch = await patchAssignment(app, teacherCookie, id, {
      title: "改不动",
    });
    expect(patch.status).toBe(404);
    expect(((await patch.json()) as ApiErr).error).toBe("ASSIGNMENT_NOT_FOUND");
  });

  it("删除不存在的作业返回 404", async () => {
    const { app, teacherCookie } = await makeApp();
    const res = await app.request(
      "/api/teacher/assignments/00000000-0000-4000-8000-000000000000",
      { method: "DELETE", headers: { cookie: teacherCookie } },
    );
    expect(res.status).toBe(404);
  });
});

describe("教师列表与详情（courseId 筛选 + 详情扩展）", () => {
  it("列表符合契约壳；多份作业按布置时间倒序", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      title: "第一份",
    });
    // createdAt 为毫秒精度 ISO 字符串：同一毫秒内创建的两份作业排序键相同，
    // 隔 3ms 保证「第二份」更晚（历史偶发翻转教训）
    await new Promise((resolve) => setTimeout(resolve, 3));
    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      title: "第二份",
    });

    const res = await app.request("/api/teacher/assignments", {
      headers: { cookie: teacherCookie },
    });
    const body = (await res.json()) as unknown;
    expect(teacherAssignmentListOkSchema.safeParse(body).success).toBe(true);
    const list = (body as { data: { assignments: { title: string }[] } }).data
      .assignments;
    expect(list.map((item) => item.title)).toEqual(["第二份", "第一份"]);
  });

  it("courseId 筛选：UUID 精确 / none 只看无课程作业 / 非法值 400", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const courseRes = await request(
      app,
      "/api/teacher/courses",
      { title: "初一上" },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      courseId,
      title: "课程作业",
    });
    await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      title: "散作业",
    });

    const ofCourse = await teacherList(app, teacherCookie, { courseId });
    expect(ofCourse.map((row) => row.title)).toEqual(["课程作业"]);
    const ofNone = await teacherList(app, teacherCookie, { courseId: "none" });
    expect(ofNone.map((row) => row.title)).toEqual(["散作业"]);

    const bad = await app.request("/api/teacher/assignments?courseId=abc", {
      headers: { cookie: teacherCookie },
    });
    expect(bad.status).toBe(400);
  });

  it("详情：courseNewMembers=课程成员-在册名单；无课程时空数组；不存在的作业 404", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const bId = await createStudent(app, teacherCookie, "李四");
    const cId = await createStudent(app, teacherCookie, "王五");
    const courseRes = await request(
      app,
      "/api/teacher/courses",
      { title: "初一上" },
      teacherCookie,
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    await request(
      app,
      `/api/teacher/courses/${courseId}/members`,
      { studentIds: [aId, bId, cId] },
      teacherCookie,
    );
    // 名单只含张三、李四 → 王五是课程新成员
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId, bId],
      courseId,
    });
    const detail = (
      (await (
        await app.request(`/api/teacher/assignments/${created.id as string}`, {
          headers: { cookie: teacherCookie },
        })
      ).json()) as {
        data: {
          courseNewMembers: { studentId: string; displayName: string }[];
          startedCount: number;
        };
      }
    ).data;
    expect(detail.courseNewMembers).toEqual([
      { studentId: cId, displayName: "王五" },
    ]);
    expect(detail.startedCount).toBe(0);

    // 无课程作业：courseNewMembers 空数组
    const plain = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
    });
    const plainDetail = (
      (await (
        await app.request(`/api/teacher/assignments/${plain.id as string}`, {
          headers: { cookie: teacherCookie },
        })
      ).json()) as { data: { courseNewMembers: unknown[] } }
    ).data;
    expect(plainDetail.courseNewMembers).toEqual([]);

    const missing = await app.request(
      "/api/teacher/assignments/00000000-0000-4000-8000-000000000000",
      { headers: { cookie: teacherCookie } },
    );
    expect(missing.status).toBe(404);
  });

  it("PATCH 改标题与截止；dueAt 显式 null = 取消截止；目标不存在 404；查询参数非法 400", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitId],
      studentIds: [aId],
      dueAt: DUE_AT,
    });
    const id = created.id as string;

    const retitled = await patchAssignment(app, teacherCookie, id, {
      title: "周末加练",
      dueAt: "2026-10-08T04:00:00.000Z",
    });
    expect(retitled.status).toBe(200);
    const retitledData = (await retitled.json()) as {
      data: { title: string; dueAt: string };
    };
    expect(retitledData.data.title).toBe("周末加练");
    expect(retitledData.data.dueAt).toBe("2026-10-08T04:00:00.000Z");

    const cleared = await patchAssignment(app, teacherCookie, id, {
      dueAt: null,
    });
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { data: { dueAt: unknown } }).data.dueAt,
    ).toBeNull();

    const missing = await patchAssignment(app, teacherCookie, "not-exist", {
      title: "新标题",
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiErr).error).toBe(
      "ASSIGNMENT_NOT_FOUND",
    );

    const query = await app.request(
      "/api/teacher/assignments?includeDeleted=abc",
      { headers: { cookie: teacherCookie } },
    );
    expect(query.status).toBe(400);
  });
});

// ---------- 学生端无泄露（AGENTS.md 第 3 条；T2A.7 新结构） ----------

describe("学生端无泄露（多单元新结构逐接口断言）", () => {
  /** 前置：库里确实存在带答案与详解的题目（泄露才是有意义的风险） */
  async function makeAnsweredEnv() {
    const { app, db, teacherCookie } = await makeApp();
    const unitA = await importDoc(app, teacherCookie, UNIT_A_MD);
    const unitB = await importDoc(app, teacherCookie, UNIT_B_MD);
    expect(
      db
        .select()
        .from(questions)
        .all()
        .some((q) => q.answersJson != null),
    ).toBe(true);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitIds: [unitA, unitB],
      studentIds: [aId],
    });
    return {
      app,
      teacherCookie,
      cookie: await loginStudent(app, "张三"),
      assignmentId: created.id as string,
    };
  }

  it("作业列表只含公开元信息（无 stem/options/answers/solution 等）", async () => {
    const env = await makeAnsweredEnv();
    const res = await studentListRes(env.app, env.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentAssignmentListOkSchema.safeParse(body).success).toBe(true);
    assertNoTeacherSideFields(body);
    const list = (body as { data: { assignments: unknown[] } }).data
      .assignments;
    expect(list.length).toBe(1);
  });

  it("分组试卷无教师侧字段", async () => {
    const env = await makeAnsweredEnv();
    const res = await env.app.request(
      `/api/student/assignments/${env.assignmentId}/paper`,
      { headers: { cookie: env.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    assertNoLeak(body);
    expect(
      (body as { data: { units: unknown[] } }).data.units.length,
    ).toBeGreaterThan(0);
  });

  it("分组草稿视图（draft 详情）无答案/详解/未请求提示", async () => {
    const env = await makeAnsweredEnv();
    const attempt = await startAttempt(env.app, env.cookie, env.assignmentId);
    const res = await env.app.request(
      `/api/student/attempts/${attempt.id as string}`,
      {
        headers: { cookie: env.cookie },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    assertNoLeak(body);
    expect(
      (body as { data: { units: unknown[] } }).data.units.length,
    ).toBeGreaterThan(0);
  });

  it("分组结果视图（交卷后）允许 answers/solutionMd 口径照旧、无提示内容", async () => {
    const env = await makeAnsweredEnv();
    const attempt = await startAttempt(env.app, env.cookie, env.assignmentId);
    const paper = await studentPaper(env.app, env.cookie, env.assignmentId);
    const qid = paper.units[0]?.questions[0]?.id;
    if (!qid) throw new Error("试卷题目缺失");
    await saveAnswer(env.app, env.cookie, attempt.id as string, qid, {
      kind: "judge",
      value: true,
    });
    const res = await env.app.request(
      `/api/student/attempts/${attempt.id as string}/submit`,
      { method: "POST", headers: { cookie: env.cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    // 交卷后放行 answers/answer/solutionMd（参考答案语义），其余照禁（含 hints）
    assertNoLeak(body, { allow: ["answers", "answer", "solutionMd"] });
    const data = body as { data: { units: unknown[] } };
    expect(data.data.units.length).toBe(2);
  });
});

// ---------- 迁移兼容（D23-5 回填后的旧单单元作业） ----------

describe("迁移后旧作业兼容（D23-5 回填形态直插库）", () => {
  it("旧单单元作业经新接口照常：列表 units 1 项、paper 正常、PATCH 标题成功", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");

    // 直插 D23-5 回填后的形态：unitId 旧列有值 + assignment_units 一行 order=0
    //（T2B.4：回填会同时填 teacherId，此处按回填后形态补齐）
    const legacyId = "88888888-8888-4888-8888-888888888888";
    const now = new Date().toISOString();
    db.insert(assignments)
      .values({
        id: legacyId,
        teacherId: TEST_TEACHER_ID,
        unitId, // 旧列保留（@deprecated，读侧不再使用）
        courseId: null,
        title: "旧作业",
        dueAt: null,
        deletedAt: null,
        createdAt: now,
      })
      .run();
    db.insert(assignmentUnits)
      .values({ assignmentId: legacyId, unitId, order: 0 })
      .run();
    db.insert(assignmentStudents)
      .values({
        assignmentId: legacyId,
        studentId: aId,
        addedAt: now,
        removedAt: null,
      })
      .run();

    // 教师列表：units 恰 1 项
    const list = await teacherList(app, teacherCookie);
    const legacy = list.find((row) => row.id === legacyId);
    expect(legacy?.units).toEqual([
      { unitId, title: "一元一次方程", questionCount: 1, deleted: false },
    ]);
    expect(legacy?.totalQuestionCount).toBe(1);

    // 学生照常看到与取卷
    const cookie = await loginStudent(app, "张三");
    const mine = await studentList(app, cookie);
    expect(mine.find((row) => row.id === legacyId)?.unitCount).toBe(1);
    const paper = await studentPaper(app, cookie, legacyId);
    expect(paper.units.length).toBe(1);
    expect(paper.units[0]?.questions.length).toBe(1);

    // PATCH 标题成功（未开始不锁定）
    const patch = await patchAssignment(app, teacherCookie, legacyId, {
      title: "改名后的旧作业",
    });
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { data: { title: string } }).data.title,
    ).toBe("改名后的旧作业");
  });
});

// ---------- 会话隔离 ----------

describe("会话隔离", () => {
  it("未登录访问教师/学生作业接口均 401", async () => {
    const { app } = await makeApp();
    const list = await app.request("/api/teacher/assignments");
    expect(list.status).toBe(401);
    const post = await request(app, "/api/teacher/assignments", {
      unitIds: ["x"],
      studentIds: [],
    });
    expect(post.status).toBe(401);
    const mine = await app.request("/api/student/assignments");
    expect(mine.status).toBe(401);
    expect(((await mine.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("教师会话访问学生作业接口 401；学生会话访问教师作业接口 401", async () => {
    const { app, teacherCookie } = await makeApp();
    await createStudent(app, teacherCookie, "张三");
    const studentCookie = await loginStudent(app, "张三");

    const asTeacher = await app.request("/api/student/assignments", {
      headers: { cookie: teacherCookie },
    });
    expect(asTeacher.status).toBe(401);

    const list = await app.request("/api/teacher/assignments", {
      headers: { cookie: studentCookie },
    });
    expect(list.status).toBe(401);
    const post = await request(
      app,
      "/api/teacher/assignments",
      { unitIds: ["x"], studentIds: [] },
      studentCookie,
    );
    expect(post.status).toBe(401);
  });
});

describe("computeAssignmentStatus 纯函数", () => {
  const assignment = { id: "a1", dueAt: null as string | null };

  function withAttempts(statuses: AssignmentAttemptSummary["status"][]) {
    return computeAssignmentStatus(
      assignment,
      statuses.map((status, index) => ({ status, attemptId: `a-${index}` })),
    );
  }

  it("无作答记录 → not_started", () => {
    expect(withAttempts([])).toBe("not_started");
  });

  it("仅草稿 → in_progress", () => {
    expect(withAttempts(["draft"])).toBe("in_progress");
  });

  it("交卷后 → submitted（草稿与已交并存仍算已交）", () => {
    expect(withAttempts(["draft", "submitted"])).toBe("submitted");
  });

  it("批改后 → graded（优先级最高，覆盖 submitted/draft）", () => {
    expect(withAttempts(["submitted", "graded"])).toBe("graded");
    expect(withAttempts(["draft", "graded"])).toBe("graded");
  });
});
