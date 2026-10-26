import { describe, expect, it } from "vitest";
import {
  ANNOTATION_MAX_DELETED_STROKES,
  annotationDocSchema,
  annotationSurfaceCompatibilitySchema,
} from "./annotation.ts";

/**
 * 圈画过程信号与语义锚点契约自测（LR-2/LR-4/LR-5，学习记录模型设计稿 §4.2/§5）：
 * - 旧 AnnotationDoc（无 deleted/anchors）原样 parse 通过；
 * - 墓碑兄弟数组：必有 id，笔数限额 ANNOTATION_MAX_DELETED_STROKES，
 *   墓碑几何同样受坐标域约束；
 * - anchors：键必须指向 strokes∪deleted 的笔画 id（悬空拒绝）；值是题面
 *   节点键（questionNodeKeySchema）；键/值唯一性（活笔画间不重复）；
 * - surface compatibility blocks[].node 可选（旧布局无 node 原样通过）。
 */

const legacyStroke = {
  tool: "pen",
  color: "#000000",
  weight: 4,
  points: [{ x: 10, y: 10, p: 0.5, t: 0 }],
};

const legacyDoc = {
  version: 1,
  baseWidth: 1440,
  baseHeight: 800,
  strokes: [legacyStroke],
};

const tombstone = (id: string) => ({
  ...legacyStroke,
  id,
  deletedAt: 1727392800000,
  deletedBy: "eraser",
});

const isLimitIssue = (issues: readonly unknown[]) =>
  issues.some(
    (issue) =>
      (issue as { params?: { limit?: boolean } }).params?.limit === true,
  );

describe("annotation 契约 LR-2 擦除墓碑", () => {
  it("旧样例（无 deleted/anchors、笔画无 id）原样 parse 通过", () => {
    const parsed = annotationDocSchema.parse(legacyDoc);
    expect(parsed).not.toHaveProperty("deleted");
    expect(parsed).not.toHaveProperty("anchors");
  });

  it("deleted 兄弟数组 parse 通过；墓碑缺 id 拒绝", () => {
    expect(
      annotationDocSchema.safeParse({
        ...legacyDoc,
        deleted: [tombstone("stroke-dead")],
      }).success,
    ).toBe(true);
    expect(
      annotationDocSchema.safeParse({
        ...legacyDoc,
        deleted: [
          { ...legacyStroke, deletedAt: 1727392800000, deletedBy: "clear" },
        ],
      }).success,
    ).toBe(false);
  });

  it("墓碑笔数超 ANNOTATION_MAX_DELETED_STROKES → params.limit 标记", () => {
    const build = (count: number) => ({
      ...legacyDoc,
      deleted: Array.from({ length: count }, (_, i) =>
        tombstone(`dead-${String(i).padStart(4, "0")}`),
      ),
    });
    expect(
      annotationDocSchema.safeParse(build(ANNOTATION_MAX_DELETED_STROKES))
        .success,
    ).toBe(true);
    const over = annotationDocSchema.safeParse(
      build(ANNOTATION_MAX_DELETED_STROKES + 1),
    );
    expect(over.success).toBe(false);
    expect(isLimitIssue(over.error?.issues ?? [])).toBe(true);
  });

  it("墓碑几何同样受底图坐标域约束（越界拒绝）", () => {
    expect(
      annotationDocSchema.safeParse({
        ...legacyDoc,
        deleted: [
          {
            ...tombstone("stroke-dead"),
            points: [{ x: 9999, y: 0, p: 0.5, t: 0 }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("annotation 契约 LR-4 语义锚点", () => {
  it("anchors 键指向活笔画 id 时 parse 通过", () => {
    const parsed = annotationDocSchema.parse({
      ...legacyDoc,
      strokes: [{ ...legacyStroke, id: "stroke-1" }],
      anchors: { "stroke-1": "stem/p/0" },
    });
    expect(parsed.anchors).toEqual({ "stroke-1": "stem/p/0" });
  });

  it("anchors 悬空键（不指向 strokes∪deleted 的 id）拒绝", () => {
    expect(
      annotationDocSchema.safeParse({
        ...legacyDoc,
        strokes: [{ ...legacyStroke, id: "stroke-1" }],
        anchors: { "ghost-stroke": "stem/p/0" },
      }).success,
    ).toBe(false);
    // 指向墓碑 id 合法
    expect(
      annotationDocSchema.safeParse({
        ...legacyDoc,
        strokes: [{ ...legacyStroke, id: "stroke-1" }],
        deleted: [tombstone("stroke-dead")],
        anchors: { "stroke-dead": "root" },
      }).success,
    ).toBe(true);
    // 键值不是合法节点键时拒绝
    expect(
      annotationDocSchema.safeParse({
        ...legacyDoc,
        strokes: [{ ...legacyStroke, id: "stroke-1" }],
        anchors: { "stroke-1": "stem/p/-1" },
      }).success,
    ).toBe(false);
  });
});

describe("annotation 契约 LR-5 布局证据带节点键", () => {
  const compatBase = {
    version: 1,
    contentSignature: "a".repeat(64),
    blocks: [
      { x: 0, y: 0, width: 100, height: 40, tag: "p" },
      { x: 0, y: 60, width: 100, height: 40, tag: "p" },
    ],
    fonts: [
      ["16px", "16px", "16px", "sans-serif", "normal"],
      ["16px", "16px", "16px", "sans-serif", "normal"],
    ],
    textRects: [],
  };

  it("旧布局（blocks 无 node）原样 parse 通过", () => {
    expect(
      annotationSurfaceCompatibilitySchema.safeParse(compatBase).success,
    ).toBe(true);
  });

  it("blocks[].node 合法键 parse 通过；非法键拒绝", () => {
    const withNode = {
      ...compatBase,
      blocks: [
        { ...compatBase.blocks[0], node: "stem/p/0" },
        { ...compatBase.blocks[1], node: "root" },
      ],
    };
    expect(
      annotationSurfaceCompatibilitySchema.safeParse(withNode).success,
    ).toBe(true);
    const badNode = {
      ...compatBase,
      blocks: [{ ...compatBase.blocks[0], node: "stem/P/-1" }],
    };
    expect(
      annotationSurfaceCompatibilitySchema.safeParse(badNode).success,
    ).toBe(false);
  });
});
