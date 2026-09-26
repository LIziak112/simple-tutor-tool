import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.ts";
import { lectures, questionKnowledge, questions } from "../db/schema.ts";
import { createTestDb } from "../db/test-utils.ts";
import { commitImport } from "./content-service.ts";
import {
  type ReparseReport,
  reparseAll,
  renderReparseReport,
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
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
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
    expect(JSON.parse(after.optionsJson)).toEqual(
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
    expect(report.questions.filter((r) => r.status === "unchanged")).toHaveLength(
      7,
    );
    expect(report.questions).toHaveLength(8);
    expect(report.dryRun).toBe(false);
  });
});

describe("reparseAll：干净库（全部无变化）", () => {
  it("0 更新：version 与 updatedAt 全部不动，讲义与题目都报告 unchanged", () => {
    const db = createTestDb();
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
    commitImport(db, { markdown: LECTURE_MD, filename: "讲义样例.md" });
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
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });

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
    commitImport(db, { markdown: LECTURE_MD, filename: "讲义样例.md" });
    const first = db.select().from(lectures).all()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    db.update(lectures)
      .set({ title: "被篡改的标题" })
      .where(eq(lectures.id, first.id))
      .run();

    reparseAll(db, { dryRun: true });

    const row = db.select().from(lectures).where(eq(lectures.id, first.id)).get();
    expect(row?.title).toBe("被篡改的标题");
  });
});

describe("reparseAll：坏数据防御", () => {
  it("sourceMd 被篡改成解析不出题：跳过并记中文原因，该题原样保留、version 不变", () => {
    const db = createTestDb();
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
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
    expect(report.questions.filter((r) => r.status === "unchanged")).toHaveLength(
      7,
    );
  });

  it("软删题目不参与 reparse：不检查、不更新", () => {
    const db = createTestDb();
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
    db.update(questions)
      .set({ deletedAt: new Date().toISOString(), difficulty: 5 })
      .where(eq(questions.id, "练习四-2"))
      .run();

    const report = reparseAll(db, { dryRun: false });

    expect(report.questions).toHaveLength(7);
    expect(
      report.questions.some((r) => r.id === "练习四-2"),
    ).toBe(false);
    const row = getQuestion(db, "练习四-2");
    expect(row?.difficulty).toBe(5); // 软删行不被触碰
  });
});

describe("reparseAll：讲义 title 重取", () => {
  it("title 被篡改后从 markdown 的 H1 恢复：markdown 不动、updatedAt 刷新；title 未变的讲义不动", () => {
    const db = createTestDb();
    commitImport(db, { markdown: LECTURE_MD, filename: "讲义样例.md" });
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
    expect(afterFirst?.title).toBe(first.title);
    expect(afterFirst?.markdown).toBe(first.markdown);
    expect(afterFirst?.updatedAt > first.updatedAt).toBe(true);

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
    commitImport(db, { markdown: LECTURE_MD, filename: "讲义样例.md" });
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
    commitImport(db, { markdown: PRACTICE_MD, filename: "练习样例.md" });
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
