import type { AttemptQuestionPublic } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  frozenQuestionKeys,
  materialTileAt,
  materialTilePlan,
  validateFrozenQuestion,
} from "./test-support/frozen-surface-prototype";

const common = {
  id: "question-1",
  questionRevisionId: "revision-1",
  difficulty: 1 as const,
  knowledge: [],
  hintCount: 0,
};

describe("开发原型的冻结表面边界", () => {
  it("填空按冻结版本内的原有序号建键，不使用 React 实例 scopeId", () => {
    const question = {
      ...common,
      type: "fill",
      stemMd: "公式 $x^2$，甲 [[]]，乙 :blank[]。",
    } satisfies AttemptQuestionPublic;
    expect(frozenQuestionKeys(question)).toEqual([
      "fill:slot-1",
      "fill:slot-2",
    ]);
    const manifest = {
      version: 0 as const,
      questionId: question.id,
      questionRevisionId: question.questionRevisionId,
      contentSignature: "saved-content",
      slots: [
        { key: "fill:slot-1", x: 10, y: 20, width: 112, height: 44 },
        { key: "fill:slot-2", x: 60, y: 120, width: 112, height: 44 },
      ],
    };
    expect(validateFrozenQuestion(manifest, question, "saved-content")).toBe(
      true,
    );
    expect(
      validateFrozenQuestion(
        manifest,
        { ...question, questionRevisionId: "revision-2" },
        "saved-content",
      ),
    ).toBe(false);
    expect(
      validateFrozenQuestion(
        { ...manifest, slots: manifest.slots.slice(0, 1) },
        question,
        "saved-content",
      ),
    ).toBe(false);
    expect(
      validateFrozenQuestion(
        {
          ...manifest,
          slots: [manifest.slots[0], manifest.slots[0]].filter(
            (slot): slot is NonNullable<typeof slot> => slot !== undefined,
          ),
        },
        question,
        "saved-content",
      ),
    ).toBe(false);
  });

  it("配对绑定冻结材料的 slotId，排序不把动态板当静态槽位", () => {
    const matching = {
      ...common,
      type: "matching",
      stemMd: "读文章配对。",
      matchingSlots: [
        { id: "slot-3", ordinal: 3 },
        { id: "slot-5", ordinal: 5 },
      ],
      matchingOptions: {
        allowRepeat: false,
        options: [{ id: "opt-a", text: "甲" }],
      },
    } satisfies AttemptQuestionPublic;
    expect(frozenQuestionKeys(matching)).toEqual([
      "matching:slot-3",
      "matching:slot-5",
    ]);
    const ordering = {
      ...common,
      type: "ordering",
      stemMd: "排序。",
      orderingItems: [{ id: "item-a", text: "第一段", fixedPosition: null }],
      sortableCount: 1,
    } satisfies AttemptQuestionPublic;
    expect(frozenQuestionKeys(ordering)).toEqual([]);
  });

  it("长材料分片不建立超高画布，缝两侧仍在同一个逻辑坐标域", () => {
    const tiles = materialTilePlan(720, 3675, 2);
    expect(tiles.map((tile) => [tile.top, tile.height])).toEqual([
      [0, 1600],
      [1600, 1600],
      [3200, 475],
    ]);
    expect(tiles.every((tile) => tile.pixelHeight <= 4096)).toBe(true);
    expect(materialTileAt(tiles, 1599.5)?.top).toBe(0);
    expect(materialTileAt(tiles, 1600.5)?.top).toBe(1600);
    expect(materialTileAt(tiles, 3675)).toBeNull();
    expect(() => materialTilePlan(2200, 3000, 2)).toThrow(/宽度/);
    for (const ratio of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 5000]) {
      expect(() => materialTilePlan(720, 3000, ratio)).toThrow(/像素比/);
    }
  });
});
