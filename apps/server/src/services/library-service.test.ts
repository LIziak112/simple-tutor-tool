import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  attempts,
  assignments,
  courseItems,
  courses,
  lectures,
  libraryFolders,
  students,
  units,
} from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  createFolder,
  deleteFolder,
  getLectureUsage,
  getUnitUsage,
  listFolders,
  renameFolder,
  reorderFolders,
  restoreLecture,
  restoreUnit,
  softDeleteLecture,
  softDeleteUnit,
} from "./library-service.ts";

/**
 * LibraryService 服务层测试（T2A.1）：文件夹 CRUD、资源软删/恢复、使用情况查询。
 * createTestDb（内存库 + 迁移 + 回填）直插数据后调服务函数断言。
 */

const T0 = "2026-09-01T00:00:00.000Z";
const NOW = "2026-09-27T12:00:00.000Z";

/** 基础 fixture：1 课程 + 1 文件夹 + 1 讲义 + 1 配套单元 */
function seedBase(db: Db): {
  courseId: string;
  folderId: string;
  lectureId: string;
  unitId: string;
} {
  const courseId = crypto.randomUUID();
  db.insert(courses)
    .values({ id: courseId, title: "初一上", order: 0, createdAt: T0 })
    .run();
  const folderId = crypto.randomUUID();
  db.insert(libraryFolders)
    .values({ id: folderId, name: "有理数", order: 0, createdAt: T0 })
    .run();
  const lectureId = crypto.randomUUID();
  db.insert(lectures)
    .values({
      id: lectureId,
      courseId,
      folderId,
      title: "第一讲",
      markdown: "# 第一讲",
      order: 0,
      updatedAt: T0,
    })
    .run();
  const unitId = "unit-a";
  db.insert(units)
    .values({
      id: unitId,
      courseId,
      folderId,
      lectureId,
      title: "有理数练习",
      order: 0,
      updatedAt: T0,
    })
    .run();
  return { courseId, folderId, lectureId, unitId };
}

/** 捕获同步异常（不匹配则失败） */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常但没有");
}

describe("LibraryService：文件夹 CRUD", () => {
  it("createFolder 追加到末尾；空名 422；重名 409 FOLDER_NAME_EXISTS", () => {
    const db = createTestDb();
    const first = createFolder(db, { name: "文件夹一" });
    const second = createFolder(db, { name: "  文件夹二  " });
    expect(first.order).toBe(0);
    expect(second.name).toBe("文件夹二");
    expect(second.order).toBe(1);

    const empty = captureError(() => createFolder(db, { name: "  " }));
    expect((empty as HttpError).status).toBe(422);

    const dup = captureError(() => createFolder(db, { name: "文件夹一" }));
    expect((dup as HttpError).status).toBe(409);
    expect((dup as HttpError).code).toBe("FOLDER_NAME_EXISTS");
  });

  it("renameFolder 改名生效；改成他名冲突 409；不存在 404", () => {
    const db = createTestDb();
    const a = createFolder(db, { name: "A" });
    createFolder(db, { name: "B" });
    expect(renameFolder(db, a.id, { name: "  A2  " }).name).toBe("A2");
    expect(listFolders(db).map((f) => f.name)).toEqual(["A2", "B"]);

    const conflict = captureError(() => renameFolder(db, a.id, { name: "B" }));
    expect((conflict as HttpError).code).toBe("FOLDER_NAME_EXISTS");

    const missing = captureError(() =>
      renameFolder(db, "no-such-folder", { name: "C" }),
    );
    expect((missing as HttpError).status).toBe(404);
    expect((missing as HttpError).code).toBe("FOLDER_NOT_FOUND");
  });

  it("deleteFolder：内容移入未归类（folderId 置 NULL）并返回移动数量；行删除", () => {
    const db = createTestDb();
    const { folderId, lectureId, unitId } = seedBase(db);
    // 再各加一个其他文件夹的讲义，确认只动目标文件夹
    const otherFolder = createFolder(db, { name: "其他" });
    const otherLectureId = crypto.randomUUID();
    db.insert(lectures)
      .values({
        id: otherLectureId,
        courseId: null,
        folderId: otherFolder.id,
        title: "别处的讲义",
        markdown: "# 别处",
        order: 0,
        updatedAt: T0,
      })
      .run();

    const result = deleteFolder(db, folderId);
    expect(result).toEqual({ movedLectures: 1, movedUnits: 1 });
    expect(db.select().from(lectures).where(eq(lectures.id, lectureId)).get()?.folderId).toBeNull();
    expect(db.select().from(units).where(eq(units.id, unitId)).get()?.folderId).toBeNull();
    expect(db.select().from(lectures).where(eq(lectures.id, otherLectureId)).get()?.folderId).toBe(otherFolder.id);
    expect(
      db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get(),
    ).toBeUndefined();

    const again = captureError(() => deleteFolder(db, folderId));
    expect((again as HttpError).status).toBe(404);
  });

  it("reorderFolders 按下标重写；未知 id 404", () => {
    const db = createTestDb();
    const a = createFolder(db, { name: "A" });
    const b = createFolder(db, { name: "B" });
    const c = createFolder(db, { name: "C" });
    reorderFolders(db, [c.id, a.id, b.id]);
    expect(listFolders(db).map((f) => f.name)).toEqual(["C", "A", "B"]);
    const bad = captureError(() => reorderFolders(db, [a.id, b.id, "ghost"]));
    expect((bad as HttpError).status).toBe(404);
  });
});

describe("LibraryService：资源软删与恢复（D3）", () => {
  it("softDeleteLecture 置 deletedAt 且幂等；restore 清空；未知 404", () => {
    const db = createTestDb();
    const { lectureId } = seedBase(db);
    softDeleteLecture(db, lectureId);
    const deletedAt = db
      .select({ deletedAt: lectures.deletedAt })
      .from(lectures)
      .where(eq(lectures.id, lectureId))
      .get()?.deletedAt;
    expect(deletedAt).not.toBeNull();

    softDeleteLecture(db, lectureId); // 幂等，不抛
    expect(
      db.select({ deletedAt: lectures.deletedAt }).from(lectures).where(eq(lectures.id, lectureId)).get()?.deletedAt,
    ).toBe(deletedAt);

    restoreLecture(db, lectureId);
    expect(
      db.select({ deletedAt: lectures.deletedAt }).from(lectures).where(eq(lectures.id, lectureId)).get()?.deletedAt,
    ).toBeNull();
    restoreLecture(db, lectureId); // 幂等

    const missing = captureError(() => softDeleteLecture(db, "no-such"));
    expect((missing as HttpError).status).toBe(404);
    expect((missing as HttpError).code).toBe("LECTURE_NOT_FOUND");
  });

  it("softDeleteUnit / restoreUnit 同语义（UNIT_NOT_FOUND）", () => {
    const db = createTestDb();
    const { unitId } = seedBase(db);
    softDeleteUnit(db, unitId);
    expect(
      db.select({ deletedAt: units.deletedAt }).from(units).where(eq(units.id, unitId)).get()?.deletedAt,
    ).not.toBeNull();
    softDeleteUnit(db, unitId); // 幂等
    restoreUnit(db, unitId);
    expect(
      db.select({ deletedAt: units.deletedAt }).from(units).where(eq(units.id, unitId)).get()?.deletedAt,
    ).toBeNull();
    const missing = captureError(() => restoreUnit(db, "no-such"));
    expect((missing as HttpError).code).toBe("UNIT_NOT_FOUND");
  });
});

describe("LibraryService：使用情况查询（D3 删除确认弹层数据源）", () => {
  /** 造使用场景：课程条目（可配置可见性/定时）+ 作业（可软删）+ 作答 */
  function seedUsage(db: Db): {
    courseId: string;
    unitId: string;
    lectureId: string;
    liveAssignmentId: string;
    deletedAssignmentId: string;
  } {
    const { courseId, lectureId, unitId } = seedBase(db);
    // 课程目录条目：讲义可见、单元隐藏
    db.insert(courseItems)
      .values([
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "lecture",
          refId: lectureId,
          title: null,
          order: 0,
          visible: true,
          publishAt: null,
          createdAt: T0,
        },
        {
          id: crypto.randomUUID(),
          courseId,
          kind: "unit",
          refId: unitId,
          title: null,
          order: 1,
          visible: false,
          publishAt: null,
          createdAt: T0,
        },
      ])
      .run();
    // 学生 + 两个作业（一活一删）+ 一条已交卷作答
    const studentId = crypto.randomUUID();
    db.insert(students)
      .values({
        id: studentId,
        displayName: "张三",
        loginName: "张三",
        linkToken: "tok-usage",
        linkEnabled: true,
        passwordEnabled: false,
        createdAt: T0,
      })
      .run();
    const liveAssignmentId = crypto.randomUUID();
    const deletedAssignmentId = crypto.randomUUID();
    db.insert(assignments)
      .values([
        { id: liveAssignmentId, unitId, title: "进行中的作业", dueAt: "2026-10-01T00:00:00.000Z", deletedAt: null, createdAt: T0 },
        { id: deletedAssignmentId, unitId, title: "已删作业", dueAt: null, deletedAt: T0, createdAt: T0 },
      ])
      .run();
    db.insert(attempts)
      .values({
        id: crypto.randomUUID(),
        studentId,
        assignmentId: liveAssignmentId,
        unitId,
        status: "submitted",
        startedAt: T0,
        submittedAt: T0,
      })
      .run();
    return { courseId, unitId, lectureId, liveAssignmentId, deletedAssignmentId };
  }

  it("getUnitUsage：课程引用（条目级可见性）+ 未删除作业 + 作答数；now 可注入", () => {
    const db = createTestDb();
    const { courseId, unitId, liveAssignmentId } = seedUsage(db);
    const usage = getUnitUsage(db, unitId, NOW);
    expect(usage.courses).toEqual([
      { courseId, courseTitle: "初一上", visible: false }, // 单元条目默认隐藏
    ]);
    expect(usage.assignments).toEqual([
      { id: liveAssignmentId, title: "进行中的作业", dueAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(usage.attemptCount).toBe(1);

    // 把单元条目改为可见 + 定时未来 → 仍未到点不可见；到点后可见
    db.update(courseItems)
      .set({ visible: true, publishAt: "2026-09-27T12:00:00.001Z" })
      .where(eq(courseItems.refId, unitId))
      .run();
    expect(getUnitUsage(db, unitId, NOW).courses[0]?.visible).toBe(false);
    db.update(courseItems)
      .set({ publishAt: "2026-09-27T12:00:00.000Z" })
      .where(eq(courseItems.refId, unitId))
      .run();
    expect(getUnitUsage(db, unitId, NOW).courses[0]?.visible).toBe(true);
  });

  it("getUnitUsage：单元不存在 404", () => {
    const db = createTestDb();
    const err = captureError(() => getUnitUsage(db, "ghost"));
    expect((err as HttpError).code).toBe("UNIT_NOT_FOUND");
  });

  it("getLectureUsage：课程引用可见；作答数经配套单元统计；assignments 恒空", () => {
    const db = createTestDb();
    const { courseId, lectureId } = seedUsage(db);
    const usage = getLectureUsage(db, lectureId, NOW);
    expect(usage.courses).toEqual([
      { courseId, courseTitle: "初一上", visible: true },
    ]);
    expect(usage.assignments).toEqual([]);
    expect(usage.attemptCount).toBe(1); // 配套单元 unit-a 上有一条作答

    const missing = captureError(() => getLectureUsage(db, "ghost"));
    expect((missing as HttpError).code).toBe("LECTURE_NOT_FOUND");
  });
});
