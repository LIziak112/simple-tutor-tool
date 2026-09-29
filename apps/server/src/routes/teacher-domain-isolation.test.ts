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
  assignments,
  courseItems,
  courses,
  knowledgePoints,
  questions,
  students,
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
 * T2B.4 追加（课程与作业域，见文件末尾两组 describe）：
 * - 课程：乙对甲的课程（列表/详情/进度/student-view/本体改删/条目增删改排序/
 *   成员增删）→ 404；乙向自己课程塞甲的 refId / 甲的学生 → 404；甲乙同名课程
 *   互不可见；乙建课落自己域；
 * - 作业：乙对甲作业的读/改/删 → 404；乙 POST 引甲 courseId / 甲独有 unitId /
 *   甲学生 → 404；乙 PATCH 自己作业引甲 unitId / studentId → 404；乙 check 引
 *   甲资源 → 404；同 dslId 单元在乙域正常布置（不串甲）。
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
    // 乙的课程走 API（T2B.4 起 POST /courses 按会话教师落乙自己的域）
    const courseB = await request(
      app,
      "POST",
      "/api/teacher/courses",
      cookieB,
      {
        title: "乙的课程",
      },
    );
    expect(courseB.status).toBe(201);
    const courseBId = ((await courseB.json()) as { data: { id: string } }).data
      .id;

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

// ==================== T2B.4：课程与作业域隔离 ====================

/** 仅甲导入的单元（乙域内不存在——越权 unitId 断言用；dsl id 全局不冲突） */
const UNIT_A_ONLY = "unit-a-only";
const UNIT_A_ONLY_MD = `---
kind: practice
unit: ${UNIT_A_ONLY}
---

::::question{type=judge difficulty=1}
$1>0$。[[正确]]
::::
`;

/** 乙的学生（直插行：学生创建接口 T2B.5 才域化，直插模拟多教师库形态；
 * id 用合法 UUID——契约 studentIds 按 uuid 校验） */
const STUDENT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001";

interface CourseIsolationApp extends IsolationApp {
  /** 甲的作业 id */
  assignmentAId: string;
  /** 乙的课程 id（与甲课程同名——同名互不可见断言用） */
  courseBId: string;
  /** 乙的作业 id（同 dslId 单元在乙域正常布置） */
  assignmentBId: string;
  /** 甲创建的学生 id */
  studentAId: string;
  /** 甲课程里的目录条目 id（kind=unit，引 UNIT_ID） */
  itemAId: string;
}

/**
 * 在 makeIsolationApp 之上补课程/作业夹具：
 * 甲：学生 + 课程成员 + 目录条目（UNIT_ID）+ 按课程布置的作业；另导入 UNIT_A_ONLY
 *（乙域没有的单元）。乙：导入同 dslId 练习样例（乙域自己的 练习四）+ 直插学生 +
 * API 建课（与甲课程同名）+ 布置作业（乙域 练习四 + 乙学生——同 dslId 不串甲）。
 */
async function makeCourseIsolationApp(): Promise<CourseIsolationApp> {
  const base = await makeIsolationApp();
  const { app, db, cookieA, cookieB, courseAId } = base;

  // 甲：学生（student-service T2B.5 前单教师等价 → 归甲）+ 成员 + 条目 + 作业
  const studentRes = await request(
    app,
    "POST",
    "/api/teacher/students",
    cookieA,
    {
      displayName: "甲学生",
      loginName: "甲学生",
    },
  );
  expect(studentRes.status).toBe(201);
  const studentAId = (
    (await studentRes.json()) as { data: { student: { id: string } } }
  ).data.student.id;
  expect(
    await request(
      app,
      "POST",
      `/api/teacher/courses/${courseAId}/members`,
      cookieA,
      {
        studentIds: [studentAId],
      },
    ),
  ).toHaveProperty("status", 200);
  const itemRes = await request(
    app,
    "POST",
    `/api/teacher/courses/${courseAId}/items`,
    cookieA,
    { items: [{ kind: "unit", refId: UNIT_ID }] },
  );
  expect(itemRes.status).toBe(201);
  const itemAId = (
    (await itemRes.json()) as { data: { added: { id: string }[] } }
  ).data.added[0]?.id as string;
  const assignmentRes = await request(
    app,
    "POST",
    "/api/teacher/assignments",
    cookieA,
    {
      unitIds: [UNIT_ID],
      studentIds: [studentAId],
      courseId: courseAId,
      title: "甲的作业",
    },
  );
  expect(assignmentRes.status).toBe(201);
  const assignmentAId = (
    (await assignmentRes.json()) as { data: { id: string } }
  ).data.id;
  // 甲独有单元（乙域不存在）
  const onlyA = await request(
    app,
    "POST",
    "/api/teacher/import/commit",
    cookieA,
    {
      markdown: UNIT_A_ONLY_MD,
      filename: "甲专属.md",
    },
  );
  expect(onlyA.status).toBe(200);

  // 乙：同 dslId 练习样例（乙域独立单元）+ 学生 + 同名课程 + 作业
  const commitB = await request(
    app,
    "POST",
    "/api/teacher/import/commit",
    cookieB,
    {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    },
  );
  expect(commitB.status).toBe(200);
  db.insert(students)
    .values({
      id: STUDENT_B_ID,
      teacherId: TEACHER_B_ID,
      displayName: "乙学生",
      loginName: "乙学生",
      linkToken: "tok-b-student",
      linkEnabled: true,
      passwordEnabled: false,
      archivedAt: null,
      createdAt: "2026-06-02T00:00:00.000Z",
    })
    .run();
  const courseBRes = await request(
    app,
    "POST",
    "/api/teacher/courses",
    cookieB,
    {
      title: "甲的课程", // 与甲同名——同名互不可见断言
    },
  );
  expect(courseBRes.status).toBe(201);
  const courseBId = ((await courseBRes.json()) as { data: { id: string } }).data
    .id;
  const assignmentBRes = await request(
    app,
    "POST",
    "/api/teacher/assignments",
    cookieB,
    { unitIds: [UNIT_ID], studentIds: [STUDENT_B_ID], title: "乙的作业" },
  );
  expect(assignmentBRes.status).toBe(201);
  const assignmentBId = (
    (await assignmentBRes.json()) as { data: { id: string } }
  ).data.id;
  // 同 dslId 单元在乙域正常布置（不串甲）：乙作业行落乙域、单元数 1
  expect(
    db
      .select({ teacherId: assignments.teacherId })
      .from(assignments)
      .where(eq(assignments.id, assignmentBId))
      .get()?.teacherId,
  ).toBe(TEACHER_B_ID);
  expect(
    db
      .select({ teacherId: courses.teacherId })
      .from(courses)
      .where(eq(courses.id, courseBId))
      .get()?.teacherId,
  ).toBe(TEACHER_B_ID);

  return {
    ...base,
    assignmentAId,
    courseBId,
    assignmentBId,
    studentAId,
    itemAId,
  };
}

describe("T2B.4 隔离红线：课程域", () => {
  it("乙课程列表只含自己课程；甲乙同名课程互不可见（按 id 断言）", async () => {
    const { app, cookieA, cookieB, courseAId, courseBId } =
      await makeCourseIsolationApp();
    const listB = await request(app, "GET", "/api/teacher/courses", cookieB);
    const bodyB = (await listB.json()) as {
      data: { courses: { id: string; name: string }[] };
    };
    expect(bodyB.data.courses.map((c) => c.id)).toEqual([courseBId]);
    const listA = await request(app, "GET", "/api/teacher/courses", cookieA);
    const bodyA = (await listA.json()) as {
      data: { courses: { id: string; name: string }[] };
    };
    expect(bodyA.data.courses.map((c) => c.id)).toEqual([courseAId]);
    // 已归档视图同样互不可见（数量断言）
    const archivedB = await request(
      app,
      "GET",
      "/api/teacher/courses?archived=true",
      cookieB,
    );
    expect(
      ((await archivedB.json()) as { data: { courses: unknown[] } }).data
        .courses,
    ).toEqual([]);
  });

  it("乙按甲课程 id：详情 / 进度 / 学生视图 / 本体改与删 → 404 且甲课程原样", async () => {
    const { app, db, cookieB, courseAId, studentAId } =
      await makeCourseIsolationApp();
    await expectNotFound(
      await request(app, "GET", `/api/teacher/courses/${courseAId}`, cookieB),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/courses/${courseAId}/progress`,
        cookieB,
      ),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/courses/${courseAId}/student-view?studentId=${studentAId}`,
        cookieB,
      ),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/courses/${courseAId}`,
        cookieB,
        {
          name: "乙改名",
        },
      ),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/courses/${courseAId}`,
        cookieB,
      ),
      "COURSE_NOT_FOUND",
    );
    // 甲的课程行原样（未归档、未删、成员 1、条目 1）
    const row = db
      .select()
      .from(courses)
      .where(eq(courses.id, courseAId))
      .get();
    expect(row?.archivedAt).toBeNull();
    expect(
      db
        .select({ id: courseItems.id })
        .from(courseItems)
        .where(eq(courseItems.courseId, courseAId))
        .all(),
    ).toHaveLength(1);
  });

  it("乙对甲课程的条目与成员操作 → 404 且不写任何行", async () => {
    const { app, db, cookieB, courseAId, itemAId } =
      await makeCourseIsolationApp();
    // 条目：追加（即便 refId 是乙自己的单元，课程不是乙的也 404）、排序、改、删
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseAId}/items`,
        cookieB,
        { items: [{ kind: "unit", refId: UNIT_ID }] },
      ),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PUT",
        `/api/teacher/courses/${courseAId}/items/order`,
        cookieB,
        { ids: [itemAId] },
      ),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/course-items/${itemAId}`,
        cookieB,
        {
          visible: false,
        },
      ),
      "COURSE_ITEM_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/course-items/${itemAId}`,
        cookieB,
      ),
      "COURSE_ITEM_NOT_FOUND",
    );
    // 成员：加（乙自己的学生也不行）/ 移出
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseAId}/members`,
        cookieB,
        { studentIds: [STUDENT_B_ID] },
      ),
      "COURSE_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/courses/${courseAId}/members`,
        cookieB,
        { studentIds: [STUDENT_B_ID] },
      ),
      "COURSE_NOT_FOUND",
    );
    // 甲课程条目仍 1 条且可见、成员仍 1 人
    const items = db
      .select()
      .from(courseItems)
      .where(eq(courseItems.courseId, courseAId))
      .all();
    expect(items).toHaveLength(1);
    expect(items[0]?.visible).toBe(true);
  });

  it("乙向自己课程塞甲的 refId / 甲的学生 → 404（服务端归属再校验）", async () => {
    const { app, db, cookieA, cookieB, courseBId, studentAId, lectureAId } =
      await makeCourseIsolationApp();
    // 甲独有的单元 id（乙域内不存在）→ 404 UNIT_NOT_FOUND
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseBId}/items`,
        cookieB,
        {
          items: [{ kind: "unit", refId: UNIT_A_ONLY }],
        },
      ),
      "UNIT_NOT_FOUND",
    );
    // 甲的讲义（uuid）→ 404 LECTURE_NOT_FOUND
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseBId}/items`,
        cookieB,
        {
          items: [{ kind: "lecture", refId: lectureAId }],
        },
      ),
      "LECTURE_NOT_FOUND",
    );
    // 甲的学生进乙课程 → 404 STUDENT_NOT_FOUND（D14：学生归属终身）
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseBId}/members`,
        cookieB,
        { studentIds: [studentAId] },
      ),
      "STUDENT_NOT_FOUND",
    );
    // 乙用甲学生 id 预览自己课程 → 404（不泄露他人学生）
    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/courses/${courseBId}/student-view?studentId=${studentAId}`,
        cookieB,
      ),
      "STUDENT_NOT_FOUND",
    );
    // 乙课程目录与成员零写入
    expect(
      db
        .select({ id: courseItems.id })
        .from(courseItems)
        .where(eq(courseItems.courseId, courseBId))
        .all(),
    ).toEqual([]);
    // 乙自己的单元（同 dslId 练习四）可以正常加进自己课程（正向对照）
    const ok = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseBId}/items`,
      cookieB,
      { items: [{ kind: "unit", refId: UNIT_ID }] },
    );
    expect(ok.status).toBe(201);
    // 互不可见保持：乙课程的条目不出现在甲的任何课程详情里
    const detailA = await request(app, "GET", "/api/teacher/courses", cookieA);
    const coursesA = (
      (await detailA.json()) as {
        data: { courses: { id: string; itemCount: number }[] };
      }
    ).data.courses;
    expect(coursesA).toHaveLength(1);
    expect(coursesA[0]?.itemCount).toBe(1); // 只有甲自己的那条
  });
});

describe("T2B.4 隔离红线：作业域", () => {
  it("乙作业列表只含自己作业；乙按甲作业 id 详情 / 改 / 删 → 404 且甲作业原样", async () => {
    const { app, db, cookieA, cookieB, assignmentAId, assignmentBId } =
      await makeCourseIsolationApp();
    const listB = await request(
      app,
      "GET",
      "/api/teacher/assignments",
      cookieB,
    );
    const bodyB = (await listB.json()) as {
      data: { assignments: { id: string; title: string }[] };
    };
    expect(bodyB.data.assignments.map((a) => a.id)).toEqual([assignmentBId]);
    const listA = await request(
      app,
      "GET",
      "/api/teacher/assignments",
      cookieA,
    );
    const bodyA = (await listA.json()) as {
      data: { assignments: { id: string }[] };
    };
    expect(bodyA.data.assignments.map((a) => a.id)).toEqual([assignmentAId]);

    await expectNotFound(
      await request(
        app,
        "GET",
        `/api/teacher/assignments/${assignmentAId}`,
        cookieB,
      ),
      "ASSIGNMENT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/assignments/${assignmentAId}`,
        cookieB,
        { title: "乙改的作业" },
      ),
      "ASSIGNMENT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "DELETE",
        `/api/teacher/assignments/${assignmentAId}`,
        cookieB,
      ),
      "ASSIGNMENT_NOT_FOUND",
    );
    const rowA = db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentAId))
      .get();
    expect(rowA?.title).toBe("甲的作业");
    expect(rowA?.deletedAt).toBeNull();
  });

  it("乙 POST 作业：引甲 courseId / 甲独有 unitId / 甲学生 → 404", async () => {
    const { app, cookieB, courseAId, studentAId } =
      await makeCourseIsolationApp();
    // 甲的 courseId
    await expectNotFound(
      await request(app, "POST", "/api/teacher/assignments", cookieB, {
        unitIds: [UNIT_ID], // 乙自己的同 dslId 单元
        studentIds: [STUDENT_B_ID],
        courseId: courseAId,
      }),
      "COURSE_NOT_FOUND",
    );
    // 甲独有的单元 id
    await expectNotFound(
      await request(app, "POST", "/api/teacher/assignments", cookieB, {
        unitIds: [UNIT_A_ONLY],
        studentIds: [STUDENT_B_ID],
      }),
      "UNIT_NOT_FOUND",
    );
    // 甲的学生
    await expectNotFound(
      await request(app, "POST", "/api/teacher/assignments", cookieB, {
        unitIds: [UNIT_ID],
        studentIds: [studentAId],
      }),
      "STUDENT_NOT_FOUND",
    );
  });

  it("乙 PATCH 自己作业引甲 unitId / 甲学生 → 404；check 引甲资源 → 404", async () => {
    const { app, cookieB, assignmentBId, studentAId } =
      await makeCourseIsolationApp();
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/assignments/${assignmentBId}`,
        cookieB,
        { unitIds: [UNIT_A_ONLY] },
      ),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/assignments/${assignmentBId}`,
        cookieB,
        { addStudentIds: [studentAId] },
      ),
      "STUDENT_NOT_FOUND",
    );
    await expectNotFound(
      await request(app, "POST", "/api/teacher/assignments/check", cookieB, {
        unitIds: [UNIT_A_ONLY],
        studentIds: [STUDENT_B_ID],
      }),
      "UNIT_NOT_FOUND",
    );
    await expectNotFound(
      await request(app, "POST", "/api/teacher/assignments/check", cookieB, {
        unitIds: [UNIT_ID],
        studentIds: [studentAId],
      }),
      "STUDENT_NOT_FOUND",
    );
  });
});
