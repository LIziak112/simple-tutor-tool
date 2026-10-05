import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
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
  attempts,
  courseItems,
  courses,
  ink,
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
import { fetchSubmitRevisions } from "../test/submit-revisions";

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
  /** 应用数据目录（T2B.5 笔迹文件断言用） */
  dataDir: string;
  /** 甲创建的文件夹 / 课程 id */
  folderAId: string;
  courseAId: string;
  /** 甲导入的讲义 id（uuid，从列表取） */
  lectureAId: string;
}

/** 甲 setup + 导入练习/讲义进文件夹；乙直插教师行并建会话 */
async function makeIsolationApp(): Promise<IsolationApp> {
  const db = createTestDb();
  const dataDir = createTestDir();
  const app = createApp({
    isProduction: false,
    logger: silentLogger,
    db,
    publicUrl: "http://localhost:8787",
    dataDir,
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
  return {
    app,
    db,
    cookieA,
    cookieB,
    dataDir,
    folderAId,
    courseAId,
    lectureAId,
  };
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

/** 乙的学生（直插行模拟多教师库形态：跳过创建接口直接构造归属乙的学生行；
 * id 用合法 UUID——契约 studentIds 按 uuid 校验。创建接口本身的域归属
 * （写会话教师）在下方 T2B.5 矩阵以 API 直测） */
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

  // 甲：学生（T2B.5 起创建接口写会话教师 → 归甲）+ 成员 + 条目 + 作业
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
    (await assignmentRes.json()) as {
      data: { assignments: { id: string }[] };
    }
  ).data.assignments[0]?.id;
  if (assignmentAId === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }
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
    (await assignmentBRes.json()) as {
      data: { assignments: { id: string }[] };
    }
  ).data.assignments[0]?.id;
  if (assignmentBId === undefined) {
    throw new Error("布置作业响应缺少作业 id");
  }
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

// ==================== T2B.5：学生与作答域隔离 ====================

describe("T2B.5 隔离红线：学生域", () => {
  it("乙学生列表只含自己学生（含归档视图）；乙建学生落乙域（teacherId 直查证据）", async () => {
    const { app, db, cookieB } = await makeCourseIsolationApp();
    for (const query of ["", "?includeArchived=true"]) {
      const res = await request(
        app,
        "GET",
        `/api/teacher/students${query}`,
        cookieB,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { students: { id: string }[] };
      };
      // 乙视角只有直插的乙学生，甲学生零出现（数量断言）
      expect(body.data.students.map((s) => s.id)).toEqual([STUDENT_B_ID]);
    }

    // 乙经 API 建学生 → 行落乙域（D14：归属创建教师）
    const createRes = await request(
      app,
      "POST",
      "/api/teacher/students",
      cookieB,
      {
        displayName: "乙新学生",
        loginName: "乙新学生",
      },
    );
    expect(createRes.status).toBe(201);
    const newId = (
      (await createRes.json()) as { data: { student: { id: string } } }
    ).data.student.id;
    expect(
      db
        .select({ teacherId: students.teacherId })
        .from(students)
        .where(eq(students.id, newId))
        .get()?.teacherId,
    ).toBe(TEACHER_B_ID);
  });

  it("乙对甲学生：编辑 / 重置密码 / 重置链接 / 归档 → 404 且甲行原样", async () => {
    const { app, db, cookieB, studentAId } = await makeCourseIsolationApp();
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/students/${studentAId}`,
        cookieB,
        {
          displayName: "乙改名",
        },
      ),
      "STUDENT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/students/${studentAId}/reset-password`,
        cookieB,
      ),
      "STUDENT_NOT_FOUND",
    );
    await expectNotFound(
      await request(
        app,
        "POST",
        `/api/teacher/students/${studentAId}/reset-link`,
        cookieB,
      ),
      "STUDENT_NOT_FOUND",
    );
    // 归档也按归属教师（乙不能把甲的学生归档下线）
    await expectNotFound(
      await request(
        app,
        "PATCH",
        `/api/teacher/students/${studentAId}`,
        cookieB,
        {
          archived: true,
        },
      ),
      "STUDENT_NOT_FOUND",
    );
    const rowA = db
      .select()
      .from(students)
      .where(eq(students.id, studentAId))
      .get();
    expect(rowA?.displayName).toBe("甲学生");
    expect(rowA?.archivedAt).toBeNull();
    expect(rowA?.teacherId).toBe(TEST_TEACHER_ID);
  });

  it("乙创建学生 loginName 与甲重名 → 409 且不落库；改「甲学生2」成功落乙域", async () => {
    const { app, db, cookieB } = await makeCourseIsolationApp();
    const res = await request(app, "POST", "/api/teacher/students", cookieB, {
      displayName: "甲学生",
      loginName: "甲学生",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErr).error).toBe("LOGIN_NAME_TAKEN");
    // 不落库重名（D14：loginName 全局唯一，命名空间不按教师分片）
    expect(
      db
        .select({ id: students.id })
        .from(students)
        .where(eq(students.loginName, "甲学生"))
        .all(),
    ).toHaveLength(1);

    // 前端提示「如：张三2」（D14 维持现状）——换名后乙成功创建，落乙域
    const retry = await request(app, "POST", "/api/teacher/students", cookieB, {
      displayName: "甲学生2",
      loginName: "甲学生2",
    });
    expect(retry.status).toBe(201);
    const retryId = (
      (await retry.json()) as { data: { student: { id: string } } }
    ).data.student.id;
    expect(
      db
        .select({ teacherId: students.teacherId })
        .from(students)
        .where(eq(students.id, retryId))
        .get()?.teacherId,
    ).toBe(TEACHER_B_ID);
  });
});

/** T3.3：甲学生笔迹的矢量文档原文（gzip 后落盘，回放接口字节一致性断言用） */
const SEED_INK_DOC = {
  engine: "atrament" as const,
  version: 1,
  data: {
    width: 800,
    strokes: [
      {
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 12, y: 34, p: 0.5, t: 0 },
          { x: 56, y: 78, p: 0.8, t: 25 },
        ],
      },
    ],
  },
  updatedAt: 1748918400000,
};

/**
 * T2B.5：甲学生 attempt + 笔迹行 + 落盘 PNG 与 strokes gzip
 * （直插模拟既有作答数据；目录懒建；矢量文件 T3.3 起一并落盘）
 */
function seedInkOfTeacherA(
  db: Db,
  dataDir: string,
  studentAId: string,
  assignmentAId: string,
): { attemptId: string; inkId: string; strokesRel: string } {
  const attemptId = "cccccccc-cccc-4ccc-8ccc-cccccccc0001";
  const inkId = "dddddddd-dddd-4ddd-8ddd-dddddddd0001";
  db.insert(attempts)
    .values({
      id: attemptId,
      studentId: studentAId,
      sourceType: "assignment",
      assignmentId: assignmentAId,
      courseId: null,
      unitId: null,
      attemptNo: 1,
      status: "draft",
      startedAt: "2026-06-03T00:00:00.000Z",
      submittedAt: null,
      activeSec: null,
      device: null,
      scoreAuto: null,
      scoreFinal: null,
    })
    .run();
  const relPng = join("blobs", "ink", attemptId, "q-a.png");
  const relStrokes = join("blobs", "ink", attemptId, "q-a.json.gz");
  const absDir = join(dataDir, "blobs", "ink", attemptId);
  mkdirSync(absDir, { recursive: true });
  writeFileSync(join(dataDir, relPng), Buffer.from("fake-png-bytes"));
  writeFileSync(
    join(dataDir, relStrokes),
    gzipSync(Buffer.from(JSON.stringify(SEED_INK_DOC), "utf8")),
  );
  db.insert(ink)
    .values({
      id: inkId,
      attemptId,
      questionId: `${UNIT_ID}-1`,
      strokesPath: relStrokes,
      pngPath: relPng,
      width: 800,
      height: 600,
      strokeCount: 3,
      updatedAt: "2026-06-03T00:00:00.000Z",
    })
    .run();
  return { attemptId, inkId, strokesRel: relStrokes };
}

describe("T2B.5 隔离红线：教师侧作答链路（笔迹 / 内容树兼容接口）", () => {
  it("乙取甲学生的笔迹 PNG 与元数据 → 404；甲本人正常读取", async () => {
    const { app, db, dataDir, cookieA, cookieB, studentAId, assignmentAId } =
      await makeCourseIsolationApp();
    const { inkId } = seedInkOfTeacherA(db, dataDir, studentAId, assignmentAId);

    // 甲本人：PNG 直出 + 元数据正常
    const pngA = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}.png`,
      cookieA,
    );
    expect(pngA.status).toBe(200);
    expect(Buffer.from(await pngA.arrayBuffer()).toString()).toBe(
      "fake-png-bytes",
    );
    const metaA = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}`,
      cookieA,
    );
    expect(metaA.status).toBe(200);
    expect(
      ((await metaA.json()) as { data: { attemptId: string } }).data.attemptId,
    ).toBe("cccccccc-cccc-4ccc-8ccc-cccccccc0001");

    // 乙：归属链 ink → attempt → student.teacherId 不匹配 → 404（不暴露存在性）
    await expectNotFound(
      await request(app, "GET", `/api/teacher/ink/${inkId}.png`, cookieB),
      "INK_NOT_FOUND",
    );
    await expectNotFound(
      await request(app, "GET", `/api/teacher/ink/${inkId}`, cookieB),
      "INK_NOT_FOUND",
    );
  });

  it("GET /api/teacher/content（兼容接口）：甲乙各自只见自己的课程与题目（域内 version）", async () => {
    const { app, cookieA, cookieB, courseAId, courseBId } =
      await makeCourseIsolationApp();

    // 甲编辑一道题（version+1）——只有甲域能看到新版本
    const edit = await request(
      app,
      "PUT",
      `/api/teacher/questions/${UNIT_ID}-1`,
      cookieA,
      { sourceMd: "::::question{type=judge}\n$2>0$。[[正确]]\n::::" },
    );
    expect(edit.status).toBe(200);

    const treeA = await request(app, "GET", "/api/teacher/content", cookieA);
    const bodyA = (await treeA.json()) as {
      data: {
        courses: {
          id: string;
          lectures: { id: string }[];
          units: { id: string; questions: { id: string; version: number }[] }[];
        }[];
      };
    };
    expect(bodyA.data.courses.map((c) => c.id)).toEqual([courseAId]);
    const unitA = bodyA.data.courses[0]?.units.find((u) => u.id === UNIT_ID);
    expect(unitA?.questions).toHaveLength(8);
    expect(unitA?.questions.find((q) => q.id === `${UNIT_ID}-1`)?.version).toBe(
      2,
    );

    // 乙把自己的同 dslId 单元加进自己课程（fixture 只建了空课程；乙域自有副本）
    const addItem = await request(
      app,
      "POST",
      `/api/teacher/courses/${courseBId}/items`,
      cookieB,
      { items: [{ kind: "unit", refId: UNIT_ID }] },
    );
    expect(addItem.status).toBe(201);

    const treeB = await request(app, "GET", "/api/teacher/content", cookieB);
    const bodyB = (await treeB.json()) as {
      data: {
        courses: {
          id: string;
          lectures: { id: string }[];
          units: { id: string; questions: { id: string; version: number }[] }[];
        }[];
      };
    };
    // 乙：只见自己的同名课程；同 dslId 单元下的题目是乙域自己的版本（version 1）
    expect(bodyB.data.courses.map((c) => c.id)).toEqual([courseBId]);
    const unitB = bodyB.data.courses[0]?.units.find((u) => u.id === UNIT_ID);
    expect(unitB?.questions).toHaveLength(8);
    expect(unitB?.questions.every((q) => q.version === 1)).toBe(true);
  });
});

// ==================== T3.3：教师端笔迹矢量数据接口（D12） ====================

describe("T3.3 教师端笔迹矢量数据接口（GET /api/teacher/ink/:inkId.json.gz）", () => {
  it("甲本人取矢量：200 + application/gzip + 响应字节与落盘 strokes 文件逐字节一致", async () => {
    const { app, db, dataDir, cookieA, studentAId, assignmentAId } =
      await makeCourseIsolationApp();
    const { inkId, strokesRel } = seedInkOfTeacherA(
      db,
      dataDir,
      studentAId,
      assignmentAId,
    );
    const res = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}.json.gz`,
      cookieA,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const body = Buffer.from(await res.arrayBuffer());
    // 逐字节一致（服务端不解不校验，原样回传落盘 gzip）
    expect(body.equals(readFileSync(join(dataDir, strokesRel)))).toBe(true);
    // 是真 gzip（魔数 1f 8b），解压回原文档（内容闭环）
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
    expect(JSON.parse(gunzipSync(body).toString("utf8"))).toEqual(SEED_INK_DOC);
  });

  it("乙取甲学生的笔迹矢量 → 404 INK_NOT_FOUND（域隔离红线，不暴露存在性）", async () => {
    const { app, db, dataDir, cookieB, studentAId, assignmentAId } =
      await makeCourseIsolationApp();
    const { inkId } = seedInkOfTeacherA(db, dataDir, studentAId, assignmentAId);
    await expectNotFound(
      await request(app, "GET", `/api/teacher/ink/${inkId}.json.gz`, cookieB),
      "INK_NOT_FOUND",
    );
  });

  it("ink 行存在但磁盘 strokes 文件缺失 → 404；.png 分支不受影响仍 200", async () => {
    const { app, db, dataDir, cookieA, studentAId, assignmentAId } =
      await makeCourseIsolationApp();
    const { inkId, strokesRel } = seedInkOfTeacherA(
      db,
      dataDir,
      studentAId,
      assignmentAId,
    );
    rmSync(join(dataDir, strokesRel));
    await expectNotFound(
      await request(app, "GET", `/api/teacher/ink/${inkId}.json.gz`, cookieA),
      "INK_NOT_FOUND",
    );
    // PNG 文件仍在：快照分支照常直出（降级路径可用，D12）
    const png = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}.png`,
      cookieA,
    );
    expect(png.status).toBe(200);
    expect(Buffer.from(await png.arrayBuffer()).toString()).toBe(
      "fake-png-bytes",
    );
  });

  it("三分支并存：同一 inkId 的 .png / 元数据 / .json.gz 各自正确分流", async () => {
    const { app, db, dataDir, cookieA, studentAId, assignmentAId } =
      await makeCourseIsolationApp();
    const { inkId, attemptId } = seedInkOfTeacherA(
      db,
      dataDir,
      studentAId,
      assignmentAId,
    );
    // .png：PNG 字节直出
    const png = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}.png`,
      cookieA,
    );
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    // 元数据：JSON 统一壳
    const meta = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}`,
      cookieA,
    );
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toContain("application/json");
    expect(
      ((await meta.json()) as { data: { attemptId: string } }).data.attemptId,
    ).toBe(attemptId);
    // .json.gz：矢量 gzip 直出
    const gz = await request(
      app,
      "GET",
      `/api/teacher/ink/${inkId}.json.gz`,
      cookieA,
    );
    expect(gz.status).toBe(200);
    expect(gz.headers.get("content-type")).toBe("application/gzip");
    expect(Buffer.from(await gz.arrayBuffer())[0]).toBe(0x1f);
  });
});

// ==================== T2B.5：同 id 冲突 + 学生端双教师全流程回归 ====================

/** 同 id 冲突单元：甲乙各导同 dslId、同题目 id（same-q1）但题干/答案/提示/主题不同；
 * 甲版多一道 only-a（题数差异验证目录统计按域） */
const CONFLICT_UNIT_ID = "unit-same-id";
const CONFLICT_STUDENT_PASSWORD = "student-pass-8";

function conflictMd(owner: "甲" | "乙"): string {
  const extra =
    owner === "甲"
      ? `\n::::question{id=only-a type=judge difficulty=1}\n$2>1$。[[正确]]\n::::\n`
      : "";
  return `---
kind: practice
unit: ${CONFLICT_UNIT_ID}
topic: ${owner}版主题
---

::::question{id=same-q1 type=judge difficulty=1}
${owner}版题干：$1>0$。[[${owner === "甲" ? "正确" : "错误"}]]

:::hint
${owner}老师的提示
:::
::::
${extra}`;
}

/** 双教师学生端夹具：甲乙各导冲突单元 + 各建可登录学生 + 各布置作业 + 各建课程目录 */
async function makeSameIdConflictApp() {
  const base = await makeIsolationApp();
  const { app, cookieA, cookieB } = base;

  // 两域各导同 dslId、同题目 id 的不同版本
  for (const [cookie, owner] of [
    [cookieA, "甲"],
    [cookieB, "乙"],
  ] as const) {
    const res = await request(
      app,
      "POST",
      "/api/teacher/import/commit",
      cookie,
      {
        markdown: conflictMd(owner),
        filename: `冲突单元-${owner}.md`,
      },
    );
    expect(res.status).toBe(200);
  }

  /** 各自建学生（带密码，可登录）+ 作业 + 课程成员与目录 */
  async function setupTeacherSide(cookie: string, label: string) {
    const studentName = label === "甲" ? "冲突甲生" : "冲突乙生";
    const studentRes = await request(
      app,
      "POST",
      "/api/teacher/students",
      cookie,
      {
        displayName: studentName,
        loginName: studentName,
        password: CONFLICT_STUDENT_PASSWORD,
      },
    );
    expect(studentRes.status).toBe(201);
    const studentId = (
      (await studentRes.json()) as { data: { student: { id: string } } }
    ).data.student.id;
    const courseRes = await request(
      app,
      "POST",
      "/api/teacher/courses",
      cookie,
      {
        title: `${label}的冲突课程`,
      },
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    expect(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseId}/members`,
        cookie,
        { studentIds: [studentId] },
      ),
    ).toHaveProperty("status", 200);
    expect(
      await request(
        app,
        "POST",
        `/api/teacher/courses/${courseId}/items`,
        cookie,
        { items: [{ kind: "unit", refId: CONFLICT_UNIT_ID }] },
      ),
    ).toHaveProperty("status", 201);
    const assignmentRes = await request(
      app,
      "POST",
      "/api/teacher/assignments",
      cookie,
      { unitIds: [CONFLICT_UNIT_ID], studentIds: [studentId] },
    );
    expect(assignmentRes.status).toBe(201);
    const assignmentId = (
      (await assignmentRes.json()) as {
        data: { assignments: { id: string }[] };
      }
    ).data.assignments[0]?.id;
    if (assignmentId === undefined) {
      throw new Error("布置作业响应缺少作业 id");
    }

    // 学生登录 + 开卷
    const loginRes = await app.request("/api/public/student/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        loginName: studentName,
        password: CONFLICT_STUDENT_PASSWORD,
      }),
    });
    expect(loginRes.status).toBe(200);
    const studentCookie = `tutor_session=${extractSessionToken(loginRes)}`;
    const attemptRes = await app.request(
      `/api/student/assignments/${assignmentId}/attempt`,
      { method: "POST", headers: { cookie: studentCookie } },
    );
    expect(attemptRes.status).toBe(200);
    const attemptId = ((await attemptRes.json()) as { data: { id: string } })
      .data.id;
    return { studentId, studentCookie, courseId, assignmentId, attemptId };
  }

  const sideA = await setupTeacherSide(cookieA, "甲");
  const sideB = await setupTeacherSide(cookieB, "乙");
  return { ...base, sideA, sideB };
}

describe("T2B.5 同 id 冲突：甲乙各导同 dslId/同题目 id 的不同版本并各自布置", () => {
  it("两边学生取卷、提示、判分、课程目录都只来自本教师的版本", async () => {
    const { app, sideA, sideB } = await makeSameIdConflictApp();

    // 取卷：题干与题数（甲 2 题 / 乙 1 题）都来自本域版本
    const paperA = await request(
      app,
      "GET",
      `/api/student/assignments/${sideA.assignmentId}/paper`,
      sideA.studentCookie,
    );
    const paperABody = (await paperA.json()) as {
      data: { units: { questions: { id: string; stemMd: string }[] }[] };
    };
    const questionsA = paperABody.data.units[0]?.questions ?? [];
    expect(questionsA.map((q) => q.id)).toEqual(["same-q1", "only-a"]);
    const stemA = questionsA[0]?.stemMd ?? "";
    expect(stemA).toContain("甲版题干");
    expect(stemA).not.toContain("乙版题干");

    const paperB = await request(
      app,
      "GET",
      `/api/student/assignments/${sideB.assignmentId}/paper`,
      sideB.studentCookie,
    );
    const paperBBody = (await paperB.json()) as {
      data: { units: { questions: { id: string; stemMd: string }[] }[] };
    };
    const questionsB = paperBBody.data.units[0]?.questions ?? [];
    expect(questionsB.map((q) => q.id)).toEqual(["same-q1"]);
    const stemB = questionsB[0]?.stemMd ?? "";
    expect(stemB).toContain("乙版题干");
    expect(stemB).not.toContain("甲版题干");

    // 提示：同 questionId、同 index，内容只来自本域版本
    const hintA = await request(
      app,
      "POST",
      `/api/student/attempts/${sideA.attemptId}/hints`,
      sideA.studentCookie,
      { questionId: "same-q1", index: 0 },
    );
    expect(hintA.status).toBe(200);
    expect(
      ((await hintA.json()) as { data: { hint: string } }).data.hint,
    ).toContain("甲老师的提示");
    const hintB = await request(
      app,
      "POST",
      `/api/student/attempts/${sideB.attemptId}/hints`,
      sideB.studentCookie,
      { questionId: "same-q1", index: 0 },
    );
    expect(hintB.status).toBe(200);
    expect(
      ((await hintB.json()) as { data: { hint: string } }).data.hint,
    ).toContain("乙老师的提示");

    // 判分：同一答案 true——甲版正确答案=正确（判对）、乙版=错误（判错）
    for (const side of [sideA, sideB]) {
      const save = await request(
        app,
        "PUT",
        `/api/student/attempts/${side.attemptId}/answers/same-q1`,
        side.studentCookie,
        { answer: { kind: "judge", value: true } },
      );
      expect(save.status).toBe(200);
    }
    const submitA = await request(
      app,
      "POST",
      `/api/student/attempts/${sideA.attemptId}/submit`,
      sideA.studentCookie,
      {
        revisions: await fetchSubmitRevisions(
          app,
          sideA.studentCookie,
          sideA.attemptId,
        ),
      },
    );
    expect(submitA.status).toBe(200);
    const resultA = (await submitA.json()) as {
      data: {
        summary: { correct: number; wrong: number };
        units: {
          questions: { questionId: string; autoCorrect: boolean | null }[];
        }[];
      };
    };
    expect(
      resultA.data.units[0]?.questions.find((q) => q.questionId === "same-q1")
        ?.autoCorrect,
    ).toBe(true);
    expect(resultA.data.summary.correct).toBe(1); // only-a 未作答按 null 待批

    const submitB = await request(
      app,
      "POST",
      `/api/student/attempts/${sideB.attemptId}/submit`,
      sideB.studentCookie,
      {
        revisions: await fetchSubmitRevisions(
          app,
          sideB.studentCookie,
          sideB.attemptId,
        ),
      },
    );
    expect(submitB.status).toBe(200);
    const resultB = (await submitB.json()) as {
      data: {
        summary: { correct: number; wrong: number };
        units: {
          questions: { questionId: string; autoCorrect: boolean | null }[];
        }[];
      };
    };
    expect(
      resultB.data.units[0]?.questions.find((q) => q.questionId === "same-q1")
        ?.autoCorrect,
    ).toBe(false);
    expect(resultB.data.summary.wrong).toBe(1);

    // 课程目录与落地页：题数与主题只来自本域版本
    const catalogA = await request(
      app,
      "GET",
      `/api/student/courses/${sideA.courseId}`,
      sideA.studentCookie,
    );
    const catalogABody = (await catalogA.json()) as {
      data: {
        items: { refId: string | null; questionCount: number | null }[];
      };
    };
    expect(
      catalogABody.data.items.find((i) => i.refId === CONFLICT_UNIT_ID)
        ?.questionCount,
    ).toBe(2);
    const catalogB = await request(
      app,
      "GET",
      `/api/student/courses/${sideB.courseId}`,
      sideB.studentCookie,
    );
    const catalogBBody = (await catalogB.json()) as {
      data: {
        items: { refId: string | null; questionCount: number | null }[];
      };
    };
    expect(
      catalogBBody.data.items.find((i) => i.refId === CONFLICT_UNIT_ID)
        ?.questionCount,
    ).toBe(1);

    const landingA = await request(
      app,
      "GET",
      `/api/student/courses/${sideA.courseId}/units/${CONFLICT_UNIT_ID}`,
      sideA.studentCookie,
    );
    expect(landingA.status).toBe(200);
    expect(
      ((await landingA.json()) as { data: { topic: string | null } }).data
        .topic,
    ).toContain("甲版主题");
    const landingB = await request(
      app,
      "GET",
      `/api/student/courses/${sideB.courseId}/units/${CONFLICT_UNIT_ID}`,
      sideB.studentCookie,
    );
    expect(landingB.status).toBe(200);
    expect(
      ((await landingB.json()) as { data: { topic: string | null } }).data
        .topic,
    ).toContain("乙版主题");
  });
});

/** 最小合法 PNG（服务端只校验魔数/IHDR；与学生端测试同构造） */
function conflictPng(width = 320, height = 200): Uint8Array {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/** 构造 atrament InkDoc 并 gzip（与学生端测试同口径） */
function conflictInkDoc(strokeCount: number): Uint8Array {
  const doc = {
    engine: "atrament" as const,
    version: 1,
    data: {
      width: 1000,
      strokes: Array.from({ length: strokeCount }, (_, i) => ({
        tool: "pen" as const,
        color: "#1f2328",
        weight: 4,
        points: [
          { x: 10 + i, y: 20, p: 0.5, t: 0 },
          { x: 30 + i, y: 1240, p: 0.8, t: 25 },
        ],
      })),
    },
    updatedAt: 1727392800000,
  };
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(doc), "utf8")));
}

/** PUT 笔迹（multipart） */
function putConflictInk(
  app: ReturnType<typeof createApp>,
  cookie: string,
  attemptId: string,
  questionId: string,
  strokes: Uint8Array,
): Promise<Response> {
  const form = new FormData();
  form.append(
    "strokes",
    new Blob([strokes], { type: "application/gzip" }),
    "strokes.json.gz",
  );
  form.append(
    "snapshot",
    new Blob([conflictPng()], { type: "image/png" }),
    "snapshot.png",
  );
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/ink/${questionId}`, {
      method: "PUT",
      headers: { cookie },
      body: form,
    }),
  );
}

describe("T2B.5 学生端回归：两名不同教师的学生全流程互不串扰", () => {
  it("草稿/笔迹/事件/结果各自独立；乙生访问甲生 attempt → 403", async () => {
    const { app, db, sideA, sideB } = await makeSameIdConflictApp();

    // 草稿：同 questionId（same-q1）各存各的 attempt，互不覆盖
    for (const [side, value] of [
      [sideA, true],
      [sideB, false],
    ] as const) {
      const save = await request(
        app,
        "PUT",
        `/api/student/attempts/${side.attemptId}/answers/same-q1`,
        side.studentCookie,
        { answer: { kind: "judge", value } },
      );
      expect(save.status).toBe(200);
    }
    const detailA = await request(
      app,
      "GET",
      `/api/student/attempts/${sideA.attemptId}`,
      sideA.studentCookie,
    );
    expect(
      (
        (await detailA.json()) as {
          data: { drafts: Record<string, { value: boolean }> };
        }
      ).data.drafts["same-q1"]?.value,
    ).toBe(true);
    const detailB = await request(
      app,
      "GET",
      `/api/student/attempts/${sideB.attemptId}`,
      sideB.studentCookie,
    );
    expect(
      (
        (await detailB.json()) as {
          data: { drafts: Record<string, { value: boolean }> };
        }
      ).data.drafts["same-q1"]?.value,
    ).toBe(false);

    // 笔迹：同 questionId 各传各的（甲 3 笔 / 乙 7 笔），回读只拿到自己的
    expect(
      (
        await putConflictInk(
          app,
          sideA.studentCookie,
          sideA.attemptId,
          "same-q1",
          conflictInkDoc(3),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await putConflictInk(
          app,
          sideB.studentCookie,
          sideB.attemptId,
          "same-q1",
          conflictInkDoc(7),
        )
      ).status,
    ).toBe(200);
    const inkA = await request(
      app,
      "GET",
      `/api/student/attempts/${sideA.attemptId}/ink/same-q1`,
      sideA.studentCookie,
    );
    expect(inkA.status).toBe(200);
    expect(
      (
        (await inkA.json()) as {
          data: { data: { strokes: unknown[] } };
        }
      ).data.data.strokes,
    ).toHaveLength(3);
    const inkB = await request(
      app,
      "GET",
      `/api/student/attempts/${sideB.attemptId}/ink/same-q1`,
      sideB.studentCookie,
    );
    expect(inkB.status).toBe(200);
    expect(
      (
        (await inkB.json()) as {
          data: { data: { strokes: unknown[] } };
        }
      ).data.data.strokes,
    ).toHaveLength(7);

    // 事件：各报各的（同 questionId 落各自 attempt 上下文）
    for (const side of [sideA, sideB]) {
      const events = await request(
        app,
        "POST",
        `/api/student/attempts/${side.attemptId}/events`,
        side.studentCookie,
        {
          events: [
            {
              type: "answer_change",
              clientTs: 1727392800000,
              questionId: "same-q1",
            },
          ],
        },
      );
      expect(events.status).toBe(200);
    }

    // 越权：乙生访问甲生的 attempt（详情/取卷/笔迹/事件）→ 403 FORBIDDEN
    const crossDetail = await request(
      app,
      "GET",
      `/api/student/attempts/${sideA.attemptId}`,
      sideB.studentCookie,
    );
    expect(crossDetail.status).toBe(403);
    const crossPaper = await request(
      app,
      "GET",
      `/api/student/attempts/${sideA.attemptId}/paper`,
      sideB.studentCookie,
    );
    expect(crossPaper.status).toBe(403);
    const crossInk = await request(
      app,
      "GET",
      `/api/student/attempts/${sideA.attemptId}/ink/same-q1`,
      sideB.studentCookie,
    );
    expect(crossInk.status).toBe(403);
    const crossEvents = await request(
      app,
      "POST",
      `/api/student/attempts/${sideA.attemptId}/events`,
      sideB.studentCookie,
      {
        events: [
          {
            type: "answer_change",
            clientTs: 1727392800000,
            questionId: "same-q1",
          },
        ],
      },
    );
    expect(crossEvents.status).toBe(403);

    // 交卷后各自结果独立（甲生 true=对；乙生 false 在乙版答案下=对——判分同域）
    const submitA = await request(
      app,
      "POST",
      `/api/student/attempts/${sideA.attemptId}/submit`,
      sideA.studentCookie,
      {
        revisions: await fetchSubmitRevisions(
          app,
          sideA.studentCookie,
          sideA.attemptId,
        ),
      },
    );
    expect(submitA.status).toBe(200);
    const submitB = await request(
      app,
      "POST",
      `/api/student/attempts/${sideB.attemptId}/submit`,
      sideB.studentCookie,
      {
        revisions: await fetchSubmitRevisions(
          app,
          sideB.studentCookie,
          sideB.attemptId,
        ),
      },
    );
    expect(submitB.status).toBe(200);
    const resultA = (await submitA.json()) as {
      data: { summary: { correct: number } };
    };
    const resultB = (await submitB.json()) as {
      data: { summary: { correct: number } };
    };
    expect(resultA.data.summary.correct).toBe(1);
    expect(resultB.data.summary.correct).toBe(1); // 乙版正确答案=错误，乙生答 false 判对

    // 归属直查证据：两份 attempt 的 ink 行各一条（各自 attemptId 名下）
    expect(
      db
        .select({ id: ink.id })
        .from(ink)
        .where(eq(ink.attemptId, sideA.attemptId))
        .all(),
    ).toHaveLength(1);
    expect(
      db
        .select({ id: ink.id })
        .from(ink)
        .where(eq(ink.attemptId, sideB.attemptId))
        .all(),
    ).toHaveLength(1);
  });
});
