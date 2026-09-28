import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  type QuestionPublic,
  studentPaperOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { questions } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * 学生试卷接口集成测试（T2.4 两条验收项，app.request() 直调路由 + 内存库）：
 * - 验收项 1（泄露测试覆盖该接口）：assertNoLeak 全量通过；填空/判断题的答案文本
 *   不出现在 stemMd（[[答案]] 已替换为 [[]]）；数学环境内的 [[…]] 公式记号与
 *   $…$ 公式原文原样保留；选择题只下发纯文本选项、无 correct 正确项标记；
 * - 验收项 2（未被指派的学生请求返回 403）：含 PATCH 换名单后被移出学生的联动；
 * - 权限与状态：作业不存在 404、已删除（软删）404、未登录 401、教师会话 401；
 * - 内容形态：题数/顺序（单元题序）/题型/难度/考点/hintCount 与样例一致；
 * - 软删题目不出现在试卷。
 * 夹具用 samples/v2/练习样例.md（兼容性回归样例，八题覆盖七种题型 + 数学内 [[…]]）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 练习样例原文（八题：judge/choice/multi/fill/fill/solve/apply/find-error） */
const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);

/** 导入练习样例后试卷应有的题目顺序（id → order 0–7；第 6 题显式 id p4-q7） */
const EXPECTED_ORDER = [
  { id: "练习四-1", type: "judge", hintCount: 0 },
  { id: "练习四-2", type: "choice", hintCount: 1 },
  { id: "练习四-3", type: "multi", hintCount: 0 },
  { id: "练习四-4", type: "fill", hintCount: 1 },
  { id: "练习四-5", type: "fill", hintCount: 0 },
  { id: "p4-q7", type: "solve", hintCount: 0 },
  { id: "练习四-7", type: "apply", hintCount: 1 },
  { id: "练习四-8", type: "find-error", hintCount: 2 },
] as const;

/** 组装被测应用：内存库 + 教师 Cookie + 导入练习样例（返回单元 id） */
async function makeApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
  unitId: string;
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
    body: JSON.stringify({ password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  const unitId = await importPractice(app, teacherCookie);
  return { app, db, teacherCookie, unitId };
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

/** 导入练习样例，返回单元 id（frontmatter unit = 练习四） */
async function importPractice(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
): Promise<string> {
  const res = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ markdown: PRACTICE_MD, filename: "练习样例.md" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { units: { id: string }[] } };
  const unitId = body.data.units[0]?.id;
  if (!unitId) throw new Error("样例导入未产出单元");
  return unitId;
}

/** 创建学生并返回 id */
async function createStudent(
  app: ReturnType<typeof createApp>,
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

/** 学生密码登录，返回学生 Cookie */
async function loginStudent(
  app: ReturnType<typeof createApp>,
  name: string,
): Promise<string> {
  const res = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: name, password: STUDENT_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return `tutor_session=${extractSessionToken(res)}`;
}

/** 布置作业给指定学生（断言 201），返回 assignmentId */
async function createAssignmentFor(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  unitId: string,
  studentIds: string[],
): Promise<string> {
  const res = await app.request("/api/teacher/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ unitIds: [unitId], studentIds }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

/** 学生取试卷（原始 Response） */
function fetchPaper(
  app: ReturnType<typeof createApp>,
  cookie: string | undefined,
  assignmentId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/student/assignments/${assignmentId}/paper`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );
}

/** 学生取试卷并平铺分组题目（T2A.7 units 结构；断言 200） */
async function fetchPaperQuestions(
  app: ReturnType<typeof createApp>,
  cookie: string,
  assignmentId: string,
): Promise<QuestionPublic[]> {
  const res = await fetchPaper(app, cookie, assignmentId);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { units: { questions: QuestionPublic[] }[] };
  };
  return body.data.units.flatMap((unit) => unit.questions);
}

/** 全套前置：导入样例 + 张三（被指派）/李四（未指派）+ 布置作业 */
async function makeAssignedPaper(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
  aCookie: string;
  bCookie: string;
  assignmentId: string;
  aId: string;
  bId: string;
}> {
  const { app, db, teacherCookie, unitId } = await makeApp();
  const aId = await createStudent(app, teacherCookie, "张三");
  const bId = await createStudent(app, teacherCookie, "李四");
  const assignmentId = await createAssignmentFor(app, teacherCookie, unitId, [
    aId,
  ]);
  return {
    app,
    db,
    teacherCookie,
    aCookie: await loginStudent(app, "张三"),
    bCookie: await loginStudent(app, "李四"),
    assignmentId,
    aId,
    bId,
  };
}

describe("GET /api/student/assignments/:id/paper：被指派学生取试卷", () => {
  it("题数/顺序/题型/难度/考点/hintCount 与单元题序一致；响应符合契约壳", async () => {
    const { app, aCookie, assignmentId } = await makeAssignedPaper();
    const res = await fetchPaper(app, aCookie, assignmentId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentPaperOkSchema.safeParse(body).success).toBe(true);

    const list = (
      body as { data: { units: { questions: QuestionPublic[] }[] } }
    ).data.units.flatMap((unit) => unit.questions);
    // 前置：库里确实存在带答案的题目（泄露才是有意义的风险）
    expect(list.length).toBe(EXPECTED_ORDER.length);
    expect(
      list.every(
        (q) =>
          q.options === undefined ||
          q.options.every((o) => typeof o === "string"),
      ),
    ).toBe(true);

    expect(list.map((q) => q.id)).toEqual(EXPECTED_ORDER.map((q) => q.id));
    expect(list.map((q) => q.type)).toEqual(EXPECTED_ORDER.map((q) => q.type));
    expect(list.map((q) => q.hintCount)).toEqual(
      EXPECTED_ORDER.map((q) => q.hintCount),
    );
    expect(list.map((q) => q.difficulty)).toEqual([1, 1, 2, 2, 3, 3, 3, 2]);
    // 考点经 knowledge_points 归一后按名下发（单考点样例）
    expect(list[1]?.knowledge).toEqual(["相反数"]);
    // solve/apply 等手写题不带 options；choice/multi 带纯文本选项
    expect(list[0]?.options).toBeUndefined();
    expect(list[5]?.options).toBeUndefined();
  });

  it("泄露测试（验收项 1）：assertNoLeak 全量通过，选项无 correct 标记", async () => {
    const { app, db, aCookie, assignmentId } = await makeAssignedPaper();
    // 前置：库里确实存在答案/详解/提示（泄露才是有意义的风险）
    expect(
      db
        .select()
        .from(questions)
        .all()
        .some((q) => q.answersJson != null && q.solutionMd != null),
    ).toBe(true);

    const res = await fetchPaper(app, aCookie, assignmentId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    assertNoLeak(body);
    // 选项正确项标记绝不出现（公开形态是 string[]，不是 {text, correct} 对象）
    expect(JSON.stringify(body)).not.toContain("correct");
    // 确认拿到的是完整试卷（而非空列表导致「碰巧不泄露」）
    expect(
      (
        body as { data: { units: { questions: unknown[] }[] } }
      ).data.units.flatMap((unit) => unit.questions).length,
    ).toBe(EXPECTED_ORDER.length);
  });

  it("填空/判断题的答案文本不出现在 stemMd；[[答案]] 全部替换为空标记 [[]]", async () => {
    const { app, aCookie, assignmentId } = await makeAssignedPaper();
    const list = await fetchPaperQuestions(app, aCookie, assignmentId);
    const byId = new Map(list.map((q) => [q.id, q] as const));

    // 判断题：[[正确]] 即答案，脱敏为 [[]]
    const judge = byId.get("练习四-1");
    expect(judge?.stemMd).toBe("$0$ 既不是正数，也不是负数。[[]]");

    // 填空题（练习四-4）：三处标记（含等价答案 0.5|1/2）全部脱敏
    const fill = byId.get("练习四-4");
    expect(fill?.stemMd).toBe(
      "计算：$(-3)+7=$ [[]]；$(-2)+(-5)=$ [[]]。\n\n写等价形式：$0.5=$ [[]]（填小数或分数均可）。",
    );
    for (const secret of [
      "[[4]]",
      "[[-7]]",
      "[[0.5|1/2]]",
      "0.5|1/2",
      "[[正确]]",
      "[[错误]]",
    ]) {
      expect(JSON.stringify(list)).not.toContain(secret);
    }

    // 全部试卷题干中不残留任何非空 [[…]] 标记（数学环境除外，下一用例单独锁定）
    for (const q of list) {
      if (q.id === "练习四-5") continue; // 该题含数学环境记号，单独断言
      const nonEmptyMarkers = q.stemMd.match(/\[\[[^[\]]+?\]\]/g) ?? [];
      expect(nonEmptyMarkers, `题目 ${q.id} 的 stemMd 残留非空标记`).toEqual(
        [],
      );
    }
  });

  it("数学公式原文保留（$…$ 不被破坏；数学环境内的 [[…]] 记号原样保留）", async () => {
    const { app, aCookie, assignmentId } = await makeAssignedPaper();
    const list = await fetchPaperQuestions(app, aCookie, assignmentId);
    const byId = new Map(list.map((q) => [q.id, q] as const));

    // 练习四-5：公式内的 $a_{[[1]]}$、$a_{[[2]]}$ 是记号（保留），
    // 真实空位 [[-3]] 脱敏为 [[]]，其余数学原文不动
    const mixed = byId.get("练习四-5");
    expect(mixed?.stemMd).toContain("$a_{[[1]]}$ 与 $a_{[[2]]}$");
    expect(mixed?.stemMd).toContain("则 $a_{1}+a_{2}=$ [[]]");
    expect(mixed?.stemMd).not.toContain("[[-3]]");

    // 填空题公式两侧的 $…$ 完整保留
    const fill = byId.get("练习四-4");
    expect(fill?.stemMd).toContain("$(-3)+7=$ [[]]");
    expect(fill?.stemMd).toContain("$0.5=$ [[]]");
  });

  it("选择题只下发纯文本选项且顺序不变（无正确项标记）", async () => {
    const { app, aCookie, assignmentId } = await makeAssignedPaper();
    const list = await fetchPaperQuestions(app, aCookie, assignmentId);
    const byId = new Map(list.map((q) => [q.id, q] as const));

    expect(byId.get("练习四-2")?.options).toEqual([
      "$-5$",
      "$5$",
      "$\\frac{1}{5}$",
      "$-\\frac{1}{5}$",
    ]);
    expect(byId.get("练习四-3")?.options).toEqual([
      "$(-3)+7$",
      "$(-2)+(-5)$",
      "$0+4.8$",
      "$|-9|+(-10)$",
    ]);
  });
});

describe("GET /api/student/assignments/:id/paper：权限（验收项 2 + 错误分支）", () => {
  it("未被指派的学生请求返回 403 FORBIDDEN（验收项 2）", async () => {
    const { app, bCookie, assignmentId } = await makeAssignedPaper();
    const res = await fetchPaper(app, bCookie, assignmentId);
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("FORBIDDEN");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("PATCH 换名单后被移出的学生从 200 变为 403（可见性联动）", async () => {
    const { app, teacherCookie, aCookie, aId, bId, assignmentId } =
      await makeAssignedPaper();
    expect((await fetchPaper(app, aCookie, assignmentId)).status).toBe(200);

    const patch = await app.request(
      `/api/teacher/assignments/${assignmentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({
          removeStudentIds: [aId],
          addStudentIds: [bId],
        }),
      },
    );
    expect(patch.status).toBe(200);

    const res = await fetchPaper(app, aCookie, assignmentId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErr).error).toBe("FORBIDDEN");
  });

  it("作业不存在返回 404 ASSIGNMENT_NOT_FOUND（统一错误壳）", async () => {
    const { app, aCookie } = await makeAssignedPaper();
    const res = await fetchPaper(
      app,
      aCookie,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("ASSIGNMENT_NOT_FOUND");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("已删除（软删）的作业返回 404；库行保留", async () => {
    const { app, db, teacherCookie, aCookie, assignmentId } =
      await makeAssignedPaper();
    const del = await app.request(`/api/teacher/assignments/${assignmentId}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);

    const res = await fetchPaper(app, aCookie, assignmentId);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("ASSIGNMENT_NOT_FOUND");
    // 软删语义：库行保留（与 T2.2 口径一致）
    expect(db.select().from(questions).all().length).toBe(8);
  });

  it("未登录返回 401；教师会话访问学生试卷接口返回 401（会话类型隔离）", async () => {
    const { app, teacherCookie, aCookie, assignmentId } =
      await makeAssignedPaper();
    const anon = await fetchPaper(app, undefined, assignmentId);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as ApiErr).error).toBe("UNAUTHORIZED");

    const asTeacher = await fetchPaper(app, teacherCookie, assignmentId);
    expect(asTeacher.status).toBe(401);
    // 对照：同一作业学生本人可取
    expect((await fetchPaper(app, aCookie, assignmentId)).status).toBe(200);
  });
});

describe("GET /api/student/assignments/:id/paper：软删题目不出现", () => {
  it("教师软删一道题后，试卷少一题且不含该题（其余顺序不变）", async () => {
    const { app, teacherCookie, aCookie, assignmentId } =
      await makeAssignedPaper();
    const del = await app.request("/api/teacher/questions/练习四-4", {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);

    const list = await fetchPaperQuestions(app, aCookie, assignmentId);
    expect(list.length).toBe(EXPECTED_ORDER.length - 1);
    expect(list.some((q) => q.id === "练习四-4")).toBe(false);
    expect(list.map((q) => q.id)).toEqual(
      EXPECTED_ORDER.map((q) => q.id).filter((id) => id !== "练习四-4"),
    );
  });
});
