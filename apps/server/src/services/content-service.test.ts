import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportPreviewData } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  assignments,
  courseItems,
  courses,
  imports,
  knowledgePoints,
  lectures,
  libraryFolders,
  questionKnowledge,
  questions,
  students,
  teachers,
  units,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
  V1_LEGACY_MD,
} from "../db/test-utils.ts";
import { HttpError } from "../lib/http-error.ts";
import { createAssignment } from "./assignment-service.ts";
import {
  commitImport,
  createCourse,
  previewImport,
  previewImportBatch,
  updateLecture,
} from "./content-service.ts";
import { createFolder } from "./library-service.ts";
import { createStudent } from "./student-service.ts";

/**
 * ContentService 服务层测试（T1.10 验收项，createTestDb 内存库）：
 * - preview 不写库；摘要正确；
 * - commit：导入 → 再导入同文件题目 version 递增且 id 不变（验收 1）；
 * - 有 error 时 commit 抛 LINT_ERROR（422，验收 2）；
 * - v1 旧格式不再自动转换：按 v2 lint 直接报 MISSING_FRONTMATTER（2026-10-05
 *   移除 v1 兼容层后的新口径，见架构文档 §10 决策 10）；
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

/** 无 frontmatter.unit 的单题练习（单元名应由文件名兜底，内容模型与导入规范化方案 §2） */
const NO_UNIT_MD = `---
kind: practice
---

::::question{type=judge difficulty=1}
$1>0$。[[正确]]
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
  it("v2 练习样例：摘要正确、无 error；库仍为空", () => {
    const db = createTestDb();
    const data: ImportPreviewData = previewImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
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

  it("v1 旧格式不再自动转换：按 v2 lint 直接报 MISSING_FRONTMATTER error（2026-10-05 移除 v1 兼容层）", () => {
    const db = createTestDb();
    const data = previewImport(db, TEST_TEACHER_ID, {
      markdown: V1_LEGACY_MD,
      filename: "旧格式练习.md",
    });
    expect(
      data.issues.some(
        (i) => i.code === "MISSING_FRONTMATTER" && i.level === "error",
      ),
    ).toBe(true);
    expect(db.select().from(imports).all()).toHaveLength(0);
  });

  it("mixed 混合样例：讲义 2 篇 + 单元 1 个 + 题 3 道", () => {
    const db = createTestDb();
    const data = previewImport(db, TEST_TEACHER_ID, {
      markdown: MIXED_MD,
      filename: "混合样例.md",
    });
    expect(data.summary).toEqual({
      unitCount: 1,
      lectureCount: 2,
      questionCount: 3,
      typeDistribution: { judge: 1, choice: 1, fill: 1 },
    });
  });

  it("讲义样例：lectureCount 2、无题目", () => {
    const db = createTestDb();
    const data = previewImport(db, TEST_TEACHER_ID, {
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
    const data = previewImport(db, TEST_TEACHER_ID, {
      markdown: BROKEN_MD,
      filename: "坏练习.md",
    });
    const errors = data.issues.filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((i) => i.code === "FILL_NO_BLANK")).toBe(true);
  });
});

describe("导入单元名锚定文件名（内容模型与导入规范化方案 §2/§7 第 3 步，服务端接线）", () => {
  it("单文件 preview：无 unit + filename「练习四.md」→ 单元名 = 文件名去扩展名，issues 透传 UNIT_FROM_FALLBACK warning", () => {
    const db = createTestDb();
    const data = previewImport(db, TEST_TEACHER_ID, {
      markdown: NO_UNIT_MD,
      filename: "练习四.md",
    });
    expect(data.summary).toMatchObject({ unitCount: 1, questionCount: 1 });
    expect(data.actions).toEqual([
      {
        kind: "createUnit",
        title: "练习四",
        unitId: "练习四",
        folderName: null,
        restore: false,
      },
    ]);
    expect(
      data.issues.some(
        (i) => i.code === "UNIT_FROM_FALLBACK" && i.level === "warning",
      ),
    ).toBe(true);
  });

  it("文件名按规则派生：.markdown 大小写不敏感、取 basename、只剩扩展名则不兜底（回到解析器原兜底）", () => {
    const db = createTestDb();
    const withSubdir = previewImport(db, TEST_TEACHER_ID, {
      markdown: NO_UNIT_MD,
      filename: "第一章/有理数.MARKDOWN",
    });
    expect(withSubdir.actions[0]?.unitId).toBe("有理数");

    const dotOnly = previewImport(db, TEST_TEACHER_ID, {
      markdown: NO_UNIT_MD,
      filename: ".md",
    });
    expect(dotOnly.actions[0]?.unitId).toBe("unit");
  });

  it("frontmatter.unit 声明优先：不出现 UNIT_FROM_FALLBACK，单元名仍为 unit 值", () => {
    const db = createTestDb();
    const data = previewImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "别的名.md",
    });
    expect(data.issues.some((i) => i.code === "UNIT_FROM_FALLBACK")).toBe(
      false,
    );
    expect(data.actions[0]).toMatchObject({
      kind: "createUnit",
      unitId: "练习四",
      title: "练习四",
    });
  });

  it("批量 preview：path 含子目录 dir/abc.md 无 unit → 单元名锚定 basename「abc」；warning 级不置 hasError", () => {
    const db = createTestDb();
    const data = previewImportBatch(db, TEST_TEACHER_ID, {
      autoFolderBySubdir: false,
      files: [{ path: "dir/abc.md", markdown: NO_UNIT_MD }],
    });
    expect(data.files).toHaveLength(1);
    const entry = data.files[0];
    expect(entry?.preview.actions[0]).toMatchObject({
      kind: "createUnit",
      unitId: "abc",
      title: "abc",
    });
    expect(
      entry?.preview.issues.some((i) => i.code === "UNIT_FROM_FALLBACK"),
    ).toBe(true);
    expect(entry?.hasError).toBe(false);
  });

  it("commit：filename 兜底的单元名真正落库（units.id/title = 文件名去扩展名），缺省题目 id 前缀随之", () => {
    const db = createTestDb();
    const report = commitImport(db, TEST_TEACHER_ID, {
      markdown: NO_UNIT_MD,
      filename: "练习四.md",
    });
    expect(report.units).toEqual([
      { id: "练习四", title: "练习四", inserted: true, updated: false },
    ]);
    const unitRow = db.select().from(units).all()[0];
    expect(unitRow).toMatchObject({ id: "练习四", title: "练习四" });
    const questionRow = db.select().from(questions).all()[0];
    expect(questionRow).toMatchObject({ id: "练习四-1", unitId: "练习四" });
  });
});

describe("commitImport 基本路径（v2 练习样例）", () => {
  it("首次导入（无 folderId/courseId，T2A.3）：落未归类、不创建任何课程，单元与 8 题落库、知识点归一、imports 留档原文", () => {
    const db = createTestDb();
    const report = commitImport(db, TEST_TEACHER_ID, {
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
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    const second = commitImport(db, TEST_TEACHER_ID, {
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
      commitImport(db, TEST_TEACHER_ID, {
        markdown: BROKEN_MD,
        filename: "坏练习.md",
      }),
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
      commitImport(db, TEST_TEACHER_ID, {
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
    const first = commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "a.md",
    });
    const second = commitImport(db, TEST_TEACHER_ID, {
      markdown: MIXED_MD,
      filename: "b.md",
    });
    expect(db.select().from(courses).all()).toHaveLength(0);
    expect(first.courseId).toBeNull();
    expect(second.courseId).toBeNull();
    expect(db.select().from(libraryFolders).all()).toHaveLength(0);
  });
});

describe("commitImport：mixed 文档（讲义 + 单元）", () => {
  it("讲义 2 篇与单元都入库；unit.lectureTitle 关联到最后一题所在讲义", () => {
    const db = createTestDb();
    const report = commitImport(db, TEST_TEACHER_ID, {
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
    commitImport(db, TEST_TEACHER_ID, { markdown: oldMd, filename: "讲义.md" });
    const second = commitImport(db, TEST_TEACHER_ID, {
      markdown: newMd,
      filename: "讲义.md",
    });

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
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    const modified = PRACTICE_MD.replace(
      "topic: 有理数加减混合",
      "topic: 新主题",
    );
    const second = commitImport(db, TEST_TEACHER_ID, {
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

// ---------- T7.8：教学包声明的导入保存（方案 §4.6） ----------

/** 带教学包声明的 mixed 文档（讲义 + 单元各一，声明引用全部合法） */
const PACK_MIXED_MD = `---
kind: mixed
unit: 教学包单元
teachingPack: {name: "测试教学包", version: "2", directives: [steps, blank], validators: [judge, fill]}
---

# 第一讲 教学包

正文一段。

::::question{type=judge difficulty=1 id=tp-q1}
$1+1=2$。[[正确]]
::::
`;

/** 同文档去掉声明行（普通 MD 重导，应清空旧声明） */
const PACK_MIXED_PLAIN_MD = PACK_MIXED_MD.split("\n")
  .filter((line) => !line.startsWith("teachingPack:"))
  .join("\n");

describe("commitImport：教学包声明保存（T7.8）", () => {
  it("一次导入拆出的讲义与单元共享同一声明（teachingPackJson 落库）", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PACK_MIXED_MD,
      filename: "教学包.md",
    });

    const expected = JSON.stringify({
      formatVersion: 1,
      name: "测试教学包",
      version: "2",
      directives: ["steps", "blank"],
      validators: ["judge", "fill"],
    });
    const lectureRow = db.select().from(lectures).all()[0];
    expect(lectureRow?.teachingPackJson).toBe(expected);
    const unitRow = db.select().from(units).all()[0];
    expect(unitRow?.teachingPackJson).toBe(expected);
  });

  it("普通 MD 重导清空旧声明（更新与替换路径都覆盖）", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PACK_MIXED_MD,
      filename: "教学包.md",
    });
    const second = commitImport(db, TEST_TEACHER_ID, {
      markdown: PACK_MIXED_PLAIN_MD,
      filename: "教学包.md",
    });
    expect(second.lectures.every((l) => l.updated)).toBe(true);
    expect(second.units.every((u) => u.updated)).toBe(true);
    expect(db.select().from(lectures).all()[0]?.teachingPackJson).toBeNull();
    expect(db.select().from(units).all()[0]?.teachingPackJson).toBeNull();
  });

  it("重导新声明覆盖旧声明（更新路径）", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PACK_MIXED_MD,
      filename: "教学包.md",
    });
    const modified = PACK_MIXED_MD.replace(
      'teachingPack: {name: "测试教学包", version: "2", directives: [steps, blank], validators: [judge, fill]}',
      'teachingPack: {name: "改名包"}',
    );
    commitImport(db, TEST_TEACHER_ID, {
      markdown: modified,
      filename: "教学包.md",
    });
    const expected = JSON.stringify({
      formatVersion: 1,
      name: "改名包",
      version: "1",
      directives: [],
      validators: [],
    });
    expect(db.select().from(lectures).all()[0]?.teachingPackJson).toBe(expected);
    expect(db.select().from(units).all()[0]?.teachingPackJson).toBe(expected);
  });

  it("缺失引用阻断 preview 与直接 commit（commit 重新分析不可绕过）", () => {
    const db = createTestDb();
    const broken = PACK_MIXED_MD.replace(
      "directives: [steps, blank]",
      "directives: [steps, no-such-directive]",
    ).replace("validators: [judge, fill]", "validators: [judge, gpt]");

    const preview = previewImport(db, TEST_TEACHER_ID, {
      markdown: broken,
      filename: "教学包.md",
    });
    expect(
      preview.issues.filter((i) => i.code === "DIRECTIVE_REF_NOT_FOUND"),
    ).toHaveLength(1);
    expect(
      preview.issues.filter((i) => i.code === "VALIDATOR_REF_NOT_FOUND"),
    ).toHaveLength(1);

    expect(() =>
      commitImport(db, TEST_TEACHER_ID, {
        markdown: broken,
        filename: "教学包.md",
      }),
    ).toThrowError(HttpError);
    expect(db.select().from(units).all()).toHaveLength(0);
    expect(db.select().from(lectures).all()).toHaveLength(0);
  });

  it("正文编辑不触碰声明列：updateLecture 只换 markdown（声明保留）", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PACK_MIXED_MD,
      filename: "教学包.md",
    });
    const before = db.select().from(lectures).all()[0]?.teachingPackJson;
    updateLecture(db, TEST_TEACHER_ID, db.select().from(lectures).all()[0]?.id ?? "", {
      markdown: "# 第一讲 教学包\n\n编辑后的正文。\n",
    });
    expect(db.select().from(lectures).all()[0]?.teachingPackJson).toBe(before);
    expect(db.select().from(lectures).all()[0]?.markdown).toContain(
      "编辑后的正文",
    );
  });
});

describe("commitImport：边界行为", () => {
  it("跨单元同 id 题目：按更新处理，unitId 随之更新到新单元（派单裁决 3）", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: judgeDoc("单元A", "$1>0$。"),
      filename: "a.md",
    });
    const second = commitImport(db, TEST_TEACHER_ID, {
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
    commitImport(db, TEST_TEACHER_ID, {
      markdown: judgeDoc("单元A", "$1>0$。"),
      filename: "a.md",
    });
    db.update(questions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(questions.id, "shared-q"))
      .run();
    expect(db.select().from(questions).all()[0]?.deletedAt).not.toBeNull();

    const second = commitImport(db, TEST_TEACHER_ID, {
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
    commitImport(db, TEST_TEACHER_ID, { markdown: docA, filename: "a.md" });
    expect(db.select().from(questionKnowledge).all()).toHaveLength(1);

    commitImport(db, TEST_TEACHER_ID, { markdown: docB, filename: "b.md" });
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
      teacherId: TEST_TEACHER_ID,
      title: "目标课程",
      order: 0,
      createdAt: new Date().toISOString(),
    };
    db.insert(courses).values(course).run();

    const report = commitImport(db, TEST_TEACHER_ID, {
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
      teacherId: TEST_TEACHER_ID,
      title: "条目复用课程",
      order: 0,
      createdAt: new Date().toISOString(),
    };
    db.insert(courses).values(course).run();
    const first = commitImport(db, TEST_TEACHER_ID, {
      markdown: DOC,
      filename: "a.md",
      courseId: course.id,
    });
    const second = commitImport(db, TEST_TEACHER_ID, {
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
      teacherId: TEST_TEACHER_ID,
      title: "课程A",
      order: 0,
      createdAt: new Date().toISOString(),
    };
    const courseB = {
      id: crypto.randomUUID(),
      teacherId: TEST_TEACHER_ID,
      title: "课程B",
      order: 1,
      createdAt: new Date().toISOString(),
    };
    db.insert(courses).values([courseA, courseB]).run();

    commitImport(db, TEST_TEACHER_ID, {
      markdown: DOC,
      filename: "a.md",
      courseId: courseA.id,
    });
    commitImport(db, TEST_TEACHER_ID, {
      markdown: DOC,
      filename: "b.md",
      courseId: courseB.id,
    });

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
    const first = commitImport(db, TEST_TEACHER_ID, {
      markdown: DOC,
      filename: "a.md",
    });
    db.update(lectures)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(lectures.id, first.lectures[0]?.id ?? ""))
      .run();
    const second = commitImport(db, TEST_TEACHER_ID, {
      markdown: DOC,
      filename: "a.md",
    });
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

// ---------- T2B.1：单教师等价（创建入口写 teacherId + 域内匹配） ----------

/** 最小单题练习文档（unit u1、显式 id 题目 u1-1，带考点） */
const SCOPED_MD = `---
kind: practice
unit: u1
---

::::question{id=u1-1 type=judge difficulty=2 knowledge="有理数"}
$1>0$。[[正确]]
::::
`;

describe("T2B.1 单教师等价：创建入口写 teacherId（D9）", () => {
  it("文件夹/课程/学生/讲义/单元/题目/导入留档/作业的创建行 teacherId 均为唯一教师", async () => {
    const db = createTestDb();
    const folder = createFolder(db, TEST_TEACHER_ID, { name: "第一章" });
    const course = createCourse(db, TEST_TEACHER_ID, { title: "初一上" });
    const student = await createStudent(db, TEST_TEACHER_ID, {
      displayName: "张三",
      loginName: "张三",
    });
    commitImport(db, TEST_TEACHER_ID, {
      filename: "练习.md",
      markdown: SCOPED_MD,
    });
    const assignment = createAssignment(db, TEST_TEACHER_ID, {
      unitIds: ["u1"],
      studentIds: [student.student.id],
      title: "作业一",
    }).assignments[0];
    if (assignment === undefined) {
      throw new Error("创建作业未产出首份");
    }

    expect(
      db
        .select({ teacherId: libraryFolders.teacherId })
        .from(libraryFolders)
        .where(eq(libraryFolders.id, folder.id))
        .get()?.teacherId,
    ).toBe(TEST_TEACHER_ID);
    expect(
      db
        .select({ teacherId: courses.teacherId })
        .from(courses)
        .where(eq(courses.id, course.id))
        .get()?.teacherId,
    ).toBe(TEST_TEACHER_ID);
    expect(
      db
        .select({ teacherId: lectures.teacherId })
        .from(lectures)
        .all()
        .every((row) => row.teacherId === TEST_TEACHER_ID),
    ).toBe(true);
    expect(
      db
        .select({ teacherId: units.teacherId })
        .from(units)
        .where(eq(units.id, "u1"))
        .get()?.teacherId,
    ).toBe(TEST_TEACHER_ID);
    expect(
      db
        .select({ teacherId: questions.teacherId })
        .from(questions)
        .where(eq(questions.id, "u1-1"))
        .get()?.teacherId,
    ).toBe(TEST_TEACHER_ID);
    expect(
      db
        .select({ teacherId: imports.teacherId })
        .from(imports)
        .all()
        .every((row) => row.teacherId === TEST_TEACHER_ID),
    ).toBe(true);
    expect(
      db
        .select({ teacherId: assignments.teacherId })
        .from(assignments)
        .where(eq(assignments.id, assignment.id))
        .get()?.teacherId,
    ).toBe(TEST_TEACHER_ID);
    expect(
      db
        .select({ teacherId: questionKnowledge.teacherId })
        .from(questionKnowledge)
        .all()
        .every((row) => row.teacherId === TEST_TEACHER_ID),
    ).toBe(true);
    // 学生创建行（student-service，D14 归属创建教师）
    expect(
      db
        .select({ teacherId: students.teacherId })
        .from(students)
        .where(eq(students.id, student.student.id))
        .get()?.teacherId,
    ).toBe(TEST_TEACHER_ID);
    db.$client.close();
  });
});

describe("T2B.1 域内匹配（D10/D13：复合主键下按 (teacherId, dslId) 匹配）", () => {
  /** 手工造两教师域的同 dslId 冲突行：甲（=测试种子教师，createdAt 最早）与乙 */
  function seedTwoTeacherFixture(db: Db): void {
    const now = "2026-06-01T00:00:00.000Z";
    db.insert(teachers)
      .values({
        id: "th-b",
        loginName: "乙老师",
        isAdmin: false,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-06-01T00:00:00.000Z", // 晚于种子教师（2026-01-01）
      })
      .run();
    // 两域各持同 id 单元 u1 与题目 u1-1（内容/版本不同）
    for (const [teacherId, stem, version] of [
      [TEST_TEACHER_ID, "甲的题干", 3],
      ["th-b", "乙的题干", 1],
    ] as const) {
      db.insert(units)
        .values({
          id: "u1",
          teacherId,
          folderId: null,
          lectureId: null,
          title: `${teacherId === TEST_TEACHER_ID ? "甲" : "乙"}的单元`,
          topic: null,
          order: 0,
          updatedAt: now,
        })
        .run();
      db.insert(questions)
        .values({
          id: "u1-1",
          teacherId,
          unitId: "u1",
          order: 0,
          type: "judge",
          difficulty: 1,
          stemMd: stem,
          optionsJson: null,
          answersJson: '{"kind":"judge","value":true}',
          hintsJson: "[]",
          solutionMd: null,
          sourceMd: "::::question\n::::",
          version,
          updatedAt: now,
          deletedAt: null,
        })
        .run();
    }
  }

  it("同 teacherId 同 dslId 再导入：单元不重复、题目 version+1 且 id 不变", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      filename: "练习.md",
      markdown: SCOPED_MD,
    });
    commitImport(db, TEST_TEACHER_ID, {
      filename: "练习.md",
      markdown: SCOPED_MD,
    });

    expect(
      db.select({ id: units.id }).from(units).where(eq(units.id, "u1")).all(),
    ).toHaveLength(1);
    const question = db
      .select()
      .from(questions)
      .where(eq(questions.id, "u1-1"))
      .get();
    expect(question).toMatchObject({ id: "u1-1", version: 2 });
    db.$client.close();
  });

  it("两 teacherId 同 dslId 互不干扰：甲（会话教师）导入只更新甲域，乙域行数与内容不变", () => {
    const db = createTestDb();
    seedTwoTeacherFixture(db);
    const report = commitImport(db, TEST_TEACHER_ID, {
      filename: "练习.md",
      markdown: SCOPED_MD,
    });

    // 导入按会话教师（甲）执行：甲域命中更新，不新增行（unitTitle = frontmatter.unit = "u1"）
    expect(report.units).toEqual([
      { id: "u1", title: "u1", inserted: false, updated: true },
    ]);
    expect(report.questions).toEqual({ inserted: 0, updated: 1 });

    // 行数不变：units/questions 各恰 2 行（甲乙各一）
    expect(db.select({ id: units.id }).from(units).all()).toHaveLength(2);
    expect(db.select({ id: questions.id }).from(questions).all()).toHaveLength(
      2,
    );

    // 甲域：version 3→4、题干更新、标题更新、考点关联建立
    const questionA = db
      .select()
      .from(questions)
      .where(
        and(eq(questions.teacherId, TEST_TEACHER_ID), eq(questions.id, "u1-1")),
      )
      .get();
    expect(questionA).toMatchObject({ version: 4, stemMd: "$1>0$。[[正确]]" });
    expect(
      db
        .select({ title: units.title })
        .from(units)
        .where(and(eq(units.teacherId, TEST_TEACHER_ID), eq(units.id, "u1")))
        .get()?.title,
    ).toBe("u1");
    expect(
      db
        .select({ questionId: questionKnowledge.questionId })
        .from(questionKnowledge)
        .where(
          and(
            eq(questionKnowledge.teacherId, TEST_TEACHER_ID),
            eq(questionKnowledge.questionId, "u1-1"),
          ),
        )
        .all(),
    ).toHaveLength(1);

    // 乙域：version 仍 1、题干/标题原样、考点关联不被触碰（本域无关联行）
    const questionB = db
      .select()
      .from(questions)
      .where(and(eq(questions.teacherId, "th-b"), eq(questions.id, "u1-1")))
      .get();
    expect(questionB).toMatchObject({ version: 1, stemMd: "乙的题干" });
    expect(
      db
        .select({ title: units.title })
        .from(units)
        .where(and(eq(units.teacherId, "th-b"), eq(units.id, "u1")))
        .get()?.title,
    ).toBe("乙的单元");
    expect(
      db
        .select({ questionId: questionKnowledge.questionId })
        .from(questionKnowledge)
        .where(eq(questionKnowledge.teacherId, "th-b"))
        .all(),
    ).toHaveLength(0);
    db.$client.close();
  });

  it("乙导入与甲同 dslId 的相同文件：乙域内新增独立单元，甲的题数与 version 不变（T2B.3 验收）", () => {
    const db = createTestDb();
    // 只种甲域的 u1/u1-1（乙域为空）+ 乙教师行——乙导入同 dslId 文件应全新增
    const now = "2026-06-01T00:00:00.000Z";
    db.insert(teachers)
      .values({
        id: "th-b",
        loginName: "乙老师",
        isAdmin: false,
        disabledAt: null,
        passwordHash: null,
        apiToken: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      .run();
    db.insert(units)
      .values({
        id: "u1",
        teacherId: TEST_TEACHER_ID,
        folderId: null,
        lectureId: null,
        title: "甲的单元",
        topic: null,
        order: 0,
        updatedAt: now,
      })
      .run();
    db.insert(questions)
      .values({
        id: "u1-1",
        teacherId: TEST_TEACHER_ID,
        unitId: "u1",
        order: 0,
        type: "judge",
        difficulty: 1,
        stemMd: "甲的题干",
        optionsJson: null,
        answersJson: '{"kind":"judge","value":true}',
        hintsJson: "[]",
        solutionMd: null,
        sourceMd: "::::question\n::::",
        version: 3,
        updatedAt: now,
        deletedAt: null,
      })
      .run();

    const reportB = commitImport(db, "th-b", {
      filename: "练习.md",
      markdown: SCOPED_MD,
    });
    expect(reportB.units).toEqual([
      { id: "u1", title: "u1", inserted: true, updated: false },
    ]);
    expect(reportB.questions).toEqual({ inserted: 1, updated: 0 });

    // 甲域完全不受影响：题数不变（1 题）、version 仍 3、题干原样
    const questionA = db
      .select()
      .from(questions)
      .where(
        and(eq(questions.teacherId, TEST_TEACHER_ID), eq(questions.id, "u1-1")),
      )
      .get();
    expect(questionA).toMatchObject({ version: 3, stemMd: "甲的题干" });
    expect(
      db
        .select({ id: questions.id })
        .from(questions)
        .where(eq(questions.teacherId, TEST_TEACHER_ID))
        .all(),
    ).toHaveLength(1);
    // 乙域持有自己的 u1-1（version=1，导入内容）
    const questionB = db
      .select()
      .from(questions)
      .where(and(eq(questions.teacherId, "th-b"), eq(questions.id, "u1-1")))
      .get();
    expect(questionB).toMatchObject({ version: 1, stemMd: "$1>0$。[[正确]]" });
    db.$client.close();
  });
});

describe("导入图片存在性核对（IMAGE_SRC_NOT_FOUND，媒体管线第四单）", () => {
  /** 两个互不相同的 64 位小写 hex（严格契约形态） */
  const HASH_A = "ab".repeat(32);
  const HASH_B = "cd".repeat(32);
  const SRC_A = `blobs/media/${HASH_A}.png`;
  const SRC_B = `blobs/media/${HASH_B}.jpg`;

  /** 合法讲义文档：第 9 行引用图 A、第 13 行引用图 B、第 14 行重复引用图 A */
  const IMAGE_LECTURE_MD = [
    "---",
    "kind: lecture",
    "---",
    "",
    "# 图象讲义",
    "",
    "观察第一张图。",
    "",
    `::image{src="${SRC_A}"}`,
    "",
    "再看第二张图。",
    "",
    `::image{src="${SRC_B}"}`,
    `::image{alt="同图再引" src="${SRC_A}"}`,
    "",
  ].join("\n");

  /** 往临时 dataDir 种入一张「已上传」图片文件 */
  function seedMediaFile(dataDir: string, src: string): void {
    mkdirSync(join(dataDir, "blobs", "media"), { recursive: true });
    writeFileSync(join(dataDir, ...src.split("/")), new Uint8Array([1, 2, 3]));
  }

  it("未上传的严格形态引用：预览逐图报 warning（同图去重、行号=首次出现行、含路径与修复指引）", () => {
    const db = createTestDb();
    const data = previewImport(
      db,
      TEST_TEACHER_ID,
      { markdown: IMAGE_LECTURE_MD, filename: "图象讲义.md" },
      createTestDir(),
    );
    const notFound = data.issues.filter(
      (issue) => issue.code === "IMAGE_SRC_NOT_FOUND",
    );
    expect(notFound).toHaveLength(2); // 图 A 两次引用去重为一条
    expect(notFound[0]).toMatchObject({
      level: "warning",
      line: 9,
      column: 1,
      code: "IMAGE_SRC_NOT_FOUND",
    });
    expect(notFound[0]?.message).toContain(SRC_A);
    expect(notFound[0]?.message).toContain("一起在导入页选择导入");
    expect(notFound[1]).toMatchObject({ level: "warning", line: 13 });
    expect(notFound[1]?.message).toContain(SRC_B);
    expect(notFound[0]?.fix).toContain("blobs/media/");
    // 文档本身合法：除存在性 warning 外无其他 issue
    expect(
      data.issues.filter((issue) => issue.code !== "IMAGE_SRC_NOT_FOUND"),
    ).toEqual([]);
    db.$client.close();
  });

  it("dataDir 种入对应文件后不再告警（先导 md 后补图的工作流闭环）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    seedMediaFile(dataDir, SRC_A);
    seedMediaFile(dataDir, SRC_B);
    const data = previewImport(
      db,
      TEST_TEACHER_ID,
      { markdown: IMAGE_LECTURE_MD, filename: "图象讲义.md" },
      dataDir,
    );
    expect(data.issues).toEqual([]); // 文件齐了：0 issue
    db.$client.close();
  });

  it("部分缺失只报缺失的：种入图 A 后只剩图 B 一条", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    seedMediaFile(dataDir, SRC_A);
    const data = previewImport(
      db,
      TEST_TEACHER_ID,
      { markdown: IMAGE_LECTURE_MD, filename: "图象讲义.md" },
      dataDir,
    );
    expect(
      data.issues.filter((i) => i.code === "IMAGE_SRC_NOT_FOUND"),
    ).toHaveLength(1);
    expect(data.issues[0]?.message).toContain(SRC_B);
    db.$client.close();
  });

  it("旧式 blobs/fig-1.png 引用不触发本检查（无内容寻址文件名可核对，维持现状）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const md = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 旧式配图讲义",
      "",
      '::image{src="blobs/fig-1.png"}',
      "",
    ].join("\n");
    const data = previewImport(
      db,
      TEST_TEACHER_ID,
      { markdown: md, filename: "旧式配图讲义.md" },
      dataDir,
    );
    expect(
      data.issues.some(
        (i) =>
          i.code === "IMAGE_SRC_NOT_FOUND" || i.code === "IMAGE_SRC_NOT_BLOBS",
      ),
    ).toBe(false); // blobs/ 前缀豁免前缀规则，也无文件可核对
    db.$client.close();
  });

  it("commit 不被阻断：缺失图片照常落库（warning 仅提示，预览侧可见）", () => {
    const db = createTestDb();
    const report = commitImport(
      db,
      TEST_TEACHER_ID,
      { markdown: IMAGE_LECTURE_MD, filename: "图象讲义.md" },
      createTestDir(),
    );
    expect(report.lectures).toHaveLength(1);
    expect(report.lectures[0]?.inserted).toBe(true);
    db.$client.close();
  });

  it("dataDir 缺省时跳过核对（seed/无 DATA_DIR 语境的直调不因缺目录而报）", () => {
    const db = createTestDb();
    const data = previewImport(db, TEST_TEACHER_ID, {
      markdown: IMAGE_LECTURE_MD,
      filename: "图象讲义.md",
    });
    expect(data.issues.some((i) => i.code === "IMAGE_SRC_NOT_FOUND")).toBe(
      false,
    );
    db.$client.close();
  });

  it("批量预览：不同文件各自缺失各自报（每文件 issues 独立、hasError 不受 warning 影响）", () => {
    const db = createTestDb();
    const dataDir = createTestDir();
    const mdA = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 甲讲义",
      "",
      `::image{src="${SRC_A}"}`,
      "",
    ].join("\n");
    const mdB = [
      "---",
      "kind: lecture",
      "---",
      "",
      "# 乙讲义",
      "",
      `::image{src="${SRC_B}"}`,
      "",
    ].join("\n");
    const batch = previewImportBatch(
      db,
      TEST_TEACHER_ID,
      {
        autoFolderBySubdir: false,
        files: [
          { path: "甲.md", markdown: mdA },
          { path: "乙.md", markdown: mdB },
        ],
      },
      dataDir,
    );
    const issuesA = batch.files[0]?.preview.issues ?? [];
    const issuesB = batch.files[1]?.preview.issues ?? [];
    expect(issuesA).toHaveLength(1);
    expect(issuesA[0]).toMatchObject({ code: "IMAGE_SRC_NOT_FOUND", line: 7 });
    expect(issuesA[0]?.message).toContain(SRC_A);
    expect(issuesB).toHaveLength(1);
    expect(issuesB[0]?.message).toContain(SRC_B);
    // warning 不置 hasError（只有 error 级/跨文件冲突才标红）
    expect(batch.files.map((f) => f.hasError)).toEqual([false, false]);
    db.$client.close();
  });
});
