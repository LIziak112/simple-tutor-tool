import type { ParsedDocument } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  assignments,
  assignmentUnits,
  lectures,
  libraryFolders,
  questions,
  units,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import {
  buildImportPlan,
  type LibrarySnapshot,
  loadLibrarySnapshot,
} from "./import-actions.ts";

/**
 * 动作清单纯函数测试（T2A.3，D18/D19）：
 * buildImportPlan 不触碰数据库——快照用字面量构造，覆盖：
 * 新增/更新单元与讲义、保留题计数、回收站恢复标注、未截止作业 warning、
 * 其他文件夹同名讲义 warning；loadLibrarySnapshot 用内存库验证读库口径。
 */

const FOLDER_A = "11111111-1111-4111-8111-111111111111";
const FOLDER_B = "22222222-2222-4222-8222-222222222222";

/** 最小练习文档（1 单元 n 题；题内容只要 id 参与 buildImportPlan，其余填最小合法值） */
function parsedUnit(unitId: string, questionIds: string[]): ParsedDocument {
  return {
    frontmatter: { kind: "practice", dsl: 2, unit: unitId },
    units: [
      {
        id: unitId,
        title: unitId,
        questions: questionIds.map((id) => ({
          id,
          type: "judge" as const,
          difficulty: 1,
          stemMd: "题干",
          answers: { kind: "judge" as const, value: true },
          knowledge: [],
          hints: [],
          sourceMd: "::::question\n::::",
        })),
      },
    ],
    lectures: [],
    issues: [],
  };
}

/** 最小讲义文档 */
function parsedLecture(title: string): ParsedDocument {
  return {
    frontmatter: { kind: "lecture", dsl: 2 },
    units: [],
    lectures: [{ title, markdown: `# ${title}`, headings: [] }],
    issues: [],
  };
}

/** 最小判断题（id 参与 buildImportPlan，其余填最小合法值） */
function makeJudgeQuestion(
  id: string,
): ParsedDocument["units"][number]["questions"][number] {
  return {
    id,
    type: "judge",
    difficulty: 1,
    stemMd: "题干",
    answers: { kind: "judge", value: true },
    knowledge: [],
    hints: [],
    sourceMd: "::::question\n::::",
  };
}

/** 带配套讲义指针的练习文档（frontmatter lecture → unit.lectureTitle，本文件无讲义产出） */
function parsedUnitWithLecture(
  unitId: string,
  lectureTitle: string,
): ParsedDocument {
  return {
    frontmatter: {
      kind: "practice",
      dsl: 2,
      unit: unitId,
      lecture: lectureTitle,
    },
    units: [
      {
        id: unitId,
        title: unitId,
        lectureTitle,
        questions: [makeJudgeQuestion(`${unitId}-1`)],
      },
    ],
    lectures: [],
    issues: [],
  };
}

/** mixed 文档：单元配套指针指向本文件产出的讲义（title 为 title: 覆盖后的最终标题） */
function parsedMixedWithSelfLecture(
  unitId: string,
  lectureTitle: string,
): ParsedDocument {
  return {
    frontmatter: {
      kind: "mixed",
      dsl: 2,
      unit: unitId,
      title: lectureTitle,
      lecture: lectureTitle,
    },
    units: [
      {
        id: unitId,
        title: unitId,
        lectureTitle,
        questions: [makeJudgeQuestion(`${unitId}-1`)],
      },
    ],
    lectures: [
      { title: lectureTitle, markdown: `# ${lectureTitle}`, headings: [] },
    ],
    issues: [],
  };
}

function snapshot(overrides: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    units: new Map(),
    lectures: [],
    folderNameById: new Map([
      [FOLDER_A, "第一章"],
      [FOLDER_B, "第二章"],
    ]),
    openAssignmentCountByUnitId: new Map(),
    ...overrides,
  };
}

describe("buildImportPlan：单元动作（D18/D19）", () => {
  it("空库：createUnit，folderName = 目标文件夹；未归类为 null", () => {
    const plan = buildImportPlan({
      parsed: parsedUnit("练习四", ["练习四-1"]),
      folderId: FOLDER_A,
      snapshot: snapshot(),
    });
    expect(plan.actions).toEqual([
      {
        kind: "createUnit",
        title: "练习四",
        unitId: "练习四",
        folderName: "第一章",
        restore: false,
      },
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("命中同 id 单元：updateUnit，保留原文件夹（D18），题目细分 inserted/updated/kept", () => {
    const plan = buildImportPlan({
      parsed: parsedUnit("练习四", ["练习四-1", "练习四-9"]),
      folderId: FOLDER_B, // 目标文件夹与单元原文件夹不同 → 仍标注原文件夹
      snapshot: snapshot({
        units: new Map([
          [
            "练习四",
            {
              folderId: FOLDER_A,
              deletedAt: null,
              allQuestionIds: new Set(["练习四-1", "练习四-2", "练习四-3"]),
              liveQuestionIds: new Set(["练习四-1", "练习四-2", "练习四-3"]),
            },
          ],
        ]),
      }),
    });
    expect(plan.actions).toEqual([
      {
        kind: "updateUnit",
        title: "练习四",
        unitId: "练习四",
        folderName: "第一章", // 原文件夹，不是目标文件夹
        restore: false,
        questions: { inserted: 1, updated: 1, kept: 2 },
      },
    ]);
    // kept=2（练习四-2、-3 未出现在文件中）→ 保留 warning
    expect(plan.warnings).toEqual([
      {
        code: "KEPT_QUESTIONS",
        message: "单元「练习四」文件中未出现的 2 道已有题目将保留",
      },
    ]);
  });

  it("软删题目不算 kept（再导入即恢复）；软删单元 restore=true（回收站恢复）", () => {
    const plan = buildImportPlan({
      parsed: parsedUnit("练习四", ["练习四-1"]),
      folderId: null,
      snapshot: snapshot({
        units: new Map([
          [
            "练习四",
            {
              folderId: null,
              deletedAt: "2026-09-01T00:00:00.000Z", // 回收站中
              allQuestionIds: new Set(["练习四-1", "练习四-2"]),
              liveQuestionIds: new Set(["练习四-1"]), // -2 已软删
            },
          ],
        ]),
      }),
    });
    expect(plan.actions).toEqual([
      {
        kind: "updateUnit",
        title: "练习四",
        unitId: "练习四",
        folderName: null,
        restore: true,
        questions: { inserted: 0, updated: 1, kept: 0 },
      },
    ]);
    expect(plan.warnings).toEqual([]); // kept=0 无 warning
  });

  it("被未截止作业使用：UNIT_USED_BY_OPEN_ASSIGNMENTS warning（D19）", () => {
    const plan = buildImportPlan({
      parsed: parsedUnit("练习四", ["练习四-1"]),
      folderId: null,
      snapshot: snapshot({
        units: new Map([
          [
            "练习四",
            {
              folderId: null,
              deletedAt: null,
              allQuestionIds: new Set(["练习四-1"]),
              liveQuestionIds: new Set(["练习四-1"]),
            },
          ],
        ]),
        openAssignmentCountByUnitId: new Map([["练习四", 2]]),
      }),
    });
    expect(plan.warnings).toContainEqual({
      code: "UNIT_USED_BY_OPEN_ASSIGNMENTS",
      message:
        "该单元「练习四」被 2 个未截止作业使用：已交卷学生不受影响，未交卷学生将看到新版本",
    });
  });
});

describe("buildImportPlan：讲义动作（D18）", () => {
  it("目标文件夹已有同名：updateLecture（同文件夹匹配键）", () => {
    const plan = buildImportPlan({
      parsed: parsedLecture("第1讲"),
      folderId: FOLDER_A,
      snapshot: snapshot({
        lectures: [
          {
            id: "l1",
            title: "第1讲",
            folderId: FOLDER_A,
            deletedAt: null,
          },
        ],
      }),
    });
    expect(plan.actions).toEqual([
      {
        kind: "updateLecture",
        title: "第1讲",
        unitId: null,
        folderName: "第一章",
        restore: false,
      },
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("其他文件夹已有同名：createLecture + 重复导入 warning；命中回收站同名讲义 restore=true", () => {
    const plan = buildImportPlan({
      parsed: parsedLecture("第1讲"),
      folderId: null,
      snapshot: snapshot({
        lectures: [
          {
            id: "l1",
            title: "第1讲",
            folderId: FOLDER_B, // 其他文件夹
            deletedAt: null,
          },
          {
            id: "l2",
            title: "第1讲（回收站）",
            folderId: null,
            deletedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    });
    expect(plan.actions).toEqual([
      {
        kind: "createLecture",
        title: "第1讲",
        unitId: null,
        folderName: null,
        restore: false,
      },
    ]);
    expect(plan.warnings).toEqual([
      {
        code: "DUPLICATE_LECTURE_TITLE_IN_OTHER_FOLDER",
        message: "资源库「第二章」已有同名讲义「第1讲」，确认不是重复导入",
      },
    ]);

    // 未归类下命中回收站的同名讲义 → updateLecture + restore
    const plan2 = buildImportPlan({
      parsed: parsedLecture("第1讲（回收站）"),
      folderId: null,
      snapshot: snapshot({
        lectures: [
          {
            id: "l2",
            title: "第1讲（回收站）",
            folderId: null,
            deletedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    });
    expect(plan2.actions).toEqual([
      {
        kind: "updateLecture",
        title: "第1讲（回收站）",
        unitId: null,
        folderName: null,
        restore: true,
      },
    ]);
  });
});

describe("buildImportPlan：配套讲义悬空提示（LECTURE_LINK_UNRESOLVED，方案 §4）", () => {
  it("lecture 指向的讲义在目标文件夹与本文件中都不存在 → warning（文案含讲义名）", () => {
    const plan = buildImportPlan({
      parsed: parsedUnitWithLecture("练习四", "第4讲 有理数"),
      folderId: FOLDER_A,
      snapshot: snapshot(),
    });
    expect(plan.warnings).toContainEqual({
      code: "LECTURE_LINK_UNRESOLVED",
      message:
        "配套讲义「第4讲 有理数」在目标文件夹与本文件中都未找到：练习将暂不关联讲义；若讲义在其他文件夹或尚未导入，请调整后再试",
    });
  });

  it("指向本文件产出的讲义（title: 覆盖后的最终标题）→ 不出 warning", () => {
    const plan = buildImportPlan({
      parsed: parsedMixedWithSelfLecture("随堂练习", "第4讲 有理数"),
      folderId: FOLDER_A,
      snapshot: snapshot(),
    });
    expect(plan.warnings).toEqual([]);
  });

  it("指向目标文件夹已有同名讲义 → 不出 warning；其他文件夹同名不算；回收站同名同文件夹也算（commit 恢复后即关联）", () => {
    const base = { parsed: parsedUnitWithLecture("练习四", "第4讲 有理数") };

    // 目标文件夹命中（未删）
    const hit = buildImportPlan({
      ...base,
      folderId: FOLDER_A,
      snapshot: snapshot({
        lectures: [
          {
            id: "l1",
            title: "第4讲 有理数",
            folderId: FOLDER_A,
            deletedAt: null,
          },
        ],
      }),
    });
    expect(hit.warnings).toEqual([]);

    // 同名讲义在别的文件夹 → 匹配范围限同文件夹，仍悬空
    const miss = buildImportPlan({
      ...base,
      folderId: FOLDER_A,
      snapshot: snapshot({
        lectures: [
          {
            id: "l1",
            title: "第4讲 有理数",
            folderId: FOLDER_B,
            deletedAt: null,
          },
        ],
      }),
    });
    expect(miss.warnings.map((w) => w.code)).toContain(
      "LECTURE_LINK_UNRESOLVED",
    );

    // 回收站中的同名讲义（同文件夹）：commit 会恢复并关联，预览不提示悬空
    const recycled = buildImportPlan({
      ...base,
      folderId: FOLDER_A,
      snapshot: snapshot({
        lectures: [
          {
            id: "l1",
            title: "第4讲 有理数",
            folderId: FOLDER_A,
            deletedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    });
    expect(recycled.warnings).toEqual([]);
  });

  it("未声明 lecture（lectureTitle 缺省）→ 不参与悬空判定，无 warning", () => {
    const plan = buildImportPlan({
      parsed: parsedUnit("练习四", ["练习四-1"]),
      folderId: FOLDER_A,
      snapshot: snapshot(),
    });
    expect(plan.warnings).toEqual([]);
  });
});

describe("loadLibrarySnapshot：读库口径（内存库）", () => {
  it("单元/讲义/文件夹/未截止作业计数正确（截止与已删作业不计）", () => {
    const db = createTestDb();
    const now = "2026-09-27T00:00:00.000Z";
    db.insert(libraryFolders)
      .values({ id: FOLDER_A, name: "第一章", order: 0, createdAt: now })
      .run();
    db.insert(units)
      .values({
        id: "练习四",
        teacherId: TEST_TEACHER_ID,
        folderId: FOLDER_A,
        lectureId: null,
        title: "练习四",
        topic: null,
        order: 0,
        updatedAt: now,
      })
      .run();
    db.insert(questions)
      .values([
        {
          id: "练习四-1",
          teacherId: TEST_TEACHER_ID,
          unitId: "练习四",
          order: 0,
          type: "judge",
          difficulty: 1,
          stemMd: "题干",
          answersJson: "true",
          hintsJson: "[]",
          sourceMd: "::::question\n::::",
          version: 1,
          updatedAt: now,
        },
        {
          id: "练习四-2",
          teacherId: TEST_TEACHER_ID,
          unitId: "练习四",
          order: 1,
          type: "judge",
          difficulty: 1,
          stemMd: "题干",
          answersJson: "true",
          hintsJson: "[]",
          sourceMd: "::::question\n::::",
          version: 1,
          updatedAt: now,
          deletedAt: now, // 软删题：all 有、live 无
        },
      ])
      .run();
    db.insert(lectures)
      .values({
        id: "l1",
        folderId: null,
        title: "第1讲",
        markdown: "# 第1讲",
        order: 0,
        updatedAt: now,
      })
      .run();
    db.insert(assignments)
      .values([
        {
          id: "a1",
          unitId: null,
          title: "未截止（无 dueAt）",
          createdAt: now,
        },
        {
          id: "a2",
          unitId: null,
          title: "未截止（未来 dueAt）",
          dueAt: "2026-12-01T00:00:00.000Z",
          createdAt: now,
        },
        {
          id: "a3",
          unitId: null,
          title: "已截止",
          dueAt: "2026-01-01T00:00:00.000Z",
          createdAt: now,
        },
        {
          id: "a4",
          unitId: null,
          title: "已删除",
          createdAt: now,
          deletedAt: now,
        },
      ])
      .run();
    // T2A.7：作业内容走 assignment_units（assignments.unitId 废弃）
    db.insert(assignmentUnits)
      .values([
        { assignmentId: "a1", unitId: "练习四", order: 0 },
        { assignmentId: "a2", unitId: "练习四", order: 0 },
        { assignmentId: "a3", unitId: "练习四", order: 0 },
        { assignmentId: "a4", unitId: "练习四", order: 0 },
      ])
      .run();

    // T2B.1：快照按教师域过滤（测试库教师行由 createTestDb 种入）
    const snapshotLoaded = loadLibrarySnapshot(db, now, TEST_TEACHER_ID);
    const unit = snapshotLoaded.units.get("练习四");
    expect(unit).toBeDefined();
    expect(unit?.folderId).toBe(FOLDER_A);
    expect(unit?.deletedAt).toBeNull();
    expect([...(unit?.allQuestionIds ?? [])].sort()).toEqual([
      "练习四-1",
      "练习四-2",
    ]);
    expect([...(unit?.liveQuestionIds ?? [])]).toEqual(["练习四-1"]);
    expect(snapshotLoaded.lectures).toEqual([
      { id: "l1", title: "第1讲", folderId: null, deletedAt: null },
    ]);
    expect(snapshotLoaded.folderNameById.get(FOLDER_A)).toBe("第一章");
    expect(snapshotLoaded.openAssignmentCountByUnitId.get("练习四")).toBe(2);
  });

  it("纯函数 + 真实快照端到端：库中练习四（未删 1 题）再导入同 id 单元 → update + kept 提示", () => {
    const db = createTestDb();
    const now = "2026-09-27T00:00:00.000Z";
    db.insert(units)
      .values({
        id: "练习四",
        teacherId: TEST_TEACHER_ID,
        folderId: null,
        lectureId: null,
        title: "练习四",
        topic: null,
        order: 0,
        updatedAt: now,
      })
      .run();
    db.insert(questions)
      .values({
        id: "练习四-1",
        teacherId: TEST_TEACHER_ID,
        unitId: "练习四",
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "题干",
        answersJson: "true",
        hintsJson: "[]",
        sourceMd: "::::question\n::::",
        version: 1,
        updatedAt: now,
      })
      .run();
    expect(db.select({ id: questions.id }).from(questions).all()).toHaveLength(
      1,
    );

    const plan = buildImportPlan({
      parsed: parsedUnit("练习四", ["练习四-1"]),
      folderId: null,
      snapshot: loadLibrarySnapshot(db, now, TEST_TEACHER_ID),
    });
    expect(plan.actions[0]).toMatchObject({
      kind: "updateUnit",
      unitId: "练习四",
      questions: { inserted: 0, updated: 1, kept: 0 },
    });
    // 清理断言用（防 no-unused）：确认写库只发生在夹具
    expect(
      db
        .select({ id: units.id })
        .from(units)
        .where(eq(units.id, "练习四"))
        .all(),
    ).toHaveLength(1);
  });
});
