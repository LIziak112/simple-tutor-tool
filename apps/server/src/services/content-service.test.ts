import { readFileSync } from "node:fs";
import type { ImportPreviewData } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  courseItems,
  courses,
  imports,
  knowledgePoints,
  lectures,
  libraryFolders,
  questionKnowledge,
  questions,
  units,
} from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import { commitImport, previewImport } from "./content-service.ts";

/**
 * ContentService 服务层测试（T1.10 验收项，createTestDb 内存库）：
 * - preview 不写库；v1/v2 版本识别与摘要；
 * - commit：导入 → 再导入同文件题目 version 递增且 id 不变（验收 1）；
 * - 有 error 时 commit 抛 LINT_ERROR（422，验收 2）；
 * - v1 文档可导入：经 toV2 落库、题数正确、再导入 version+1（验收 3）；
 * - mixed 文档：讲义 + 单元都入、lectureTitle 关联；讲义按标题替换；
 * - T2A.3：无 folderId/courseId 的导入落「未归类」、不再自动创建「默认课程」；
 *   courseId 不存在报错；跨单元同 id 更新；软删同 id 恢复。
 */

/** 读取仓库根 samples/ 下的样例文档 */
function loadSample(relative: string): string {
  return readFileSync(
    new URL(`../../../../samples/${relative}`, import.meta.url),
    "utf8",
  );
}

const PRACTICE_MD = loadSample("v2/练习样例.md");
const LECTURE_MD = loadSample("v2/讲义样例.md");
const MIXED_MD = loadSample("v2/混合样例.md");
const V1_MD = loadSample("v1/示例练习.md");

/** 练习样例 8 题的题型分布（缺省 id `练习四-N`，第 7 题显式 id=p4-q7） */
const PRACTICE_TYPE_DISTRIBUTION = {
  judge: 1,
  choice: 1,
  multi: 1,
  fill: 2,
  solve: 1,
  apply: 1,
  "find-error": 1,
};

/** 有 error 的练习文档（填空题没有任何 [[…]] 空，FILL_NO_BLANK） */
const BROKEN_MD = `---
kind: practice
unit: 练习
---

::::question{type=fill difficulty=2 knowledge="有理数加法"}
计算：$(-3)+7=$ 4。（答案忘了写进双方括号）
::::
`;

/** 生成单题判断练习文档（unit/题干可定制，用于跨单元与内容更新场景） */
function judgeDoc(unit: string, stem: string): string {
  return `---
kind: practice
unit: ${unit}
---

::::question{type=judge difficulty=1 id=shared-q}
${stem}[[正确]]
::::
`;
}

/** 练习样例 8 题的期望 id 集合 */
const PRACTICE_IDS = new Set([
  "练习四-1",
  "练习四-2",
  "练习四-3",
  "练习四-4",
  "练习四-5",
  "p4-q7",
  "练习四-7",
  "练习四-8",
]);

function allQuestionIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: questions.id })
      .from(questions)
      .all()
      .map((r) => r.id),
  );
}

describe("previewImport（不写库）", () => {
  it("v2 练习样例：version 2、摘要正确、无 error；库仍为空", () => {
    const db = createTestDb();
    const data: ImportPreviewData = previewImport(db, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    expect(data.version).toBe(2);
    expect(data.summary).toEqual({
      unitCount: 1,
      lectureCount: 0,
      questionCount: 8,
      typeDistribution: PRACTICE_TYPE_DISTRIBUTION,
    });
    expect(data.issues.filter((i) => i.level === "error")).toHaveLength(0);

    // 验收点：preview 不写库——七张内容表全部为空
    expect(db.select().from(courses).all()).toHaveLength(0);
    expect(db.select().from(lectures).all()).toHaveLength(0);
    expect(db.select().from(units).all()).toHaveLength(0);
    expect(db.select().from(questions).all()).toHaveLength(0);
    expect(db.select().from(knowledgePoints).all()).toHaveLength(0);
    expect(db.select().from(questionKnowledge).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("v1 示例练习：version 1、题数 8", () => {
    const db = createTestDb();
    const data = previewImport(db, {
      markdown: V1_MD,
      filename: "示例练习.md",
    });
    expect(data.version).toBe(1);
    expect(data.summary.unitCount).toBe(1);
    expect(data.summary.questionCount).toBe(8);
    expect(data.issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("mixed 混合样例：讲义 2 篇 + 单元 1 个 + 题 3 道", () => {
    const db = createTestDb();
    const data = previewImport(db, {
      markdown: MIXED_MD,
      filename: "混合样例.md",
    });
    expect(data.version).toBe(2);
    expect(data.summary).toEqual({
      unitCount: 1,
      lectureCount: 2,
      questionCount: 3,
      typeDistribution: { judge: 1, choice: 1, fill: 1 },
    });
  });

  it("讲义样例：lectureCount 2、无题目", () => {
    const db = createTestDb();
    const data = previewImport(db, {
      markdown: LECTURE_MD,
      filename: "讲义样例.md",
    });
    expect(data.summary).toEqual({
      unitCount: 0,
      lectureCount: 2,
      questionCount: 0,
      typeDistribution: {},
    });
  });

  it("有 error 的文档：preview 正常返回 issues（供前端标红），不抛异常", () => {
    const db = createTestDb();
    const data = previewImport(db, {
      markdown: BROKEN_MD,
      filename: "坏练习.md",
    });
    const errors = data.issues.filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((i) => i.code === "FILL_NO_BLANK")).toBe(true);
  });
});

describe("commitImport 基本路径（v2 练习样例）", () => {
  it("首次导入（无 folderId/courseId，T2A.3）：落未归类、不创建任何课程，单元与 8 题落库、知识点归一、imports 留档原文", () => {
    const db = createTestDb();
    const report = commitImport(db, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });

    // T2A.3（D17/D23-7）：「默认课程」自动创建分支已删除——不再新建任何课程
    expect(db.select().from(courses).all()).toHaveLength(0);
    expect(report.courseId).toBeNull();
    expect(report.folderId).toBeNull();

    // 报告：单元插入、题目 8 插入 0 更新
    expect(report.units).toEqual([
      { id: "练习四", title: "练习四", inserted: true, updated: false },
    ]);
    expect(report.questions).toEqual({ inserted: 8, updated: 0 });
    expect(report.lectures).toEqual([]);

    // 单元行：topic 来自 frontmatter；lectureTitle「第4讲」在库中无同名讲义 → 不关联。
    // folderId = null（未归类，D17）；courseId 不写入（@deprecated T2A）
    const unitRows = db.select().from(units).all();
    expect(unitRows).toHaveLength(1);
    expect(unitRows[0]).toMatchObject({
      id: "练习四",
      title: "练习四",
      topic: "有理数加减混合",
      lectureId: null,
      courseId: null,
      folderId: null,
    });
    // 未归类不是文件夹行（D2）
    expect(db.select().from(libraryFolders).all()).toHaveLength(0);
    // 无课程目录条目（未指定 addToCourse/courseId）
    expect(db.select().from(courseItems).all()).toHaveLength(0);

    // 题目行：8 题、version=1、id 与解析一致（含显式 id p4-q7）
    const questionRows = db.select().from(questions).all();
    expect(questionRows).toHaveLength(8);
    expect(allQuestionIds(db)).toEqual(PRACTICE_IDS);
    for (const row of questionRows) {
      expect(row.version).toBe(1);
      expect(row.deletedAt).toBeNull();
      expect(row.unitId).toBe("练习四");
      expect(row.sourceMd.length).toBeGreaterThan(0);
    }

    // 选择题结构化字段：选项 + 正确项（练习四-2 为 choice，正确项下标 1）
    const choice = db
      .select()
      .from(questions)
      .where(eq(questions.id, "练习四-2"))
      .get();
    expect(choice?.type).toBe("choice");
    expect(JSON.parse(choice?.optionsJson ?? "[]")).toHaveLength(4);
    expect(JSON.parse(choice?.answersJson ?? "{}")).toEqual({
      kind: "choice",
      index: 1,
    });

    // 知识考点：同名归一（练习样例 6 个不同考点、8 条关联）
    expect(db.select().from(knowledgePoints).all()).toHaveLength(6);
    expect(db.select().from(questionKnowledge).all()).toHaveLength(8);

    // imports 留档：原文（非空）、kind、报告 JSON；T2A.3 起含 folderId/sourcePath/batchId
    const importRows = db.select().from(imports).all();
    expect(importRows).toHaveLength(1);
    expect(importRows[0]?.id).toBe(report.importId);
    expect(importRows[0]?.filename).toBe("练习样例.md");
    expect(importRows[0]?.kind).toBe("practice");
    expect(importRows[0]?.rawMd).toBe(PRACTICE_MD);
    expect(importRows[0]?.folderId).toBeNull();
    expect(importRows[0]?.sourcePath).toBeNull();
    expect(importRows[0]?.batchId).toBeNull();
    expect(JSON.parse(importRows[0]?.reportJson ?? "{}")).toMatchObject({
      importId: report.importId,
      courseId: null,
    });
  });

  it("再导入同文件：题目 version+1 且 id 不变（验收 1）；单元更新不重复；知识点复用", () => {
    const db = createTestDb();
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
    const second = commitImport(db, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });

    expect(second.questions).toEqual({ inserted: 0, updated: 8 });
    expect(second.units).toEqual([
      { id: "练习四", title: "练习四", inserted: false, updated: true },
    ]);
    expect(second.courseId).toBeNull();

    // id 集合不变，version 全部 +1
    expect(allQuestionIds(db)).toEqual(PRACTICE_IDS);
    const rows = db.select().from(questions).all();
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.version).toBe(2);

    // 单元不重复、知识点不重复创建（同名复用）；仍未创建任何课程
    expect(db.select().from(units).all()).toHaveLength(1);
    expect(db.select().from(knowledgePoints).all()).toHaveLength(6);
    expect(db.select().from(courses).all()).toHaveLength(0);

    // 每次导入都留档
    expect(db.select().from(imports).all()).toHaveLength(2);
  });

  it("有 error 级 issue 时拒绝：422 LINT_ERROR + _issues；库无任何写入（验收 2）", () => {
    const db = createTestDb();
    const err = captureError(() =>
      commitImport(db, { markdown: BROKEN_MD, filename: "坏练习.md" }),
    );
    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(422);
    expect(httpErr.code).toBe("LINT_ERROR");
    const issues = (httpErr.extra?._issues ?? []) as unknown[];
    expect(issues.length).toBeGreaterThan(0);
    expect(httpErr.message).toContain("error");

    // 拒绝时连默认课程都不创建
    expect(db.select().from(courses).all()).toHaveLength(0);
    expect(db.select().from(imports).all()).toHaveLength(0);
    expect(db.select().from(questions).all()).toHaveLength(0);
  });

  it("courseId 不存在：404 COURSE_NOT_FOUND", () => {
    const db = createTestDb();
    const err = captureError(() =>
      commitImport(db, {
        markdown: PRACTICE_MD,
        filename: "练习样例.md",
        courseId: "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b",
      }),
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).code).toBe("COURSE_NOT_FOUND");
  });

  it("两次导入均未指定 courseId/folderId：都落未归类，courses 始终为 0（不再自动建默认课程）", () => {
    const db = createTestDb();
    const first = commitImport(db, { markdown: PRACTICE_MD, filename: "a.md" });
    const second = commitImport(db, { markdown: V1_MD, filename: "b.md" });
    expect(db.select().from(courses).all()).toHaveLength(0);
    expect(first.courseId).toBeNull();
    expect(second.courseId).toBeNull();
    expect(db.select().from(libraryFolders).all()).toHaveLength(0);
  });
});

describe("commitImport：v1 文档（验收 3）", () => {
  it("v1 原文经 toV2 落库：单元 练习四、8 题、知识点归一；imports.rawMd 存 v1 原文", () => {
    const db = createTestDb();
    const preview = previewImport(db, {
      markdown: V1_MD,
      filename: "示例练习.md",
    });
    expect(preview.version).toBe(1);

    const report = commitImport(db, {
      markdown: V1_MD,
      filename: "示例练习.md",
    });
    expect(report.questions).toEqual({ inserted: 8, updated: 0 });
    expect(report.units[0]?.id).toBe("练习四");

    const rows = db.select().from(questions).all();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.version === 1 && r.unitId === "练习四")).toBe(
      true,
    );
    // v1 题目 id：{单元id}-{题号}
    expect(allQuestionIds(db)).toEqual(
      new Set([
        "练习四-1",
        "练习四-2",
        "练习四-3",
        "练习四-4",
        "练习四-5",
        "练习四-6",
        "练习四-7",
        "练习四-8",
      ]),
    );
    // 知识点同名归一（示例练习 7 个不同考点、8 条关联）
    expect(db.select().from(knowledgePoints).all()).toHaveLength(7);
    expect(db.select().from(questionKnowledge).all()).toHaveLength(8);

    // 留档的是 v1 原文（不是转换后的 v2 文本）
    const importRow = db.select().from(imports).all()[0];
    expect(importRow?.rawMd).toBe(V1_MD);
    expect(importRow?.kind).toBe("practice");
  });

  it("再导入同一 v1 文件：题数不变、version+1、id 不变", () => {
    const db = createTestDb();
    commitImport(db, { markdown: V1_MD, filename: "示例练习.md" });
    const second = commitImport(db, {
      markdown: V1_MD,
      filename: "示例练习.md",
    });
    expect(second.questions).toEqual({ inserted: 0, updated: 8 });
    const rows = db.select().from(questions).all();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.version === 2)).toBe(true);
  });
});

describe("commitImport：mixed 文档（讲义 + 单元）", () => {
  it("讲义 2 篇与单元都入库；unit.lectureTitle 关联到最后一题所在讲义", () => {
    const db = createTestDb();
    const report = commitImport(db, {
      markdown: MIXED_MD,
      filename: "混合样例.md",
    });

    expect(report.lectures).toHaveLength(2);
    expect(report.lectures.every((l) => l.inserted)).toBe(true);
    expect(report.units).toEqual([
      { id: "随堂练习", title: "随堂练习", inserted: true, updated: false },
    ]);
    expect(report.questions).toEqual({ inserted: 3, updated: 0 });

    // 关联：混合样例最后一题在第2讲 数轴 → unit.lectureId 指向该讲义
    const lectureRows = db.select().from(lectures).all();
    expect(lectureRows.map((l) => l.title)).toEqual([
      "第1讲 有理数",
      "第2讲 数轴",
    ]);
    const unitRow = db.select().from(units).all()[0];
    const lecture2 = lectureRows.find((l) => l.title === "第2讲 数轴");
    expect(unitRow?.lectureId).toBe(lecture2?.id);

    // 讲义 markdown 保存原文（含 H1 标题行）
    for (const l of lectureRows) expect(l.markdown).toContain("#");
  });

  it("讲义按标题替换：同名讲义第二次导入 updated 且 markdown 被替换、id 不变", () => {
    const db = createTestDb();
    const oldMd = "---\nkind: lecture\n---\n\n# 第1讲 测试\n\n旧内容。\n";
    const newMd = "---\nkind: lecture\n---\n\n# 第1讲 测试\n\n新内容。\n";
    commitImport(db, { markdown: oldMd, filename: "讲义.md" });
    const second = commitImport(db, { markdown: newMd, filename: "讲义.md" });

    expect(second.lectures).toEqual([
      {
        id: second.lectures[0]?.id,
        title: "第1讲 测试",
        inserted: false,
        updated: true,
      },
    ]);
    const rows = db.select().from(lectures).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.markdown).toContain("新内容");
  });

  it("单元按 id 合并：同单元再导入（topic 变化）更新而不重复", () => {
    const db = createTestDb();
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
    const modified = PRACTICE_MD.replace(
      "topic: 有理数加减混合",
      "topic: 新主题",
    );
    const second = commitImport(db, {
      markdown: modified,
      filename: "练习样例.md",
    });
    expect(second.units).toEqual([
      { id: "练习四", title: "练习四", inserted: false, updated: true },
    ]);
    expect(db.select().from(units).all()).toHaveLength(1);
    expect(db.select().from(units).all()[0]?.topic).toBe("新主题");
  });
});

describe("commitImport：边界行为", () => {
  it("跨单元同 id 题目：按更新处理，unitId 随之更新到新单元（派单裁决 3）", () => {
    const db = createTestDb();
    commitImport(db, {
      markdown: judgeDoc("单元A", "$1>0$。"),
      filename: "a.md",
    });
    const second = commitImport(db, {
      markdown: judgeDoc("单元B", "$2>0$。"),
      filename: "b.md",
    });

    expect(second.questions).toEqual({ inserted: 0, updated: 1 });
    // 第二次导入报告只含当前文档的单元；两个单元都在库中
    expect(second.units.map((u) => u.id)).toEqual(["单元B"]);
    expect(
      db
        .select()
        .from(units)
        .all()
        .map((u) => u.id),
    ).toEqual(["单元A", "单元B"]);
    const row = db
      .select()
      .from(questions)
      .where(eq(questions.id, "shared-q"))
      .get();
    expect(row?.unitId).toBe("单元B");
    expect(row?.version).toBe(2);
    expect(row?.stemMd).toContain("$2>0$");
  });

  it("软删的同 id 题目再导入：恢复（deletedAt 清空）并 version+1，计入 updated", () => {
    const db = createTestDb();
    commitImport(db, {
      markdown: judgeDoc("单元A", "$1>0$。"),
      filename: "a.md",
    });
    db.update(questions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(questions.id, "shared-q"))
      .run();
    expect(db.select().from(questions).all()[0]?.deletedAt).not.toBeNull();

    const second = commitImport(db, {
      markdown: judgeDoc("单元A", "$1>0$。"),
      filename: "a.md",
    });
    expect(second.questions).toEqual({ inserted: 0, updated: 1 });
    const row = db
      .select()
      .from(questions)
      .where(eq(questions.id, "shared-q"))
      .get();
    expect(row?.deletedAt).toBeNull();
    expect(row?.version).toBe(2);
  });

  it("知识点变更后再导入：关联全量替换，旧关联不残留（同名考点复用）", () => {
    const db = createTestDb();
    const docA = `---
kind: practice
unit: 练习
---

::::question{type=judge difficulty=1 id=q1 knowledge="考点一"}
$1>0$。[[正确]]
::::
`;
    const docB = docA.replace('knowledge="考点一"', 'knowledge="考点三"');
    commitImport(db, { markdown: docA, filename: "a.md" });
    expect(db.select().from(questionKnowledge).all()).toHaveLength(1);

    commitImport(db, { markdown: docB, filename: "b.md" });
    const links = db.select().from(questionKnowledge).all();
    expect(links).toHaveLength(1);
    const points = db.select().from(knowledgePoints).all();
    expect(new Set(points.map((n) => n.name))).toEqual(
      new Set(["考点一", "考点三"]),
    );
  });
});

/** 捕获同步抛出的异常（不匹配则测试失败） */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常但没有");
}

describe("commitImport 的 T2A.1 兼容口径（courseId → 文件夹 + 课程目录条目）", () => {
  /** 一份单讲义 + 单单元的混合文档（judge 题；unit 由 frontmatter 声明，id=兼容练习） */
  const DOC = `---
kind: mixed
unit: 兼容练习
---

# 第9讲 测试

正文。

::::question{type=judge difficulty=1}
$1>0$。[[正确]]
::::
`;

  it("显式 courseId：内容进课程同名文件夹（无则建）+ 追加条目（讲义可见、单元隐藏）", () => {
    const db = createTestDb();
    const course = {
      id: crypto.randomUUID(),
      title: "目标课程",
      order: 0,
      createdAt: new Date().toISOString(),
    };
    db.insert(courses).values(course).run();

    const report = commitImport(db, {
      markdown: DOC,
      filename: "compat.md",
      courseId: course.id,
    });
    expect(report.courseId).toBe(course.id);

    // 同名文件夹自动创建，讲义/单元 folderId 指向它
    const folder = db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.name, "目标课程"))
      .get();
    expect(folder).toBeDefined();
    const lectureRow = db.select().from(lectures).all()[0];
    expect(lectureRow?.folderId).toBe(folder?.id);
    expect(lectureRow?.courseId).toBeNull();
    const unitRow = db.select().from(units).all()[0];
    expect(unitRow?.folderId).toBe(folder?.id);

    // 课程目录条目：讲义 visible=true、单元 visible=false，按导入顺序
    const items = db
      .select()
      .from(courseItems)
      .where(eq(courseItems.courseId, course.id))
      .all()
      .sort((a, b) => a.order - b.order);
    expect(items.map((row) => [row.kind, row.refId, row.visible])).toEqual([
      ["lecture", report.lectures[0]?.id, true],
      ["unit", "兼容练习", false],
    ]);
  });

  it("重复导入同文件：资源更新、目录条目不重复（跳过不报错）", () => {
    const db = createTestDb();
    const course = {
      id: crypto.randomUUID(),
      title: "条目复用课程",
      order: 0,
      createdAt: new Date().toISOString(),
    };
    db.insert(courses).values(course).run();
    const first = commitImport(db, {
      markdown: DOC,
      filename: "a.md",
      courseId: course.id,
    });
    const second = commitImport(db, {
      markdown: DOC,
      filename: "a.md",
      courseId: course.id,
    });

    expect(second.lectures[0]).toMatchObject({
      id: first.lectures[0]?.id,
      inserted: false,
      updated: true,
    });
    expect(second.units[0]).toMatchObject({
      id: "兼容练习",
      inserted: false,
      updated: true,
    });
    // 条目仍只有两条（唯一约束 + onConflictDoNothing）
    expect(db.select().from(courseItems).all()).toHaveLength(2);
  });

  it("同一单元导入到另一课程：保留原文件夹，两课程目录各自有条目", () => {
    const db = createTestDb();
    const courseA = {
      id: crypto.randomUUID(),
      title: "课程A",
      order: 0,
      createdAt: new Date().toISOString(),
    };
    const courseB = {
      id: crypto.randomUUID(),
      title: "课程B",
      order: 1,
      createdAt: new Date().toISOString(),
    };
    db.insert(courses).values([courseA, courseB]).run();

    commitImport(db, { markdown: DOC, filename: "a.md", courseId: courseA.id });
    commitImport(db, { markdown: DOC, filename: "b.md", courseId: courseB.id });

    // 单元只有一行，folderId 保持在课程A的文件夹（D18：命中保留原文件夹）；
    // 讲义按 (folder, title) 匹配——B 文件夹无同名 → 新建讲义行（两个独立资源）
    const unitRows = db.select().from(units).all();
    expect(unitRows).toHaveLength(1);
    const folderA = db
      .select()
      .from(libraryFolders)
      .where(eq(libraryFolders.name, "课程A"))
      .get();
    expect(unitRows[0]?.folderId).toBe(folderA?.id);
    expect(db.select().from(lectures).all()).toHaveLength(2);

    // 两个课程各有自己的条目（B 的讲义是新资源）
    const itemA = db
      .select()
      .from(courseItems)
      .where(eq(courseItems.courseId, courseA.id))
      .all();
    const itemB = db
      .select()
      .from(courseItems)
      .where(eq(courseItems.courseId, courseB.id))
      .all();
    expect(itemA.map((row) => row.kind)).toEqual(["lecture", "unit"]);
    expect(itemB.map((row) => row.kind)).toEqual(["lecture", "unit"]);
  });

  it("软删的讲义再导入同名：自动恢复（deletedAt 清空）并计入 updated", () => {
    const db = createTestDb();
    const first = commitImport(db, { markdown: DOC, filename: "a.md" });
    db.update(lectures)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(lectures.id, first.lectures[0]?.id ?? ""))
      .run();
    const second = commitImport(db, { markdown: DOC, filename: "a.md" });
    expect(second.lectures[0]).toMatchObject({
      id: first.lectures[0]?.id,
      updated: true,
    });
    const row = db
      .select()
      .from(lectures)
      .where(eq(lectures.id, first.lectures[0]?.id ?? ""))
      .get();
    expect(row?.deletedAt).toBeNull();
  });
});
