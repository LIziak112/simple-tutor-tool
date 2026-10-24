import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import {
  attemptContextSnapshots,
  attempts,
  lectures,
  materials,
  questionGroupMembers,
  questionGroups,
  questionKnowledge,
  questions,
  students,
  teachers,
} from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import { commitImport } from "./content-service.ts";
import {
  type ReparseReport,
  renderReparseReport,
  reparseAll,
} from "./reparse-service.ts";

/**
 * reparse 命令服务层测试（T1.14 验收：修改解析规则模拟升级后 reparse，
 * 字段更新、id 不变、无数据丢失）。模拟方式：createTestDb 导入样例后直接
 * UPDATE 库中结构化字段为「旧版解析器输出」（difficulty 改 5、hints 清空、
 * options 顺序打乱、考点关联删除），再跑 reparseAll 断言恢复。
 *
 * 覆盖：
 * 1. 模拟升级：字段被当前解析器输出恢复、id 不变、题数不变、version+1、
 *    sourceMd 未被修改；其余未受影响题目无变化（version 不动）；
 * 2. 干净库：全部无变化 → 0 更新、version/updatedAt 不动；
 * 3. --dry-run（dryRun: true）：报告有变更但不写库（重查验证）；
 * 4. 坏数据：sourceMd 被篡改成解析不出题 → 跳过并记原因、该题原样保留；
 * 5. 讲义：title 从 H1 重取，title 变化才更新（markdown 不动）；
 * 6. 软删题目不参与 reparse。
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
const LESSON_MD = loadSample("v2/讲练样例.md");

/** 练习样例 8 题的期望 id 集合（与 content-service.test 保持同一口径） */
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

function getQuestion(db: Db, id: string) {
  return db.select().from(questions).where(eq(questions.id, id)).get();
}

function allQuestionIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: questions.id })
      .from(questions)
      .all()
      .map((r) => r.id),
  );
}

describe("reparseAll：模拟解析器升级（验收核心）", () => {
  it("被篡改的结构化字段按当前解析器输出恢复：id 不变、题数不变、version+1、sourceMd 未动", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    const before = getQuestion(db, "练习四-2");
    expect(before).toBeDefined();
    if (before === undefined) return;
    const beforeIds = allQuestionIds(db);
    const beforeRowsById = new Map(
      db
        .select()
        .from(questions)
        .all()
        .map((r) => [r.id, r] as const),
    );
    const beforeKnowledgeCount = db
      .select()
      .from(questionKnowledge)
      .all().length;

    // 模拟「旧版解析器输出」：difficulty 抬到 5、hints 清空、options 顺序打乱、
    // 考点关联丢失（旧版不抽 knowledge 的情形）
    const oldOptions = JSON.parse(before.optionsJson ?? "[]") as unknown[];
    db.update(questions)
      .set({
        difficulty: 5,
        hintsJson: "[]",
        optionsJson: JSON.stringify([...oldOptions].reverse()),
        updatedAt: "2000-01-01T00:00:00.000Z",
      })
      .where(eq(questions.id, "练习四-2"))
      .run();
    db.delete(questionKnowledge)
      .where(eq(questionKnowledge.questionId, "练习四-2"))
      .run();

    const report = reparseAll(db, { dryRun: false });

    const after = getQuestion(db, "练习四-2");
    expect(after).toBeDefined();
    if (after === undefined) return;

    // 字段恢复为当前解析器输出
    expect(after.difficulty).toBe(before.difficulty); // 1（choice 题原难度）
    expect(JSON.parse(after.hintsJson)).toEqual(JSON.parse(before.hintsJson));
    expect(JSON.parse(after.optionsJson ?? "[]")).toEqual(
      JSON.parse(before.optionsJson ?? "[]"),
    );
    expect(after.type).toBe(before.type);
    expect(after.stemMd).toBe(before.stemMd);
    expect(after.answersJson).toBe(before.answersJson);
    expect(after.solutionMd).toBe(before.solutionMd);

    // id 不变、题目总数不变（无数据丢失）、version+1、sourceMd 未被修改
    expect(after.id).toBe("练习四-2");
    expect(after.unitId).toBe(before.unitId);
    expect(after.order).toBe(before.order);
    expect(allQuestionIds(db)).toEqual(beforeIds);
    expect(db.select().from(questions).all()).toHaveLength(8);
    expect(after.version).toBe(before.version + 1);
    expect(after.sourceMd).toBe(before.sourceMd);
    expect(after.updatedAt > before.updatedAt).toBe(true);

    // 考点关联恢复（归一复用：knowledge_points 不新建）
    expect(db.select().from(questionKnowledge).all()).toHaveLength(
      beforeKnowledgeCount,
    );

    // 其余 7 题无变化：version 保持 1、updatedAt 保持导入时的值
    for (const id of PRACTICE_IDS) {
      if (id === "练习四-2") continue;
      const row = getQuestion(db, id);
      expect(row?.version).toBe(1);
      expect(row?.updatedAt).toBe(beforeRowsById.get(id)?.updatedAt);
    }

    // 报告：该题 updated，变更字段含 difficulty/hints/options/knowledge
    const result = report.questions.find((r) => r.id === "练习四-2");
    expect(result?.status).toBe("updated");
    const fields = result?.changes.map((c) => c.field) ?? [];
    expect(fields).toContain("difficulty");
    expect(fields).toContain("hints");
    expect(fields).toContain("options");
    expect(fields).toContain("knowledge");
    const difficultyChange = result?.changes.find(
      (c) => c.field === "difficulty",
    );
    expect(difficultyChange?.from).toContain("5");
    expect(difficultyChange?.to).toContain("1");
    // 其余题为 unchanged
    expect(
      report.questions.filter((r) => r.status === "unchanged"),
    ).toHaveLength(7);
    expect(report.questions).toHaveLength(8);
    expect(report.dryRun).toBe(false);
  });
});

describe("reparseAll：讲练页（kind: lesson，2026-10 讲练一体）", () => {
  it("lesson 讲义按存储 kind 重解析，不被 QUESTION_IN_LECTURE 误跳过；题块保留、全部 unchanged", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: LESSON_MD,
      filename: "讲练样例.md",
    });
    const beforeLectures = db.select().from(lectures).all();
    // 讲练样例双 H1 → 两篇讲义（各自正文含注入 id 的题块）
    expect(beforeLectures.length).toBeGreaterThanOrEqual(1);
    expect(
      beforeLectures.every(
        (row) => row.kind === "lesson" && row.markdown.includes("::::question"),
      ),
    ).toBe(true);
    const beforeQuestions = db.select().from(questions).all();

    const report = reparseAll(db, { dryRun: false });

    // 不出现 skipped（修复前：按 lecture 语境包装 → QUESTION_IN_LECTURE error → skipped）
    expect(report.lectures.every((r) => r.status === "unchanged")).toBe(true);
    expect(report.questions.every((r) => r.status === "unchanged")).toBe(true);
    // 题块仍原位保留（重解析不改讲义 markdown），题目行数不变
    const afterLectures = db.select().from(lectures).all();
    expect(afterLectures.map((r) => r.markdown)).toEqual(
      beforeLectures.map((r) => r.markdown),
    );
    expect(db.select().from(questions).all()).toHaveLength(
      beforeQuestions.length,
    );
  });
});

describe("reparseAll：干净库（全部无变化）", () => {
  it("0 更新：version 与 updatedAt 全部不动，讲义与题目都报告 unchanged", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    commitImport(db, TEST_TEACHER_ID, {
      markdown: LECTURE_MD,
      filename: "讲义样例.md",
    });
    const beforeRows = db.select().from(questions).all();
    const beforeLectures = db.select().from(lectures).all();

    const report = reparseAll(db, { dryRun: false });

    expect(report.questions.every((r) => r.status === "unchanged")).toBe(true);
    expect(report.lectures.every((r) => r.status === "unchanged")).toBe(true);
    const afterRows = db.select().from(questions).all();
    for (const row of afterRows) {
      const before = beforeRows.find((r) => r.id === row.id);
      expect(row.version).toBe(before?.version);
      expect(row.updatedAt).toBe(before?.updatedAt);
    }
    const afterLectures = db.select().from(lectures).all();
    for (const row of afterLectures) {
      const before = beforeLectures.find((r) => r.id === row.id);
      expect(row.updatedAt).toBe(before?.updatedAt);
    }
  });
});

describe("reparseAll：--dry-run", () => {
  it("报告变更但不写库：重查字段仍为篡改值、version 不变、报告标注 dryRun", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });

    db.update(questions)
      .set({ difficulty: 5 })
      .where(eq(questions.id, "练习四-2"))
      .run();
    const lectureBefore = db.select().from(lectures).all();

    const report = reparseAll(db, { dryRun: true });

    expect(report.dryRun).toBe(true);
    // 报告仍列出该题的变更
    const result = report.questions.find((r) => r.id === "练习四-2");
    expect(result?.status).toBe("updated");
    expect(result?.changes.some((c) => c.field === "difficulty")).toBe(true);

    // 库未被写入：difficulty 仍为 5、version 仍为 1
    const row = getQuestion(db, "练习四-2");
    expect(row?.difficulty).toBe(5);
    expect(row?.version).toBe(1);

    // 渲染文本明确标注「未写入」
    const text = renderReparseReport(report);
    expect(text).toContain("未写入");
    expect(text).toContain("练习四-2");
    expect(text).toContain("difficulty");

    // 讲义无人变更（讲义样例未导入，仅练习）
    expect(lectureBefore).toHaveLength(0);
  });

  it("讲义 title 篡改后 dry-run 同样不写库", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: LECTURE_MD,
      filename: "讲义样例.md",
    });
    const first = db.select().from(lectures).all()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    db.update(lectures)
      .set({ title: "被篡改的标题" })
      .where(eq(lectures.id, first.id))
      .run();

    reparseAll(db, { dryRun: true });

    const row = db
      .select()
      .from(lectures)
      .where(eq(lectures.id, first.id))
      .get();
    expect(row?.title).toBe("被篡改的标题");
  });
});

describe("reparseAll：坏数据防御", () => {
  it("sourceMd 被篡改成解析不出题：跳过并记中文原因，该题原样保留、version 不变", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    const before = getQuestion(db, "练习四-2");
    expect(before).toBeDefined();
    if (before === undefined) return;

    // 篡改：sourceMd 变成解析不出题目的文本，同时把 difficulty 改坏
    db.update(questions)
      .set({ sourceMd: "这段文本里没有任何题目容器。", difficulty: 5 })
      .where(eq(questions.id, "练习四-2"))
      .run();

    const report = reparseAll(db, { dryRun: false });

    const result = report.questions.find((r) => r.id === "练习四-2");
    expect(result?.status).toBe("skipped");
    expect(result?.reason).toContain("未解析出");

    // 原样保留：坏值不动、version 不动、行还在（无数据丢失）
    const row = getQuestion(db, "练习四-2");
    expect(row?.difficulty).toBe(5);
    expect(row?.sourceMd).toBe("这段文本里没有任何题目容器。");
    expect(row?.version).toBe(before.version);
    expect(db.select().from(questions).all()).toHaveLength(8);

    // 其余题目照常检查（全部无变化）
    expect(
      report.questions.filter((r) => r.status === "unchanged"),
    ).toHaveLength(7);
  });

  it("软删题目不参与 reparse：不检查、不更新", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    db.update(questions)
      .set({ deletedAt: new Date().toISOString(), difficulty: 5 })
      .where(eq(questions.id, "练习四-2"))
      .run();

    const report = reparseAll(db, { dryRun: false });

    expect(report.questions).toHaveLength(7);
    expect(report.questions.some((r) => r.id === "练习四-2")).toBe(false);
    const row = getQuestion(db, "练习四-2");
    expect(row?.difficulty).toBe(5); // 软删行不被触碰
  });
});

describe("reparseAll：讲义 title 重取", () => {
  it("title 被篡改后从 markdown 的 H1 恢复：markdown 不动、updatedAt 刷新；title 未变的讲义不动", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: LECTURE_MD,
      filename: "讲义样例.md",
    });
    const rows = db.select().from(lectures).all();
    expect(rows).toHaveLength(2);
    const first = rows[0];
    const second = rows[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    db.update(lectures)
      .set({ title: "手工改坏的标题" })
      .where(eq(lectures.id, first.id))
      .run();

    const report = reparseAll(db, { dryRun: false });

    // 被篡改的讲义：title 恢复为 H1 原文、markdown 未动、updatedAt 刷新
    const afterFirst = db
      .select()
      .from(lectures)
      .where(eq(lectures.id, first.id))
      .get();
    expect(afterFirst).toBeDefined();
    if (afterFirst === undefined) return;
    expect(afterFirst.title).toBe(first.title);
    expect(afterFirst.markdown).toBe(first.markdown);
    expect(afterFirst.updatedAt > first.updatedAt).toBe(true);

    // 未篡改的讲义：unchanged、updatedAt 不动
    const afterSecond = db
      .select()
      .from(lectures)
      .where(eq(lectures.id, second.id))
      .get();
    expect(afterSecond?.updatedAt).toBe(second.updatedAt);

    const firstResult = report.lectures.find((r) => r.id === first.id);
    expect(firstResult?.status).toBe("updated");
    expect(firstResult?.changes[0]?.field).toBe("title");
    expect(firstResult?.changes[0]?.from).toContain("手工改坏的标题");
    // 展示值统一 JSON 形态（字符串带引号）
    expect(firstResult?.changes[0]?.to).toBe(JSON.stringify(first.title));
    expect(report.lectures.find((r) => r.id === second.id)?.status).toBe(
      "unchanged",
    );
  });

  it("markdown 被篡改成无 H1：跳过并记原因、行原样保留", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: LECTURE_MD,
      filename: "讲义样例.md",
    });
    const first = db.select().from(lectures).all()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    db.update(lectures)
      .set({ markdown: "没有标题的正文。" })
      .where(eq(lectures.id, first.id))
      .run();

    const report = reparseAll(db, { dryRun: false });

    const result = report.lectures.find((r) => r.id === first.id);
    expect(result?.status).toBe("skipped");
    expect(typeof result?.reason === "string" && result.reason.length > 0).toBe(
      true,
    );
    const row = db
      .select()
      .from(lectures)
      .where(eq(lectures.id, first.id))
      .get();
    expect(row?.markdown).toBe("没有标题的正文。");
    expect(row?.title).toBe(first.title);
  });
});

describe("renderReparseReport：变更摘要输出", () => {
  it("包含总计统计与 dry-run 标注（写入模式无「未写入」字样）", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: PRACTICE_MD,
      filename: "练习样例.md",
    });
    db.update(questions)
      .set({ difficulty: 5 })
      .where(eq(questions.id, "练习四-2"))
      .run();

    const written: ReparseReport = reparseAll(db, { dryRun: false });
    const text = renderReparseReport(written);
    expect(text).toContain("检查 8 题");
    expect(text).toContain("更新 1 题");
    expect(text).toContain("无变化 7 题");
    expect(text).not.toContain("未写入");

    const dry: ReparseReport = reparseAll(db, { dryRun: true });
    expect(renderReparseReport(dry)).toContain("未写入");
  });
});

describe("T2B.3：按教师分组遍历（每位教师的域独立分析、独立写入）", () => {
  /** 最小单题练习（unit dup、题 dup-1），difficulty 可篡改以制造两组各一题待更新 */
  const DUP_MD = `---
kind: practice
unit: dup
---

::::question{type=judge difficulty=1 id=dup-1}
$1>0$。[[正确]]
::::
`;

  it("两教师各持同 id 题（内容相同、篡改各自 difficulty）：两题都独立恢复，id 不串域", () => {
    const db = createTestDb();
    db.insert(teachers)
      .values({
        id: "th-reparse-b",
        loginName: "乙老师",
        isAdmin: false,
        disabledAt: null,
        passwordHash: "scrypt$fixture",
        apiToken: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      .run();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: DUP_MD,
      filename: "a.md",
    });
    commitImport(db, "th-reparse-b", {
      markdown: DUP_MD,
      filename: "a.md",
    });
    // 各组各篡改一行（甲 difficulty=5、乙 difficulty=4），reparse 应各自恢复为 1
    db.update(questions)
      .set({ difficulty: 5 })
      .where(
        and(
          eq(questions.teacherId, TEST_TEACHER_ID),
          eq(questions.id, "dup-1"),
        ),
      )
      .run();
    db.update(questions)
      .set({ difficulty: 4 })
      .where(
        and(eq(questions.teacherId, "th-reparse-b"), eq(questions.id, "dup-1")),
      )
      .run();

    const report = reparseAll(db, { dryRun: false });
    expect(report.questions).toHaveLength(2);
    expect(report.questions.every((r) => r.status === "updated")).toBe(true);

    const rowA = db
      .select({ difficulty: questions.difficulty, version: questions.version })
      .from(questions)
      .where(
        and(
          eq(questions.teacherId, TEST_TEACHER_ID),
          eq(questions.id, "dup-1"),
        ),
      )
      .get();
    const rowB = db
      .select({ difficulty: questions.difficulty, version: questions.version })
      .from(questions)
      .where(
        and(eq(questions.teacherId, "th-reparse-b"), eq(questions.id, "dup-1")),
      )
      .get();
    expect(rowA).toMatchObject({ difficulty: 1, version: 2 });
    expect(rowB).toMatchObject({ difficulty: 1, version: 2 });
  });
});

// ---------- tt-06b / QM-05：材料/题组/题级引用重解析 ----------

const QM_REPARSE_MD = [
  "---",
  "kind: practice",
  "unit: 资料分析",
  "---",
  "",
  "# 资料分析练习",
  "",
  "::::material{id=mat-资料分析-1}",
  "给定资料正文，含槽位 {{slot-1}}。",
  "",
  ":::seg{id=seg-1}",
  "首段。",
  ":::",
  "::::",
  "",
  "::::group{id=grp-资料分析-1 label=1～1}",
  "::ref{material=mat-资料分析-1 slot=slot-1}",
  "::ref{question=资料分析-1}",
  "::::",
  "",
  "::::question{type=choice difficulty=2}",
  "根据材料回答。",
  "",
  "- [ ] 甲",
  "- [x] 乙",
  "::::",
  "",
].join("\n");

function commitQmForReparse(db: Db): void {
  commitImport(
    db,
    TEST_TEACHER_ID,
    { markdown: QM_REPARSE_MD, filename: "资料分析.md" },
    undefined,
    undefined,
    true,
  );
}

describe("reparseAll：材料/题组（tt-06b / QM-05）", () => {
  it("抽取副本被篡改 → 按当前解析器恢复；sourceMd 与 version 不动", () => {
    const db = createTestDb();
    commitQmForReparse(db);
    // 模拟旧版抽取输出：槽位清空、组引用索引丢一行成员
    db.update(materials)
      .set({ slotsJson: "[]" })
      .where(eq(materials.id, "mat-资料分析-1"))
      .run();
    db.update(questionGroups)
      .set({ questionIdsJson: "[]" })
      .where(eq(questionGroups.id, "grp-资料分析-1"))
      .run();

    const report = reparseAll(db, { dryRun: false });

    const material = report.materials.find((r) => r.id === "mat-资料分析-1");
    expect(material?.status).toBe("updated");
    expect(material?.changes.some((c) => c.field === "slots")).toBe(true);
    const group = report.groups.find((r) => r.id === "grp-资料分析-1");
    expect(group?.status).toBe("updated");
    expect(group?.changes.some((c) => c.field === "questionIds")).toBe(true);

    const materialRow = db
      .select()
      .from(materials)
      .where(eq(materials.id, "mat-资料分析-1"))
      .get();
    expect(JSON.parse(materialRow?.slotsJson ?? "[]")).toEqual([
      { id: "slot-1", slotKind: "choice", order: 0 },
    ]);
    // sourceMd 不变 → version 不动（抽取副本刷新不升版）
    expect(materialRow?.version).toBe(1);
    expect(materialRow?.sourceMd).toContain("给定资料正文");
    const groupRow = db
      .select()
      .from(questionGroups)
      .where(eq(questionGroups.id, "grp-资料分析-1"))
      .get();
    expect(JSON.parse(groupRow?.questionIdsJson ?? "[]")).toEqual([
      "资料分析-1",
    ]);
    // 成员索引随组保存同事务重建
    const members = db
      .select()
      .from(questionGroupMembers)
      .where(eq(questionGroupMembers.groupId, "grp-资料分析-1"))
      .all();
    expect(members.map((m) => m.questionId)).toEqual(["资料分析-1"]);
  });

  it("QM-07 P2-3：updated 保持行内 order（0,1,5 不重排为 0,1,2）", () => {
    const db = createTestDb();
    commitQmForReparse(db);
    // 模拟历史库的非连续 order（中间实体被清理后留下空洞）
    db.update(materials)
      .set({ order: 5, slotsJson: "[]" })
      .where(eq(materials.id, "mat-资料分析-1"))
      .run();
    db.update(questionGroups)
      .set({ order: 5, questionIdsJson: "[]" })
      .where(eq(questionGroups.id, "grp-资料分析-1"))
      .run();

    const report = reparseAll(db, { dryRun: false });

    // 两实体均走 updated 分支（抽取副本被篡改触发恢复）
    expect(
      report.materials.find((r) => r.id === "mat-资料分析-1")?.status,
    ).toBe("updated");
    expect(report.groups.find((r) => r.id === "grp-资料分析-1")?.status).toBe(
      "updated",
    );
    // reparse 只刷新抽取副本：order 维持行内原值，不按数组下标重排
    expect(
      db
        .select()
        .from(materials)
        .where(eq(materials.id, "mat-资料分析-1"))
        .get()?.order,
    ).toBe(5);
    expect(
      db
        .select()
        .from(questionGroups)
        .where(eq(questionGroups.id, "grp-资料分析-1"))
        .get()?.order,
    ).toBe(5);
  });

  it("干净 QM 库：材料/组全部 unchanged；报告含材料/题组两段且渲染四行统计", () => {
    const db = createTestDb();
    commitQmForReparse(db);
    const report = reparseAll(db, { dryRun: false });
    expect(report.materials.every((r) => r.status === "unchanged")).toBe(true);
    expect(report.groups.every((r) => r.status === "unchanged")).toBe(true);
    const text = renderReparseReport(report);
    expect(text).toContain("材料：检查 1 份");
    expect(text).toContain("题组：检查 1 组");
  });

  it("--dry-run：报告材料变更但不写库", () => {
    const db = createTestDb();
    commitQmForReparse(db);
    db.update(materials)
      .set({ slotsJson: "[]" })
      .where(eq(materials.id, "mat-资料分析-1"))
      .run();
    const report = reparseAll(db, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.materials[0]?.status).toBe("updated");
    const row = db
      .select()
      .from(materials)
      .where(eq(materials.id, "mat-资料分析-1"))
      .get();
    expect(row?.slotsJson).toBe("[]");
  });

  it("题外材料丢失（旧库）：组与题级引用明确要求原文件重导，不从相邻文本猜测恢复", () => {
    const db = createTestDb();
    commitQmForReparse(db);
    // 模拟旧库丢失：材料行被外力删除，组/题引用悬垂
    db.delete(materials).where(eq(materials.id, "mat-资料分析-1")).run();

    const report = reparseAll(db, { dryRun: false });

    const group = report.groups.find((r) => r.id === "grp-资料分析-1");
    expect(group?.status).toBe("skipped");
    expect(group?.reason).toContain("原文件重新导入恢复");
    expect(group?.reason).toContain("不从相邻文本猜测恢复");
    // 组行原样保留（未猜测恢复材料）
    const groupRow = db
      .select()
      .from(questionGroups)
      .where(eq(questionGroups.id, "grp-资料分析-1"))
      .get();
    expect(groupRow?.sourceMd).toContain("::ref{material=mat-资料分析-1");
  });

  it("历史作答快照（attempt_context_snapshots）不受 reparse 影响", () => {
    const db = createTestDb();
    commitQmForReparse(db);
    // 造最小作答链：学生 → attempt → 冻结快照（材料公开投影形态）
    db.insert(students)
      .values({
        id: "stu-reparse",
        teacherId: TEST_TEACHER_ID,
        displayName: "重解析学生",
        loginName: "stu-reparse",
        linkToken: "tok-reparse",
        createdAt: "2026-10-24T08:00:00.000Z",
      })
      .run();
    db.insert(attempts)
      .values({
        id: "att-reparse",
        studentId: "stu-reparse",
        sourceType: "course",
        status: "draft",
        startedAt: "2026-10-24T08:00:00.000Z",
      })
      .run();
    db.insert(attemptContextSnapshots)
      .values({
        id: "snap-reparse-1",
        attemptId: "att-reparse",
        kind: "material",
        sourceId: "mat-资料分析-1",
        sourceVersion: 1,
        snapshotJson: JSON.stringify({
          id: "mat-资料分析-1",
          contentMd: "冻结时的材料正文",
          anchors: [],
          slots: [],
          mediaPaths: [],
        }),
        frozenAt: "2026-10-24T08:00:00.000Z",
      })
      .run();
    // 篡改当前材料抽取副本诱导 reparse 写材料行
    db.update(materials)
      .set({ contentMd: "被篡改的正文" })
      .where(eq(materials.id, "mat-资料分析-1"))
      .run();

    reparseAll(db, { dryRun: false });

    const snapshot = db
      .select()
      .from(attemptContextSnapshots)
      .where(eq(attemptContextSnapshots.id, "snap-reparse-1"))
      .get();
    expect(snapshot?.snapshotJson).toContain("冻结时的材料正文");
    expect(snapshot?.sourceVersion).toBe(1);
    // 材料行本身恢复（抽取副本刷新），快照不动——两个事实互不覆盖
    const materialRow = db
      .select()
      .from(materials)
      .where(eq(materials.id, "mat-资料分析-1"))
      .get();
    expect(materialRow?.contentMd).not.toContain("被篡改");
  });
});
