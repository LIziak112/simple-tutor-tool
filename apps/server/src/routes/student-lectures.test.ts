import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  studentLectureDetailOkSchema,
  studentLectureListOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { sessions } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * 学生端讲义两接口 + 学生 logout 集成测试（T2.3 起；T2A.5 切换 D5 后重写）：
 * 讲义只经课程可见（成员 + 目录条目可见）——导入进课程（courseId 兼容路径：
 * 讲义条目可见）、学生加入成员后按 D5 返回两讲；关联单元（默认隐藏）不贡献
 * topic，教师放开可见后 topic 出现；详情返回全文 markdown + 课程上下文 +
 * 本课配套练习；404；泄露断言（响应不携带 questions 表任何字段，讲义 markdown
 * 本身允许含指令语法文本）。T2A.4 起泄露断言复用通用工具 assertNoLeak
 * （src/test/assert-no-leak.ts）。D22 越权矩阵与配套练习的完整覆盖见
 * routes/student-courses.test.ts；此处聚焦讲义读路径的行为切换。
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

/**
 * 组装被测环境 + 教师 setup + 课程 + 学生创建登录并加入成员，返回两侧 Cookie。
 * importLecture = 同时导入讲义样例（courseId 兼容路径：讲义条目可见）。
 */
async function makeApp(options?: { importLecture?: boolean }): Promise<{
  app: ReturnType<typeof createApp>;
  db: Db;
  studentCookie: string;
  teacherCookie: string;
  courseId: string;
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

  const created = await app.request("/api/teacher/courses", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ title: "初一上" }),
  });
  expect(created.status).toBe(201);
  const courseId = ((await created.json()) as { data: { id: string } }).data.id;

  // 学生创建 + 密码登录（登录页与链接登录同写一种会话 Cookie，此处用密码登录即可）
  const studentCreate = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName: "张三",
      loginName: "张三",
      password: STUDENT_PASSWORD,
    }),
  });
  expect(studentCreate.status).toBe(201);
  const studentId = (
    (await studentCreate.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: "张三", password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const studentCookie = `tutor_session=${extractSessionToken(login)}`;

  // T2A.5：学生能看到讲义的前提是课程成员 + 目录条目可见（D5）
  const member = await app.request(`/api/teacher/courses/${courseId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ studentIds: [studentId] }),
  });
  expect(member.status).toBe(200);

  if (options?.importLecture !== false) {
    await importDoc(app, teacherCookie, LECTURE_MD, "讲义样例.md", courseId);
  }
  return { app, db, studentCookie, teacherCookie, courseId };
}

/** 教师导入一份文档进课程（commit；有 error 级 issue 时 422 直接让测试失败） */
async function importDoc(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  markdown: string,
  filename: string,
  courseId?: string,
): Promise<void> {
  const res = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify(
      courseId === undefined
        ? { markdown, filename }
        : { markdown, filename, courseId },
    ),
  });
  expect(res.status).toBe(200);
}

/**
 * 讲义接口的泄露断言（AGENTS.md 第 3 条）：
 * 通用禁用集合（answers、solution 前缀、hints 内容、sourceMd、passwordHash、
 * linkToken、optionsJson）之外，讲义响应额外不得出现任何题目侧字段
 * （stemMd/optionsJson/questions——题目本体只经 T2.4 的 paper 接口下发）。
 * 注意只断言 JSON 字段名——讲义 markdown 文本本身允许含 :::solution 等指令语法。
 */
function assertNoQuestionFields(body: unknown): void {
  assertNoLeak(body, { forbid: ["stemMd", "optionsJson", "questions"] });
}

describe("GET /api/student/lectures（讲义摘要列表，T2A.5 D5 切换）", () => {
  it("未登录返回 401", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/student/lectures");
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("UNAUTHORIZED");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("没有课程内容时空双视图（结构符合契约）", async () => {
    const { app, studentCookie } = await makeApp({ importLecture: false });
    const res = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentLectureListOkSchema.safeParse(body).success).toBe(true);
    expect(
      (body as { data: { lectures: unknown[]; courses: unknown[] } }).data,
    ).toEqual({ lectures: [], courses: [] });
    assertNoQuestionFields(body);
  });

  it("课程成员看到讲义样例两讲（条目顺序）；详情含全文 markdown 与 :::solution 讲解（设计如此）", async () => {
    const { app, studentCookie, courseId } = await makeApp();

    const list = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: {
        lectures: { id: string; title: string; topic: string | null }[];
        courses: {
          courseId: string;
          courseName: string;
          lectures: unknown[];
        }[];
      };
    };
    expect(studentLectureListOkSchema.safeParse(listBody).success).toBe(true);
    // 顺序 = 文档内 H1 顺序（第1讲 → 第2讲）；无可见关联单元 → topic null
    expect(listBody.data.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    expect(listBody.data.lectures.every((l) => l.topic === null)).toBe(true);
    // 分组视图：唯一课程组「初一上」含两讲
    expect(listBody.data.courses).toHaveLength(1);
    expect(listBody.data.courses[0]?.courseId).toBe(courseId);
    expect(listBody.data.courses[0]?.courseName).toBe("初一上");
    expect(listBody.data.courses[0]?.lectures).toHaveLength(2);
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
    expect(studentLectureDetailOkSchema.safeParse(detailBody).success).toBe(
      true,
    );
    expect(detailBody.data.title).toBe("第1讲 有理数");
    expect(detailBody.data.markdown).toContain("# 第1讲 有理数");
    expect(detailBody.data.markdown).toContain(":::solution");
    assertNoQuestionFields(detailBody);
  });

  it("关联单元默认隐藏不贡献 topic；教师放开可见后列表聚合该单元 topic", async () => {
    const { app, studentCookie, teacherCookie, courseId } = await makeApp();
    await importDoc(
      app,
      teacherCookie,
      LINKED_PRACTICE_MD,
      "有理数小练.md",
      courseId,
    );

    const before = (await (
      await app.request("/api/student/lectures", {
        headers: { cookie: studentCookie },
      })
    ).json()) as {
      data: { lectures: { title: string; topic: string | null }[] };
    };
    // 「有理数小练」条目默认隐藏（导入兼容口径）→ topic 保持 null（隐藏条目零信息）
    expect(before.data.lectures).toEqual([
      expect.objectContaining({ title: "第1讲 有理数", topic: null }),
      expect.objectContaining({ title: "第2讲 数轴", topic: null }),
    ]);

    // 教师放开配套单元 → 第1讲 topic = 正数与负数（可见配套单元贡献）
    const detail = (await (
      await app.request(`/api/teacher/courses/${courseId}`, {
        headers: { cookie: teacherCookie },
      })
    ).json()) as {
      data: { items: { id: string; title: string }[] };
    };
    const unitItem = detail.data.items.find(
      (item) => item.title === "有理数小练",
    );
    expect(unitItem).toBeDefined();
    const patched = await app.request(
      `/api/teacher/course-items/${unitItem?.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ visible: true }),
      },
    );
    expect(patched.status).toBe(200);

    const after = (await (
      await app.request("/api/student/lectures", {
        headers: { cookie: studentCookie },
      })
    ).json()) as {
      data: { lectures: { title: string; topic: string | null }[] };
    };
    expect(after.data.lectures).toEqual([
      expect.objectContaining({ title: "第1讲 有理数", topic: "正数与负数" }),
      expect.objectContaining({ title: "第2讲 数轴", topic: null }),
    ]);
    // 关联练习已在 questions 表落了行（含答案/详解字段），列表响应不得出现任何题目侧字段
    assertNoQuestionFields(after);
  });
});

describe("GET /api/student/lectures/:id（讲义详情）", () => {
  it("未登录返回 401", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/student/lectures/some-id");
    expect(res.status).toBe(401);
  });

  it("讲义不存在返回 404 NOT_FOUND（统一错误壳，不暴露存在性）", async () => {
    const { app, studentCookie } = await makeApp();
    const res = await app.request("/api/student/lectures/not-exist", {
      headers: { cookie: studentCookie },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("NOT_FOUND");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("教师会话访问学生讲义接口返回 401（会话类型隔离）", async () => {
    const { app } = await makeApp();
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

describe("讲义软删的可见性（T2A.5，D5 条件 4）", () => {
  it("教师删除讲义后：学生端列表立即不可见、详情 404；响应仍无题目侧字段（泄露断言）", async () => {
    const { app, studentCookie, teacherCookie } = await makeApp();

    // 删除前：两讲都在
    const before = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    const beforeBody = (await before.json()) as {
      data: { lectures: { id: string; title: string }[] };
    };
    expect(beforeBody.data.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    const firstId = beforeBody.data.lectures[0]?.id as string;

    // 教师走真实删除接口（软删；接口路径与语义确认弹层不变）
    const del = await app.request(`/api/teacher/lectures/${firstId}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);

    // 学生端列表立即不含已删讲义（不需要刷新缓存以外的任何操作）
    const after = await app.request("/api/student/lectures", {
      headers: { cookie: studentCookie },
    });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      data: { lectures: { id: string; title: string }[] };
    };
    expect(studentLectureListOkSchema.safeParse(afterBody).success).toBe(true);
    expect(afterBody.data.lectures.map((l) => l.title)).toEqual(["第2讲 数轴"]);
    assertNoQuestionFields(afterBody);

    // 详情：已删讲义按不可见处理（404 NOT_FOUND，D22）
    const detail = await app.request(`/api/student/lectures/${firstId}`, {
      headers: { cookie: studentCookie },
    });
    expect(detail.status).toBe(404);
    expect(((await detail.json()) as ApiErr).error).toBe("NOT_FOUND");
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
    // Cookie 清除指令（hono deleteCookie 用 max-age=0 立即过期，属性与写入时一致）。
    // 登出请求先经过守卫：滑动续期会先续发一条会话 Cookie，同名 Cookie
    // 按序应用、后写的清除生效（RFC 6265），故断言「存在清除指令」而非首条。
    const cleared = logout.headers
      .getSetCookie()
      .find((c) => c.toLowerCase().includes("max-age=0"));
    expect(cleared).toBeDefined();
    expect(cleared?.toLowerCase()).toContain("tutor_session=");
    expect(cleared?.toLowerCase()).toContain("path=/");

    // 会话行已删除（库内无残留）；旧 Cookie 再访问 → 401
    const token = studentCookie.slice("tutor_session=".length);
    expect(
      db
        .select()
        .from(sessions)
        .all()
        .find((row) => row.id === token),
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
