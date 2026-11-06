import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { questionKnowledge, questions } from "../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils.ts";
import {
  commitImport,
  getQuestionDetail,
  updateQuestion,
} from "./content-service.ts";
import { exportUnitMd } from "./library-service.ts";
import { reparseAll } from "./reparse-service.ts";

const source = (knowledge?: string) =>
  `::::question{type=judge id=knowledge-q${knowledge === undefined ? "" : ` knowledge="${knowledge}"`}}\n判断。[[正确]]\n::::`;
const document = (knowledge?: string) =>
  `---\nkind: practice\nunit: 多考点\n---\n${source(knowledge)}`;

describe("多考点导入、编辑与往返", () => {
  it("导入去重、详情返回全部考点、导出重导与重抽取稳定，编辑和重导全量替换关联", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: document(" 数轴 | 加法 || 数轴 | "),
      filename: "多考点.md",
    });
    const detail = () => getQuestionDetail(db, TEST_TEACHER_ID, "knowledge-q");
    expect(new Set(detail().knowledge)).toEqual(new Set(["数轴", "加法"]));
    expect(db.select().from(questionKnowledge).all()).toHaveLength(2);
    expect(reparseAll(db, { dryRun: true }).questions[0]?.status).toBe(
      "unchanged",
    );

    const exported = exportUnitMd(db, TEST_TEACHER_ID, "多考点");
    const copy = createTestDb();
    commitImport(copy, TEST_TEACHER_ID, {
      markdown: exported.markdown,
      filename: exported.filename,
    });
    expect(
      new Set(
        getQuestionDetail(copy, TEST_TEACHER_ID, "knowledge-q").knowledge,
      ),
    ).toEqual(new Set(["数轴", "加法"]));

    updateQuestion(db, TEST_TEACHER_ID, "knowledge-q", {
      sourceMd: source("减法 | 数轴 | 减法"),
    });
    expect(new Set(detail().knowledge)).toEqual(new Set(["减法", "数轴"]));
    expect(db.select().from(questionKnowledge).all()).toHaveLength(2);
    for (const value of ["   ", " | | "]) {
      const before = detail();
      expect(() =>
        updateQuestion(db, TEST_TEACHER_ID, "knowledge-q", {
          sourceMd: source(value),
        }),
      ).toThrow();
      expect(detail()).toEqual(before);
    }

    commitImport(db, TEST_TEACHER_ID, {
      markdown: document(),
      filename: "多考点.md",
    });
    expect(detail().knowledge).toEqual([]);
    expect(db.select().from(questionKnowledge).all()).toHaveLength(0);
  });

  it("历史原文可先 dry-run，再重抽取多考点，保持题目身份", () => {
    const db = createTestDb();
    commitImport(db, TEST_TEACHER_ID, {
      markdown: document("数轴"),
      filename: "多考点.md",
    });
    // 模拟升级前留有管道符原文、抽取关联仍为旧值的题目。
    db.update(questions)
      .set({ sourceMd: source("数轴|加法") })
      .where(eq(questions.id, "knowledge-q"))
      .run();
    const preview = reparseAll(db, { dryRun: true });
    expect(preview.questions[0]?.changes).toContainEqual(
      expect.objectContaining({ field: "knowledge" }),
    );
    expect(
      getQuestionDetail(db, TEST_TEACHER_ID, "knowledge-q").knowledge,
    ).toEqual(["数轴"]);
    reparseAll(db, { dryRun: false });
    expect(
      new Set(getQuestionDetail(db, TEST_TEACHER_ID, "knowledge-q").knowledge),
    ).toEqual(new Set(["数轴", "加法"]));
    expect(reparseAll(db, { dryRun: true }).questions[0]?.status).toBe(
      "unchanged",
    );
  });
});
