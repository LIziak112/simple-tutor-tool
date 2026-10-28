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

/** 最小判断题（id 参与 buildImportPlan，其余填最小合法值；sourceMd 可定制围栏形态） */
function makeJudgeQuestion(
  id: string,
  sourceMd = "::::question\n::::",
): ParsedDocument["units"][number]["questions"][number] {
  return {
    id,
    type: "judge",
    difficulty: 1,
    stemMd: "题干",
    answers: { kind: "judge", value: true },
    knowledge: [],
    hints: [],
    sourceMd,
  };
}

/**
 * 练习文档（题块围栏形态可逐题定制，P2b 缺省题号错位预警用）：
 * explicitId 缺省 = 围栏无 id=（缺省派生 id，hasExplicitQuestionId=false）；
 * explicitId: true = 围栏带 id=（显式 id / lesson 导出注入形态）。
 */
function parsedUnitFences(
  unitId: string,
  questions: ReadonlyArray<{ id: string; explicitId?: boolean }>,
): ParsedDocument {
  return {
    frontmatter: { kind: "practice", dsl: 2, unit: unitId },
    units: [
      {
        id: unitId,
        title: unitId,
        questions: questions.map((q) =>
          makeJudgeQuestion(
            q.id,
            q.explicitId === true
              ? `::::question{id="${q.id}" type=judge}\n::::`
              : "::::question\n::::",
          ),
        ),
      },
    ],
    lectures: [],
    issues: [],
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
    // tt-06b / QM-05：材料/组快照字段（空域缺省）
    materials: new Map(),
    groups: new Map(),
    materialRefOwners: new Map(),
    liveMaterialIds: new Set(),
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
      // 题块围栏带显式 id：不触发缺省题号错位预警（P2b），本用例专注细分计数口径
      parsed: parsedUnitFences("练习四", [
        { id: "练习四-1", explicitId: true },
        { id: "练习四-9", explicitId: true },
      ]),
      folderId: FOLDER_B, // 目标文件夹与单元原文件夹不同 → 仍标注原文件夹
      snapshot: snapshot({
        units: new Map([
          [
            "练习四",
            {
              folderId: FOLDER_A,
              deletedAt: null,
              lectureId: null,
              title: "练习四",
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
      // 显式 id 围栏：不触发缺省题号错位预警（P2b），保持本用例原断言口径
      parsed: parsedUnitFences("练习四", [
        { id: "练习四-1", explicitId: true },
      ]),
      folderId: null,
      snapshot: snapshot({
        units: new Map([
          [
            "练习四",
            {
              folderId: null,
              deletedAt: "2026-09-01T00:00:00.000Z", // 回收站中
              lectureId: null,
              title: "练习四",
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
              lectureId: null,
              title: "练习四",
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
            kind: "lecture",
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
            kind: "lecture",
          },
          {
            id: "l2",
            title: "第1讲（回收站）",
            folderId: null,
            deletedAt: "2026-09-01T00:00:00.000Z",
            kind: "lecture",
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
            kind: "lecture",
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
            kind: "lecture",
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
            kind: "lecture",
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
            kind: "lecture",
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
      .values({
        id: FOLDER_A,
        teacherId: TEST_TEACHER_ID,
        name: "第一章",
        order: 0,
        createdAt: now,
      })
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
        teacherId: TEST_TEACHER_ID,
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
          teacherId: TEST_TEACHER_ID,
          unitId: null,
          title: "未截止（无 dueAt）",
          createdAt: now,
        },
        {
          id: "a2",
          teacherId: TEST_TEACHER_ID,
          unitId: null,
          title: "未截止（未来 dueAt）",
          dueAt: "2026-12-01T00:00:00.000Z",
          createdAt: now,
        },
        {
          id: "a3",
          teacherId: TEST_TEACHER_ID,
          unitId: null,
          title: "已截止",
          dueAt: "2026-01-01T00:00:00.000Z",
          createdAt: now,
        },
        {
          id: "a4",
          teacherId: TEST_TEACHER_ID,
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
      {
        id: "l1",
        title: "第1讲",
        folderId: null,
        deletedAt: null,
        kind: "lecture",
      },
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

describe("buildImportPlan：讲练页嵌入单元接管预检（2026-10-28 修复）", () => {
  /** 最小讲练文档：单讲 + 单元（lectureTitle 挂本讲），题 id 可定制 */
  function parsedLesson(
    unitId: string,
    lectureTitle: string,
    questionIds: string[],
  ): ParsedDocument {
    return {
      frontmatter: { kind: "lesson" as const, dsl: 2, unit: unitId },
      units: [
        {
          id: unitId,
          title: unitId,
          lectureTitle,
          questions: questionIds.map((id) => makeJudgeQuestion(id)),
        },
      ],
      lectures: [
        { title: lectureTitle, markdown: `# ${lectureTitle}`, headings: [] },
      ],
      issues: [],
    };
  }

  /** 快照里的讲练页 + 一个 live 嵌入单元（挂该页，题集可定制） */
  function lessonSnapshot(
    unitId: string,
    questionIds: string[],
    overrides: Partial<LibrarySnapshot> = {},
  ): LibrarySnapshot {
    return snapshot({
      lectures: [
        {
          id: "l-lesson",
          title: "第1讲 有理数",
          folderId: null,
          deletedAt: null,
          kind: "lesson",
        },
      ],
      units: new Map([
        [
          unitId,
          {
            title: unitId,
            folderId: null,
            deletedAt: null,
            lectureId: "l-lesson",
            allQuestionIds: new Set(questionIds),
            liveQuestionIds: new Set(questionIds),
          },
        ],
      ]),
      ...overrides,
    });
  }

  it("改名单元重导：LESSON_EMBEDDED_UNIT_SUPERSEDED（含旧单元名），新单元不误报 KEPT", () => {
    const plan = buildImportPlan({
      parsed: parsedLesson("随堂讲练0", "第1讲 有理数", ["随堂讲练0-1"]),
      folderId: null,
      snapshot: lessonSnapshot("随堂讲练", ["随堂讲练-1"]),
    });
    expect(
      plan.warnings.filter((w) => w.code === "LESSON_EMBEDDED_UNIT_SUPERSEDED"),
    ).toEqual([
      {
        code: "LESSON_EMBEDDED_UNIT_SUPERSEDED",
        message:
          "讲练页「第1讲 有理数」的旧随堂练习单元「随堂讲练」将被替换（移入回收站，作答历史保留）",
      },
    ]);
    // 旧单元不在文件里 → 无 updateUnit 动作，也不产生 KEPT_QUESTIONS
    expect(plan.warnings.some((w) => w.code === "KEPT_QUESTIONS")).toBe(false);
  });

  it("同单元改题号：LESSON_EMBEDDED_QUESTIONS_SUPERSEDED 计数 + updateUnit kept=0、无 KEPT warning", () => {
    const plan = buildImportPlan({
      parsed: parsedLesson("随堂讲练", "第1讲 有理数", ["q-renamed"]),
      folderId: null,
      snapshot: lessonSnapshot("随堂讲练", ["随堂讲练-1", "随堂讲练-2"]),
    });
    expect(
      plan.warnings.filter(
        (w) => w.code === "LESSON_EMBEDDED_QUESTIONS_SUPERSEDED",
      ),
    ).toEqual([
      {
        code: "LESSON_EMBEDDED_QUESTIONS_SUPERSEDED",
        message:
          "随堂练习单元「随堂讲练」中 2 道不在本次讲练页的题目将移出（移入回收站）",
      },
    ]);
    expect(plan.warnings.some((w) => w.code === "KEPT_QUESTIONS")).toBe(false);
    expect(plan.actions).toContainEqual({
      kind: "updateUnit",
      title: "随堂讲练",
      unitId: "随堂讲练",
      folderName: null,
      restore: false,
      questions: { inserted: 1, updated: 0, kept: 0 },
    });
  });

  it("快照讲义非 lesson（普通配套练习）：不触发接管，KEPT 语义照常", () => {
    const plan = buildImportPlan({
      parsed: parsedMixedWithSelfLecture("随堂讲练", "第1讲 有理数"),
      folderId: null,
      snapshot: lessonSnapshot("随堂讲练", ["随堂讲练-1", "随堂讲练-2"]),
    });
    expect(
      plan.warnings.some(
        (w) =>
          w.code === "LESSON_EMBEDDED_UNIT_SUPERSEDED" ||
          w.code === "LESSON_EMBEDDED_QUESTIONS_SUPERSEDED",
      ),
    ).toBe(false);
    expect(plan.warnings.some((w) => w.code === "KEPT_QUESTIONS")).toBe(true);
  });

  it("新讲练页（快照无同名）：无接管 warning", () => {
    const plan = buildImportPlan({
      parsed: parsedLesson("随堂讲练", "第2讲 新页", ["随堂讲练-1"]),
      folderId: null,
      snapshot: lessonSnapshot("别的单元", ["别的单元-1"]),
    });
    expect(plan.warnings).toEqual([]);
  });
});

describe("buildImportPlan：缺省题号错位预警（P2b DERIVED_ID_UPDATED_QUESTIONS）", () => {
  /** 库内单元快照（folderId/挂载缺省形态；题集可定制，all 与 live 同集） */
  function unitSnapshotOf(
    unitId: string,
    questionIds: string[],
  ): LibrarySnapshot {
    return snapshot({
      units: new Map([
        [
          unitId,
          {
            folderId: null,
            deletedAt: null,
            lectureId: null,
            title: unitId,
            allQuestionIds: new Set(questionIds),
            liveQuestionIds: new Set(questionIds),
          },
        ],
      ]),
    });
  }

  it("缺省 id 命中更新 → updatedDerived 计数 + DERIVED_ID_UPDATED_QUESTIONS 警告", () => {
    // 文件两题均未写显式 id（缺省派生 练习四-1 / 练习四-2），库中已有同 id 题
    const plan = buildImportPlan({
      parsed: parsedUnitFences("练习四", [
        { id: "练习四-1" },
        { id: "练习四-2" },
      ]),
      folderId: null,
      snapshot: unitSnapshotOf("练习四", ["练习四-1", "练习四-2"]),
    });
    const action = plan.actions.find((a) => a.unitId === "练习四");
    expect(action?.questions).toMatchObject({
      inserted: 0,
      updated: 2,
      updatedDerived: 2,
    });
    expect(plan.warnings).toContainEqual({
      code: "DERIVED_ID_UPDATED_QUESTIONS",
      message:
        "单元「练习四」有 2 道题使用缺省题号且将更新既有题：文件中插题/删题会使题号错位、学情张冠李戴；建议先导出一次（自动注入题号）再修改，或为题容器补显式 id",
    });
  });

  it("显式 id 更新 / 全新插入 / lesson 注入 id → updatedDerived 均 0 且不出该警告", () => {
    // ① 显式 id 更新：围栏带 id=，命中既有题 → updated 但不计 derived
    const explicit = buildImportPlan({
      parsed: parsedUnitFences("练习四", [
        { id: "练习四-1", explicitId: true },
      ]),
      folderId: null,
      snapshot: unitSnapshotOf("练习四", ["练习四-1"]),
    });
    const explicitAction = explicit.actions.find((a) => a.unitId === "练习四");
    expect(explicitAction?.questions).toMatchObject({
      inserted: 0,
      updated: 1,
    });
    expect(explicitAction?.questions?.updatedDerived ?? 0).toBe(0);
    expect(
      explicit.warnings.some((w) => w.code === "DERIVED_ID_UPDATED_QUESTIONS"),
    ).toBe(false);

    // ② 全新插入：缺省派生 id 但库中无此题 → inserted，不涉及更新
    const fresh = buildImportPlan({
      parsed: parsedUnitFences("练习五", [{ id: "练习五-9" }]),
      folderId: null,
      snapshot: unitSnapshotOf("练习五", ["练习五-1"]),
    });
    const freshAction = fresh.actions.find((a) => a.unitId === "练习五");
    expect(freshAction?.questions).toMatchObject({ inserted: 1, updated: 0 });
    expect(freshAction?.questions?.updatedDerived ?? 0).toBe(0);
    expect(
      fresh.warnings.some((w) => w.code === "DERIVED_ID_UPDATED_QUESTIONS"),
    ).toBe(false);

    // ③ lesson 注入 id：讲练文档题块围栏带 id=（lesson 导出恒注入形态），
    //    命中更新既有题也不告警（Review Focus 5：预警不误报）
    const lesson = buildImportPlan({
      parsed: {
        frontmatter: { kind: "lesson" as const, dsl: 2, unit: "随堂讲练" },
        units: [
          {
            id: "随堂讲练",
            title: "随堂讲练",
            lectureTitle: "第1讲 有理数",
            questions: [
              makeJudgeQuestion(
                "随堂讲练-1",
                '::::question{id="随堂讲练-1" type=judge}\n::::',
              ),
            ],
          },
        ],
        lectures: [
          { title: "第1讲 有理数", markdown: "# 第1讲 有理数", headings: [] },
        ],
        issues: [],
      },
      folderId: null,
      snapshot: unitSnapshotOf("随堂讲练", ["随堂讲练-1"]),
    });
    const lessonAction = lesson.actions.find((a) => a.unitId === "随堂讲练");
    expect(lessonAction?.questions).toMatchObject({ inserted: 0, updated: 1 });
    expect(lessonAction?.questions?.updatedDerived ?? 0).toBe(0);
    expect(
      lesson.warnings.some((w) => w.code === "DERIVED_ID_UPDATED_QUESTIONS"),
    ).toBe(false);
  });
});
