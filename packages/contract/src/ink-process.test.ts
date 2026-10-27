import { describe, expect, it } from "vitest";
import {
  INK_LOGICAL_WIDTH,
  INK_MAX_DELETED_POINTS,
  inkAtramentDataSchema,
  inkDeletedStrokeSchema,
  inkDocSchema,
  inkDuplicateStrokeIds,
  inkStrokeIdSchema,
  inkStrokeSchema,
} from "./ink.ts";
import { NOTE_MAX_DELETED_POINTS, noteDocSchema } from "./note.ts";

/**
 * 过程信号写入侧契约自测（LR-1/LR-2，学习记录模型设计稿 §4）：
 * - 旧文档样例（无 id/startedAt/pointer/deleted）原样 parse 通过（P2 只增不改）；
 * - 笔画可选新字段形状（id 8–40 位、startedAt 正整数 epoch ms、pointer 枚举）；
 * - 墓碑必有 id/deletedAt/deletedBy；兄弟数组 deleted 语义（活笔画消费方零变化）；
 * - 墓碑点数限额（params.limit → 服务端 413 分级）与 id 唯一性。
 * 圈画侧（AnnotationDoc.deleted/anchors）见 annotation-anchor.test.ts。
 */

/** 旧样例笔画（无任何新字段） */
const legacyStroke = {
  tool: "pen",
  color: "#1f2328",
  weight: 4,
  points: [
    { x: 100, y: 200, p: 0.5, t: 0 },
    { x: 120, y: 240, p: 0.8, t: 30 },
  ],
};

const tombstone = (id: string, points = 1) => ({
  ...legacyStroke,
  id,
  deletedAt: 1727392800000,
  deletedBy: "eraser",
  points: Array.from({ length: points }, (_, i) => ({
    x: i % 1000,
    y: i % 1000,
    p: 0.5,
    t: i,
  })),
});

const isLimitIssue = (issues: readonly unknown[]) =>
  issues.some(
    (issue) =>
      (issue as { params?: { limit?: boolean } }).params?.limit === true,
  );

describe("ink 契约 LR-1 笔画身份与绝对时刻", () => {
  it("旧样例笔画原样 parse 通过，且不引入新键", () => {
    const parsed = inkStrokeSchema.parse(legacyStroke);
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("startedAt");
    expect(parsed).not.toHaveProperty("pointer");
  });

  it("新字段（id/startedAt/pointer）合法时 parse 通过", () => {
    const parsed = inkStrokeSchema.parse({
      ...legacyStroke,
      id: "stroke-abc_123",
      startedAt: 1727392800000,
      pointer: "pen",
    });
    expect(parsed.id).toBe("stroke-abc_123");
    expect(parsed.startedAt).toBe(1727392800000);
    expect(parsed.pointer).toBe("pen");
  });

  it("id 形状：8–40 位 [0-9A-Za-z_-]；crypto.randomUUID 形状天然合法", () => {
    expect(inkStrokeIdSchema.safeParse("a".repeat(8)).success).toBe(true);
    expect(inkStrokeIdSchema.safeParse("Z-_9".padEnd(40, "0")).success).toBe(
      true,
    );
    expect(
      inkStrokeIdSchema.safeParse("3f8a2b1c-4d5e-6f70-8a9b-c0d1e2f3a4b5")
        .success,
    ).toBe(true);
    expect(inkStrokeIdSchema.safeParse("a".repeat(7)).success).toBe(false);
    expect(inkStrokeIdSchema.safeParse(`a${"b".repeat(40)}`).success).toBe(
      false,
    );
    expect(inkStrokeIdSchema.safeParse("含中文字符id").success).toBe(false);
    expect(inkStrokeIdSchema.safeParse("has space id").success).toBe(false);
  });

  it("startedAt 必须为正整数 epoch ms；pointer 枚举 pen/touch/mouse", () => {
    expect(
      inkStrokeSchema.safeParse({ ...legacyStroke, startedAt: 0 }).success,
    ).toBe(false);
    expect(
      inkStrokeSchema.safeParse({ ...legacyStroke, startedAt: 1.5 }).success,
    ).toBe(false);
    expect(
      inkStrokeSchema.safeParse({ ...legacyStroke, startedAt: -1 }).success,
    ).toBe(false);
    expect(
      inkStrokeSchema.safeParse({ ...legacyStroke, pointer: "stylus" }).success,
    ).toBe(false);
    for (const pointer of ["pen", "touch", "mouse"] as const) {
      expect(
        inkStrokeSchema.safeParse({ ...legacyStroke, pointer }).success,
      ).toBe(true);
    }
  });
});

describe("ink 契约 LR-2 擦除墓碑", () => {
  it("墓碑必有 id/deletedAt/deletedBy；缺 id 拒绝", () => {
    const ok = inkDeletedStrokeSchema.safeParse(tombstone("stroke-1"));
    expect(ok.success).toBe(true);
    const missingId = inkDeletedStrokeSchema.safeParse({
      ...legacyStroke,
      deletedAt: 1727392800000,
      deletedBy: "eraser",
    });
    expect(missingId.success).toBe(false);
    expect(
      inkDeletedStrokeSchema.safeParse({
        ...tombstone("stroke-1"),
        deletedAt: 1727392800000,
      }).success,
    ).toBe(true);
    expect(
      inkDeletedStrokeSchema.safeParse({ id: "stroke-1", deletedBy: "undo" })
        .success,
    ).toBe(false);
  });

  it("deletedBy 枚举 eraser/clear/undo", () => {
    for (const deletedBy of ["eraser", "clear", "undo"] as const) {
      expect(
        inkDeletedStrokeSchema.safeParse({
          ...tombstone("stroke-1"),
          deletedBy,
        }).success,
      ).toBe(true);
    }
    expect(
      inkDeletedStrokeSchema.safeParse({
        ...tombstone("stroke-1"),
        deletedBy: "redo",
      }).success,
    ).toBe(false);
  });

  it("atrament：旧样例（无 deleted）原样 parse 通过", () => {
    const parsed = inkAtramentDataSchema.parse({
      width: INK_LOGICAL_WIDTH,
      strokes: [legacyStroke],
    });
    expect(parsed).not.toHaveProperty("deleted");
  });

  it("atrament：deleted 兄弟数组 parse 通过，活笔画语义不变", () => {
    const parsed = inkAtramentDataSchema.parse({
      width: INK_LOGICAL_WIDTH,
      strokes: [{ ...legacyStroke, id: "stroke-live" }],
      deleted: [tombstone("stroke-dead")],
    });
    expect(parsed.strokes).toHaveLength(1);
    expect(parsed.deleted).toHaveLength(1);
    expect(parsed.deleted?.[0]?.id).toBe("stroke-dead");
  });

  it("InkDoc（正式手写）：墓碑总点数超 INK_MAX_DELETED_POINTS → params.limit 标记", () => {
    const perStrokePoints = 2000;
    const atLimit = INK_MAX_DELETED_POINTS / perStrokePoints;
    const build = (strokeCount: number) => ({
      engine: "atrament",
      version: 1,
      updatedAt: 1727392800000,
      data: {
        width: INK_LOGICAL_WIDTH,
        strokes: [],
        deleted: Array.from({ length: strokeCount }, (_, i) =>
          tombstone(`deleted-${i}`, perStrokePoints),
        ),
      },
    });
    expect(inkDocSchema.safeParse(build(atLimit)).success).toBe(true);
    const over = inkDocSchema.safeParse(build(atLimit + 1));
    expect(over.success).toBe(false);
    expect(isLimitIssue(over.error?.issues ?? [])).toBe(true);
  });

  it("atrament：id 必须在活笔画 ∪ 墓碑内唯一（跨数组重复拒绝）", () => {
    const dup = inkAtramentDataSchema.safeParse({
      width: INK_LOGICAL_WIDTH,
      strokes: [{ ...legacyStroke, id: "stroke-1" }],
      deleted: [tombstone("stroke-1")],
    });
    expect(dup.success).toBe(false);
    // 活笔画之间重复同样拒绝
    const dupLive = inkAtramentDataSchema.safeParse({
      width: INK_LOGICAL_WIDTH,
      strokes: [
        { ...legacyStroke, id: "stroke-1" },
        { ...legacyStroke, id: "stroke-1" },
      ],
    });
    expect(dupLive.success).toBe(false);
  });

  it("inkDuplicateStrokeIds：undefined 旧稿笔画跳过，返回重复 id 列表", () => {
    expect(inkDuplicateStrokeIds([{ id: undefined }, {}])).toEqual([]);
    expect(
      inkDuplicateStrokeIds([{ id: "a" }, { id: "b" }], [{ id: "a" }]),
    ).toEqual(["a"]);
    expect(
      inkDuplicateStrokeIds([{ id: "a" }, { id: "a" }, { id: "a" }]),
    ).toEqual(["a"]);
  });
});

describe("note 契约 LR-2 草稿墓碑限额", () => {
  const legacyNote = {
    version: 1,
    ink: { width: INK_LOGICAL_WIDTH, strokes: [legacyStroke] },
  };

  it("旧样例草稿原样 parse 通过，不引入 deleted 键", () => {
    const parsed = noteDocSchema.parse(legacyNote);
    expect(parsed.ink).not.toHaveProperty("deleted");
  });

  it("草稿墓碑点数恰在 NOTE_MAX_DELETED_POINTS 内通过，超限拒绝并带 params.limit", () => {
    const perStrokePoints = 2000;
    const atLimit = NOTE_MAX_DELETED_POINTS / perStrokePoints;
    const build = (strokeCount: number) => ({
      version: 1,
      ink: {
        width: INK_LOGICAL_WIDTH,
        strokes: [],
        deleted: Array.from({ length: strokeCount }, (_, i) =>
          tombstone(`deleted-${i}`, perStrokePoints),
        ),
      },
    });
    expect(noteDocSchema.safeParse(build(atLimit)).success).toBe(true);
    const over = noteDocSchema.safeParse(build(atLimit + 1));
    expect(over.success).toBe(false);
    expect(isLimitIssue(over.error?.issues ?? [])).toBe(true);
  });
});
