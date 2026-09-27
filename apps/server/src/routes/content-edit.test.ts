import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  type ContentTree,
  contentTreeOkSchema,
  type QuestionDetail,
  type QuestionUpdateData,
  questionUpdateDataSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { courseItems, lectures, questions, units } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { restoreLecture } from "../services/library-service.ts";

/**
 * T1.12 单条编辑/删除/排序/课程 CRUD 集成测试（app.request() 直调路由 + 内存库）：
 * - 验收三条：编辑后题目 version+1 且 id 不变；软删题目不出现在内容树；
 *   reorder 后顺序保持（重新查询一致）；
 * - 单题编辑 422 分支：0 题 / 多题 / id 改动（ID_IMMUTABLE）/ error 级 lint（LINT_ERROR）；
 * - 讲义编辑（title 从 H1 重取、id 不变）与删除——T2A.1 起改软删（行保留、
 *   内容树消失、恢复经 LibraryService；关联单元 lectureId 保留）；
 * - 课程 CRUD（T2A.4 起 DELETE 按 D4：无作答即删，目录/成员随删、资源库保留）；
 *   全部接口未登录 401。
 */

const silentLogger: Logger = pino({ enabled: false });
const PASSWORD = "teacher-pass-8";

function loadSample(relative: string): string {
  return readFileSync(
    new URL(`../../../../samples/${relative}`, import.meta.url),
    "utf8",
  );
}

/** 只导入 v2 三份样例（不导 v1，保证 练习四 恰好 8 题、顺序确定） */
const SAMPLES = [
  { markdown: loadSample("v2/练习样例.md"), filename: "练习样例.md" },
  { markdown: loadSample("v2/讲义样例.md"), filename: "讲义样例.md" },
  { markdown: loadSample("v2/混合样例.md"), filename: "混合样例.md" },
] as const;

/** 导入练习样例后 练习四 单元的题目顺序（order 0–7） */
const EXPECTED_UNIT_QUESTIONS = [
  "练习四-1",
  "练习四-2",
  "练习四-3",
  "练习四-4",
  "练习四-5",
  "p4-q7",
  "练习四-7",
  "练习四-8",
];

interface TeacherApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
}

async function makeTeacherApp(): Promise<TeacherApp> {
  const db = createTestDb();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir: createTestDir(),
  });
  const res = await app.request("/api/public/teacher/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("setup 未下发会话 Cookie");
  const token = line.slice("tutor_session=".length).split(";")[0] ?? "";
  const cookie = `tutor_session=${token}`;
  // T2A.3：导入不再自动创建「默认课程」——显式建课并按兼容路径（courseId）导入，
  // 保持内容树（course_items 组装）有课程可显示的测试口径
  const courseRes = await app.request("/api/teacher/courses", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "默认课程" }),
  });
  if (courseRes.status !== 201) {
    throw new Error("测试课程创建失败");
  }
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  for (const sample of SAMPLES) {
    const commitRes = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...sample, courseId }),
    });
    if (commitRes.status !== 200) {
      throw new Error(`样例导入失败：${sample.filename}`);
    }
  }
  return { app, db, cookie };
}

/** 登录态 JSON 请求 */
function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
  // Hono 的 app.request 返回 Promise<Response> | Response，包一层统一成 Promise
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function getTree(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<ContentTree> {
  const res = await request(app, "GET", "/api/teacher/content", cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: ContentTree };
  expect(contentTreeOkSchema.safeParse(body).success).toBe(true);
  return body.data;
}

/** 练习四 单元的题目 id 顺序（内容树口径） */
function unitQuestionIds(tree: ContentTree): string[] {
  return (
    tree.courses[0]?.units
      .find((u) => u.id === "练习四")
      ?.questions.map((q) => q.id) ?? []
  );
}

async function getQuestionDetail(
  app: ReturnType<typeof createApp>,
  cookie: string,
  id: string,
): Promise<QuestionDetail> {
  const res = await request(
    app,
    "GET",
    `/api/teacher/questions/${encodeURIComponent(id)}`,
    cookie,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: QuestionDetail }).data;
}

describe("T1.12 未登录 401", () => {
  const UUID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
  const CASES: ReadonlyArray<{
    method: string;
    path: string;
    body?: unknown;
  }> = [
    { method: "GET", path: `/api/teacher/questions/${UUID}` },
    {
      method: "PUT",
      path: `/api/teacher/questions/${UUID}`,
      body: { sourceMd: "x" },
    },
    { method: "DELETE", path: `/api/teacher/questions/${UUID}` },
    { method: "GET", path: `/api/teacher/lectures/${UUID}` },
    {
      method: "PUT",
      path: `/api/teacher/lectures/${UUID}`,
      body: { markdown: "x" },
    },
    { method: "DELETE", path: `/api/teacher/lectures/${UUID}` },
    {
      method: "POST",
      path: "/api/teacher/reorder",
      body: { kind: "unit", ids: ["u"] },
    },
    { method: "POST", path: "/api/teacher/courses", body: { title: "x" } },
    {
      method: "PATCH",
      path: `/api/teacher/courses/${UUID}`,
      body: { title: "x" },
    },
    { method: "DELETE", path: `/api/teacher/courses/${UUID}` },
  ];

  it("全部新接口未登录返回 401 统一错误壳", async () => {
    const db = createTestDb();
    const app = createApp({
      isProduction: false,
      logger: silentLogger,
      db,
      publicUrl: "http://localhost:8787",
      dataDir: createTestDir(),
    });
    for (const testCase of CASES) {
      const res = await request(
        app,
        testCase.method,
        testCase.path,
        undefined,
        testCase.body,
      );
      expect(res.status, `${testCase.method} ${testCase.path}`).toBe(401);
      expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
    }
  });
});

describe("PUT /api/teacher/questions/:id 单题编辑", () => {
  it("编辑题干保存：version+1、id/unitId/order 不变，内容树与题目详情反映新内容", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const detail = await getQuestionDetail(app, cookie, "练习四-1");
    expect(detail.version).toBe(1);
    expect(detail.order).toBe(0);
    expect(detail.sourceMd).toContain("既不是正数，也不是负数");
    // 缺省 id 题（无显式 id 属性）原样提交也必须解析回同一 id（startNumber=order+1 复现）
    const edited = detail.sourceMd.replace(
      "既不是正数，也不是负数",
      "既不是正数，也不是负数（正负数的分界点）",
    );

    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      { sourceMd: edited },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: QuestionUpdateData };
    expect(questionUpdateDataSchema.safeParse(body.data).success).toBe(true);
    expect(body.data).toMatchObject({
      id: "练习四-1",
      version: 2,
      type: "judge",
      difficulty: 1,
      knowledge: ["有理数的概念"],
    });
    expect(body.data.issues.filter((i) => i.level === "error")).toEqual([]);

    // 落库断言：id/unitId/order 不变，stemMd/sourceMd 已更新，version=2
    const row = db
      .select()
      .from(questions)
      .where(eq(questions.id, "练习四-1"))
      .get();
    expect(row).toBeDefined();
    expect(row?.unitId).toBe("练习四");
    expect(row?.order).toBe(0);
    expect(row?.version).toBe(2);
    expect(row?.stemMd).toContain("正负数的分界点");
    expect(row?.sourceMd).toBe(edited);

    // 内容树：version 显示 2
    const tree = await getTree(app, cookie);
    const summary = tree.courses[0]?.units
      .find((u) => u.id === "练习四")
      ?.questions.find((q) => q.id === "练习四-1");
    expect(summary?.version).toBe(2);
  });

  it("sourceMd 为空 → 400 VALIDATION_ERROR（契约拦截）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      {
        sourceMd: "",
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErr).error).toBe("VALIDATION_ERROR");
  });

  it("未解析出题目（正文没有 question 容器）→ 422 VALIDATION_ERROR", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      {
        sourceMd: "这里只有普通文本，没有任何题目。",
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("未解析出任何题目");
  });

  it("一次提交多道题 → 422 VALIDATION_ERROR（一次只能编辑一道题）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const detail = await getQuestionDetail(app, cookie, "练习四-1");
    const twoQuestions = `${detail.sourceMd}\n\n${detail.sourceMd.replace(
      "type=judge",
      "type=judge id=another",
    )}`;
    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      {
        sourceMd: twoQuestions,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("一次只能编辑一道题");
  });

  it("改动题目 id（显式 id ≠ 原 id）→ 422 ID_IMMUTABLE，原题不受影响", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const detail = await getQuestionDetail(app, cookie, "练习四-1");
    const renamed = detail.sourceMd.replace(
      "{type=judge",
      "{id=my-new-q type=judge",
    );
    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      {
        sourceMd: renamed,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("ID_IMMUTABLE");
    expect(body.message).toContain("题目 id 不可变");
    // 原题未动：version 仍为 1
    const row = db
      .select({ version: questions.version })
      .from(questions)
      .where(eq(questions.id, "练习四-1"))
      .get();
    expect(row?.version).toBe(1);
  });

  it("改动缺省序号之外的属性使 id 复现失败（跨单元移动语义）→ 422 ID_IMMUTABLE", async () => {
    // p4-q7 是显式 id 题：改成无显式 id 后，缺省 id 按 order+1=6 复现为 练习四-6 ≠ p4-q7
    const { app, cookie } = await makeTeacherApp();
    const detail = await getQuestionDetail(app, cookie, "p4-q7");
    const noExplicitId = detail.sourceMd.replace(" id=p4-q7", "");
    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/p4-q7",
      cookie,
      {
        sourceMd: noExplicitId,
      },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as ApiErr).error).toBe("ID_IMMUTABLE");
  });

  it("error 级 lint 问题（type=essay 未知题型）→ 422 LINT_ERROR 附 _issues（行号为片段坐标）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const detail = await getQuestionDetail(app, cookie, "练习四-1");
    const broken = detail.sourceMd.replace("type=judge", "type=essay");
    const res = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      {
        sourceMd: broken,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErr & { _issues?: unknown[] };
    expect(body.error).toBe("LINT_ERROR");
    expect(Array.isArray(body._issues)).toBe(true);
    expect((body._issues ?? []).length).toBeGreaterThan(0);
    // 行号已平移回片段坐标（题目容器起始行 = 片段第 1 行）
    const firstIssue = body._issues?.[0] as { line: number; code: string };
    expect(firstIssue.line).toBeLessThanOrEqual(broken.split("\n").length);
    // 原题未动
    const row = db
      .select({ version: questions.version })
      .from(questions)
      .where(eq(questions.id, "练习四-1"))
      .get();
    expect(row?.version).toBe(1);
  });

  it("题目不存在 / 已软删 → 404 QUESTION_NOT_FOUND", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const notFound = await request(
      app,
      "PUT",
      "/api/teacher/questions/no-such-q",
      cookie,
      {
        sourceMd: "::::question{type=judge difficulty=1}\n对。[[正确]]\n::::",
      },
    );
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as ApiErr).error).toBe(
      "QUESTION_NOT_FOUND",
    );

    // 软删后按不存在处理
    db.update(questions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(questions.id, "练习四-1"))
      .run();
    const deleted = await request(
      app,
      "PUT",
      "/api/teacher/questions/练习四-1",
      cookie,
      {
        sourceMd: "::::question{type=judge difficulty=1}\n对。[[正确]]\n::::",
      },
    );
    expect(deleted.status).toBe(404);
  });
});

describe("DELETE /api/teacher/questions/:id 软删", () => {
  it("软删后题目不出现在内容树，行保留（deletedAt 写入、version 不变）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const before = await getTree(app, cookie);
    expect(unitQuestionIds(before)).toEqual(EXPECTED_UNIT_QUESTIONS);

    const res = await request(
      app,
      "DELETE",
      "/api/teacher/questions/练习四-2",
      cookie,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    // 验收：软删题目不出现在列表
    const after = await getTree(app, cookie);
    expect(unitQuestionIds(after)).toEqual(
      EXPECTED_UNIT_QUESTIONS.filter((id) => id !== "练习四-2"),
    );

    // 行仍在（软删不物理删除），deletedAt 已写、version 不变
    const row = db
      .select()
      .from(questions)
      .where(eq(questions.id, "练习四-2"))
      .get();
    expect(row).toBeDefined();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.version).toBe(1);

    // 未知 id → 404
    const notFound = await request(
      app,
      "DELETE",
      "/api/teacher/questions/no-such",
      cookie,
    );
    expect(notFound.status).toBe(404);
  });
});

describe("POST /api/teacher/reorder 排序", () => {
  it("题目倒序后内容树顺序保持（验收：排序刷新后保持 → 重新查询一致）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const reversed = [...EXPECTED_UNIT_QUESTIONS].reverse();
    const res = await request(app, "POST", "/api/teacher/reorder", cookie, {
      kind: "question",
      ids: reversed,
    });
    expect(res.status).toBe(200);

    // 重新查询（模拟刷新）两次，顺序一致
    const tree1 = await getTree(app, cookie);
    expect(unitQuestionIds(tree1)).toEqual(reversed);
    const tree2 = await getTree(app, cookie);
    expect(unitQuestionIds(tree2)).toEqual(reversed);

    // 落库 order 按 ids 下标重写
    const orders = db
      .select({ id: questions.id, order: questions.order })
      .from(questions)
      .where(eq(questions.unitId, "练习四"))
      .all()
      .sort((a, b) => a.order - b.order)
      .map((row) => row.id);
    expect(orders).toEqual(reversed);
  });

  it("单元与讲义排序同样生效", async () => {
    const { app, cookie } = await makeTeacherApp();
    const before = await getTree(app, cookie);
    const course = before.courses[0];
    if (course === undefined) throw new Error("课程缺失");

    const reversedUnits = [...course.units.map((u) => u.id)].reverse();
    const reversedLectures = [...course.lectures.map((l) => l.id)].reverse();
    const unitRes = await request(app, "POST", "/api/teacher/reorder", cookie, {
      kind: "unit",
      ids: reversedUnits,
    });
    const lectureRes = await request(
      app,
      "POST",
      "/api/teacher/reorder",
      cookie,
      {
        kind: "lecture",
        ids: reversedLectures,
      },
    );
    expect(unitRes.status).toBe(200);
    expect(lectureRes.status).toBe(200);

    const after = await getTree(app, cookie);
    expect(after.courses[0]?.units.map((u) => u.id)).toEqual(reversedUnits);
    expect(after.courses[0]?.lectures.map((l) => l.id)).toEqual(
      reversedLectures,
    );
  });

  it("ids 含不存在的实体 → 404，顺序不变", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await request(app, "POST", "/api/teacher/reorder", cookie, {
      kind: "question",
      ids: [...EXPECTED_UNIT_QUESTIONS, "ghost-q"],
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("QUESTION_NOT_FOUND");
    const tree = await getTree(app, cookie);
    expect(unitQuestionIds(tree)).toEqual(EXPECTED_UNIT_QUESTIONS);
  });

  it("软删题目参与排序 → 404（按不存在处理）", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    db.update(questions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(questions.id, "练习四-1"))
      .run();
    const res = await request(app, "POST", "/api/teacher/reorder", cookie, {
      kind: "question",
      ids: EXPECTED_UNIT_QUESTIONS,
    });
    expect(res.status).toBe(404);
  });

  it("ids 重复 / 空 → 400 VALIDATION_ERROR", async () => {
    const { app, cookie } = await makeTeacherApp();
    const dup = await request(app, "POST", "/api/teacher/reorder", cookie, {
      kind: "question",
      ids: ["练习四-1", "练习四-1"],
    });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const empty = await request(app, "POST", "/api/teacher/reorder", cookie, {
      kind: "question",
      ids: [],
    });
    expect(empty.status).toBe(400);
  });
});

describe("讲义编辑与删除", () => {
  /** 取「第1讲 有理数」的详情 */
  async function getLectureId(
    app: ReturnType<typeof createApp>,
    cookie: string,
  ): Promise<string> {
    const tree = await getTree(app, cookie);
    const id = tree.courses[0]?.lectures.find(
      (l) => l.title === "第1讲 有理数",
    )?.id;
    if (id === undefined) throw new Error("第1讲缺失");
    return id;
  }

  it("GET 讲义详情返回 markdown（含 H1）；整篇编辑后 title 从 H1 重取、id 不变", async () => {
    const { app, cookie } = await makeTeacherApp();
    const id = await getLectureId(app, cookie);

    const detailRes = await request(
      app,
      "GET",
      `/api/teacher/lectures/${id}`,
      cookie,
    );
    expect(detailRes.status).toBe(200);
    const detail = ((await detailRes.json()) as { data: { markdown: string } })
      .data;
    expect(detail.markdown).toContain("# 第1讲 有理数");

    const edited = detail.markdown.replace(
      "# 第1讲 有理数",
      "# 第1讲 有理数（修订）",
    );
    const putRes = await request(
      app,
      "PUT",
      `/api/teacher/lectures/${id}`,
      cookie,
      {
        markdown: edited,
      },
    );
    expect(putRes.status).toBe(200);
    const body = (
      (await putRes.json()) as {
        data: { id: string; title: string; updatedAt: string };
      }
    ).data;
    expect(body.id).toBe(id);
    expect(body.title).toBe("第1讲 有理数（修订）");

    // 内容树反映新标题
    const tree = await getTree(app, cookie);
    expect(tree.courses[0]?.lectures.map((l) => l.title)).toContain(
      "第1讲 有理数（修订）",
    );
  });

  it("markdown 无 H1 → 422 LINT_ERROR（MISSING_HEADING）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const id = await getLectureId(app, cookie);
    const detailRes = await request(
      app,
      "GET",
      `/api/teacher/lectures/${id}`,
      cookie,
    );
    const { markdown } = (
      (await detailRes.json()) as { data: { markdown: string } }
    ).data;
    const noH1 = markdown.split("\n").slice(1).join("\n"); // 去掉首行 H1
    const res = await request(
      app,
      "PUT",
      `/api/teacher/lectures/${id}`,
      cookie,
      {
        markdown: noH1,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErr & {
      _issues?: { code: string }[];
    };
    expect(body.error).toBe("LINT_ERROR");
    expect(body._issues?.some((i) => i.code === "MISSING_HEADING")).toBe(true);
  });

  it("markdown 含多个 H1 → 422 VALIDATION_ERROR（一篇讲义只能一个 H1）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const id = await getLectureId(app, cookie);
    const detailRes = await request(
      app,
      "GET",
      `/api/teacher/lectures/${id}`,
      cookie,
    );
    const { markdown } = (
      (await detailRes.json()) as { data: { markdown: string } }
    ).data;
    const twoH1 = `${markdown}\n\n# 第3讲 多余的标题\n正文`;
    const res = await request(
      app,
      "PUT",
      `/api/teacher/lectures/${id}`,
      cookie,
      {
        markdown: twoH1,
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("一个 H1");
  });

  it("删除讲义：软删（行保留、deletedAt 写入、内容树消失），关联单元 lectureId 保留；重复删除幂等", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const tree = await getTree(app, cookie);
    const lectureId = tree.courses[0]?.lectures.find(
      (l) => l.title === "第2讲 数轴",
    )?.id;
    if (lectureId === undefined) throw new Error("第2讲缺失");
    // 混合样例的 随堂练习 单元关联第 2 讲（题目在 # 第2讲 之后）
    const linkedUnit = db
      .select()
      .from(units)
      .where(eq(units.id, "随堂练习"))
      .get();
    expect(linkedUnit?.lectureId).toBe(lectureId);

    const res = await request(
      app,
      "DELETE",
      `/api/teacher/lectures/${lectureId}`,
      cookie,
    );
    expect(res.status).toBe(200);

    // 内容树：已删讲义立即消失（窗口期过滤）
    const after = await getTree(app, cookie);
    expect(after.courses[0]?.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
    ]);
    // 行保留（软删不物理删除），deletedAt 已写
    const row = db
      .select()
      .from(lectures)
      .where(eq(lectures.id, lectureId))
      .get();
    expect(row).toBeDefined();
    expect(row?.deletedAt).not.toBeNull();
    // 关联保留（恢复讲义即回到原状；「从课程移除」由目录条目承担，属 T2A.4）
    const unitAfter = db
      .select()
      .from(units)
      .where(eq(units.id, "随堂练习"))
      .get();
    expect(unitAfter?.lectureId).toBe(lectureId);

    // 重复删除幂等成功（软删口径，与题目一致；不再是 404）
    const again = await request(
      app,
      "DELETE",
      `/api/teacher/lectures/${lectureId}`,
      cookie,
    );
    expect(again.status).toBe(200);

    // 未知 id → 404
    const notFound = await request(
      app,
      "DELETE",
      `/api/teacher/lectures/0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b`,
      cookie,
    );
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as ApiErr).error).toBe("LECTURE_NOT_FOUND");
  });

  it("软删讲义经 LibraryService 恢复后回到内容树", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const tree = await getTree(app, cookie);
    const lectureId = tree.courses[0]?.lectures.find(
      (l) => l.title === "第2讲 数轴",
    )?.id;
    if (lectureId === undefined) throw new Error("第2讲缺失");
    await request(app, "DELETE", `/api/teacher/lectures/${lectureId}`, cookie);
    restoreLecture(db, lectureId);
    const after = await getTree(app, cookie);
    expect(after.courses[0]?.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
  });
});

describe("课程 CRUD", () => {
  it("新建课程 → 201 并出现在内容树；重命名生效；空课程可删除", async () => {
    const { app, cookie } = await makeTeacherApp();
    const createRes = await request(
      app,
      "POST",
      "/api/teacher/courses",
      cookie,
      {
        title: "初一上",
      },
    );
    expect(createRes.status).toBe(201);
    const created = (
      (await createRes.json()) as {
        data: { id: string; title: string; order: number };
      }
    ).data;
    expect(created.title).toBe("初一上");

    let tree = await getTree(app, cookie);
    expect(tree.courses.map((c) => c.title)).toContain("初一上");

    const patchRes = await request(
      app,
      "PATCH",
      `/api/teacher/courses/${created.id}`,
      cookie,
      { title: "初一上学期" },
    );
    expect(patchRes.status).toBe(200);
    expect(
      ((await patchRes.json()) as { data: { title: string } }).data.title,
    ).toBe("初一上学期");

    tree = await getTree(app, cookie);
    expect(tree.courses.map((c) => c.title)).toContain("初一上学期");

    const deleteRes = await request(
      app,
      "DELETE",
      `/api/teacher/courses/${created.id}`,
      cookie,
    );
    expect(deleteRes.status).toBe(200);
    tree = await getTree(app, cookie);
    expect(tree.courses.map((c) => c.title)).not.toContain("初一上学期");
  });

  it("课程下有内容但无作答 → D4 删除成功；目录条目清理、资源库保留", async () => {
    const { app, db, cookie } = await makeTeacherApp();
    const tree = await getTree(app, cookie);
    const defaultCourse = tree.courses.find((c) => c.title === "默认课程");
    if (defaultCourse === undefined) throw new Error("默认课程缺失");
    const res = await request(
      app,
      "DELETE",
      `/api/teacher/courses/${defaultCourse.id}`,
      cookie,
    );
    expect(res.status).toBe(200);
    // 课程与目录条目消失
    const after = await getTree(app, cookie);
    expect(after.courses.map((c) => c.title)).not.toContain("默认课程");
    expect(
      db
        .select()
        .from(courseItems)
        .where(eq(courseItems.courseId, defaultCourse.id))
        .all().length,
    ).toBe(0);
    // D4：删除课程不影响资源库内容（讲义/单元仍在库中）
    expect(
      db.select({ id: lectures.id }).from(lectures).all().length,
    ).toBeGreaterThan(0);
    expect(
      db.select({ id: units.id }).from(units).all().length,
    ).toBeGreaterThan(0);
  });

  it("空标题 → 400；不存在的课程 → 404 COURSE_NOT_FOUND；课程排序生效", async () => {
    const { app, cookie } = await makeTeacherApp();
    const bad = await request(app, "POST", "/api/teacher/courses", cookie, {
      title: "  ",
    });
    expect(bad.status).toBe(400);

    const UUID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
    const patch404 = await request(
      app,
      "PATCH",
      `/api/teacher/courses/${UUID}`,
      cookie,
      {
        title: "x",
      },
    );
    expect(patch404.status).toBe(404);
    expect(((await patch404.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");

    // 课程排序：新建课程提到默认课程之前
    const createRes = await request(
      app,
      "POST",
      "/api/teacher/courses",
      cookie,
      {
        title: "初一上",
      },
    );
    expect(createRes.status).toBe(201);
    const createdId = ((await createRes.json()) as { data: { id: string } })
      .data.id;
    const tree = await getTree(app, cookie);
    const defaultId =
      tree.courses.find((c) => c.title === "默认课程")?.id ?? "";
    const reorderRes = await request(
      app,
      "POST",
      "/api/teacher/reorder",
      cookie,
      {
        kind: "course",
        ids: [createdId, defaultId],
      },
    );
    expect(reorderRes.status).toBe(200);
    const after = await getTree(app, cookie);
    expect(after.courses.map((c) => c.title)).toEqual(["初一上", "默认课程"]);
  });
});
