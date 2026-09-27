import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  studentCourseDetailOkSchema,
  studentCourseListOkSchema,
  studentLectureDetailOkSchema,
  studentLectureListOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { createTestDb, createTestDir } from "../db/test-utils";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * T2A.5 学生端课程与讲义接口集成测试（app.request() 直调路由 + 内存库）：
 * 越权测试矩阵（D22）：非成员 403、课程归档 403、隐藏条目 404、未到 publishAt 404、
 * 资源软删 404、移出成员后立即 403；正常路径的契约解析与 assertNoLeak 泄露断言
 * （新接口只含目录与讲义元信息，不得出现任何题目侧字段，AGENTS.md 第 3 条）。
 * publishAt 到点的精确边界（可注入时钟）在
 * src/services/student-course-service.test.ts 覆盖；此处 API 层用过去/远未来时间。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";

/** 讲义样例原文（两篇讲义：第1讲 有理数 / 第2讲 数轴；兼容性回归夹具） */
const LECTURE_MD = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

/** 关联第1讲的练习单元（units.lectureId 命中 + topic，供 D8 配套练习验证） */
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

/** 测试环境：应用 + 教师 Cookie + 成员/非成员两个学生 Cookie + 课程 id */
interface TestEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
  memberCookie: string;
  outsiderCookie: string;
  courseId: string;
  memberStudentId: string;
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

/** 建学生并密码登录，返回 { studentId, cookie } */
async function createStudentAndLogin(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  displayName: string,
): Promise<{ studentId: string; cookie: string }> {
  const create = await app.request("/api/teacher/students", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      displayName,
      loginName: displayName,
      password: STUDENT_PASSWORD,
    }),
  });
  expect(create.status).toBe(201);
  const created = (await create.json()) as { data: { student: { id: string } } };
  const login = await app.request("/api/public/student/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginName: displayName, password: STUDENT_PASSWORD }),
  });
  expect(login.status).toBe(200);
  return {
    studentId: created.data.student.id,
    cookie: `tutor_session=${extractSessionToken(login)}`,
  };
}

/**
 * 组装被测环境：教师 + 课程 + 讲义样例导入（courseId 兼容路径：讲义条目可见、
 * 单元条目隐藏）+ 两名学生（成员/非成员）。importLinkedPractice=true 时再导入
 * 关联第1讲的练习单元（默认隐藏，测试内按需用教师接口放开可见性）。
 */
async function makeEnv(options?: {
  courseTitle?: string;
  importLinkedPractice?: boolean;
}): Promise<TestEnv> {
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
    body: JSON.stringify({
      title: options?.courseTitle ?? "初一上",
      description: "有理数入门",
    }),
  });
  expect(created.status).toBe(201);
  const courseId = ((await created.json()) as { data: { id: string } }).data.id;

  const imported = await app.request("/api/teacher/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({
      markdown: LECTURE_MD,
      filename: "讲义样例.md",
      courseId,
    }),
  });
  expect(imported.status).toBe(200);
  if (options?.importLinkedPractice === true) {
    const linked = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({
        markdown: LINKED_PRACTICE_MD,
        filename: "有理数小练.md",
        courseId,
      }),
    });
    expect(linked.status).toBe(200);
  }

  const member = await createStudentAndLogin(app, teacherCookie, "成员张三");
  const outsider = await createStudentAndLogin(app, teacherCookie, "非成员李四");
  const added = await app.request(`/api/teacher/courses/${courseId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ studentIds: [member.studentId] }),
  });
  expect(added.status).toBe(200);

  return {
    app,
    db,
    teacherCookie,
    memberCookie: member.cookie,
    outsiderCookie: outsider.cookie,
    courseId,
    memberStudentId: member.studentId,
  };
}

/**
 * 新接口的泄露断言：通用禁用集合之外，额外不得出现任何题目侧字段
 * （stemMd/optionsJson/questions——题目本体只经作业 paper 接口下发）。
 */
function assertNoQuestionFields(body: unknown): void {
  assertNoLeak(body, { forbid: ["stemMd", "optionsJson", "questions"] });
}

/** 教师侧读取课程详情，返回目录条目（id/kind/refId/title） */
async function teacherItems(
  env: TestEnv,
): Promise<
  { id: string; kind: string; refId: string | null; title: string }[]
> {
  const res = await env.app.request(
    `/api/teacher/courses/${env.courseId}`,
    { headers: { cookie: env.teacherCookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      items: {
        id: string;
        kind: string;
        refId: string | null;
        title: string;
      }[];
    };
  };
  return body.data.items;
}

/** 教师修改目录条目（visible / publishAt） */
async function patchItem(
  env: TestEnv,
  itemId: string,
  body: { visible?: boolean; publishAt?: string | null },
): Promise<void> {
  const res = await env.app.request(`/api/teacher/course-items/${itemId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: env.teacherCookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

describe("T2A.5 学生端课程与讲义：未登录与会话隔离", () => {
  it("四个学生端课程/讲义接口未登录 401", async () => {
    const { app } = await makeEnv();
    for (const path of [
      "/api/student/courses",
      `/api/student/courses/${crypto.randomUUID()}`,
      "/api/student/lectures",
      `/api/student/lectures/${crypto.randomUUID()}`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      const body = (await res.json()) as ApiErr;
      expect(body.error).toBe("UNAUTHORIZED");
    }
  });

  it("教师会话访问学生端接口 401（会话类型隔离）", async () => {
    const { app, teacherCookie } = await makeEnv();
    for (const path of ["/api/student/courses", "/api/student/lectures"]) {
      const res = await app.request(path, {
        headers: { cookie: teacherCookie },
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("GET /api/student/courses（我的课程）", () => {
  it("未加入课程时空列表（结构符合契约 + 无泄露）", async () => {
    const { app, outsiderCookie } = await makeEnv();
    const res = await app.request("/api/student/courses", {
      headers: { cookie: outsiderCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentCourseListOkSchema.safeParse(body).success).toBe(true);
    expect((body as { data: { courses: unknown[] } }).data.courses).toEqual([]);
    assertNoQuestionFields(body);
  });

  it("成员：课程卡片数据（可见计数、completedUnitCount=0、描述）+ 无泄露", async () => {
    const { app, memberCookie, courseId } = await makeEnv();
    const res = await app.request("/api/student/courses", {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        courses: {
          id: string;
          name: string;
          description: string | null;
          visibleLectureCount: number;
          visibleUnitCount: number;
          completedUnitCount: number;
        }[];
      };
    };
    expect(studentCourseListOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.courses).toEqual([
      {
        id: courseId,
        name: "初一上",
        description: "有理数入门",
        visibleLectureCount: 2, // 讲义样例两讲（courseId 导入路径讲义可见）
        visibleUnitCount: 0, // 未导入单元；导入的单元条目默认隐藏（T2A.1 口径）
        completedUnitCount: 0,
      },
    ]);
    assertNoQuestionFields(body);
  });

  it("归档课程从列表消失（D4/D5）", async () => {
    const { app, memberCookie, teacherCookie, courseId } = await makeEnv();
    const archived = await app.request(`/api/teacher/courses/${courseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    const res = await app.request("/api/student/courses", {
      headers: { cookie: memberCookie },
    });
    const body = (await res.json()) as { data: { courses: unknown[] } };
    expect(body.data.courses).toEqual([]);
  });
});

describe("GET /api/student/courses/:id（课程可见目录，D22 越权矩阵）", () => {
  it("非成员 403 COURSE_ACCESS_DENIED（统一错误壳）", async () => {
    const { app, outsiderCookie, courseId } = await makeEnv();
    const res = await app.request(`/api/student/courses/${courseId}`, {
      headers: { cookie: outsiderCookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("COURSE_ACCESS_DENIED");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("课程归档 403 COURSE_ACCESS_DENIED（成员也不可访问）", async () => {
    const { app, memberCookie, teacherCookie, courseId } = await makeEnv();
    await app.request(`/api/teacher/courses/${courseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ archived: true }),
    });
    const res = await app.request(`/api/student/courses/${courseId}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErr).error).toBe("COURSE_ACCESS_DENIED");
  });

  it("课程不存在 404 NOT_FOUND（不暴露存在性）", async () => {
    const { app, memberCookie } = await makeEnv();
    const res = await app.request(
      `/api/student/courses/${crypto.randomUUID()}`,
      { headers: { cookie: memberCookie } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("NOT_FOUND");
  });

  it("成员：目录只含可见条目；隐藏讲义后条目消失、计数同步 + 无泄露", async () => {
    const env = await makeEnv();
    const { app, memberCookie, courseId } = env;

    const before = await app.request(`/api/student/courses/${courseId}`, {
      headers: { cookie: memberCookie },
    });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      data: { items: { kind: string; title: string }[] };
    };
    expect(studentCourseDetailOkSchema.safeParse(beforeBody).success).toBe(
      true,
    );
    expect(beforeBody.data.items.map((i) => i.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    assertNoQuestionFields(beforeBody);

    // 教师隐藏第2讲 → 学生目录与课程卡片计数立即零信息
    const items = await teacherItems(env);
    const lecture2 = items.find((item) => item.title === "第2讲 数轴");
    expect(lecture2).toBeDefined();
    await patchItem(env, lecture2?.id as string, { visible: false });

    const after = await app.request(`/api/student/courses/${courseId}`, {
      headers: { cookie: memberCookie },
    });
    const afterBody = (await after.json()) as {
      data: { items: { title: string }[] };
    };
    expect(afterBody.data.items.map((i) => i.title)).toEqual(["第1讲 有理数"]);
    assertNoQuestionFields(afterBody);

    const listBody = (await (
      await app.request("/api/student/courses", {
        headers: { cookie: memberCookie },
      })
    ).json()) as {
      data: { courses: { visibleLectureCount: number }[] };
    };
    expect(listBody.data.courses[0]?.visibleLectureCount).toBe(1);
  });

  it("移出成员后立即 403（D7 验收项）", async () => {
    const env = await makeEnv();
    const { app, memberCookie, teacherCookie, courseId, memberStudentId } = env;
    const removed = await app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie: teacherCookie },
        body: JSON.stringify({ studentIds: [memberStudentId] }),
      },
    );
    expect(removed.status).toBe(200);
    const res = await app.request(`/api/student/courses/${courseId}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ApiErr).error).toBe("COURSE_ACCESS_DENIED");
  });
});

describe("GET /api/student/lectures（可见讲义双视图）", () => {
  it("非成员空双视图（不再有「全部讲义对所有学生可见」——核心切换）", async () => {
    const { app, outsiderCookie } = await makeEnv();
    const res = await app.request("/api/student/lectures", {
      headers: { cookie: outsiderCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentLectureListOkSchema.safeParse(body).success).toBe(true);
    const data = (body as { data: { lectures: unknown[]; courses: unknown[] } })
      .data;
    expect(data.lectures).toEqual([]);
    expect(data.courses).toEqual([]);
    assertNoQuestionFields(body);
  });

  it("成员：分组视图含课程名；隐藏讲义后立即消失 + 无泄露", async () => {
    const env = await makeEnv();
    const { app, memberCookie, courseId } = env;

    const before = (await (
      await app.request("/api/student/lectures", {
        headers: { cookie: memberCookie },
      })
    ).json()) as {
      data: {
        lectures: { title: string }[];
        courses: { courseId: string; courseName: string; lectures: unknown[] }[];
      };
    };
    expect(studentLectureListOkSchema.safeParse(before).success).toBe(true);
    expect(before.data.lectures.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    expect(before.data.courses).toHaveLength(1);
    expect(before.data.courses[0]?.courseId).toBe(courseId);
    expect(before.data.courses[0]?.courseName).toBe("初一上");
    assertNoQuestionFields(before);

    const items = await teacherItems(env);
    await patchItem(
      env,
      items.find((item) => item.title === "第1讲 有理数")?.id as string,
      { visible: false },
    );
    const after = (await (
      await app.request("/api/student/lectures", {
        headers: { cookie: memberCookie },
      })
    ).json()) as {
      data: { lectures: { title: string }[]; courses: { lectures: unknown[] }[] };
    };
    expect(after.data.lectures.map((l) => l.title)).toEqual(["第2讲 数轴"]);
    assertNoQuestionFields(after);
  });
});

describe("GET /api/student/lectures/:id（讲义详情 + D8 配套练习）", () => {
  it("缺省 courseId：成员取到全文 + 课程上下文；配套练习默认空（单元隐藏）+ 无泄露", async () => {
    const env = await makeEnv({ importLinkedPractice: true });
    const { app, memberCookie, courseId } = env;
    const items = await teacherItems(env);
    const lecture1RefId = items.find(
      (item) => item.title === "第1讲 有理数",
    )?.refId as string;

    const res = await app.request(`/api/student/lectures/${lecture1RefId}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        title: string;
        markdown: string;
        courseId: string;
        courseName: string;
        companionUnits: unknown[];
      };
    };
    expect(studentLectureDetailOkSchema.safeParse(body).success).toBe(true);
    expect(body.data.title).toBe("第1讲 有理数");
    expect(body.data.markdown).toContain("# 第1讲 有理数");
    expect(body.data.courseId).toBe(courseId);
    expect(body.data.courseName).toBe("初一上");
    // 配套单元「有理数小练」条目默认隐藏（导入兼容口径）→ 不出现（零信息）
    expect(body.data.companionUnits).toEqual([]);
    assertNoQuestionFields(body);

    // 教师放开配套单元可见 → 详情立即返回（id/标题/题数，「即将开放」语义）
    const unitItem = items.find((item) => item.title === "有理数小练");
    expect(unitItem).toBeDefined();
    await patchItem(env, unitItem?.id as string, { visible: true });
    const after = (await (
      await app.request(`/api/student/lectures/${lecture1RefId}`, {
        headers: { cookie: memberCookie },
      })
    ).json()) as {
      data: {
        companionUnits: { id: string; title: string; questionCount: number }[];
      };
    };
    expect(after.data.companionUnits).toEqual([
      { id: "有理数小练", title: "有理数小练", questionCount: 1 },
    ]);
    // 题目本体字段仍不下发（题数只是计数）
    assertNoQuestionFields(after);
  });

  it("隐藏条目 404 NOT_FOUND（D22 验收项）", async () => {
    const env = await makeEnv();
    const { app, memberCookie, courseId } = env;
    const items = await teacherItems(env);
    const lecture1 = items.find((item) => item.title === "第1讲 有理数");
    await patchItem(env, lecture1?.id as string, { visible: false });
    const res = await app.request(
      `/api/student/lectures/${lecture1?.refId}?courseId=${courseId}`,
      { headers: { cookie: memberCookie } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("NOT_FOUND");
  });

  it("未到 publishAt 404、已过 publishAt 200（API 层；边界见服务层时钟测试）", async () => {
    const env = await makeEnv();
    const { app, memberCookie, courseId } = env;
    const items = await teacherItems(env);
    const lecture1 = items.find((item) => item.title === "第1讲 有理数");

    // 远未来定时 → 404（不暴露存在性）
    await patchItem(env, lecture1?.id as string, {
      publishAt: "2099-01-01T00:00:00.000Z",
    });
    const future = await app.request(
      `/api/student/lectures/${lecture1?.refId}?courseId=${courseId}`,
      { headers: { cookie: memberCookie } },
    );
    expect(future.status).toBe(404);
    expect(((await future.json()) as ApiErr).error).toBe("NOT_FOUND");

    // 过去时间 → 200
    await patchItem(env, lecture1?.id as string, {
      publishAt: "2000-01-01T00:00:00.000Z",
    });
    const past = await app.request(
      `/api/student/lectures/${lecture1?.refId}?courseId=${courseId}`,
      { headers: { cookie: memberCookie } },
    );
    expect(past.status).toBe(200);
  });

  it("资源软删 404：教师删除讲义后学生详情 404、列表消失（D22 验收项）", async () => {
    const env = await makeEnv();
    const { app, memberCookie, teacherCookie, courseId } = env;
    const items = await teacherItems(env);
    const lecture1RefId = items.find(
      (item) => item.title === "第1讲 有理数",
    )?.refId as string;

    const del = await app.request(`/api/teacher/lectures/${lecture1RefId}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);

    const detail = await app.request(
      `/api/student/lectures/${lecture1RefId}?courseId=${courseId}`,
      { headers: { cookie: memberCookie } },
    );
    expect(detail.status).toBe(404);
    expect(((await detail.json()) as ApiErr).error).toBe("NOT_FOUND");

    const list = (await (
      await app.request("/api/student/lectures", {
        headers: { cookie: memberCookie },
      })
    ).json()) as { data: { lectures: { title: string }[] } };
    expect(list.data.lectures.map((l) => l.title)).toEqual(["第2讲 数轴"]);
  });

  it("?courseId 越权：非成员 403、课程不存在 404、非 UUID 400；移出成员后 403", async () => {
    const env = await makeEnv();
    const { app, memberCookie, outsiderCookie, courseId } = env;
    const items = await teacherItems(env);
    const lecture1RefId = items.find(
      (item) => item.title === "第1讲 有理数",
    )?.refId as string;

    const outsider = await app.request(
      `/api/student/lectures/${lecture1RefId}?courseId=${courseId}`,
      { headers: { cookie: outsiderCookie } },
    );
    expect(outsider.status).toBe(403);
    expect(((await outsider.json()) as ApiErr).error).toBe(
      "COURSE_ACCESS_DENIED",
    );

    const missingCourse = await app.request(
      `/api/student/lectures/${lecture1RefId}?courseId=${crypto.randomUUID()}`,
      { headers: { cookie: memberCookie } },
    );
    expect(missingCourse.status).toBe(404);
    expect(((await missingCourse.json()) as ApiErr).error).toBe("NOT_FOUND");

    const badQuery = await app.request(
      `/api/student/lectures/${lecture1RefId}?courseId=not-uuid`,
      { headers: { cookie: memberCookie } },
    );
    expect(badQuery.status).toBe(400);
    expect(((await badQuery.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    // 移出成员后带 courseId 访问立即 403（D7）
    const removed = await app.request(
      `/api/teacher/courses/${courseId}/members`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie: env.teacherCookie },
        body: JSON.stringify({ studentIds: [env.memberStudentId] }),
      },
    );
    expect(removed.status).toBe(200);
    const afterRemoval = await app.request(
      `/api/student/lectures/${lecture1RefId}?courseId=${courseId}`,
      { headers: { cookie: memberCookie } },
    );
    expect(afterRemoval.status).toBe(403);
    expect(((await afterRemoval.json()) as ApiErr).error).toBe(
      "COURSE_ACCESS_DENIED",
    );
  });

  it("非成员（不带 courseId）访问存在的讲义 404（不暴露存在性）", async () => {
    const env = await makeEnv();
    const { app, outsiderCookie } = env;
    const items = await teacherItems(env);
    const lecture1RefId = items.find(
      (item) => item.title === "第1讲 有理数",
    )?.refId as string;
    const res = await app.request(`/api/student/lectures/${lecture1RefId}`, {
      headers: { cookie: outsiderCookie },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("NOT_FOUND");
  });
});
