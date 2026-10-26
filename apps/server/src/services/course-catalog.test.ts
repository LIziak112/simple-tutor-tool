import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runBackfills } from "../db/backfill";
import {
  courseItems,
  courseStudents,
  courses,
  dataMigrations,
  lectures,
  students,
} from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import {
  ensureCourseFolderPath,
  executeCatalogCommand,
  uniqueCatalogTitle,
} from "./course-catalog";
import {
  appendCourseItems,
  getCourseDetail,
  listVisibleItems,
} from "./course-service";

const now = "2026-10-27T00:00:00.000Z";
function setup() {
  const db = createTestDb();
  const courseId = crypto.randomUUID();
  db.insert(courses)
    .values({
      id: courseId,
      teacherId: TEST_TEACHER_ID,
      title: "数学",
      order: 0,
      createdAt: now,
    })
    .run();
  const run = (command: Parameters<typeof executeCatalogCommand>[3]) =>
    executeCatalogCommand(db, TEST_TEACHER_ID, courseId, command);
  const folder = (title: string, parentId: string | null = null) =>
    run({ action: "createFolder", title, parentId }).id as string;
  return { db, courseId, run, folder };
}

describe("嵌套课程目录", () => {
  it("支持嵌套、课程内全局名称去重，拒绝循环与跨课程移动", () => {
    const { db, courseId, run, folder } = setup();
    const root = folder("第一章");
    const child = folder("基础", root);
    folder("基础");
    expect(
      getCourseDetail(db, TEST_TEACHER_ID, courseId).items.map((i) => i.title),
    ).toContain("基础（2）");
    expect(() =>
      run({ action: "move", ids: [root], parentId: child }),
    ).toThrow();
    expect(() =>
      run({ action: "move", ids: [child], parentId: crypto.randomUUID() }),
    ).toThrow();
    expect(() =>
      run({ action: "rename", id: child, title: "第一章" }),
    ).toThrow();
    expect(
      db.select().from(courseItems).where(eq(courseItems.id, child)).get()
        ?.parentId,
    ).toBe(root);
  });

  it("目标文件夹追加，解散保留资源和子树，重试不重复添加", () => {
    const { db, courseId, run, folder } = setup();
    const root = folder("章节");
    const child = folder("小节", root);
    const refId = crypto.randomUUID();
    db.insert(lectures)
      .values({
        id: refId,
        teacherId: TEST_TEACHER_ID,
        title: "章节",
        markdown: "# 正文",
        order: 0,
        updatedAt: now,
      })
      .run();
    appendCourseItems(
      db,
      TEST_TEACHER_ID,
      courseId,
      [{ kind: "lecture", refId }],
      { parentId: child },
    );
    expect(
      appendCourseItems(
        db,
        TEST_TEACHER_ID,
        courseId,
        [{ kind: "lecture", refId }],
        { parentId: child },
      ).added,
    ).toHaveLength(0);
    const item = getCourseDetail(db, TEST_TEACHER_ID, courseId).items.find(
      (i) => i.kind === "lecture",
    );
    expect(item).toMatchObject({ parentId: child, title: "章节（2）" });
    run({ action: "remove", ids: [root], keepChildren: true });
    expect(
      db.select().from(courseItems).where(eq(courseItems.id, child)).get()
        ?.parentId,
    ).toBeNull();
    expect(
      db.select().from(lectures).where(eq(lectures.id, refId)).get(),
    ).toBeDefined();
  });

  it("祖先隐藏或未到发布时间时不泄露后代，根目录内容不串组", () => {
    const { db, courseId, folder, run } = setup();
    const root = folder("隐藏章节");
    const child = folder("内部小节", root);
    const studentId = crypto.randomUUID();
    db.insert(students)
      .values({
        id: studentId,
        teacherId: TEST_TEACHER_ID,
        displayName: "学生",
        loginName: studentId,
        linkToken: studentId,
        createdAt: now,
      })
      .run();
    db.insert(courseStudents)
      .values({ courseId, studentId, joinedAt: now })
      .run();
    run({ action: "setVisibility", ids: [root], visible: false });
    expect(listVisibleItems(db, studentId, courseId)).toEqual([]);
    run({ action: "setVisibility", ids: [root], visible: true });
    db.update(courseItems)
      .set({ publishAt: "2099-01-01T00:00:00.000Z" })
      .where(eq(courseItems.id, root))
      .run();
    expect(
      listVisibleItems(db, studentId, courseId).some((i) => i.id === child),
    ).toBe(false);
  });
});

describe("目录导入与隔离", () => {
  it("已有文件夹首次复用后改名，导入重试仍复用同一路径", () => {
    const { db, courseId, run, folder } = setup();
    const root = folder("教材");
    const first = ensureCourseFolderPath(db, TEST_TEACHER_ID, courseId, null, [
      "教材",
      "基础",
    ]);
    run({ action: "rename", id: root, title: "教材归档" });
    expect(
      ensureCourseFolderPath(db, TEST_TEACHER_ID, courseId, null, [
        "教材",
        "基础",
      ]),
    ).toBe(first);
    expect(getCourseDetail(db, TEST_TEACHER_ID, courseId).items).toHaveLength(
      2,
    );
    expect(() =>
      ensureCourseFolderPath(db, TEST_TEACHER_ID, courseId, null, [".."]),
    ).toThrow();
  });
  it("越权和重复排序不产生部分写入；删除子树仅删除引用", () => {
    const { db, courseId, folder, run } = setup();
    const root = folder("根");
    const child = folder("子", root);
    expect(() =>
      executeCatalogCommand(db, "other-teacher", courseId, {
        action: "createFolder",
        title: "越权",
        parentId: null,
      }),
    ).toThrow();
    expect(() =>
      run({ action: "reorder", parentId: null, ids: [root, root] }),
    ).toThrow();
    expect(getCourseDetail(db, TEST_TEACHER_ID, courseId).items).toHaveLength(
      2,
    );
    run({ action: "remove", ids: [root], keepChildren: false });
    expect(
      db.select().from(courseItems).where(eq(courseItems.id, child)).get(),
    ).toBeUndefined();
  });
});

it("旧章节迁入父子目录保留条目 ID、顺序和发布设置，并且只运行一次", () => {
  const { db, courseId } = setup();
  const sectionId = crypto.randomUUID();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const refId = crypto.randomUUID();
  db.insert(lectures)
    .values({
      id: refId,
      teacherId: TEST_TEACHER_ID,
      title: "标题",
      markdown: "正文",
      order: 0,
      updatedAt: now,
    })
    .run();
  db.insert(courseItems)
    .values([
      {
        id: firstId,
        courseId,
        kind: "lecture",
        refId,
        order: 0,
        visible: true,
        createdAt: now,
      },
      {
        id: sectionId,
        courseId,
        kind: "section",
        title: "标题",
        order: 1,
        visible: false,
        createdAt: now,
      },
      {
        id: secondId,
        courseId,
        kind: "section",
        title: "标题",
        order: 3,
        visible: true,
        createdAt: now,
      },
    ])
    .run();
  const nestedId = crypto.randomUUID();
  db.insert(courseItems)
    .values({
      id: nestedId,
      courseId,
      kind: "unit",
      refId: "missing",
      order: 2,
      visible: false,
      createdAt: now,
    })
    .run();
  db.delete(dataMigrations)
    .where(eq(dataMigrations.key, "nested_course_catalog_v1"))
    .run();
  runBackfills(db);
  expect(
    db.select().from(courseItems).where(eq(courseItems.id, firstId)).get(),
  ).toMatchObject({ parentId: null, order: 0, visible: true });
  expect(
    db.select().from(courseItems).where(eq(courseItems.id, nestedId)).get(),
  ).toMatchObject({ parentId: sectionId, order: 2, visible: false });
  expect(
    db.select().from(courseItems).where(eq(courseItems.id, secondId)).get(),
  ).toMatchObject({ parentId: null, title: "标题（3）" });
  executeCatalogCommand(db, TEST_TEACHER_ID, courseId, {
    action: "move",
    ids: [nestedId],
    parentId: secondId,
  });
  runBackfills(db);
  expect(
    db.select().from(courseItems).where(eq(courseItems.id, nestedId)).get()
      ?.parentId,
  ).toBe(secondId);
});

it("课程引用保留资源完整长标题，去重不截断正文名称", () => {
  const title = "长标题".repeat(45);
  const used = new Set<string>();
  expect(uniqueCatalogTitle(title, used)).toBe(title);
  expect(uniqueCatalogTitle(title, used)).toBe(`${title}（2）`);
});
