import { readFileSync } from "node:fs";
import type { ApiErr, QuestionAnswers } from "@tutor/contract";
import {
  apiErrSchema,
  type LibraryBatchData,
  type LibraryUnitList,
  type LibraryUsage,
  libraryFolderListOkSchema,
  libraryUnitListOkSchema,
  libraryUsageOkSchema,
} from "@tutor/contract";
import { lintDocument } from "@tutor/md-dsl";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Db } from "../db/client";
import {
  courseItems,
  courseStudents,
  courses,
  lectures,
  questions,
  units,
} from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils.ts";
import { listVisibleItems } from "../services/course-service.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";

/**
 * 资源库路由集成测试（T2A.2，app.request() 直调路由 + 内存库）：
 * - 文件夹 CRUD / 排序 / 删除后内容进未归类（D2）；
 * - 讲义库 / 题库 / 回收站列表（folderId=none、q、deleted）；
 * - 单元元数据 PATCH（title/topic/folderId/lectureId）与讲义移动文件夹；
 * - 软删单元 → 学生课程目录不可见、作业仍可取卷（D3/D16，学生接口 assertNoLeak
 *   不回归）→ 恢复后可见性恢复；
 * - purge：有作业引用 / 有作答记录 → 409 RESOURCE_IN_USE；无引用 → 彻底删除
 *   （题目、目录条目一并清理）；讲义 purge 解除配套关联；
 * - 批量 move / delete / restore / addToCourse（重复跳过）；
 * - 导出往返：导出单元（已删题不导出 + 注释）→ preview 0 error → 题数/题型/
 *   答案/顺序一致；导出讲义 → preview 0 error 且识别 1 篇讲义。
 * 夹具用 samples/v2/练习样例.md + 讲义样例.md（兼容性回归样例）。
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

/** 练习样例全部 8 题的（id, type）顺序（导出往返对比基线） */
const EXPECTED_QUESTIONS = [
  { id: "练习四-1", type: "judge" },
  { id: "练习四-2", type: "choice" },
  { id: "练习四-3", type: "multi" },
  { id: "练习四-4", type: "fill" },
  { id: "练习四-5", type: "fill" },
  { id: "p4-q7", type: "solve" },
  { id: "练习四-7", type: "apply" },
  { id: "练习四-8", type: "find-error" },
] as const;

const UNIT_ID = "练习四";
const LECTURE_TITLE = "第1讲 有理数";

interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  teacherCookie: string;
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
    body: JSON.stringify({ loginName: "teacher", password: TEACHER_PASSWORD }),
  });
  const teacherCookie = `tutor_session=${extractSessionToken(setup)}`;
  // T2A.3：导入不再自动创建「默认课程」——显式建课 + 兼容路径（courseId）导入，
  // 后续按「默认课程」文件夹/条目断言的口径保持不变
  const courseRes = await app.request("/api/teacher/courses", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: teacherCookie },
    body: JSON.stringify({ title: "默认课程" }),
  });
  if (courseRes.status !== 201) {
    throw new Error("测试课程创建失败");
  }
  const courseId = ((await courseRes.json()) as { data: { id: string } }).data
    .id;
  for (const [markdown, filename] of [
    [PRACTICE_MD, "练习样例.md"],
    [LECTURE_MD, "讲义样例.md"],
  ] as const) {
    const res = await app.request("/api/teacher/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: teacherCookie },
      body: JSON.stringify({ markdown, filename, courseId }),
    });
    expect(res.status).toBe(200);
  }
  return { app, db, teacherCookie };
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

/** 读统一壳失败的错误体 */
async function readErr(res: Response): Promise<ApiErr> {
  const body = (await res.json()) as unknown;
  return apiErrSchema.parse(body);
}

/** 教师创建学生并登录（返回 id + 学生会话 Cookie） */
async function makeStudent(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  name: string,
): Promise<{ id: string; cookie: string }> {
  const res = await request(
    app,
    "POST",
    "/api/teacher/students",
    teacherCookie,
    {
      displayName: name,
      loginName: name,
      password: STUDENT_PASSWORD,
    },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { student: { id: string } } };
  const login = await request(
    app,
    "POST",
    "/api/public/student/login",
    undefined,
    { loginName: name, password: STUDENT_PASSWORD },
  );
  expect(login.status).toBe(200);
  return {
    id: body.data.student.id,
    cookie: `tutor_session=${extractSessionToken(login)}`,
  };
}

/** 教师布置作业（T2.2 单单元契约），返回作业 id */
async function makeAssignment(
  app: ReturnType<typeof createApp>,
  teacherCookie: string,
  unitId: string,
  studentIds: string[],
): Promise<string> {
  const res = await request(
    app,
    "POST",
    "/api/teacher/assignments",
    teacherCookie,
    {
      unitIds: [unitId],
      studentIds,
    },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    data: { assignments: { id: string }[] };
  };
  const id = body.data.assignments[0]?.id;
  if (id === undefined) throw new Error("布置作业响应缺少作业 id");
  return id;
}

/** 「默认课程」id（导入样例时自动创建并追加目录条目） */
function defaultCourseId(db: Db): string {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.title, "默认课程"))
    .get();
  if (row === undefined) throw new Error("默认课程未创建");
  return row.id;
}

/** 第一篇讲义 id */
function firstLectureId(db: Db): string {
  const row = db
    .select({ id: lectures.id })
    .from(lectures)
    .where(eq(lectures.title, LECTURE_TITLE))
    .get();
  if (row === undefined) throw new Error("讲义样例未导入");
  return row.id;
}

// ---------- 基础：鉴权 ----------

describe("资源库路由：鉴权", () => {
  it("未登录 / 学生会话访问教师接口一律 401", async () => {
    const { app, teacherCookie } = await makeApp();
    const student = await makeStudent(app, teacherCookie, "张三");
    for (const path of [
      "/api/teacher/library/folders",
      "/api/teacher/library/units",
      "/api/teacher/library/lectures",
      "/api/teacher/units/练习四/usage",
      "/api/teacher/units/练习四/export.md",
    ]) {
      const noAuth = await request(app, "GET", path, undefined);
      expect(noAuth.status, path).toBe(401);
      const asStudent = await request(app, "GET", path, student.cookie);
      expect(asStudent.status, path).toBe(401);
    }
    const noAuthBatch = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      undefined,
      {
        action: "delete",
        kind: "unit",
        ids: [UNIT_ID],
      },
    );
    expect(noAuthBatch.status).toBe(401);
  });
});

// ---------- 文件夹（D2） ----------

describe("资源库路由：文件夹", () => {
  it("CRUD + reorder + 删除后内容进未归类（验收：删除文件夹后内容进入未归类）", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const created = await request(
      app,
      "POST",
      "/api/teacher/library/folders",
      teacherCookie,
      { name: "新文件夹" },
    );
    expect(created.status).toBe(201);
    const folder = ((await created.json()) as { data: { id: string } }).data;

    // 列表含计数
    const listRes = await request(
      app,
      "GET",
      "/api/teacher/library/folders",
      teacherCookie,
    );
    expect(listRes.status).toBe(200);
    const listBody = libraryFolderListOkSchema.parse(await listRes.json());
    const names = listBody.data.folders.map((f) => f.name);
    expect(names).toContain("新文件夹");
    expect(names).toContain("默认课程");
    const defaultFolder = listBody.data.folders.find(
      (f) => f.name === "默认课程",
    );
    // 讲义样例含两篇讲义（第1讲/第2讲）+ 练习样例 1 个单元
    expect(defaultFolder).toMatchObject({ lectureCount: 2, unitCount: 1 });

    // 改名 + 重名 409
    const renamed = await request(
      app,
      "PATCH",
      `/api/teacher/library/folders/${folder.id}`,
      teacherCookie,
      { name: "改名后" },
    );
    expect(renamed.status).toBe(200);
    const dup = await request(
      app,
      "PATCH",
      `/api/teacher/library/folders/${folder.id}`,
      teacherCookie,
      { name: "默认课程" },
    );
    expect(dup.status).toBe(409);
    expect((await readErr(dup)).error).toBe("FOLDER_NAME_EXISTS");

    // 排序
    const order = await request(
      app,
      "POST",
      "/api/teacher/library/folders/reorder",
      teacherCookie,
      { ids: [folder.id, defaultFolder?.id] },
    );
    expect(order.status).toBe(200);

    // 把单元移到新文件夹后删除文件夹 → 单元进未归类
    await request(app, "PATCH", "/api/teacher/units/练习四", teacherCookie, {
      folderId: folder.id,
    });
    const deleted = await request(
      app,
      "DELETE",
      `/api/teacher/library/folders/${folder.id}`,
      teacherCookie,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      ok: true,
      data: { movedLectures: 0, movedUnits: 1 },
    });
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get()?.folderId,
    ).toBeNull();

    // 再删 → 404
    const again = await request(
      app,
      "DELETE",
      `/api/teacher/library/folders/${folder.id}`,
      teacherCookie,
    );
    expect(again.status).toBe(404);
  });
});

// ---------- 列表（讲义库 / 题库 / 回收站） ----------

describe("资源库路由：列表", () => {
  it("units 列表：题型分布/考点/题目摘要/folderId 筛选/none/q 搜索/回收站", async () => {
    const { app, teacherCookie } = await makeApp();
    const foldersRes = await request(
      app,
      "GET",
      "/api/teacher/library/folders",
      teacherCookie,
    );
    const folders = libraryFolderListOkSchema.parse(await foldersRes.json())
      .data.folders;
    const folderId = folders.find((f) => f.name === "默认课程")?.id as string;

    const allRes = await request(
      app,
      "GET",
      "/api/teacher/library/units",
      teacherCookie,
    );
    const all = libraryUnitListOkSchema.parse(await allRes.json()).data;
    expect(all.units).toHaveLength(1);
    const unit = all.units[0] as LibraryUnitList["units"][number];
    expect(unit.id).toBe(UNIT_ID);
    expect(unit.questionCount).toBe(8);
    expect(unit.typeDistribution).toEqual({
      judge: 1,
      choice: 1,
      multi: 1,
      fill: 2,
      solve: 1,
      apply: 1,
      "find-error": 1,
    });
    expect(unit.knowledge.length).toBeGreaterThan(0);
    expect(unit.questions).toHaveLength(8);
    expect(unit.folderId).toBe(folderId);

    // folderId=none：导入样例都在默认课程文件夹 → 空
    const noneRes = await request(
      app,
      "GET",
      "/api/teacher/library/units?folderId=none",
      teacherCookie,
    );
    expect(
      libraryUnitListOkSchema.parse(await noneRes.json()).data.units,
    ).toHaveLength(0);

    // q 搜索：按 topic / 考点 / 单元 id
    for (const q of ["有理数加减混合", "相反数", UNIT_ID]) {
      const hit = await request(
        app,
        "GET",
        `/api/teacher/library/units?q=${encodeURIComponent(q)}`,
        teacherCookie,
      );
      expect(
        libraryUnitListOkSchema
          .parse(await hit.json())
          .data.units.map((u) => u.id),
      ).toEqual([UNIT_ID]);
    }
    const missRes = await request(
      app,
      "GET",
      "/api/teacher/library/units?q=%E4%B8%8D%E5%AD%98%E5%9C%A8",
      teacherCookie,
    );
    expect(
      libraryUnitListOkSchema.parse(await missRes.json()).data.units,
    ).toHaveLength(0);

    // 软删后进回收站，默认列表消失
    await request(app, "DELETE", "/api/teacher/units/练习四", teacherCookie);
    const afterDelete = libraryUnitListOkSchema.parse(
      await (
        await request(app, "GET", "/api/teacher/library/units", teacherCookie)
      ).json(),
    ).data;
    expect(afterDelete.units).toHaveLength(0);
    const recycle = libraryUnitListOkSchema.parse(
      await (
        await request(
          app,
          "GET",
          "/api/teacher/library/units?deleted=1",
          teacherCookie,
        )
      ).json(),
    ).data;
    expect(recycle.units).toHaveLength(1);
    expect(recycle.units[0]?.deletedAt).not.toBeNull();
  });

  it("lectures 列表：courseCount；软删进回收站", async () => {
    const { app, teacherCookie } = await makeApp();
    const lecturesBody = (await (
      await request(app, "GET", "/api/teacher/library/lectures", teacherCookie)
    ).json()) as {
      data: {
        lectures: {
          id: string;
          title: string;
          folderId: string | null;
          courseCount: number;
        }[];
      };
    };
    // 讲义样例按 H1 切出两篇讲义
    expect(lecturesBody.data.lectures).toHaveLength(2);
    const lecture = lecturesBody.data.lectures.find(
      (l) => l.title === LECTURE_TITLE,
    ) as {
      id: string;
      title: string;
      folderId: string | null;
      courseCount: number;
    };
    expect(lecture.folderId).not.toBeNull();
    expect(lecture.courseCount).toBe(1); // 导入时追加了课程目录条目

    await request(
      app,
      "DELETE",
      `/api/teacher/lectures/${lecture.id}`,
      teacherCookie,
    );
    const recycle = (await (
      await request(
        app,
        "GET",
        "/api/teacher/library/lectures?deleted=1",
        teacherCookie,
      )
    ).json()) as { data: { lectures: { id: string }[] } };
    expect(recycle.data.lectures.map((l) => l.id)).toEqual([lecture.id]);
  });
});

// ---------- 单元 / 讲义元数据编辑 ----------

describe("资源库路由：PATCH 单元与讲义元数据", () => {
  it("改标题/topic/文件夹/配套讲义；空标题 422；未知单元/文件夹 404", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const lectureId = firstLectureId(db);

    const res = await request(
      app,
      "PATCH",
      "/api/teacher/units/练习四",
      teacherCookie,
      {
        title: "有理数练习（改）",
        topic: "新主题",
        folderId: null,
        lectureId,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      data: {
        id: "练习四",
        title: "有理数练习（改）",
        topic: "新主题",
        folderId: null,
        lectureId,
      },
    });

    // topic 显式 null 清空
    const clear = await request(
      app,
      "PATCH",
      "/api/teacher/units/练习四",
      teacherCookie,
      {
        topic: null,
      },
    );
    expect(
      ((await clear.json()) as { data: { topic: string | null } }).data.topic,
    ).toBeNull();

    const emptyTitle = await request(
      app,
      "PATCH",
      "/api/teacher/units/练习四",
      teacherCookie,
      { title: "  " },
    );
    // 契约 schema 先拦（trim 后非空）→ 400 VALIDATION_ERROR
    expect(emptyTitle.status).toBe(400);
    const missing = await request(
      app,
      "PATCH",
      "/api/teacher/units/ghost",
      teacherCookie,
      {
        title: "x",
      },
    );
    expect(missing.status).toBe(404);
    const badFolder = await request(
      app,
      "PATCH",
      "/api/teacher/units/练习四",
      teacherCookie,
      { folderId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b" },
    );
    expect(badFolder.status).toBe(404);
    expect((await readErr(badFolder)).error).toBe("FOLDER_NOT_FOUND");
  });

  it("PATCH /lectures/:id 移动文件夹；未知讲义 404", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const lectureId = firstLectureId(db);
    const res = await request(
      app,
      "PATCH",
      `/api/teacher/lectures/${lectureId}`,
      teacherCookie,
      { folderId: null },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { folderId: string | null } }).data
        .folderId,
    ).toBeNull();
    const missing = await request(
      app,
      "PATCH",
      "/api/teacher/lectures/ghost",
      teacherCookie,
      { folderId: null },
    );
    expect(missing.status).toBe(404);
  });
});

// ---------- 核心验收：软删可见性 / 作业取卷 / 恢复 ----------

describe("资源库路由：软删、学生可见性与作业取卷（D3/D16）", () => {
  it("单元软删后课程中对学生不可见、作业仍可取卷；恢复后可见性恢复", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const student = await makeStudent(app, teacherCookie, "张三");

    // 复用默认课程：单元条目改可见 + 学生加成员（导入时讲义可见、单元隐藏）
    const courseId = defaultCourseId(db);
    db.update(courseItems)
      .set({ visible: true })
      .where(eq(courseItems.refId, UNIT_ID))
      .run();
    db.insert(courseStudents)
      .values({
        courseId,
        studentId: student.id,
        joinedAt: new Date().toISOString(),
      })
      .run();

    const assignmentId = await makeAssignment(app, teacherCookie, UNIT_ID, [
      student.id,
    ]);

    // 基线：学生可见单元
    expect(
      listVisibleItems(db, student.id, courseId).map((item) => item.refId),
    ).toContain(UNIT_ID);

    // 软删单元
    const del = await request(
      app,
      "DELETE",
      "/api/teacher/units/练习四",
      teacherCookie,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, data: null });

    // 课程中对学生不可见（D3）
    expect(
      listVisibleItems(db, student.id, courseId).map((item) => item.refId),
    ).not.toContain(UNIT_ID);

    // 作业不受影响：学生照常开始作答并取到全部题目（D16：单元软删不影响作业
    // 通道——只有 questions.deletedAt 才从试卷排除）；泄露断言不回归
    const start = await request(
      app,
      "POST",
      `/api/student/assignments/${assignmentId}/attempt`,
      student.cookie,
    );
    expect(start.status).toBe(200);
    const paper = await request(
      app,
      "GET",
      `/api/student/assignments/${assignmentId}/paper`,
      student.cookie,
    );
    expect(paper.status).toBe(200);
    const paperBody = (await paper.json()) as unknown;
    assertNoLeak(paperBody);
    const paperQuestions = (
      paperBody as {
        data: { units: { questions: { id: string }[] }[] };
      }
    ).data.units.flatMap((unit) => unit.questions);
    expect(paperQuestions).toHaveLength(8);
    expect(paperQuestions.map((q) => q.id)).toEqual(
      EXPECTED_QUESTIONS.map((q) => q.id),
    );

    // 恢复 → 可见性恢复（试卷在软删期间本就照常，内容无变化）
    const restore = await request(
      app,
      "POST",
      "/api/teacher/units/练习四/restore",
      teacherCookie,
    );
    expect(restore.status).toBe(200);
    expect(
      listVisibleItems(db, student.id, courseId).map((item) => item.refId),
    ).toContain(UNIT_ID);
  });
});

// ---------- purge（D3 条件） ----------

describe("资源库路由：purge（D3 条件）", () => {
  it("单元：有作业引用 → 409；有作答记录 → 409；无引用 → 彻底删除（题目与目录条目一并清理）", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const student = await makeStudent(app, teacherCookie, "李四");

    // 场景一：作业引用
    const assignmentId = await makeAssignment(app, teacherCookie, UNIT_ID, [
      student.id,
    ]);
    let res = await request(
      app,
      "DELETE",
      "/api/teacher/units/练习四/purge",
      teacherCookie,
    );
    expect(res.status).toBe(409);
    expect((await readErr(res)).error).toBe("RESOURCE_IN_USE");

    // 学生开始作答后删除作业：作答记录仍在 → 依旧 409
    await request(
      app,
      "POST",
      `/api/student/assignments/${assignmentId}/attempt`,
      student.cookie,
    );
    await request(
      app,
      "DELETE",
      `/api/teacher/assignments/${assignmentId}`,
      teacherCookie,
    );
    res = await request(
      app,
      "DELETE",
      "/api/teacher/units/练习四/purge",
      teacherCookie,
    );
    expect(res.status).toBe(409);
    expect((await readErr(res)).error).toBe("RESOURCE_IN_USE");

    // 场景二：清掉作答与作业（模拟从未使用）→ purge 成功
    //（assignment_students 有 FK，先清名单再清作业；走底层 prepare 直跑 SQL）
    // T2A.7：作业内容在 assignment_units（assignments.unitId 已废弃为空），按关联表清
    db.$client
      .prepare(
        "DELETE FROM assignment_students WHERE assignment_id IN (SELECT assignment_id FROM assignment_units WHERE unit_id = ?)",
      )
      .run(UNIT_ID);
    db.$client
      .prepare(
        "DELETE FROM responses WHERE attempt_id IN (SELECT id FROM attempts WHERE unit_id = ? OR assignment_id IN (SELECT assignment_id FROM assignment_units WHERE unit_id = ?))",
      )
      .run(UNIT_ID, UNIT_ID);
    db.$client
      .prepare(
        "DELETE FROM attempts WHERE unit_id = ? OR assignment_id IN (SELECT assignment_id FROM assignment_units WHERE unit_id = ?)",
      )
      .run(UNIT_ID, UNIT_ID);
    db.$client.prepare("DELETE FROM assignment_units").run();
    db.$client.prepare("DELETE FROM assignments").run();
    res = await request(
      app,
      "DELETE",
      "/api/teacher/units/练习四/purge",
      teacherCookie,
    );
    expect(res.status).toBe(200);
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get(),
    ).toBeUndefined();
    expect(
      db.select().from(questions).where(eq(questions.unitId, UNIT_ID)).all(),
    ).toHaveLength(0);
    expect(
      db.select().from(courseItems).where(eq(courseItems.refId, UNIT_ID)).all(),
    ).toHaveLength(0);

    // 再删 → 404
    res = await request(
      app,
      "DELETE",
      "/api/teacher/units/练习四/purge",
      teacherCookie,
    );
    expect(res.status).toBe(404);
  });

  it("讲义：配套单元有作答 → 409；干净讲义 → 删除并解除配套、清理目录条目", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const student = await makeStudent(app, teacherCookie, "王五");
    const lectureId = firstLectureId(db);

    // 建立配套关系 + 学生作答（经配套单元计入讲义使用情况）
    await request(app, "PATCH", "/api/teacher/units/练习四", teacherCookie, {
      lectureId,
    });
    const assignmentId = await makeAssignment(app, teacherCookie, UNIT_ID, [
      student.id,
    ]);
    await request(
      app,
      "POST",
      `/api/student/assignments/${assignmentId}/attempt`,
      student.cookie,
    );
    let res = await request(
      app,
      "DELETE",
      `/api/teacher/lectures/${lectureId}/purge`,
      teacherCookie,
    );
    expect(res.status).toBe(409);
    expect((await readErr(res)).error).toBe("RESOURCE_IN_USE");

    // 清掉作答与作业 → 讲义可 purge；单元配套关联被解除，单元保留
    for (const table of [
      "assignment_students",
      "assignment_units",
      "responses",
      "attempts",
      "assignments",
    ]) {
      db.$client.prepare(`DELETE FROM ${table}`).run();
    }
    res = await request(
      app,
      "DELETE",
      `/api/teacher/lectures/${lectureId}/purge`,
      teacherCookie,
    );
    expect(res.status).toBe(200);
    expect(
      db.select().from(lectures).where(eq(lectures.id, lectureId)).get(),
    ).toBeUndefined();
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get()?.lectureId,
    ).toBeNull();
    expect(
      db
        .select()
        .from(courseItems)
        .where(eq(courseItems.refId, lectureId))
        .all(),
    ).toHaveLength(0);
  });
});

// ---------- usage ----------

describe("资源库路由：usage", () => {
  it("单元 usage：课程引用 + 未删除作业 + 作答数；未知 404", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const student = await makeStudent(app, teacherCookie, "赵六");
    const courseId = defaultCourseId(db);
    const assignmentId = await makeAssignment(app, teacherCookie, UNIT_ID, [
      student.id,
    ]);
    await request(
      app,
      "POST",
      `/api/student/assignments/${assignmentId}/attempt`,
      student.cookie,
    );

    const res = await request(
      app,
      "GET",
      "/api/teacher/units/练习四/usage",
      teacherCookie,
    );
    expect(res.status).toBe(200);
    const usage = libraryUsageOkSchema.parse(await res.json())
      .data as LibraryUsage;
    expect(usage.courses.map((c) => c.id)).toEqual([courseId]);
    expect(usage.assignments.map((a) => a.id)).toEqual([assignmentId]);
    expect(usage.attemptCount).toBe(1);

    const missing = await request(
      app,
      "GET",
      "/api/teacher/units/ghost/usage",
      teacherCookie,
    );
    expect(missing.status).toBe(404);
  });

  it("讲义 usage：assignments 恒空；作答数经配套单元", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const student = await makeStudent(app, teacherCookie, "孙七");
    const lectureId = firstLectureId(db);
    await request(app, "PATCH", "/api/teacher/units/练习四", teacherCookie, {
      lectureId,
    });
    const assignmentId = await makeAssignment(app, teacherCookie, UNIT_ID, [
      student.id,
    ]);
    await request(
      app,
      "POST",
      `/api/student/assignments/${assignmentId}/attempt`,
      student.cookie,
    );
    const res = await request(
      app,
      "GET",
      `/api/teacher/lectures/${lectureId}/usage`,
      teacherCookie,
    );
    expect(res.status).toBe(200);
    const usage = libraryUsageOkSchema.parse(await res.json())
      .data as LibraryUsage;
    expect(usage.assignments).toEqual([]);
    expect(usage.attemptCount).toBe(1);
  });
});

// ---------- 批量操作 ----------

describe("资源库路由：batch", () => {
  it("move → delete → restore 全链路；addToCourse 重复跳过；参数级错误", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const created = await request(
      app,
      "POST",
      "/api/teacher/library/folders",
      teacherCookie,
      { name: "批量目标" },
    );
    const folderId = ((await created.json()) as { data: { id: string } }).data
      .id;

    // move
    let res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "move",
        kind: "unit",
        ids: [UNIT_ID],
        folderId,
      },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: LibraryBatchData }).data.results,
    ).toEqual([{ id: UNIT_ID, ok: true }]);
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get()?.folderId,
    ).toBe(folderId);

    // move 到未归类（folderId: null）
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "move",
        kind: "unit",
        ids: [UNIT_ID],
        folderId: null,
      },
    );
    expect(res.status).toBe(200);
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get()?.folderId,
    ).toBeNull();

    // delete（软删）→ 回收站；未知 id 逐条失败不中断
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "delete",
        kind: "unit",
        ids: [UNIT_ID, "ghost"],
      },
    );
    expect(res.status).toBe(200);
    const delResults = ((await res.json()) as { data: LibraryBatchData }).data
      .results;
    expect(delResults).toHaveLength(2);
    expect(delResults[0]).toEqual({ id: UNIT_ID, ok: true });
    expect(delResults[1]).toMatchObject({
      id: "ghost",
      ok: false,
      error: "UNIT_NOT_FOUND",
    });
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get()?.deletedAt,
    ).not.toBeNull();

    // restore
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "restore",
        kind: "unit",
        ids: [UNIT_ID],
      },
    );
    expect(res.status).toBe(200);
    expect(
      db.select().from(units).where(eq(units.id, UNIT_ID)).get()?.deletedAt,
    ).toBeNull();

    // addToCourse：加入成功；重复 → skipped
    const courseRes = await request(
      app,
      "POST",
      "/api/teacher/courses",
      teacherCookie,
      {
        title: "批量课程",
      },
    );
    const courseId = ((await courseRes.json()) as { data: { id: string } }).data
      .id;
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "addToCourse",
        kind: "unit",
        ids: [UNIT_ID],
        courseId,
      },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: LibraryBatchData }).data.results,
    ).toEqual([{ id: UNIT_ID, ok: true }]);
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "addToCourse",
        kind: "unit",
        ids: [UNIT_ID],
        courseId,
      },
    );
    const dupResults = ((await res.json()) as { data: LibraryBatchData }).data
      .results;
    expect(dupResults[0]).toMatchObject({
      id: UNIT_ID,
      ok: true,
      skipped: true,
    });

    // 参数级错误：move 缺 folderId → 422；addToCourse 未知课程 → 404
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "move",
        kind: "unit",
        ids: [UNIT_ID],
      },
    );
    expect(res.status).toBe(422);
    res = await request(
      app,
      "POST",
      "/api/teacher/library/batch",
      teacherCookie,
      {
        action: "addToCourse",
        kind: "unit",
        ids: [UNIT_ID],
        courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      },
    );
    expect(res.status).toBe(404);
  });
});

// ---------- 导出（往返） ----------

/** 解析 practice 文档为 {id, type, answers} 列表（与导入同一解析器） */
function parsePractice(
  markdown: string,
): { id: string; type: string; answers: QuestionAnswers | undefined }[] {
  const { parsed } = lintDocument(markdown);
  return parsed.units.flatMap((unit) =>
    unit.questions.map((q) => ({ id: q.id, type: q.type, answers: q.answers })),
  );
}

describe("资源库路由：export.md 往返", () => {
  it("导出单元：frontmatter 正确、已删题不导出并注明、preview 0 error、题数/题型/答案/顺序一致", async () => {
    const { app, db, teacherCookie } = await makeApp();
    // 软删第一题（练习四-1）——验证已删题不导出
    await request(
      app,
      "DELETE",
      "/api/teacher/questions/练习四-1",
      teacherCookie,
    );
    // 关联配套讲义（导出 frontmatter 带 lecture 标题）
    const lectureId = firstLectureId(db);
    await request(app, "PATCH", "/api/teacher/units/练习四", teacherCookie, {
      lectureId,
    });

    const res = await request(
      app,
      "GET",
      "/api/teacher/units/练习四/export.md",
      teacherCookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const markdown = await res.text();
    expect(markdown).toContain("kind: practice");
    expect(markdown).toContain('unit: "练习四"');
    expect(markdown).toContain("topic:");
    expect(markdown).toContain(`lecture: ${JSON.stringify(LECTURE_TITLE)}`);
    // 已删题不出现 + 注释说明（不产生 lint error/warning）
    expect(markdown).not.toContain("练习四-1");
    expect(markdown).toContain("另有 1 道已删除的题目未导出");

    // preview 0 error / 0 warning（往返第一步）
    const preview = await request(
      app,
      "POST",
      "/api/teacher/import/preview",
      teacherCookie,
      {
        markdown,
        filename: "练习四.md",
      },
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      data: {
        summary: { questionCount: number; unitCount: number };
        issues: { level: string }[];
      };
    };
    expect(previewBody.data.issues).toHaveLength(0);
    expect(previewBody.data.summary.questionCount).toBe(7);
    expect(previewBody.data.summary.unitCount).toBe(1);

    // 结构一致：解析导出文本与库内未删题比对 id/题型/顺序/答案
    const parsed = parsePractice(markdown);
    expect(parsed.map((q) => q.id)).toEqual(
      EXPECTED_QUESTIONS.slice(1).map((q) => q.id),
    );
    expect(parsed.map((q) => q.type)).toEqual(
      EXPECTED_QUESTIONS.slice(1).map((q) => q.type),
    );
    const liveRows = db
      .select()
      .from(questions)
      .where(eq(questions.unitId, UNIT_ID))
      .all()
      .filter((row) => row.deletedAt === null)
      .sort((a, b) => a.order - b.order);
    expect(liveRows).toHaveLength(7);
    for (const [index, row] of liveRows.entries()) {
      const exported = parsed[index];
      expect(exported?.answers).toEqual(
        row.answersJson === null ? undefined : JSON.parse(row.answersJson),
      );
    }

    // 未知单元 404
    const missing = await request(
      app,
      "GET",
      "/api/teacher/units/ghost/export.md",
      teacherCookie,
    );
    expect(missing.status).toBe(404);
  });

  it("导出讲义：kind: lecture 头 + 原文；preview 0 error 且识别 1 篇讲义", async () => {
    const { app, db, teacherCookie } = await makeApp();
    const lectureId = firstLectureId(db);
    const res = await request(
      app,
      "GET",
      `/api/teacher/lectures/${lectureId}/export.md`,
      teacherCookie,
    );
    expect(res.status).toBe(200);
    const markdown = await res.text();
    expect(markdown.startsWith("---\nkind: lecture\n---\n\n")).toBe(true);
    // 内容部分与库内讲义原文一致（讲义样例按 H1 切两篇，库中只存本篇）
    const storedMarkdown = db
      .select({ markdown: lectures.markdown })
      .from(lectures)
      .where(eq(lectures.id, lectureId))
      .get()?.markdown as string;
    expect(markdown.endsWith(storedMarkdown)).toBe(true);

    const preview = await request(
      app,
      "POST",
      "/api/teacher/import/preview",
      teacherCookie,
      {
        markdown,
        filename: "讲义导出.md",
      },
    );
    const previewBody = (await preview.json()) as {
      data: {
        summary: { lectureCount: number };
        issues: { level: string }[];
      };
    };
    expect(
      previewBody.data.issues.filter((i) => i.level === "error"),
    ).toHaveLength(0);
    expect(previewBody.data.summary.lectureCount).toBe(1);
  });
});
