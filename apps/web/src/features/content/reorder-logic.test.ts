import type { ContentTree } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  applyReorder,
  buildReorderPayload,
  moveItem,
  orderByIds,
} from "./reorder-logic";

/** 排序纯逻辑测试（T1.12）：移动/重排/乐观更新树/payload 构造 */
describe("moveItem / orderByIds", () => {
  it("moveItem 移动数组元素", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("orderByIds 按新顺序重排；未提到的排末尾", () => {
    expect(orderByIds(["a", "b", "c"], ["c", "a"], (x) => x)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("applyReorder 内容树乐观更新", () => {
  const TREE: ContentTree = {
    courses: [
      {
        id: "c1",
        title: "默认课程",
        lectures: [
          { id: "l1", title: "第1讲", updatedAt: "2026-09-26T00:00:00.000Z" },
          { id: "l2", title: "第2讲", updatedAt: "2026-09-26T00:00:00.000Z" },
        ],
        units: [
          {
            id: "u1",
            title: "练习四",
            topic: null,
            updatedAt: "2026-09-26T00:00:00.000Z",
            questions: [
              {
                id: "q1",
                type: "judge",
                difficulty: 1,
                knowledge: [],
                version: 1,
              },
              {
                id: "q2",
                type: "fill",
                difficulty: 2,
                knowledge: [],
                version: 1,
              },
              {
                id: "q3",
                type: "solve",
                difficulty: 3,
                knowledge: [],
                version: 1,
              },
            ],
          },
        ],
      },
      { id: "c2", title: "初一上", lectures: [], units: [] },
    ],
  };

  it("题目在单元内重排（q1 拖到末尾）", () => {
    const next = applyReorder(TREE, { kind: "question", unitId: "u1" }, [
      "q2",
      "q3",
      "q1",
    ]);
    expect(next.courses[0]?.units[0]?.questions.map((q) => q.id)).toEqual([
      "q2",
      "q3",
      "q1",
    ]);
    // 原树不变（纯函数）
    expect(TREE.courses[0]?.units[0]?.questions.map((q) => q.id)).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
  });

  it("讲义/单元/课程重排", () => {
    expect(
      applyReorder(TREE, { kind: "lecture", courseId: "c1" }, [
        "l2",
        "l1",
      ]).courses[0]?.lectures.map((l) => l.id),
    ).toEqual(["l2", "l1"]);
    expect(
      applyReorder(TREE, { kind: "unit", courseId: "c1" }, [
        "u1",
      ]).courses[0]?.units.map((u) => u.id),
    ).toEqual(["u1"]);
    expect(
      applyReorder(TREE, { kind: "course" }, ["c2", "c1"]).courses.map(
        (c) => c.id,
      ),
    ).toEqual(["c2", "c1"]);
  });
});

describe("buildReorderPayload", () => {
  it("构造 reorder 请求体：kind + 完整新顺序 ids", () => {
    expect(buildReorderPayload("question", ["q2", "q1", "q3"])).toEqual({
      kind: "question",
      ids: ["q2", "q1", "q3"],
    });
    expect(buildReorderPayload("course", ["c2", "c1"])).toEqual({
      kind: "course",
      ids: ["c2", "c1"],
    });
  });
});
