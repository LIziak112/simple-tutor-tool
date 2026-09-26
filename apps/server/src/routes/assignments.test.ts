import type { ApiErr } from "@tutor/contract";
import {
  apiErrSchema,
  assignmentCreateOkSchema,
  studentAssignmentListOkSchema,
  teacherAssignmentListOkSchema,
} from "@tutor/contract";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import { assignments, questions } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import {
  type AssignmentAttemptSummary,
  computeAssignmentStatus,
} from "../services/assignment-service.ts";

/**
 * 作业接口集成测试（T2.2 验收项，app.request() 直调路由 + 内存库）：
 * - 学生只能看到指派给自己的作业（验收项 1）；
 * - 删除作业 = 软删：教师列表默认不显示、学生端不可见、库行保留（验收项 2 的
 *   「作业标记删除」部分；「作答保留」需 attempts 表，T2.6 建表后回归验证）；
 * - 创建校验（unitId 不存在 / studentIds 为空 / dueAt 非 UTC / 未知学生）；
 * - PATCH 全量替换名单后学生端可见性随之变化；
 * - 学生接口无教师侧字段泄露（AGENTS.md 第 3 条；T2.4 起换用通用 assertNoLeak）；
 * - 会话隔离：未登录 / 教师会话访问学生作业接口 401，学生会话访问教师作业接口 401；
 * - computeAssignmentStatus 纯函数四状态与优先级。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";
const STUDENT_PASSWORD = "stu-pass-6";
/** 合法 UTC 截止时间（契约要求带 Z 后缀） */
const DUE_AT = "2026-10-01T12:00:00.000Z";

/** 最小可导入练习文档：1 个单元、1 道带答案的填空题（泄露测试需库里真实存在答案） */
const PRACTICE_MD = `---
kind: practice
unit: 一元一次方程
topic: 方程
---

::::question{type=fill difficulty=2}
解方程 $x+1=3$，则 $x=$ [[2]]
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
  });
  const setup = await request(app, "/api/public/teacher/setup", {
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
  method: "POST" | "PATCH" = "POST",
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

/** 导入最小练习文档，返回单元 id（= frontmatter unit，来自 DSL） */
async function importUnit(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  unit = "一元一次方程",
): Promise<string> {
  const res = await request(
    app,
    "/api/teacher/import/commit",
    {
      markdown: PRACTICE_MD.replace("一元一次方程", unit),
      filename: "练习.md",
    },
    teacherCookie,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { units: { id: string }[] } };
  const unitId = body.data.units[0]?.id;
  if (!unitId) throw new Error("导入未产出单元");
  return unitId;
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

/** 教师作业列表 */
async function teacherList(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  includeDeleted = false,
): Promise<Record<string, unknown>[]> {
  const res = await app.request(
    includeDeleted
      ? "/api/teacher/assignments?includeDeleted=true"
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

/**
 * 递归断言响应体不含教师侧字段（AGENTS.md 第 3 条泄露测试的 T2.2 本地实现；
 * T2.4 提供通用 assertNoLeak 后统一切换）。
 */
function assertNoTeacherSideFields(value: unknown): void {
  const forbidden = /^answers?$|^solution|^hint|^stem|^options|^sourceMd$/i;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        expect(forbidden.test(key), `学生端响应出现教师侧字段：${key}`).toBe(
          false,
        );
        walk(child);
      }
    }
  };
  walk(value);
}

describe("教师布置作业：POST /api/teacher/assignments", () => {
  it("创建成功：201 + 契约壳；title 缺省用单元标题；dueAt 原样存 UTC；学生名单按姓名排序", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "王五");
    const bId = await createStudent(app, teacherCookie, "张三");

    const data = await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [aId, bId, aId],
      dueAt: DUE_AT,
    });
    expect(assignmentCreateOkSchema.safeParse({ ok: true, data }).success).toBe(
      true,
    );
    expect(data.title).toBe("一元一次方程");
    expect(data.unitTitle).toBe("一元一次方程");
    expect(data.dueAt).toBe(DUE_AT);
    expect(data.questionCount).toBe(1);
    // 重复 studentIds 去重；名单按姓名排序（展示口径稳定）
    expect(data.students).toEqual([
      { id: bId, displayName: "张三" },
      { id: aId, displayName: "王五" },
    ]);
    expect(data.deleted).toBe(false);
  });

  it("unitId 不存在返回 404 UNIT_NOT_FOUND", async () => {
    const { app, teacherCookie } = await makeApp();
    const aId = await createStudent(app, teacherCookie, "张三");
    const res = await request(
      app,
      "/api/teacher/assignments",
      { unitId: "no-such-unit", studentIds: [aId] },
      teacherCookie,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("UNIT_NOT_FOUND");
    expect(apiErrSchema.safeParse(body).success).toBe(true);
  });

  it("studentIds 为空数组返回 400 且提示「至少指派一名学生」", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const res = await request(
      app,
      "/api/teacher/assignments",
      { unitId, studentIds: [] },
      teacherCookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErr;
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("至少指派一名学生");
  });

  it("studentIds 含未知学生返回 404 STUDENT_NOT_FOUND", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const res = await request(
      app,
      "/api/teacher/assignments",
      {
        unitId,
        studentIds: ["99999999-9999-4999-8999-999999999999"],
      },
      teacherCookie,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("STUDENT_NOT_FOUND");
  });

  it("dueAt 非 UTC ISO（datetime-local 原始值 / +08:00 偏移）返回 400", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");

    const local = await request(
      app,
      "/api/teacher/assignments",
      { unitId, studentIds: [aId], dueAt: "2026-10-01T20:00" },
      teacherCookie,
    );
    expect(local.status).toBe(400);
    expect(((await local.json()) as ApiErr).error).toBe("VALIDATION_ERROR");

    const offset = await request(
      app,
      "/api/teacher/assignments",
      { unitId, studentIds: [aId], dueAt: "2026-10-01T20:00:00+08:00" },
      teacherCookie,
    );
    expect(offset.status).toBe(400);
  });
});

describe("学生可见性（验收项 1：学生只能看到指派给自己的作业）", () => {
  it("学生 A 看不到指派给学生 B 的作业；各自只看到自己的", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const bId = await createStudent(app, teacherCookie, "李四");

    await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [bId],
      title: "给李四的作业",
    });
    await createAssignment(app, teacherCookie, {
      unitId,
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

    // 响应符合契约壳；条目附状态（T2.2 内恒为 not_started，T2.6 接 attempts 后补全）
    expect(aList[0]?.status).toBe("not_started");
    expect(aList[0]?.questionCount).toBe(1);
    expect(aList[0]?.topic).toBe("方程");
  });

  it("PATCH 全量替换名单后：新学生立即可见、移出的学生立即不可见", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const bId = await createStudent(app, teacherCookie, "李四");

    const created = await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [aId],
    });
    const id = created.id as string;

    const aCookie = await loginStudent(app, "张三");
    const bCookie = await loginStudent(app, "李四");
    expect((await studentList(app, aCookie)).length).toBe(1);
    expect((await studentList(app, bCookie)).length).toBe(0);

    const patch = await request(
      app,
      `/api/teacher/assignments/${id}`,
      { studentIds: [bId] },
      teacherCookie,
      "PATCH",
    );
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { data: Record<string, unknown> }).data.students,
    ).toEqual([{ id: bId, displayName: "李四" }]);

    expect((await studentList(app, aCookie)).length).toBe(0);
    expect((await studentList(app, bCookie)).length).toBe(1);
  });
});

describe("删除作业 = 软删（验收项 2：「作业标记删除」；作答保留在 T2.6 回归）", () => {
  it("DELETE 后：教师默认列表不显示、includeDeleted=true 可见并带标记；学生端立即不可见", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [aId],
    });
    const id = created.id as string;

    const del = await app.request(`/api/teacher/assignments/${id}`, {
      method: "DELETE",
      headers: { cookie: teacherCookie },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { data: unknown }).data).toBeNull();

    // 教师默认列表不显示
    expect((await teacherList(app, teacherCookie)).length).toBe(0);
    // includeDeleted=true 可见且 deleted=true
    const withDeleted = await teacherList(app, teacherCookie, true);
    expect(withDeleted.length).toBe(1);
    expect(withDeleted[0]?.deleted).toBe(true);
    expect(typeof withDeleted[0]?.deletedAt).toBe("string");

    // 学生端立即不可见
    const aCookie = await loginStudent(app, "张三");
    expect((await studentList(app, aCookie)).length).toBe(0);

    // 「作业标记删除」：库行保留（软删），未物理 DELETE——
    // 「作答保留」的完整回归（attempts.responses 不受影响）在 T2.6 建 attempts 表后进行。
    const rows = db.select().from(assignments).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.deletedAt).not.toBeNull();
  });

  it("重复删除幂等成功；对已删除作业 PATCH 返回 404", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitId,
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

    const patch = await request(
      app,
      `/api/teacher/assignments/${id}`,
      { title: "改不动" },
      teacherCookie,
      "PATCH",
    );
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

describe("教师列表与 PATCH", () => {
  it("列表符合契约壳；多份作业按布置时间倒序", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [aId],
      title: "第一份",
    });
    await createAssignment(app, teacherCookie, {
      unitId,
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

  it("PATCH 改标题与截止；dueAt 显式 null = 取消截止", async () => {
    const { app, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    const aId = await createStudent(app, teacherCookie, "张三");
    const created = await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [aId],
      dueAt: DUE_AT,
    });
    const id = created.id as string;

    const retitled = await request(
      app,
      `/api/teacher/assignments/${id}`,
      { title: "周末加练", dueAt: "2026-10-08T04:00:00.000Z" },
      teacherCookie,
      "PATCH",
    );
    expect(retitled.status).toBe(200);
    const retitledData = (await retitled.json()) as {
      data: { title: string; dueAt: string };
    };
    expect(retitledData.data.title).toBe("周末加练");
    expect(retitledData.data.dueAt).toBe("2026-10-08T04:00:00.000Z");

    const cleared = await request(
      app,
      `/api/teacher/assignments/${id}`,
      { dueAt: null },
      teacherCookie,
      "PATCH",
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { data: { dueAt: unknown } }).data.dueAt,
    ).toBeNull();
  });

  it("PATCH 目标不存在返回 404；查询参数非法返回 400", async () => {
    const { app, teacherCookie } = await makeApp();
    const patch = await request(
      app,
      "/api/teacher/assignments/not-exist",
      { title: "新标题" },
      teacherCookie,
      "PATCH",
    );
    expect(patch.status).toBe(404);
    expect(((await patch.json()) as ApiErr).error).toBe("ASSIGNMENT_NOT_FOUND");

    const query = await app.request(
      "/api/teacher/assignments?includeDeleted=abc",
      { headers: { cookie: teacherCookie } },
    );
    expect(query.status).toBe(400);
  });
});

describe("学生端无泄露（AGENTS.md 第 3 条）", () => {
  it("作业列表只含公开元信息：无 answers/solution/hints/stem/options 等教师侧字段", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const unitId = await importUnit(app, teacherCookie);
    // 前置：库里确实存在带答案的题目（泄露才是有意义的风险）
    expect(
      db
        .select()
        .from(questions)
        .all()
        .some((q) => q.answersJson != null),
    ).toBe(true);

    const aId = await createStudent(app, teacherCookie, "张三");
    await createAssignment(app, teacherCookie, {
      unitId,
      studentIds: [aId],
    });

    const aCookie = await loginStudent(app, "张三");
    const res = await studentListRes(app, aCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(studentAssignmentListOkSchema.safeParse(body).success).toBe(true);
    assertNoTeacherSideFields(body);
    // 确认拿到的是完整数据（而非空列表导致「碰巧不泄露」）
    const list = (body as { data: { assignments: unknown[] } }).data
      .assignments;
    expect(list.length).toBe(1);
  });
});

describe("会话隔离", () => {
  it("未登录访问教师/学生作业接口均 401", async () => {
    const { app } = await makeApp();
    const list = await app.request("/api/teacher/assignments");
    expect(list.status).toBe(401);
    const post = await request(app, "/api/teacher/assignments", {
      unitId: "x",
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
      { unitId: "x", studentIds: [] },
      studentCookie,
    );
    expect(post.status).toBe(401);
  });
});

describe("computeAssignmentStatus 纯函数（T2.2 恒 not_started；T2.6 接入后按记录计算）", () => {
  const assignment = { id: "a1", dueAt: null as string | null };

  function withAttempts(statuses: AssignmentAttemptSummary["status"][]) {
    return computeAssignmentStatus(
      assignment,
      statuses.map((status) => ({ status })),
    );
  }

  it("无作答记录 → not_started（T2.2 现状：所有作业均为该状态）", () => {
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
