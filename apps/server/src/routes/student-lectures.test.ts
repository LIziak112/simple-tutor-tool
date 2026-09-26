import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  studentLectureDetailOkSchema,
  studentLectureListOkSchema,
} from "@tutor/contract";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { sessions } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";

/**
 * 学生端讲义两接口 + 学生 logout 集成测试（T2.3，app.request() 直调路由 + 内存库）：
 * 未登录 401；空列表；导入 samples/v2/讲义样例.md 后按课程顺序返回两讲；
 * 关联单元后 topic 聚合；详情返回全文 markdown；404；泄露断言
 * （响应不携带 questions 表任何字段，讲义 markdown 本身允许含指令语法文本）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 讲义样例原文（T1.13 起作为兼容性回归夹具；含两篇讲义：第1讲 有理数 / 第2讲 数轴） */
const LECTURE_MD = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

/** 关联第1讲的练习文档：让 units.lectureId 命中，验证 topic 聚合（judge 题结构照抄练习样例） */
const LINKED_PRACTICE_MD = `---
kind: practice
unit: 有理数小练
lecture: 第1讲 有理数
topic: 正数与负数
---

::::question{type=judge difficulty=1}
$1$ 是正数。[[正确]]

:::solution
$1$ 大于 $0$，是正数。
:::
::::
`;

/** 组装被测应用 + 教师 setup + 学生创建与登录，返回两侧 Cookie */
async function makeApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  studentCookie: string;
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

  // 学生创建 + 密码登录（登录页与链接登录同写一种会话 Cookie，此处用密码登录即可）
  await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: "张三",
      loginName: "张三",
      password: STUDENT_PASSWORD,
    }),
  });
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "张三", password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  return { app, db, studentCookie: `tutor_session=${extractSessionToken(login)}` };
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

/** 教师导入一份文档（commit；有 error 级 issue 时 422 直接让测试失败） */
async function importDoc(
  app: ReturnType<typeof createApp>,
  markdown: string,
  filename: string,
): Promise<void> {
  const setup = await app.request("/api/public/teacher/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEACHER_PASSWORD }),
  });
  const res = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `tutor_session=${extractSessionToken(setup)}`,
    },
    body: JSON.stringify({ markdown, filename }),
  });
  expect(res.status).toBe(200);
}

/**
 * 泄露断言（AGENTS.md 第 3 条；T2.4 的通用 assertNoLeak 落地前的本地版本）：
 * 递归收集响应 JSON 的全部 key，与「教师侧/题目侧字段」禁用集合不相交。
 * 注意只断言 JSON 字段名——讲义 markdown 文本本身允许含 :::solution 等指令语法。
 */
function assertNoQuestionFields(body: unknown): void {
  const FORBIDDEN_KEYS = new Set([
    "stemMd",
    "optionsJson",
    "answersJson",
    "answers",
    "solutionMd",
    "hints",
    "hintsJson",
    "sourceMd",
    "questions",
    "passwordHash",
    "linkToken",
  ]);
  const keys: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  walk(body);
  const leaked = keys.filter((key) => FORBIDDEN_KEYS.has(key));
  expect(leaked, `响应中出现教师侧字段：${leaked.join(", ")}`).toEqual([]);
}

describe("GET /api/student/lectures（讲义摘要列表）", () => {
  it("未登录返回 401", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/student/lectures");
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("UNAUTHORIZED");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("未导入内容时空列表（结构符合契约）", async () => {
    const { app, studentCookie } = await makeApp();
    const res = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentLectureListOkSchema.safeParse(body).success).toBe(true);
    expect((body as { data: { lectures: unknown[] } }).data.lectures).toEqual(
      [],
    );
    assertNoQuestionFields(body);
  });

  it("导入讲义样例后按课程顺序返回两讲；详情含全文 markdown 与 :::solution 讲解（设计如此）", async () => {
    const { app, studentCookie } = await makeApp();
    await importDoc(app, LECTURE_MD, "讲义样例.md");

    const list = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: { lectures: { id: string; title: string; topic: string | null }[] };
    };
    expect(studentLectureListOkSchema.safeParse(listBody).success).toBe(true);
    // 顺序 = 文档内 H1 顺序（第1讲 → 第2讲）；无关联单元 → topic null
    expect(listBody.data.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    expect(listBody.data.lectures.every((l) => l.topic === null)).toBe(true);
    assertNoQuestionFields(listBody);

    // 详情：全文 markdown（含 H1 行与 :::solution 讲解内容——学生端应见，前端折叠展示）
    const firstId = listBody.data.lectures[0]?.id as string;
    const detail = await app.request(`/api/student/lectures/${firstId}`, {
      headers: { cookie: studentCookie },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { markdown: string; title: string };
    };
    expect(
      studentLectureDetailOkSchema.safeParse(detailBody).success,
    ).toBe(true);
    expect(detailBody.data.title).toBe("第1讲 有理数");
    expect(detailBody.data.markdown).toContain("# 第1讲 有理数");
    expect(detailBody.data.markdown).toContain(":::solution");
    assertNoQuestionFields(detailBody);
  });

  it("练习单元关联讲义后，列表聚合该单元 topic", async () => {
    const { app, studentCookie } = await makeApp();
    await importDoc(app, LECTURE_MD, "讲义样例.md");
    await importDoc(app, LINKED_PRACTICE_MD, "有理数小练.md");

    const res = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    const body = (await res.json()) as {
      data: { lectures: { title: string; topic: string | null }[] };
    };
    // 第1讲被「有理数小练」单元关联 → topic = 正数与负数；第2讲仍 null
    expect(body.data.lectures).toEqual([
      expect.objectContaining({ title: "第1讲 有理数", topic: "正数与负数" }),
      expect.objectContaining({ title: "第2讲 数轴", topic: null }),
    ]);
    // 关联练习已在 questions 表落了行（含答案/详解字段），列表响应不得出现任何题目侧字段
    assertNoQuestionFields(body);
  });
});

describe("GET /api/student/lectures/:id（讲义详情）", () => {
  it("未登录返回 401", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/student/lectures/some-id");
    expect(res.status).toBe(401);
  });

  it("讲义不存在返回 404 LECTURE_NOT_FOUND（统一错误壳）", async () => {
    const { app, studentCookie } = await makeApp();
    const res = await app.request("/api/student/lectures/not-exist", {
      headers: { cookie: studentCookie },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("LECTURE_NOT_FOUND");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("教师会话访问学生讲义接口返回 401（会话类型隔离）", async () => {
    const { app } = await makeApp();
    await importDoc(app, LECTURE_MD, "讲义样例.md");
    const login = await app.request("/api/public/teacher/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEACHER_PASSWORD }),
    });
    const res = await app.request("/api/student/lectures", {
      headers: { cookie: `tutor_session=${extractSessionToken(login)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/student/logout（学生退出登录，T2.3）", () => {
  it("删除会话行 + 清除 Cookie，之后 me 401", async () => {
    const { app, db, studentCookie } = await makeApp();

    const before = await app.request("/api/student/me", {
      headers: { cookie: studentCookie },
    });
    expect(before.status).toBe(200);

    const logout = await app.request("/api/student/logout", {
      method: "POST",
      headers: { cookie: studentCookie },
    });
    expect(logout.status).toBe(200);
    const logoutBody = (await logout.json()) as { ok: boolean; data: null };
    expect(logoutBody.ok).toBe(true);
    expect(logoutBody.data).toBeNull();
    // Cookie 清除指令（hono deleteCookie 用 max-age=0 立即过期，属性与写入时一致）
    const cleared = logout.headers
      .getSetCookie()
      .find((c) => c.toLowerCase().startsWith("tutor_session="));
    expect(cleared).toBeDefined();
    expect(cleared?.toLowerCase()).toContain("max-age=0");
    expect(cleared?.toLowerCase()).toContain("path=/");

    // 会话行已删除（库内无残留）；旧 Cookie 再访问 → 401
    const token = studentCookie.slice("tutor_session=".length);
    expect(
      db.select().from(sessions).all().find((row) => row.id === token),
    ).toBeUndefined();
    const after = await app.request("/api/student/me", {
      headers: { cookie: studentCookie },
    });
    expect(after.status).toBe(401);
  });

  it("未登录调用 logout 也返回 401（整组守卫）", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/student/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
