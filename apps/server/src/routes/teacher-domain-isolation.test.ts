import { readFileSync } from "node:fs";
import type { ApiErr } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createTeacherSession } from "../auth/session.ts";
import type { Db } from "../db/client.ts";
import {
  courseItems,
  courses,
  knowledgePoints,
  questions,
  teachers,
  units,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";

/**
 * T2B.3 隔离红线测试矩阵（§0.2：教师乙访问教师甲资源 → 404 或列表为空；
 * 列表类断言不含对方任何信息，含数量）。
 *
 * 覆盖（对照 T2B.3 验收逐条）：
 * - 列表：folders / lectures / units / 回收站——乙视角数量为 0，不含甲任何信息；
 * - 详情 / 编辑 / 软删 / 恢复 / 彻底删除 / 导出 / usage：乙按甲的 id 访问 → 404；
 * - 批量操作：乙的 batch 引甲的单元/文件夹/课程 → 单条 NOT_FOUND 或整体 404，
 *   不写任何行；
 * - 排序：乙 reorder 引甲的单元/题目 id → 404；
 * - 导入：乙 preview 与甲同 dslId 文件 → 动作全为 createUnit（域内匹配不到甲的
 *   单元）；乙 commit → 乙域内新增独立单元；甲的单元题数与各题 version 不变；
 *   考点为公共数据按名称全局合并（knowledge_points 不重复建行）；
 * - 越权参数：乙 commit / preview 带甲的 folderId / courseId → 404；
 * - 批次回看：乙查甲的 batchId → 空 files。
 *
 * 夹具：甲 = setup 创建的存量管理员（TEST_TEACHER_ID 行）；乙 = 直插教师行 +
 * createTeacherSession 伪造会话（第二位教师的出现入口 T2B.6 才有，测试用直插
 * 模拟多教师库形态）。
 */

const silentLogger: Logger = pino({ enabled: false });
const TEACHER_PASSWORD = "teacher-pass-8";

const PRACTICE_MD = readFileSync(
  new URL("../../../../samples/v2/练习样例.md", import.meta.url),
  "utf8",
);
const LECTURE_MD = readFileSync(
  new URL("../../../../samples/v2/讲义样例.md", import.meta.url),
  "utf8",
);

const UNIT_ID = "练习四"; // 练习样例的 frontmatter unit（8 题）
const LECTURE_TITLE = "第1讲 有理数"; // 讲义样例的 H1
const TEACHER_B_ID = "teacher-b-test-0001";

interface IsolationApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  /** 甲（存量管理员，setup 创建）的会话 Cookie */
  cookieA: string;
  /** 乙（第二位教师，直插行 + 伪造会话）的 Cookie */
  cookieB: string;
  /** 甲创建的文件夹 / 课程 id */
  folderAId: string;
  courseAId: string;
  /** 甲导入的讲义 id（uuid，从列表取） */
  lectureAId: string;
}

/** 甲 setup + 导入练习/讲义进文件夹；乙直插教师行并建会话 */
async function makeIsolationApp(): Promise<IsolationApp> {
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
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const cookieA = `tutor_session=${extractSessionToken(setup)}`;

  // 甲：建文件夹 + 建课程 + 导入练习与讲义（进文件夹，带批次号供回看断言）
  const folderRes = await request(
    app,
    "POST",
    "/api/teacher/library/folders",
    cookieA,
    {
      name: "甲的文件夹",
    },
  );
  const courseRes = await request(
    app,
    "POST",
    "/api/teacher/courses",
    cookieA,
    {
      title: "甲的课程",
    },
  );
  const folderAId = ((await folderRes.json()) as { data: { id: string } }).data
    .id;
  const courseAId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  for (const [markdown, filename] of [
    [PRACTICE_MD, "练习样例.md"],
    [LECTURE_MD, "讲义样例.md"],
  ] as const) {
    const res = await request(
      app,
      "POST",
      "/api/teacher/import/commit",
      cookieA,
      {
        markdown,
        filename,
        folderId: folderAId,
        batchId: "1b0f6d5e-0000-4000-8000-000000000001",
      },
    );
    expect(res.status).toBe(200);
  }
  const lecturesRes = await request(
    app,
    "GET",
    "/api/teacher/library/lectures",
    cookieA,
  );
  const lectures = (
    (await lecturesRes.json()) as {
      data: { lectures: { id: string; title: string }[] };
    }
  ).data.lectures;
  const lectureAId = lectures.find((l) => l.title === LECTURE_TITLE)?.id ?? "";
  expect(lectureAId).not.toBe("");

  // 乙：直插教师行（passwordHash 非空即可过守卫——不经过登录流程）+ 会话行
  db.insert(teachers)
    .values({
      id: TEACHER_B_ID,
      loginName: "乙老师",
      isAdmin: false,
      disabledAt: null,
      passwordHash: "scrypt$isolation-fixture",
      apiToken: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    })
    .run();
  const sessionB = createTeacherSession(db, TEACHER_B_ID);
  const cookieB = `tutor_session=${sessionB.token}`;
  return { app, db, cookieA, cookieB, folderAId, courseAId, lectureAId };
}

function extractSessionToken(res: Response): string {
  const line = res.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().startsWith("tutor_session="));
  if (!line) throw new Error("响应中没有 tutor_session cookie");
  return line.slice("tutor_session=".length).split(";")[0] ?? "";
}

function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> {
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

/** 断言 404 且错误码匹配（D12：不暴露存在性） */
async function expectNotFound(res: Response, code: string): Promise<void> {
  expect(res.status).toBe(404);
  expect(((await res.json()) as ApiErr).error).toBe(code);
}

describe("T2B.3 隔离红线：列表互不可见（乙视角数量为 0，不含甲任何信息）", () => {
  it("folders / lectures / units / 回收站：乙全部为空数组", async () => {
    const { app, cookieB } = await makeIsolationApp();
    const folders = await request(
      app,
      "GET",
      "/api/teacher/library/folders",
      cookieB,
    );
    expect(folders.status).toBe(200);
    expect(
      ((await folders.json()) as { data: { folders: unknown[] } }).data.folders,
    ).toEqual([]);

    for (const [path, key] of [
      ["/api/teacher/library/lectures", "lectures"],
      ["/api/teacher/library/units", "units"],
      ["/api/teacher/library/lectures?deleted=1", "lectures"],
      ["/api/teacher/library/units?deleted=1", "units"],
    ] as const) {
      const res = await request(app, "GET", path, cookieB);
      const body = (await res.json()) as { data: Record<string, unknown[]> };
      expect(body.data[key]).toEqual([]);
    }
  });

  it("乙按甲 id 的详情访问：题目 / 讲义 / usage → 404", async () => {
    const { app, cookieB, lectureAId } = await makeIsolationApp();
    await expectNotFound(
      await request(app, "GET", `/api/teacher/questions/${UNIT_ID}-1`, cookieB),
      "QUESTION_NOT_FOUND",
    );
    await expectNotFound(
      await request(app, "GET", `/api/teacher/lectures/${lectureAId}`, cookieB),
      "LECTURE_NOT_FOUND",
    );
    await expectNotFound(
      await request(app, "GET", `/api/teacher/units/${UNIT_ID}/usage`, cookieB),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/lectures/${lectureAId}/usage`,
        cookieB,
      ),
      "LECTURE_NOT_FOUND",
    );
  });
});

describe("T2B.3 隔离红线：编辑 / 软删 / 恢复 / 彻底删除 / 导出 → 404", () => {
  it("编辑：PATCH 单元与讲义元数据、PUT 单题与整篇讲义、PATCH 甲文件夹 → 404", async () => {
    const { app, cookieB, folderAId, lectureAId } = await makeIsolationApp();
    await expectNotFound(
      await request(app, "PATCH", `/api/teacher/units/${UNIT_ID}`, cookieB, {
        title: "乙改的标题",
      }),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/lectures/${lectureAId}`,
        cookieB,
        {
          folderId: null,
        },
      ),
      "LECTURE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PUT",
        `/api/teacher/questions/${UNIT_ID}-1`,
        cookieB,
        {
          sourceMd: "::::question{type=judge}\n$1>0$。[[正确]]\n::::",
        },
      ),
      "QUESTION_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PUT",
        `/api/teacher/lectures/${lectureAId}`,
        cookieB,
        {
          markdown: "# 乙写的讲义",
        },
      ),
      "LECTURE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/library/folders/${folderAId}`,
        cookieB,
        { name: "乙改名" },
      ),
      "FOLDER_NOT_FOUND",
    );
    // 乙把单元挂到甲的文件夹 / 指定甲的讲义为配套 → 同样 404
    await expectNotFound(
      await request(app, "PATCH", `/api/teacher/units/${UNIT_ID}`, cookieB, {
        folderId: folderAId,
      }),
      "UNIT_NOT_FOUND",
    );
  });

  it("软删 / 恢复：单元、讲义、题目 → 404 且甲数据不动", async () => {
    const { app, db, cookieB, lectureAId } = await makeIsolationApp();
    await expectNotFound(
      await request(app, "DELETE", `/api/teacher/units/${UNIT_ID}`, cookieB),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/lectures/${lectureAId}`,
        cookieB,
      ),
      "LECTURE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/questions/${UNIT_ID}-1`,
        cookieB,
      ),
      "QUESTION_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/units/${UNIT_ID}/restore`,
        cookieB,
      ),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/lectures/${lectureAId}/restore`,
        cookieB,
      ),
      "LECTURE_NOT_FOUND",
    );
    // 甲的行原样：单元未软删、题目未软删
    expect(
      db
        .select({ deletedAt: units.deletedAt })
        .from(units)
        .where(and(eq(units.teacherId, TEST_TEACHER_ID), eq(units.id, UNIT_ID)))
        .get()?.deletedAt,
    ).toBeNull();
    expect(
      db
        .select({ deletedAt: questions.deletedAt })
        .from(questions)
        .where(
          and(
            eq(questions.teacherId, TEST_TEACHER_ID),
            eq(questions.id, `${UNIT_ID}-1`),
          ),
        )
        .get()?.deletedAt,
    ).toBeNull();
  });

  it("彻底删除与导出：purge / export.md → 404", async () => {
    const { app, cookieB, lectureAId } = await makeIsolationApp();
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/units/${UNIT_ID}/purge`,
        cookieB,
      ),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/lectures/${lectureAId}/purge`,
        cookieB,
      ),
      "LECTURE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/units/${UNIT_ID}/export.md`,
        cookieB,
      ),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/lectures/${lectureAId}/export.md`,
        cookieB,
      ),
      "LECTURE_NOT_FOUND",
    );
  });
});

describe("T2B.3 隔离红线：批量操作 / 排序 / 越权参数", () => {
  it("batch：乙 move/delete 甲单元 → 单条 NOT_FOUND；addToCourse 引甲单元不产生条目", async () => {
    const { app, db, cookieB } = await makeIsolationApp();
    // 乙自建文件夹与课程，尝试把甲的单元 move 进去 / 删除 / 加课
    const folderB = await request(
      app,
      "POST",
      "/api/teacher/library/folders",
      cookieB,
      { name: "乙的文件夹" },
    );
    const folderBId = ((await folderB.json()) as { data: { id: string } }).data
      .id;
    // 乙的课程直插（POST /api/teacher/courses 的域化属 T2B.4——当前单教师等价实现
    // 会把乙建的课写进最早教师域，测试不能依赖它）
    const courseBId = crypto.randomUUID();
    db.insert(courses)
      .values({
        id: courseBId,
        teacherId: TEACHER_B_ID,
        title: "乙的课程",
        order: 0,
        createdAt: "2026-06-02T00:00:00.000Z",
      })
      .run();

    const move = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      cookieB,
      {
        action: "move",
        kind: "unit",
        ids: [UNIT_ID],
        folderId: folderBId,
      },
    );
    expect(
      (
        (await move.json()) as {
          data: { results: { ok: boolean; error?: string }[] };
        }
      ).data.results,
    ).toEqual([
      {
        id: UNIT_ID,
        ok: false,
        error: "UNIT_NOT_FOUND",
        message: expect.any(String),
      },
    ]);

    const del = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      cookieB,
      {
        action: "delete",
        kind: "unit",
        ids: [UNIT_ID],
      },
    );
    expect(
      (
        (await del.json()) as { data: { results: { ok: boolean }[] } }
      ).data.results.every((r) => !r.ok),
    ).toBe(true);

    const add = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      cookieB,
      {
        action: "addToCourse",
        kind: "unit",
        ids: [UNIT_ID],
        courseId: courseBId,
      },
    );
    expect(
      (
        (await add.json()) as { data: { results: { ok: boolean }[] } }
      ).data.results.every((r) => !r.ok),
    ).toBe(true);
    // 乙课程没有任何目录条目；甲的单元 folderId / deletedAt 原样
    expect(
      db
        .select({ id: courseItems.id })
        .from(courseItems)
        .where(eq(courseItems.courseId, courseBId))
        .all(),
    ).toEqual([]);
    const unitA = db
      .select()
      .from(units)
      .where(and(eq(units.teacherId, TEST_TEACHER_ID), eq(units.id, UNIT_ID)))
      .get();
    expect(unitA?.deletedAt).toBeNull();
    expect(unitA?.folderId).not.toBe(folderBId);
  });

  it("乙 batch addToCourse 带甲的 courseId → 404 COURSE_NOT_FOUND（整体失败）", async () => {
    const { app, cookieB, courseAId } = await makeIsolationApp();
    const res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      cookieB,
      {
        action: "addToCourse",
        kind: "unit",
        ids: [UNIT_ID],
        courseId: courseAId,
      },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiErr).error).toBe("COURSE_NOT_FOUND");
  });

  it("reorder：乙引甲的单元 / 题目 id → 404", async () => {
    const { app, cookieB } = await makeIsolationApp();
    await expectNotFound(
      await request(app, "POST", "/api/teacher/reorder", cookieB, {
        kind: "unit",
        ids: [UNIT_ID],
      }),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(app, "POST", "/api/teacher/reorder", cookieB, {
        kind: "question",
        ids: [`${UNIT_ID}-1`],
      }),
      "QUESTION_NOT_FOUND",
    );
  });

  it("乙 preview / commit 带甲的 folderId / courseId → 404", async () => {
    const { app, cookieB, folderAId, courseAId } = await makeIsolationApp();
    // folderId：preview 与 commit 都校验归属（D12/D13）
    for (const path of [
      "/api/teacher/import/preview",
      "/api/teacher/import/commit",
    ]) {
      await expectNotFound(
        await request(app, "POST", path, cookieB, {
          markdown: PRACTICE_MD,
          filename: "练习样例.md",
          folderId: folderAId,
        }),
        "FOLDER_NOT_FOUND",
      );
    }
    // courseId：commit 的兼容路径校验归属（preview 契约无 courseId 参数）
    await expectNotFound(
      await request(app, "POST", "/api/teacher/import/commit", cookieB, {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
        courseId: courseAId,
      }),
      "COURSE_NOT_FOUND",
    );
  });

  it("批次回看：乙查甲的 batchId → 空 files（200）", async () => {
    const { app, cookieA, cookieB } = await makeIsolationApp();
    const mine = await request(
      app,
      "GET",
      "/api/teacher/import/batches/1b0f6d5e-0000-4000-8000-000000000001",
      cookieA,
    );
    expect(
      ((await mine.json()) as { data: { files: unknown[] } }).data.files.length,
    ).toBe(2);
    const other = await request(
      app,
      "GET",
      "/api/teacher/import/batches/1b0f6d5e-0000-4000-8000-000000000001",
      cookieB,
    );
    expect(other.status).toBe(200);
    expect(
      ((await other.json()) as { data: { files: unknown[] } }).data.files,
    ).toEqual([]);
  });
});

describe("T2B.3 隔离红线：导入匹配域内（D13）", () => {
  it("乙 preview 与甲同 dslId 文件：动作全为 createUnit（不命中甲的单元）", async () => {
    const { app, cookieB } = await makeIsolationApp();
    const res = await request(
      app,
      "POST",
      "/api/teacher/import/preview",
      cookieB,
      {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { actions: { kind: string; unitId: string | null }[] };
    };
    expect(body.data.actions).toEqual([
      {
        kind: "createUnit",
        title: expect.any(String),
        unitId: UNIT_ID,
        folderName: null,
        restore: false,
      },
    ]);
  });

  it("乙 commit 与甲同 dslId 相同文件：乙域内新增独立单元；甲题数与 version 不变；考点公共合并", async () => {
    const { app, db, cookieA, cookieB } = await makeIsolationApp();
    // 甲的基线：8 题、version 全 1
    const beforeA = db
      .select({ id: questions.id, version: questions.version })
      .from(questions)
      .where(eq(questions.teacherId, TEST_TEACHER_ID))
      .all();
    expect(beforeA).toHaveLength(8);
    expect(beforeA.every((q) => q.version === 1)).toBe(true);

    const commitRes = await request(
      app,
      "POST",
      "/api/teacher/import/commit",
      cookieB,
      {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
      },
    );
    expect(commitRes.status).toBe(200);
    const report = (await commitRes.json()) as {
      data: { units: { inserted: boolean }[]; questions: { inserted: number } };
    };
    expect(report.data.units.every((u) => u.inserted)).toBe(true);
    expect(report.data.questions.inserted).toBe(8);

    // 乙的题库列表：1 个单元、8 题（自己的域）
    const unitsB = await request(
      app,
      "GET",
      "/api/teacher/library/units",
      cookieB,
    );
    const unitsBBody = (await unitsB.json()) as {
      data: { units: { id: string; questionCount: number }[] };
    };
    expect(unitsBBody.data.units).toHaveLength(1);
    expect(unitsBBody.data.units[0]).toMatchObject({
      id: UNIT_ID,
      questionCount: 8,
    });

    // 甲的题库列表不受影响：仍 1 个单元 8 题，version 全 1
    const unitsA = await request(
      app,
      "GET",
      "/api/teacher/library/units",
      cookieA,
    );
    const unitsABody = (await unitsA.json()) as {
      data: {
        units: {
          id: string;
          questionCount: number;
          questions: { version: number }[];
        }[];
      };
    };
    expect(unitsABody.data.units).toHaveLength(1);
    expect(unitsABody.data.units[0]).toMatchObject({
      id: UNIT_ID,
      questionCount: 8,
    });
    expect(
      unitsABody.data.units[0]?.questions.every((q) => q.version === 1),
    ).toBe(true);

    // 考点为公共数据（D11）：甲乙导入同一份样例后 knowledge_points 不重复建行
    //（样例共 6 个考点名，两域导入后仍 6 行；两域各自的 question_knowledge 各自建立）
    const pointRows = db
      .select({ id: knowledgePoints.id, name: knowledgePoints.name })
      .from(knowledgePoints)
      .all();
    expect(pointRows).toHaveLength(6);
  });
});
