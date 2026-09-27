import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  courseDetailOkSchema,
  courseListOkSchema,
  courseStudentViewOkSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  assignments,
  attempts,
  courseItems,
  courseStudents,
  courses,
  lectures,
  units,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";

/**
 * 课程编辑页路由集成测试（T2A.4，app.request() 直调路由 + 内存库）：
 * - 列表/详情：成员数、条目数、可见条目数、hasAttempts、状态标签数据；
 * - 批量添加：D8 配套练习一并添加、重复跳过且返回清单（D6 批量口径）；
 * - 排序持久化（PUT items/order 后详情顺序一致）；
 * - 条目 PATCH（可见/定时/分节改名）与 DELETE；
 * - 成员增删（幂等）；
 * - student-view：隐藏条目消失、未到 publishAt 消失、非成员/归档课程为空；
 * - D4：有作答的课程删除 409 COURSE_HAS_ATTEMPTS；归档后学生不可见（经 student-view）；
 * - 未登录 401 / 学生会话访问教师接口 403 / 非法 body 400。
 * 夹具用 samples/v2/练习样例.md（含单元 练习四 8 题）+ 讲义样例.md。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);
const LECTURE_MD = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

/** 练习样例的单元 id（DSL 声明，全局唯一） */
const UNIT_ID = "练习四";
/** 讲义样例 H1 标题 */
const LECTURE_TITLE = "第1讲 有理数";

interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
  courseId: string;
  lectureId: string;
  /** 讲义样例导入后建立的课程目录条目 id（kind=lecture） */
  lectureItemId: string;
}

async function makeApp(): Promise<TestApp> {
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
  const courseRes = await app.request("/api/teacher/courses", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ title: "初一上", description: "有理数" }),
  });
  if (courseRes.status !== 201) throw new Error("测试课程创建失败");
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  for (const [markdown, filename] of [
    [LECTURE_MD, "讲义样例.md"],
    [PRACTICE_MD, "练习样例.md"],
  ] as const) {
    // 直接导入资源库（不进课程），随后走 POST items 的教师侧添加路径
    const res = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown, filename }),
    });
    expect(res.status).toBe(200);
  }
  const lectureId = db
    .select({ id: lectures.id })
    .from(lectures)
    .where(eq(lectures.title, LECTURE_TITLE))
    .get()?.id;
  if (lectureId === undefined) throw new Error("讲义样例未导入");
  return { app, db, teacherCookie, courseId, lectureId, lectureItemId: "" };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

/** 登录态 JSON 请求 */
async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 建学生（返回 id）并加入课程 */
async function addStudent(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  displayName: string,
): Promise<string> {
  const res = await request(
    app,
    "POST",
    "/api/teacher/students",
    teacherCookie,
    { displayName, loginName: displayName, password: STUDENT_PASSWORD },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { student: { id: string } } }).data
    .student.id;
}

describe("GET /api/teacher/courses（列表）", () => {
  it("未登录 401", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/teacher/courses");
    expect(res.status).toBe(401);
  });

  it("学生会话访问教师接口 401（教师守卫拒绝非教师会话）", async () => {
    const { app, teacherCookie } = await makeApp();
    await addStudent(app, teacherCookie, "张三");
    const login = await app.request("/api/public/student/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: "张三", password: STUDENT_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const studentCookie = `tutor_session=${extractSessionToken(login)}`;
    const res = await request(
      app,
      "GET",
      "/api/teacher/courses",
      studentCookie,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as ApiErr).error).toBe("UNAUTHORIZED");
  });

  it("返回成员数/条目数/可见条目数/memberIds；archived 筛选", async () => {
    const { app, db, teacherCookie, courseId } = await makeApp();
    const studentId = await addStudent(app, teacherCookie, "张三");
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    // 2 个条目：讲义可见 + 分节
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          {
            kind: "lecture",
            refId: db
              .select()
              .from(lectures)
              .where(eq(lectures.title, LECTURE_TITLE))
              .get()?.id,
          },
          { kind: "section", title: "第一周" },
        ],
        visible: true,
      },
    );

    const res = await request(
      app,
      "GET",
      "/api/teacher/courses",
      teacherCookie,
    );
    expect(res.status).toBe(200);
    const parsed = courseListOkSchema.parse(await res.json());
    const course = parsed.data.courses.find((c) => c.name === "初一上");
    expect(course).toBeDefined();
    expect(course?.memberCount).toBe(1);
    expect(course?.memberIds).toEqual([studentId]);
    expect(course?.itemCount).toBe(2);
    expect(course?.visibleItemCount).toBe(2);
    expect(course?.hasAttempts).toBe(false);

    // 归档后默认列表消失、archived=true 出现
    await request(
      app,
      "PATCH",
      `/api/teacher/courses/${courseId}`,
      teacherCookie,
      {
        archived: true,
      },
    );
    const activeRes = await request(
      app,
      "GET",
      "/api/teacher/courses",
      teacherCookie,
    );
    const active = courseListOkSchema.parse(await activeRes.json());
    expect(active.data.courses.map((c) => c.id)).not.toContain(courseId);
    const archivedRes = await request(
      app,
      "GET",
      "/api/teacher/courses?archived=true",
      teacherCookie,
    );
    const archived = courseListOkSchema.parse(await archivedRes.json());
    expect(archived.data.courses.map((c) => c.id)).toContain(courseId);
    expect(archived.data.courses[0]?.archived).toBe(true);

    // 非法查询参数 400
    const bad = await request(
      app,
      "GET",
      "/api/teacher/courses?archived=maybe",
      teacherCookie,
    );
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/teacher/courses/:id（详情）", () => {
  it("目录条目含资源摘要与状态标签；成员列表含归档标记", async () => {
    const { app, db, teacherCookie, courseId, lectureId } = await makeApp();
    const studentId = await addStudent(app, teacherCookie, "张三");
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    const addRes = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          { kind: "section", title: "第一周" },
          { kind: "lecture", refId: lectureId },
          { kind: "unit", refId: UNIT_ID },
        ],
        visible: true,
      },
    );
    expect(addRes.status).toBe(201);
    // 隐藏单元 + 定时讲义
    const added = (
      (await addRes.json()) as {
        data: { added: { id: string; kind: string }[] };
      }
    ).data.added;
    const unitItemId = added.find((item) => item.kind === "unit")?.id;
    const lectureItemId = added.find((item) => item.kind === "lecture")?.id;
    await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${unitItemId}`,
      teacherCookie,
      {
        visible: false,
      },
    );
    await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
      {
        publishAt: "2099-09-30T00:00:00.000Z",
      },
    );
    // 软删一个单元（无题目单元更简单：直接软删练习四？改用新建空单元）
    db.update(units)
      .set({ deletedAt: "2026-09-01T00:00:00.000Z" })
      .where(eq(units.id, UNIT_ID))
      .run();

    const res = await request(
      app,
      "GET",
      `/api/teacher/courses/${courseId}`,
      teacherCookie,
    );
    expect(res.status).toBe(200);
    const parsed = courseDetailOkSchema.parse(await res.json());
    const detail = parsed.data;
    expect(detail.name).toBe("初一上");
    expect(detail.description).toBe("有理数");
    expect(detail.members.map((m) => m.displayName)).toEqual(["张三"]);
    const statuses = detail.items.map((item) => [item.kind, item.status]);
    expect(statuses).toContainEqual(["section", "visible"]);
    expect(statuses).toContainEqual(["lecture", "scheduled"]);
    expect(statuses).toContainEqual(["unit", "deleted"]); // 软删资源优先于隐藏
    const unitItem = detail.items.find((item) => item.kind === "unit");
    expect(unitItem?.questionCount).toBe(8);
    void db;
  });

  it("课程不存在 404 COURSE_NOT_FOUND", async () => {
    const { app, teacherCookie } = await makeApp();
    const UUID = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";
    const res = await request(
      app,
      "GET",
      `/api/teacher/courses/${UUID}`,
      teacherCookie,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");
  });
});

describe("POST /api/teacher/courses/:id/items（批量添加）", () => {
  it("D8：讲义配套练习一并添加（紧跟讲义之后）", async () => {
    const { app, db, teacherCookie, courseId, lectureId } = await makeApp();
    // 讲义样例导入时按 (folderId, title) 匹配不到单元——练习样例的单元 lectureId=null，
    // 手动把 练习四 配套讲义指向样例讲义，构造 D8 场景
    db.update(units).set({ lectureId }).where(eq(units.id, UNIT_ID)).run();
    const res = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [{ kind: "lecture", refId: lectureId }],
        visible: true,
        withCompanionUnits: true,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        added: { kind: string; refId: string | null; companion: boolean }[];
        skipped: unknown[];
      };
    };
    expect(body.data.added.map((item) => [item.kind, item.refId])).toEqual([
      ["lecture", lectureId],
      ["unit", UNIT_ID],
    ]);
    expect(body.data.added[1]?.companion).toBe(true);
    expect(body.data.skipped).toEqual([]);
  });

  it("重复添加跳过且返回清单（D6 批量口径）；批内重复同样跳过", async () => {
    const { app, teacherCookie, courseId, lectureId } = await makeApp();
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [{ kind: "lecture", refId: lectureId }],
        visible: true,
      },
    );
    // 第二批：已在课程的讲义 + 批内重复的单元 + 新分节
    const res = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          { kind: "lecture", refId: lectureId },
          { kind: "unit", refId: UNIT_ID },
          { kind: "unit", refId: UNIT_ID },
          { kind: "section", title: "第一周" },
        ],
        visible: true,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        added: { kind: string; title: string }[];
        skipped: { kind: string; title: string | null; reason: string }[];
      };
    };
    // 新增 = 首个单元条目 + 分节（第二个单元是批内重复被跳过）
    expect(body.data.added.map((item) => [item.kind, item.title])).toEqual([
      ["unit", "练习四"],
      ["section", "第一周"],
    ]);
    expect(body.data.skipped).toHaveLength(2);
    expect(body.data.skipped[0]?.reason).toBe("已在本课程");
    expect(body.data.skipped[0]?.title).toBe(LECTURE_TITLE);
    expect(body.data.skipped[1]?.reason).toBe("同一次添加中重复");
    expect(body.data.skipped[1]?.title).toBe("练习四");
  });

  it("非法 body 400；资源不存在 404；visible=false 生效", async () => {
    const { app, teacherCookie, courseId, lectureId } = await makeApp();
    const bad = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [],
      },
    );
    expect(bad.status).toBe(400);

    const notFound = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          { kind: "lecture", refId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b" },
        ],
      },
    );
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as ApiErr).error).toBe("LECTURE_NOT_FOUND");

    const hidden = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      { items: [{ kind: "lecture", refId: lectureId }], visible: false },
    );
    expect(hidden.status).toBe(201);
    const body = (await hidden.json()) as {
      data: { added: { visible: boolean }[] };
    };
    expect(body.data.added[0]?.visible).toBe(false);
  });
});

describe("PUT /api/teacher/courses/:id/items/order（排序）", () => {
  it("排序持久化：详情顺序与新顺序一致；缺项 404 且原顺序保留", async () => {
    const { app, db, teacherCookie, courseId, lectureId } = await makeApp();
    const addRes = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          { kind: "section", title: "A" },
          { kind: "section", title: "B" },
          { kind: "lecture", refId: lectureId },
        ],
        visible: true,
      },
    );
    const added = (
      (await addRes.json()) as {
        data: { added: { id: string; title: string }[] };
      }
    ).data.added;
    const aId = added[0]?.id;
    const bId = added[1]?.id;
    const lId = added[2]?.id;
    if (aId === undefined || bId === undefined || lId === undefined) {
      throw new Error("排序测试前置条件不满足：目录条目不足 3 条");
    }

    // B、讲义、A 的新顺序
    const ok = await request(
      app,
      "PUT",
      `/api/teacher/courses/${courseId}/items/order`,
      teacherCookie,
      {
        ids: [bId, lId, aId],
      },
    );
    expect(ok.status).toBe(200);
    const detail = courseDetailOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(detail.data.items.map((item) => item.title)).toEqual([
      "B",
      LECTURE_TITLE,
      "A",
    ]);

    // 缺一项 → 404，顺序不变（事务回滚语义）
    const missing = await request(
      app,
      "PUT",
      `/api/teacher/courses/${courseId}/items/order`,
      teacherCookie,
      { ids: [aId, bId] },
    );
    expect(missing.status).toBe(404);
    const detail2 = courseDetailOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(detail2.data.items.map((item) => item.title)).toEqual([
      "B",
      LECTURE_TITLE,
      "A",
    ]);
    void db;
  });
});

describe("PATCH/DELETE /api/teacher/course-items/:id", () => {
  it("分节改名 / 取消定时；删除条目不动资源库", async () => {
    const { app, db, teacherCookie, courseId, lectureId } = await makeApp();
    const addRes = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          { kind: "section", title: "旧标题" },
          { kind: "lecture", refId: lectureId },
        ],
        visible: true,
      },
    );
    const added = (
      (await addRes.json()) as {
        data: { added: { id: string; kind: string }[] };
      }
    ).data.added;
    const sectionId = added.find((item) => item.kind === "section")?.id;
    const lectureItemId = added.find((item) => item.kind === "lecture")?.id;
    if (sectionId === undefined || lectureItemId === undefined) {
      throw new Error("测试前置条件不满足：分节/讲义条目缺失");
    }

    const rename = await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${sectionId}`,
      teacherCookie,
      {
        title: "新标题",
      },
    );
    expect(rename.status).toBe(200);
    expect(
      ((await rename.json()) as { data: { title: string } }).data.title,
    ).toBe("新标题");

    // 定时后取消（显式 null）
    await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
      {
        publishAt: "2099-01-01T00:00:00.000Z",
      },
    );
    const cancel = await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
      {
        publishAt: null,
      },
    );
    expect(cancel.status).toBe(200);
    expect(
      ((await cancel.json()) as { data: { publishAt: string | null } }).data
        .publishAt,
    ).toBeNull();

    // 非分节改名 422
    const badTitle = await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
      {
        title: "x",
      },
    );
    expect(badTitle.status).toBe(422);

    // 删除讲义条目：条目消失、资源保留
    const del = await request(
      app,
      "DELETE",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
    );
    expect(del.status).toBe(200);
    expect(
      db
        .select()
        .from(courseItems)
        .where(eq(courseItems.id, lectureItemId))
        .all().length,
    ).toBe(0);
    expect(
      db.select().from(lectures).where(eq(lectures.id, lectureId)).all().length,
    ).toBe(1);

    // 不存在的条目 404
    const notFound = await request(
      app,
      "DELETE",
      "/api/teacher/course-items/0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      teacherCookie,
    );
    expect(notFound.status).toBe(404);
  });
});

describe("成员（POST/DELETE /courses/:id/members）", () => {
  it("添加幂等；移出后 student-view 为空且 isMember=false", async () => {
    const { app, teacherCookie, courseId } = await makeApp();
    const studentId = await addStudent(app, teacherCookie, "张三");
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    // 幂等重复添加
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    const detail = courseDetailOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(detail.data.members).toHaveLength(1);

    await request(
      app,
      "DELETE",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    const view = courseStudentViewOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}/student-view?studentId=${studentId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(view.data.isMember).toBe(false);
    expect(view.data.items).toEqual([]);

    // 未知学生 404
    const notFound = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      { studentIds: ["0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b"] },
    );
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as ApiErr).error).toBe("STUDENT_NOT_FOUND");
  });
});

describe("GET /api/teacher/courses/:id/student-view（D5 学生可见预览）", () => {
  it("隐藏条目与未到 publishAt 的条目消失；可见条目保留", async () => {
    const { app, db, teacherCookie, courseId, lectureId } = await makeApp();
    const studentId = await addStudent(app, teacherCookie, "张三");
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    const addRes = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [
          { kind: "section", title: "第一周" },
          { kind: "lecture", refId: lectureId },
          { kind: "unit", refId: UNIT_ID },
        ],
        visible: true,
      },
    );
    const added = (
      (await addRes.json()) as {
        data: { added: { id: string; kind: string }[] };
      }
    ).data.added;
    // 隐藏单元；讲义定时到 2099（未到点）
    const unitItemId = added.find((item) => item.kind === "unit")?.id;
    const lectureItemId = added.find((item) => item.kind === "lecture")?.id;
    await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${unitItemId}`,
      teacherCookie,
      {
        visible: false,
      },
    );
    await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
      {
        publishAt: "2099-09-30T00:00:00.000Z",
      },
    );

    const view = courseStudentViewOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}/student-view?studentId=${studentId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(view.data.isMember).toBe(true);
    expect(view.data.courseArchived).toBe(false);
    // 只剩分节（隐藏单元与定时讲义都不出现，D5 条件 3）
    expect(view.data.items.map((item) => item.kind)).toEqual(["section"]);
    expect(view.data.items[0]?.title).toBe("第一周");

    // 到点后讲义出现（publishAt 设为过去）
    await request(
      app,
      "PATCH",
      `/api/teacher/course-items/${lectureItemId}`,
      teacherCookie,
      {
        publishAt: "2000-01-01T00:00:00.000Z",
      },
    );
    const view2 = courseStudentViewOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}/student-view?studentId=${studentId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(view2.data.items.map((item) => item.kind)).toEqual([
      "section",
      "lecture",
    ]);
    void db;
  });

  it("归档课程后成员可见目录为空（D4/D5 条件 2）", async () => {
    const { app, teacherCookie, courseId } = await makeApp();
    const studentId = await addStudent(app, teacherCookie, "张三");
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    await request(
      app,
      "PATCH",
      `/api/teacher/courses/${courseId}`,
      teacherCookie,
      {
        archived: true,
      },
    );
    const view = courseStudentViewOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}/student-view?studentId=${studentId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(view.data.courseArchived).toBe(true);
    expect(view.data.items).toEqual([]);
  });

  it("缺 studentId → 400；课程不存在 → 404", async () => {
    const { app, teacherCookie, courseId } = await makeApp();
    const bad = await request(
      app,
      "GET",
      `/api/teacher/courses/${courseId}/student-view`,
      teacherCookie,
    );
    expect(bad.status).toBe(400);
    const notFound = await request(
      app,
      "GET",
      "/api/teacher/courses/0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b/student-view?studentId=1b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      teacherCookie,
    );
    expect(notFound.status).toBe(404);
  });
});

describe("D4：课程删除", () => {
  it("有作答的课程删除 409 COURSE_HAS_ATTEMPTS；无作答删除成功且成员/条目清理", async () => {
    const { app, db, teacherCookie, courseId } = await makeApp();
    const studentId = await addStudent(app, teacherCookie, "张三");
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/members`,
      teacherCookie,
      {
        studentIds: [studentId],
      },
    );
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseId}/items`,
      teacherCookie,
      {
        items: [{ kind: "unit", refId: UNIT_ID }],
        visible: true,
      },
    );

    // 未有作答前：详情 hasAttempts=false
    let detail = courseDetailOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(detail.data.hasAttempts).toBe(false);

    // 插入一条针对 练习四 的作答（现状口径：条目引用单元的任何 attempt 都算）
    const assignmentId = crypto.randomUUID();
    db.insert(assignments)
      .values({
        id: assignmentId,
        unitId: UNIT_ID,
        title: "练习四作业",
        createdAt: "2026-09-01T00:00:00.000Z",
      })
      .run();
    db.insert(attempts)
      .values({
        id: crypto.randomUUID(),
        studentId,
        assignmentId,
        unitId: UNIT_ID,
        status: "submitted",
        startedAt: "2026-09-01T00:00:00.000Z",
        submittedAt: "2026-09-01T01:00:00.000Z",
      })
      .run();

    detail = courseDetailOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          `/api/teacher/courses/${courseId}`,
          teacherCookie,
        )
      ).json(),
    );
    expect(detail.data.hasAttempts).toBe(true);

    const refused = await request(
      app,
      "DELETE",
      `/api/teacher/courses/${courseId}`,
      teacherCookie,
    );
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ApiErr;
    expect(body.error).toBe("COURSE_HAS_ATTEMPTS");
    expect(body.message).toContain("归档");

    // 无作答的课程（新建空课）删除成功
    const createRes = await request(
      app,
      "POST",
      "/api/teacher/courses",
      teacherCookie,
      {
        title: "临时课",
      },
    );
    const tempId = ((await createRes.json()) as { data: { id: string } }).data
      .id;
    const del = await request(
      app,
      "DELETE",
      `/api/teacher/courses/${tempId}`,
      teacherCookie,
    );
    expect(del.status).toBe(200);
    expect(
      db.select().from(courses).where(eq(courses.id, tempId)).all().length,
    ).toBe(0);
    expect(
      db
        .select()
        .from(courseStudents)
        .where(eq(courseStudents.courseId, tempId))
        .all().length,
    ).toBe(0);
    expect(
      db
        .select()
        .from(courseItems)
        .where(eq(courseItems.courseId, tempId))
        .all().length,
    ).toBe(0);
  });
});
