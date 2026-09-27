import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import { type ContentTree, contentTreeOkSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { questions } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 内容树接口集成测试（T1.11，app.request() 直调路由 + 内存库）：
 * 未登录 401；未导入空树；导入三份 v2 样例 + v1 样例后的树结构与合并语义断言；
 * 软删题目不出现。
 */

const silentLogger: Logger = pino({ enabled: false });
const PASSWORD = "teacher-pass-8";

function loadSample(relative: string): string {
  return readFileSync(
    new URL(`../../../../samples/${relative}`, import.meta.url),
    "utf8",
  );
}

const SAMPLES = [
  { markdown: loadSample("v2/练习样例.md"), filename: "练习样例.md" },
  { markdown: loadSample("v2/讲义样例.md"), filename: "讲义样例.md" },
  { markdown: loadSample("v2/混合样例.md"), filename: "混合样例.md" },
  { markdown: loadSample("v1/示例练习.md"), filename: "示例练习.md" },
] as const;

/** 组装被测应用并完成教师 setup，返回 app、库与登录 Cookie */
async function makeTeacherApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
}> {
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
  return { app, db, cookie: `tutor_session=${token}` };
}

/** 登录态请求内容树并解出 data */
async function fetchTree(
  app: ReturnType<typeof createApp>,
  cookie?: string,
): Promise<Response> {
  return app.request("/api/teacher/content", {
    headers: cookie === undefined ? {} : { cookie },
  });
}

/** 依次导入样例后取内容树 */
async function importAllAndGetTree(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  cookie: string;
  tree: ContentTree;
}> {
  const { app, db, cookie } = await makeTeacherApp();
  // T2A.3：导入不再自动创建「默认课程」——显式建课 + 兼容路径（courseId）导入
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
    const res = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...sample, courseId }),
    });
    if (res.status !== 200) {
      throw new Error(`样例导入失败：${sample.filename}（HTTP ${res.status}）`);
    }
  }
  const treeRes = await fetchTree(app, cookie);
  expect(treeRes.status).toBe(200);
  const body = (await treeRes.json()) as { data: ContentTree };
  expect(contentTreeOkSchema.safeParse(body).success).toBe(true);
  return { app, db, cookie, tree: body.data };
}

describe("GET /api/teacher/content", () => {
  it("未登录返回 401 统一错误壳", async () => {
    const db = createTestDb();
    const app = createApp({
      isProduction: false,
      logger: silentLogger,
      db,
      publicUrl: "http://localhost:8787",
      dataDir: createTestDir(),
    });
    const res = await fetchTree(app);
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("未导入任何内容时返回空树（courses: []）", async () => {
    const { app, cookie } = await makeTeacherApp();
    const res = await fetchTree(app, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ContentTree };
    expect(body.data.courses).toEqual([]);
  });

  it("导入三份 v2 样例 + v1 样例后：默认课程下 2 讲义、2 单元，题目摘要结构正确", async () => {
    const { tree } = await importAllAndGetTree();

    // 四份文档均按 courseId 兼容路径导入 → 全部落到显式创建的「默认课程」
    // （T2A.3 起导入不再自动创建默认课程）
    expect(tree.courses).toHaveLength(1);
    const course = tree.courses[0];
    if (course === undefined) throw new Error("课程节点缺失");
    expect(course.title).toBe("默认课程");

    // 讲义样例 2 讲；混合样例的同名 H1 按标题替换，不新增
    expect(course.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    // 讲义节点只有 id/title/updatedAt（无题目数组）
    for (const lecture of course.lectures) {
      expect(Object.keys(lecture).sort()).toEqual(["id", "title", "updatedAt"]);
    }

    // 单元：练习四（v2 练习样例 + v1 样例合并）与随堂练习（混合样例）
    expect(course.units.map((u) => u.id)).toEqual(["练习四", "随堂练习"]);

    const unit = course.units[0];
    if (unit === undefined) throw new Error("单元节点缺失");
    expect(unit.title).toBe("练习四");
    expect(unit.topic).toBe("有理数加减混合");

    // 练习四 = v2 样例 8 题 + v1 样例特有的 练习四-6（其余 7 题同 id 被更新而非新增）。
    // 练习四-6（v1 题 6）与 p4-q7（v2 题 6）order 同为 5，按 id 兜底排序 p4-q7 在前
    expect(unit.questions.map((q) => q.id)).toEqual([
      "练习四-1",
      "练习四-2",
      "练习四-3",
      "练习四-4",
      "练习四-5",
      "p4-q7", // v2 练习样例的显式 id
      "练习四-6", // v1 样例特有（插入时 order 取 v1 文档内题序 5）
      "练习四-7",
      "练习四-8",
    ]);
    // 摘要字段：题型/难度/考点/版本（p4-q7 只导入一次 → version 1，knowledge 来自 DSL）
    const p4q7 = unit.questions.find((q) => q.id === "p4-q7");
    expect(p4q7).toEqual({
      id: "p4-q7",
      type: "solve",
      difficulty: 3,
      knowledge: ["有理数混合运算"],
      version: 1,
    });
    // 同 id 再导入 → version+1（v2 先导入、v1 后导入的 7 道重叠题）
    expect(unit.questions.find((q) => q.id === "练习四-1")?.version).toBe(2);

    const mixedUnit = course.units[1];
    if (mixedUnit === undefined) throw new Error("随堂练习单元缺失");
    expect(mixedUnit.topic).toBe("有理数与数轴");
    expect(mixedUnit.questions.map((q) => q.type)).toEqual([
      "judge",
      "choice",
      "fill",
    ]);
  });

  it("软删题目不出现在内容树里（T1.12 起删除的题目从列表消失）", async () => {
    const { db, app, cookie, tree } = await importAllAndGetTree();
    const before = tree.courses[0]?.units
      .find((u) => u.id === "练习四")
      ?.questions.map((q) => q.id);
    expect(before).toContain("p4-q7");

    // 模拟 T1.12 的软删：deletedAt 置为当前 UTC ISO
    db.update(questions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(questions.id, "p4-q7"))
      .run();

    const res = await fetchTree(app, cookie);
    const body = (await res.json()) as { data: ContentTree };
    const after = body.data.courses[0]?.units
      .find((u) => u.id === "练习四")
      ?.questions.map((q) => q.id);
    expect(after).not.toContain("p4-q7");
    expect(after).toHaveLength((before ?? []).length - 1);
  });
});
